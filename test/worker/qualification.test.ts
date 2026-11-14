import { beforeAll, describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import probe, { createQualificationProbe } from "../../src/worker/qualification/index.js";

const config = {
  QUALIFY_ENVIRONMENT: "development",
  QUALIFY_ISSUER: "https://issuer.test/",
  QUALIFY_MCP_AUDIENCE: "https://probe.test/mcp",
  QUALIFY_APPLE_IDENTITY_CLAIM: "https://simplitica.co/apple-sub",
  QUALIFY_CLIENT_ID: "third-party-client",
  QUALIFY_PROBE_SCOPE: "probe:read",
};
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let otherKeys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: object;
beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  otherKeys = await generateKeyPair("RS256");
  jwks = { keys: [{ ...await exportJWK(keys.publicKey), kid: "test-key", alg: "RS256", use: "sig" }] };
});

function network(value = jwks): typeof fetch {
  return async (input, init) => {
    // This is the only external boundary replaced: signature verification is real.
    expect(String(input)).toBe("https://issuer.test/.well-known/jwks.json");
    expect(init?.method).toBe("GET");
    return Response.json(value);
  };
}
async function token(patch: JWTPayload = {}, privateKey = keys.privateKey, algorithm = "RS256") {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: "https://issuer.test/", aud: "https://probe.test/mcp", exp: now + 120,
    sub: "auth0|private-subject", azp: "third-party-client", scope: "probe:read",
    "https://simplitica.co/apple-sub": "private-apple-subject", ...patch,
  };
  return new SignJWT(claims).setProtectedHeader({ alg: algorithm, kid: "test-key" }).sign(privateKey);
}
function request(method = "tools/list", bearer?: string, options: RequestInit = {}) {
  return new Request("https://probe.test/mcp", {
    method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 7, method,
      ...(method === "initialize" ? { params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "probe-test", version: "1" } } } : {}),
      ...(method === "tools/call" ? { params: { name: "qualification_probe", arguments: {} } } : {}),
    }), ...options,
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...options.headers },
  });
}
async function rpc(response: Response) {
  const text = await response.text();
  expect(response.status, text).toBe(200); // Finite SSE must close within this test's timeout.
  expect(text).not.toMatch(/private-subject|private-apple-subject|eyJhbGci/);
  return JSON.parse(text.startsWith("event:") ? text.split("data: ")[1].trim() : text);
}

describe("isolated qualification probe", () => {
  it("reports readiness only after valid development configuration", async () => {
    const response = await probe.fetch(new Request("https://probe.test/health"), config);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready", probe: "synthetic-development" });
  });
  it.each([
    {}, { QUALIFY_ENVIRONMENT: "production" }, { QUALIFY_ISSUER: "http://issuer.test/" },
    { QUALIFY_ISSUER: "https://issuer.test" }, { QUALIFY_MCP_AUDIENCE: "http://probe.test/mcp" },
    { QUALIFY_MCP_AUDIENCE: "https://probe.test/mcp?x=1" }, { QUALIFY_CLIENT_ID: "" }, { QUALIFY_CLIENT_ID: "REPLACE_WITH_DEVELOPMENT_CLIENT_ID" }, { QUALIFY_CLIENT_ID: " third-party-client " },
    { QUALIFY_APPLE_IDENTITY_CLAIM: "sub" }, { QUALIFY_PROBE_SCOPE: "write:all" }, { DB: {} },
  ])("fails closed on invalid configuration %j", async (patch) => {
    const env = Object.keys(patch).length ? { ...config, ...patch } : {};
    const response = await probe.fetch(new Request("https://probe.test/health"), env);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Probe configuration unavailable" });
  });
  it.each(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"])("advertises exact configured resource at %s", async (path) => {
    const response = await probe.fetch(new Request(`https://probe.test${path}`), config);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ resource: "https://probe.test/mcp", authorization_servers: ["https://issuer.test/"], scopes_supported: ["probe:read"], bearer_methods_supported: ["header"] });
  });
  it.each(["initialize", "tools/list", "tools/call"])("authenticates every %s before transport", async (method) => {
    for (const header of [undefined, "", "Basic private-credential", "Bearer a.b.c", "Bearer a b"]) {
      const response = await createQualificationProbe(network()).fetch(request(method, undefined, { headers: header ? { authorization: header } : {} }), config);
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe('Bearer resource_metadata="https://probe.test/.well-known/oauth-protected-resource/mcp", scope="probe:read"');
    }
  });
  it("negotiates initialize and returns exactly one synthetic read-only tool through real SDK", async () => {
    const worker = createQualificationProbe(network());
    const bearer = await token();
    const initialized = await rpc(await worker.fetch(request("initialize", bearer), config));
    expect(initialized.result.protocolVersion).toBe("2025-11-25");
    const listed = await rpc(await worker.fetch(request("tools/list", bearer), config));
    expect(listed.result.tools).toHaveLength(1);
    expect(listed.result.tools[0]).toMatchObject({ name: "qualification_probe", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, _meta: { securitySchemes: [{ type: "oauth2", scopes: ["probe:read"] }] } });
    const called = await rpc(await worker.fetch(request("tools/call", bearer), config));
    expect(called.result).toEqual({ content: [{ type: "text", text: '{"success":true,"probe":"synthetic-development"}' }], structuredContent: { success: true, probe: "synthetic-development" } });
  });
  it.each([
    ["issuer", { iss: "https://evil.test/" }], ["audience", { aud: "https://elsewhere.test/mcp" }], ["near audience", { aud: "https://probe.test/mcp-extra" }],
    ["missing exp", { exp: undefined }], ["expired", { exp: 1 }], ["missing sub", { sub: undefined }],
    ["empty sub", { sub: "" }], ["future nbf", { nbf: 9999999999 }],
    ["wrong azp", { azp: "another-client" }], ["missing azp", { azp: undefined }],
    ["missing Apple assertion", { "https://simplitica.co/apple-sub": undefined }],
    ["non-string Apple assertion", { "https://simplitica.co/apple-sub": ["apple"] }],
    ["blank Apple assertion", { "https://simplitica.co/apple-sub": " " }],
  ])("rejects signed %s with a valid positive control", async (_name, patch) => {
    const worker = createQualificationProbe(network());
    expect((await worker.fetch(request("tools/list", await token()), config)).status).toBe(200);
    for (const method of ["initialize", "tools/list", "tools/call"]) {
      const response = await worker.fetch(request(method, await token(patch)), config);
      expect(response.status).toBe(401);
      expect(await response.text()).toBe('{"error":"Unauthorized"}');
    }
  });
  it("accepts a signed audience array containing the exact resource", async () => {
    const response = await createQualificationProbe(network()).fetch(request("tools/list", await token({ aud: ["https://probe.test/mcp", "https://issuer.test/userinfo"] })), config);
    const payload = await rpc(response);
    expect(payload.result.tools[0].name).toBe("qualification_probe");
  });
  it("rejects invalid signature and non-RS256 algorithm", async () => {
    const worker = createQualificationProbe(network());
    expect((await worker.fetch(request("tools/list", await token()), config)).status).toBe(200);
    expect((await worker.fetch(request("tools/list", await token({}, otherKeys.privateKey)), config)).status).toBe(401);
    const hs = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).sign(new Uint8Array(32));
    expect((await worker.fetch(request("tools/list", hs), config)).status).toBe(401);
  });
  it.each([undefined, "", "other:read", "probe:reader", ["probe:read"]])("requires exact scope after verifying token (%j)", async (scope) => {
    const response = await createQualificationProbe(network()).fetch(request("tools/call", await token({ scope })), config);
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toBe('Bearer error="insufficient_scope", resource_metadata="https://probe.test/.well-known/oauth-protected-resource/mcp", scope="probe:read"');
  });
  it.each(["GET", "PUT", "DELETE"])("terminates %s without opening SSE, even with auth", async (method) => {
    const response = await createQualificationProbe(network()).fetch(new Request("https://probe.test/mcp", { method, headers: { authorization: `Bearer ${await token()}`, accept: "text/event-stream" } }), config);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(await response.text()).toBe('{"error":"Method not allowed"}');
  });
  it("rejects arbitrary hosts and origins while allowing canonical and loopback", async () => {
    const worker = createQualificationProbe(network());
    for (const url of ["https://evil.test/health", "https://probe.test:444/health"]) {
      expect((await worker.fetch(new Request(url), config)).status).toBe(403);
    }
    for (const origin of ["https://evil.test", "null", "https://probe.test.evil.test", "https://probe.test:444"]) {
      expect((await worker.fetch(request("tools/list", await token(), { headers: { origin } }), config)).status).toBe(403);
    }
    for (const origin of ["https://probe.test", "http://127.0.0.1:8787", "http://localhost:8787"]) {
      expect((await worker.fetch(request("tools/list", await token(), { headers: { origin } }), config)).status).toBe(200);
    }
    const local = await worker.fetch(new Request("http://127.0.0.1:8787/.well-known/oauth-protected-resource/mcp"), config);
    expect((await local.json<{resource: string}>()).resource).toBe("https://probe.test/mcp");
    expect((await worker.fetch(new Request("https://probe.test/health", { headers: { host: "evil.test" } }), config)).status).toBe(403);
  });
  it.each([undefined, "1", "70000"])("bounds actual body regardless of declared length %j", async (length) => {
    const response = await createQualificationProbe(network()).fetch(request("tools/list", await token(), { body: " ".repeat(65537), headers: length ? { "content-length": length } : {} }), config);
    expect(response.status).toBe(413);
    await response.text();
  });
  it("does not leak untrusted malformed JSON in errors", async () => {
    const response = await createQualificationProbe(network()).fetch(request("tools/list", await token(), { body: '{"private-secret":broken' }), config);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toMatch(/private-secret|broken|private-subject/);
  });
  it("keeps simultaneous subjects and request IDs isolated", async () => {
    const worker = createQualificationProbe(network());
    const responses = await Promise.all([21, 22, 23].map(async (id) => rpc(await worker.fetch(request("tools/call", await token({ sub: `private-subject-${id}` }), { body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "qualification_probe", arguments: {} } }) }), config))));
    expect(responses.map(r => r.id)).toEqual([21, 22, 23]);
  });
  it("serves modern envelope tool requests as bounded JSON", async () => {
    const worker = createQualificationProbe(network());
    const response = await worker.fetch(request("tools/list", await token(), {
      headers: { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 41, method: "tools/list", params: { _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "modern-test", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": {},
      } } }),
    }), config);
    expect(response.headers.get("content-type")).toContain("application/json");
    const payload = await rpc(response);
    expect(payload.id).toBe(41);
    expect(payload.result.tools.map((tool: {name: string}) => tool.name)).toEqual(["qualification_probe"]);
  });
  it("refuses modern subscription streams even though they are transport-owned", async () => {
    const controller = new AbortController();
    try {
      const response = await createQualificationProbe(network()).fetch(request("subscriptions/listen", await token(), {
        signal: controller.signal,
        headers: { "mcp-protocol-version": "2026-07-28", "mcp-method": "subscriptions/listen" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 42, method: "subscriptions/listen", params: { notifications: {}, _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "modern-test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        } } }),
      }), config);
      expect(response.headers.get("content-type")).toContain("application/json");
      const payload = await rpc(response);
      expect(payload.error).toMatchObject({ code: -32603 });
    } finally { controller.abort(); }
  });
  it("refetches issuer keys on each request so rotation is immediately observed", async () => {
    const rotated = { keys: [{ ...await exportJWK(otherKeys.publicKey), kid: "test-key", alg: "RS256" }] };
    let calls = 0;
    const worker = createQualificationProbe(async (...args) => network(++calls === 1 ? jwks : rotated)(...args));
    expect((await worker.fetch(request("tools/list", await token()), config)).status).toBe(200);
    expect((await worker.fetch(request("tools/list", await token({}, otherKeys.privateKey)), config)).status).toBe(200);
    expect((await worker.fetch(request("tools/list", await token()), config)).status).toBe(401);
    expect(calls).toBe(3);
  });
  it("bounds a stalled JWKS network request to two seconds", async () => {
    const worker = createQualificationProbe(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("private-timeout-detail")), { once: true });
    }));
    const started = Date.now();
    const response = await worker.fetch(request("tools/list", await token()), config);
    expect(response.status).toBe(401);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(await response.text()).toBe('{"error":"Unauthorized"}');
  });
  it("terminates an unsupported method without exposing inputs", async () => {
    const response = await createQualificationProbe(network()).fetch(request("unsupported", await token()), config);
    const payload = await rpc(response);
    expect(payload.error).toMatchObject({ code: -32601 });
  });
  it.each(["upstream", "malformed", "throw"])("fails closed on JWKS %s errors", async (failure) => {
    const worker = createQualificationProbe(async () => {
      if (failure === "throw") throw new Error("private-network-detail");
      return new Response(failure === "malformed" ? "private-invalid-json" : "private-network-detail", { status: failure === "upstream" ? 503 : 200 });
    });
    const response = await worker.fetch(request("tools/list", await token()), config);
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('{"error":"Unauthorized"}');
  });
});
