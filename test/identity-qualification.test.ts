import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { generateKeyPair, SignJWT } from "jose";
import { expect, it } from "vitest";
import { qualifyIdentity, type IdentityProgress, type IdentityReceivers } from "../scripts/qualification/identity-qualification.js";
import { tokenClient } from "../scripts/qualification/managed-oauth.js";
import { nativeProofReceiver } from "../scripts/qualification/native-proof.js";
import { qualificationFailureReason } from "../scripts/qualification/runner-support.js";

async function fixture(options: { nativeMismatch?: boolean; invalidHosted?: boolean; revokeFailure?: boolean; exchangeFailure?: boolean } = {}) {
  const keys = await generateKeyPair("RS256");
  const claim = "https://simplitica.co/apple_identity";
  const hosted = await new SignJWT({ iss: "https://dev-i8usug5fp48kepvr.us.auth0.com/",
    aud: options.invalidHosted ? "other-audience" : "https://simpli-invoice-mcp-dev.simplitica.co/mcp",
    sub: "synthetic-hosted", azp: "tpc_5RjUULWf1V9koMnfWj1Xg3", scope: "probe:read offline_access",
    [claim]: "synthetic-private-identity" }).setProtectedHeader({ alg: "RS256" }).setExpirationTime("2m").sign(keys.privateKey);
  const native = await new SignJWT({ iss: "https://dev-i8usug5fp48kepvr.us.auth0.com/",
    aud: "https://simpli-invoice-native-dev.simplitica.co/api", sub: "synthetic-native",
    azp: "WXTblf8z8B9kGNaX9QgR6dUzexXT5Ixa", scope: "qualification:read",
    [claim]: options.nativeMismatch ? "different-private-identity" : "synthetic-private-identity" })
    .setProtectedHeader({ alg: "RS256" }).setExpirationTime("2m").sign(keys.privateKey);
  const requests: { path: string; fields: Record<string, string> }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const fields = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
    requests.push({ path: request.url!, fields });
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/oauth/revoke") {
      response.statusCode = options.revokeFailure ? 500 : 200;
      response.end(JSON.stringify(options.revokeFailure ? { error_description: "synthetic-private-secret" } : {}));
    } else if (options.exchangeFailure) {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: "invalid_grant", error_description: "synthetic-private-code" }));
    } else {
      response.end(JSON.stringify({ access_token: hosted, refresh_token: "synthetic-private-refresh", token_type: "Bearer" }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_address");
  const client = tokenClient("synthetic-private-secret", (input, init) =>
    fetch(`http://127.0.0.1:${address.port}${new URL(String(input)).pathname}`, init));
  let callbackClosed = false, nativeClosed = false, nativeStarted = false;
  let nativeResponse: Promise<Response> | undefined;
  const events: IdentityProgress[] = [];
  const receivers: IdentityReceivers = {
    callback: async () => ({ redirect: "http://127.0.0.1:8792/callback", code: Promise.resolve("synthetic-private-code"),
      close: async () => { callbackClosed = true; } }),
    native: async (hostedIdentity, verify) => {
      nativeStarted = true;
      const receiver = await nativeProofReceiver(hostedIdentity, verify, options.nativeMismatch ? 500 : 2000, 0);
      return { ...receiver, close: async () => { nativeClosed = true; await receiver.close(); } };
    },
  };
  const report = (event: IdentityProgress) => {
    events.push(event);
    if (event.status === "awaiting_native_proof") {
      nativeResponse = fetch(event.endpoint, { method: "POST", headers: { authorization: `Bearer ${native}` } });
    }
  };
  return { client, keys: async () => keys.publicKey, report, receivers, requests, events,
    get callbackClosed() { return callbackClosed; }, get nativeClosed() { return nativeClosed; },
    get nativeStarted() { return nativeStarted; }, get nativeResponse() { return nativeResponse; },
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

it("performs one S256 hosted exchange, strictly verifies both signed tokens, and reports identity proof only", async () => {
  const f = await fixture();
  try {
    const result = await qualifyIdentity(f.client, f.keys, f.report, f.receivers);
    expect(result).toEqual({ status: "passed", environment: "development", mode: "identity-only",
      checks: ["signed-token", "native-hosted-identity-continuity"], lifecycleChecks: "not-run" });
    expect((await f.nativeResponse)?.status).toBe(200);
    expect(f.requests.map(request => request.path)).toEqual(["/oauth/token", "/oauth/revoke"]);
    const authorization = new URL((f.events[0] as Extract<IdentityProgress, { status: "awaiting_authorization" }>).authorizationURL);
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("code_challenge")).toBe(createHash("sha256").update(f.requests[0].fields.code_verifier).digest("base64url"));
    expect(f.requests[0].fields.grant_type).toBe("authorization_code");
    expect(f.requests[1].fields.token).toBe("synthetic-private-refresh");
    expect(f.callbackClosed).toBe(true);
    expect(f.nativeClosed).toBe(true);
    expect(JSON.stringify([result, f.events])).not.toContain("synthetic-private");
  } finally { await f.close(); }
});

it("revokes the hosted refresh and closes both receivers when native identity proof fails", async () => {
  const f = await fixture({ nativeMismatch: true });
  try {
    await expect(qualifyIdentity(f.client, f.keys, f.report, f.receivers)).rejects.toThrow("native_proof_timeout");
    expect((await f.nativeResponse)?.status).toBe(403);
    expect(f.requests.map(request => request.path)).toEqual(["/oauth/token", "/oauth/revoke"]);
    expect(f.requests[1].fields.token).toBe("synthetic-private-refresh");
    expect(f.callbackClosed).toBe(true);
    expect(f.nativeClosed).toBe(true);
  } finally { await f.close(); }
});

it("revokes the hosted refresh when its signed token fails the fixed audience verification", async () => {
  const f = await fixture({ invalidHosted: true });
  try {
    await expect(qualifyIdentity(f.client, f.keys, f.report, f.receivers)).rejects.toThrow("access_token_verification_failed");
    expect(f.nativeStarted).toBe(false);
    expect(f.requests.map(request => request.path)).toEqual(["/oauth/token", "/oauth/revoke"]);
    expect(f.callbackClosed).toBe(true);
  } finally { await f.close(); }
});

it("does not claim success when hosted refresh cleanup fails and never exposes provider details", async () => {
  const f = await fixture({ revokeFailure: true });
  try {
    try {
      await qualifyIdentity(f.client, f.keys, f.report, f.receivers);
      expect.fail("Cleanup failure must fail the focused run");
    } catch (error) {
      expect(qualificationFailureReason(error)).toBe("provider_request_failed");
      expect(String(error)).not.toContain("synthetic-private");
    }
    expect(f.callbackClosed).toBe(true);
    expect(f.nativeClosed).toBe(true);
  } finally { await f.close(); }
});

it("closes the hosted receiver without a fake revocation claim when no token pair was obtained", async () => {
  const f = await fixture({ exchangeFailure: true });
  try {
    await expect(qualifyIdentity(f.client, f.keys, f.report, f.receivers)).rejects.toThrow("provider_invalid_grant");
    expect(f.requests.map(request => request.path)).toEqual(["/oauth/token"]);
    expect(f.callbackClosed).toBe(true);
    expect(f.nativeStarted).toBe(false);
  } finally { await f.close(); }
});
