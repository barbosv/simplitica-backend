import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { runInNewContext } from "node:vm";
import { Client } from "undici";
import { expect, it } from "vitest";

const hookURL = "https://simpli-invoice-native-dev.simplitica.co/api/internal/oauth/connection-epoch";
const secret = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI";
const namespace = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const appleIdentity = "PRIVATE-apple|owner";
const appleClaim = "https://simplitica.co/apple_identity";
const epochClaim = "https://simplitica.co/connection_epoch";
const namespaceClaim = "https://simplitica.co/authorization_namespace";
const coherent = { active: true, epoch: 7, namespace };
type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
async function fixture(handler: Handler) {
  let calls = 0;
  const requests: { url: string; authorization?: string; body: string }[] = [];
  const targets: string[] = [];
  const server = createServer(async (req, res) => {
    calls++;
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url!, authorization: req.headers.authorization, body });
    await handler(req, res);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture unavailable");
  // Use real fetch/HTTP streams; only its network destination is routed to the
  // disposable loopback server. The artifact keeps the fixed development URL.
  const transport = new Client(`http://127.0.0.1:${address.port}`);
  return {
    get calls() { return calls; }, requests, targets,
    fetch: (url: string, init: RequestInit) => {
      targets.push(url);
      return fetch(url, { ...init, dispatcher: transport } as RequestInit);
    },
    async close() { await transport.destroy(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}
const json: Handler = (_req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(coherent)); };
async function execute(server: Awaited<ReturnType<typeof fixture>>, overrides: Record<string, unknown> = {}) {
  const claims: unknown[][] = [], denied: string[] = [], logs: string[] = [];
  const exported: { onExecutePostLogin?: (event: unknown, api: unknown) => Promise<void> } = {};
  runInNewContext(await readFile("scripts/auth0/development-apple-identity.cjs", "utf8"), {
    exports: exported, console: { log: (value: string) => logs.push(value) },
    fetch: server.fetch, AbortController, TextDecoder, setTimeout, clearTimeout, Buffer,
  });
  const event = {
    client: { client_id: "tpc_5RjUULWf1V9koMnfWj1Xg3" },
    resource_server: { identifier: "https://simpli-invoice-mcp-dev.simplitica.co/mcp" },
    connection: { strategy: "apple" }, user: { identities: [{ provider: "apple", user_id: appleIdentity }] },
    transaction: { protocol: "oidc-basic-profile", requested_scopes: ["cloud:access"] },
    request: { query: { scope: "cloud:access", resource: "https://simpli-invoice-mcp-dev.simplitica.co/mcp" } },
    secrets: { CLOUD_CONNECTION_LOOKUP_TOKEN: secret }, ...overrides,
  };
  // Deliberately provide no refreshToken/session/user metadata APIs.
  await exported.onExecutePostLogin!(event, { access: { deny: (value: string) => denied.push(value) }, accessToken: { setCustomClaim: (...values: unknown[]) => claims.push(values) } });
  expect(logs.join()).not.toContain("PRIVATE");
  expect(logs.join()).not.toContain(secret);
  expect(logs.join()).not.toContain(namespace);
  return { claims, denied, logs };
}
async function denial(handler: Handler, overrides: Record<string, unknown> = {}) {
  const server = await fixture(handler);
  try {
    const result = await execute(server, overrides);
    expect(result.claims).toEqual([]);
    expect(result.denied).toEqual(["Development cloud connection unavailable"]);
    return server.calls;
  } finally { await server.close(); }
}

it("issues coherent epoch and namespace from real HTTP only on initial cloud authorization", async () => {
  const server = await fixture(json);
  try {
    const result = await execute(server);
    expect(result.denied).toEqual([]);
    expect(result.claims).toEqual([[epochClaim, 7], [namespaceClaim, namespace], [appleClaim, appleIdentity]]);
    expect(server.targets).toEqual([hookURL]);
    expect(server.requests).toEqual([{ url: "/api/internal/oauth/connection-epoch", authorization: `Bearer ${secret}`, body: JSON.stringify({ appleIdentity }) }]);
  } finally { await server.close(); }
});

it.each(["oauth2-refresh-token", undefined, "", "unknown", "oidc-implicit-profile", "OIDC-BASIC-PROFILE"])("denies MCP protocol %j regardless of scopes, without any lookup", async protocol => {
  const server = await fixture(json);
  try {
    for (const request of [undefined, { query: {} }, { body: { scope: "cloud:access", refresh_token: "PRIVATE-refresh" } }, { query: { scope: "cloud:access" } }, { query: { scope: "probe:read" } }]) {
      const result = await execute(server, { transaction: protocol === undefined ? undefined : { protocol }, request });
      expect(result.denied).toEqual(["Development MCP authorization-code flow required"]);
      expect(result.claims).toEqual([]);
    }
    expect(server.calls).toBe(0);
  } finally { await server.close(); }
});

it("retains synthetic initial probe authorization without hook credentials or lookup", async () => {
  const server = await fixture(json);
  try {
    const result = await execute(server, { secrets: undefined, transaction: { protocol: "oidc-basic-profile", requested_scopes: ["probe:read"] }, request: { query: { scope: "probe:read" } } });
    expect(result.denied).toEqual([]);
    expect(result.claims).toEqual([[appleClaim, appleIdentity]]);
    expect(server.calls).toBe(0);
  } finally { await server.close(); }
});

it("recognizes trusted transaction cloud scope when the query omits scope", async () => {
  const server = await fixture(json);
  try {
    const result = await execute(server, { request: { query: {} } });
    expect(result.denied).toEqual([]);
    expect(result.claims).toContainEqual([epochClaim, 7]);
    expect(server.calls).toBe(1);
  } finally { await server.close(); }
});

it.each([
  { client: { client_id: "unrelated" } },
  { resource_server: { identifier: "https://other.test/mcp" } },
  { connection: { strategy: "google-oauth2" } },
  { user: { identities: [{ provider: "apple", user_id: "\ud800" }] } },
  { user: { identities: [{ provider: "apple", user_id: "x".repeat(1025) }] } },
  { user: { identities: [{ provider: "apple", user_id: "owner" }, { provider: "apple", user_id: "other" }] } },
])("does not look up or issue claims for an unrelated/invalid cloud context %j", async overrides => {
  const server = await fixture(json);
  try { const result = await execute(server, overrides); expect(result.claims).toEqual([]); expect(server.calls).toBe(0); }
  finally { await server.close(); }
});

it.each(["\ufffd", "😀", " apple|雪\u0000 ", "😀".repeat(512)])("sends opaque well-formed identity %j without normalization", async value => {
  const server = await fixture(json);
  try {
    const result = await execute(server, { user: { identities: [{ provider: "apple", user_id: value }] } });
    expect(result.denied).toEqual([]);
    expect(JSON.parse(server.requests[0]!.body)).toEqual({ appleIdentity: value });
    expect(result.claims).toContainEqual([appleClaim, value]);
  } finally { await server.close(); }
});

it.each([undefined, {}, { CLOUD_CONNECTION_LOOKUP_TOKEN: "private-invalid" }, { CLOUD_CONNECTION_LOOKUP_TOKEN: "A".repeat(42) + "B" }])("fails closed on missing or malformed service credential %j", async secrets => {
  expect(await denial(json, { secrets })).toBe(0);
});

it.each([
  { active: false }, { active: false, epoch: 7, namespace }, {}, null, [],
  { active: true, epoch: 0, namespace }, { active: true, epoch: -1, namespace },
  { active: true, epoch: 1.5, namespace }, { active: true, epoch: "7", namespace },
  { active: true, epoch: Number.MAX_SAFE_INTEGER + 1, namespace },
  { active: true, epoch: 7 }, { active: true, epoch: 7, namespace: "A".repeat(42) + "B" },
  { active: true, epoch: 7, namespace, appleIdentity },
])("denies inactive or incoherent hook result %j", async body => {
  expect(await denial((_req, res) => { res.end(JSON.stringify(body)); })).toBe(1);
});

it.each([400, 401, 503])("denies hook status %s with no claims or response detail logs", async status => {
  expect(await denial((_req, res) => { res.statusCode = status; res.end("PRIVATE-provider-body"); })).toBe(1);
});

it("does not follow redirects carrying the lookup credential", async () => {
  expect(await denial((_req, res) => { res.statusCode = 302; res.setHeader("Location", "/redirected"); res.end(); })).toBe(1);
});

it("caps bytes even for streamed or misleadingly sized responses", async () => {
  for (const handler of [
    ((_req, res) => { res.setHeader("Content-Length", "1025"); res.end(" ".repeat(1025)); }) as Handler,
    ((_req, res) => { res.write(JSON.stringify(coherent)); res.end(" ".repeat(1025)); }) as Handler,
    ((_req, res) => { res.end("{" + "😀".repeat(300)); }) as Handler,
    ((_req, res) => { res.end(Buffer.from([0xff])); }) as Handler,
  ]) expect(await denial(handler)).toBe(1);
});

it("accepts the exact 1024-byte response boundary", async () => {
  const server = await fixture((_req, res) => { res.end(JSON.stringify(coherent).padEnd(1024)); });
  try { expect((await execute(server)).denied).toEqual([]); }
  finally { await server.close(); }
});

it.each(["headers", "body", "combined"])("bounds total fetch/read time for stalled %s to two seconds", async stage => {
  const timers: ReturnType<typeof setTimeout>[] = [];
  const started = Date.now();
  try {
    expect(await denial((_req, res) => {
      if (stage === "body") { res.writeHead(200); res.write("{"); }
      if (stage === "combined") timers.push(setTimeout(() => { if (!res.destroyed) { res.writeHead(200); res.write("{"); } }, 1200));
      timers.push(setTimeout(() => { if (!res.destroyed) res.end(JSON.stringify(coherent)); }, 4000));
    })).toBe(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
    expect(Date.now() - started).toBeLessThan(3000);
  } finally { timers.forEach(clearTimeout); }
});
