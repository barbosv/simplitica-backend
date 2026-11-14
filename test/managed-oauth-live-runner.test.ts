import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { authorizationURL, callbackReceiver, checkRotation, checkRevocation, InvalidGrantError, tokenClient, verifyAccessToken, type TokenPair } from "../scripts/qualification/managed-oauth.js";

it("requests only the fixed development resource and API scopes using S256", () => {
  const verifier = "a".repeat(64);
  const url = authorizationURL("http://127.0.0.1:8792/callback", "synthetic-state", verifier);
  expect(url.origin + url.pathname).toBe("https://dev-i8usug5fp48kepvr.us.auth0.com/authorize");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    client_id: "tpc_5RjUULWf1V9koMnfWj1Xg3", response_type: "code",
    redirect_uri: "http://127.0.0.1:8792/callback", state: "synthetic-state",
    scope: "probe:read offline_access", resource: "https://simpli-invoice-mcp-dev.simplitica.co/mcp",
    code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    connection: "apple",
  });
});

it.each(["https://other.test/callback", "http://0.0.0.0:8792/callback", "http://127.0.0.1:8792/other"])(
  "rejects a callback outside the dedicated loopback receiver: %s", redirect => {
    expect(() => authorizationURL(redirect, "state", "a".repeat(64))).toThrow();
  });

it("rejects wrong state, duplicate fields, methods and paths without consuming the valid callback", async () => {
  const receiver = await callbackReceiver("correct-state", 2000, 0);
  void receiver.code.catch(() => undefined);
  try {
    expect((await fetch(receiver.redirect + "?state=wrong&code=private")).status).toBe(400);
    expect((await fetch(receiver.redirect + "?state=correct-state&state=wrong&code=private")).status).toBe(400);
    expect((await fetch(receiver.redirect + "?state=correct-state&code=a&code=b")).status).toBe(400);
    expect((await fetch(receiver.redirect + "?state=correct-state&code=private", { method: "POST" })).status).toBe(405);
    expect((await fetch(receiver.redirect.replace("/callback", "/other") + "?state=correct-state&code=private")).status).toBe(404);
    const response = await fetch(receiver.redirect + "?state=correct-state&code=private");
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("private");
    expect(await receiver.code).toBe("private");
    expect((await fetch(receiver.redirect + "?state=correct-state&code=replayed")).status).toBe(409);
  } finally { await receiver.close(); }
});

it("times out a missing callback without exposing authorization parameters", async () => {
  const receiver = await callbackReceiver("private-state", 15, 0);
  try { await expect(receiver.code).rejects.toThrow("callback_timeout"); }
  finally { await receiver.close(); }
});

it("rejects malformed raw HTTP targets without crashing or leaking a code, then accepts a valid callback", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { callbackReceiver } from './scripts/qualification/managed-oauth.ts';
    import { connect } from 'node:net';
    const receiver = await callbackReceiver('correct-state', 2000, 0);
    const port = new URL(receiver.redirect).port;
    let response = '';
    const socket = connect(Number(port), '127.0.0.1');
    await new Promise((resolve, reject) => {
      socket.on('error', reject);
      socket.on('data', chunk => response += chunk);
      socket.on('close', resolve);
      socket.on('connect', () => socket.write('GET http://[?code=SYNTHETIC-PRIVATE-CODE HTTP/1.1\\r\\nHost: 127.0.0.1:' + port + '\\r\\nConnection: close\\r\\n\\r\\n'));
    });
    const valid = await fetch(receiver.redirect + '?state=correct-state&code=valid-code');
    console.log(JSON.stringify({ rejected: response.startsWith('HTTP/1.1 400'), validStatus: valid.status,
      accepted: (await receiver.code) === 'valid-code' }));
    await receiver.close();
  `], { encoding: "utf8", timeout: 4000 });
  expect(result.status).toBe(0);
  expect(result.stderr).not.toContain("SYNTHETIC-PRIVATE-CODE");
  expect(JSON.parse(result.stdout)).toEqual({ rejected: true, validStatus: 200, accepted: true });
});

// Real HTTP issuer fixture: one rotating family, replay detection and revocation.
async function issuerScenario(behavior: "rotate" | "reuse" | "accept-replay" | "identity-change" = "rotate") {
  let current = "r0", familyValid = true;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const token = new URLSearchParams(Buffer.concat(chunks).toString()).get("refresh_token");
    if (request.url === "/revoke") { familyValid = false; response.end(); return; }
    response.setHeader("Content-Type", "application/json");
    if (!familyValid || (token !== current && behavior !== "accept-replay")) {
      familyValid = false; response.statusCode = 400; response.end(JSON.stringify({ error: "invalid_grant" })); return;
    }
    if (behavior !== "reuse") current = "r" + (Number(current.slice(1)) + 1);
    response.end(JSON.stringify({ accessToken: behavior === "identity-change" ? "changed-identity" : "valid-identity", refreshToken: current }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture failed");
  const post = async (path: string, token: string) => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method: "POST", body: new URLSearchParams({ refresh_token: token }),
  });
  const client = {
    async refresh(token: string): Promise<TokenPair> {
      const response = await post("/token", token);
      if (!response.ok) throw new InvalidGrantError();
      return response.json() as Promise<TokenPair>;
    },
    async revoke(token: string) { await post("/revoke", token); },
  };
  return { client, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); } };
}

const initialPair = { accessToken: "valid-identity", refreshToken: "r0" };
const verifyIdentity = async (token: string) => token;

it("proves refresh rotation, old-token denial and token-family invalidation", async () => {
  const fixture = await issuerScenario();
  try { await expect(checkRotation(fixture.client, initialPair, verifyIdentity)).resolves.toBeUndefined(); }
  finally { await fixture.close(); }
});

it.each(["reuse", "accept-replay", "identity-change"] as const)("rejects provider behavior %s", async behavior => {
  const fixture = await issuerScenario(behavior);
  try { await expect(checkRotation(fixture.client, initialPair, verifyIdentity)).rejects.toThrow(); }
  finally { await fixture.close(); }
});

it("proves refresh denial after revoking a previously usable token", async () => {
  const fixture = await issuerScenario();
  try { await expect(checkRevocation(fixture.client, initialPair, verifyIdentity)).resolves.toBeUndefined(); }
  finally { await fixture.close(); }
});

it("requires a signed exact development JWT and keeps its Apple identity private", async () => {
  const keys = await generateKeyPair("RS256");
  const base = { iss: "https://dev-i8usug5fp48kepvr.us.auth0.com/", aud: "https://simpli-invoice-mcp-dev.simplitica.co/mcp",
    sub: "synthetic-subject", azp: "tpc_5RjUULWf1V9koMnfWj1Xg3", scope: "probe:read offline_access",
    "https://simplitica.co/apple_identity": "private-opaque-identity", exp: Math.floor(Date.now()/1000)+120 };
  const sign = (overrides = {}) => new SignJWT({...base,...overrides}).setProtectedHeader({alg:"RS256"}).sign(keys.privateKey);
  const verifyKeys = async () => keys.publicKey;
  await expect(verifyAccessToken(await sign(), verifyKeys)).resolves.toBe("private-opaque-identity");
  for (const input of [{iss:"https://other.test/"},{aud:"other"},{azp:"other"},{scope:"offline_access"},
    {exp:1},{sub:""},{"https://simplitica.co/apple_identity":""}]) {
    await expect(verifyAccessToken(await sign(input), verifyKeys)).rejects.toThrow();
  }
  const otherKeys = await generateKeyPair("RS256");
  await expect(verifyAccessToken(await sign(), async()=>otherKeys.publicKey)).rejects.toThrow();
});

it("sends confidential-client form requests and sanitizes provider failures", async () => {
  const server = createServer(async(request,response)=>{
    const chunks:Buffer[]=[];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = new URLSearchParams(Buffer.concat(chunks).toString());
    response.setHeader("Content-Type","application/json");
    if (request.method!=="POST" || !String(request.headers["content-type"]).startsWith("application/x-www-form-urlencoded")
      || body.get("client_id")!=="tpc_5RjUULWf1V9koMnfWj1Xg3" || body.get("client_secret")!=="private-secret") {
      response.statusCode=400; response.end(JSON.stringify({error:"invalid_client",error_description:"private-secret"}));return;
    }
    if(request.url==="/oauth/revoke") {response.end("{}");return;}
    if(body.get("refresh_token")==="old") {response.statusCode=400;response.end(JSON.stringify({error:"invalid_grant",error_description:"private-token"}));return;}
    if(body.get("resource")!=="https://simpli-invoice-mcp-dev.simplitica.co/mcp"
      || (body.get("grant_type")==="authorization_code" && (body.get("code")!=="private-code" || body.get("code_verifier")!=="private-verifier" || body.get("redirect_uri")!=="http://127.0.0.1:8792/callback"))) {
      response.statusCode=400;response.end(JSON.stringify({error:"invalid_request"}));return;
    }
    response.end(JSON.stringify({access_token:"access",refresh_token:"refresh",token_type:"Bearer"}));
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address();if(!address||typeof address==="string")throw new Error("fixture failed");
  const transport:typeof fetch = (input,init)=>fetch(`http://127.0.0.1:${address.port}${new URL(String(input)).pathname}`,init);
  try {
    const client = tokenClient("private-secret",transport);
    await expect(client.exchange("private-code","private-verifier","http://127.0.0.1:8792/callback")).resolves.toEqual({accessToken:"access",refreshToken:"refresh"});
    await expect(client.refresh("current")).resolves.toEqual({accessToken:"access",refreshToken:"refresh"});
    await expect(client.refresh("old")).rejects.toBeInstanceOf(InvalidGrantError);
    await expect(client.revoke("current")).resolves.toBeUndefined();
    await expect(tokenClient("wrong",transport).refresh("current")).rejects.toThrow("provider_request_failed");
  } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
