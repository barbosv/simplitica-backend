import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { env as workerEnv } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { createCloudAccountRepository } from "../../src/chatgpt/accounts/d1.js";
import { CloudConnectionError, createCloudConnectionRepository } from "../../src/chatgpt/accounts/connections.js";
import { createCloudTokenAuthorizer } from "../../src/chatgpt/auth/cloud-token.js";
import { createEpochHook } from "../../src/chatgpt/auth/epoch-hook.js";

const env = workerEnv as {
  DB: D1Database;
  TEST_MIGRATIONS: import("@cloudflare/vitest-plugin").D1Migration[];
  TEST_CLOUD_MIGRATIONS: import("@cloudflare/vitest-plugin").D1Migration[];
};
// Independent, immutable issuer fixtures: never fetch the current D1 epoch to
// manufacture authority for a previously issued token.
const issuer = "https://dev-i8usug5fp48kepvr.us.auth0.com/";
const audience = "https://simpli-invoice-mcp-dev.simplitica.co/mcp";
const clientId = "tpc_5RjUULWf1V9koMnfWj1Xg3";
const appleClaim = "https://simplitica.co/apple_identity";
const epochClaim = "https://simplitica.co/connection_epoch";
const namespaceClaim = "https://simplitica.co/authorization_namespace";
// Synthetic, explicit out-of-D1 configuration, independent of token contents.
const authorizationNamespace = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const restoredNamespace = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
const now = 1_800_000_010_000;
const identity = { issuer, appleIdentity: "apple|owner" };
const command = () => ({ identity: { ...identity }, clientId, deviceKeyId: "device", now: now - 10_000, expectedRevision: 0 });
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let otherKeys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: { keys: import("jose").JWK[] };
let resolveKey: JWTVerifyGetKey;
beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  otherKeys = await generateKeyPair("RS256");
  jwks = { keys: [{ ...await exportJWK(keys.publicKey), kid: "test-key", alg: "RS256", use: "sig" }] };
  resolveKey = createLocalJWKSet(jwks);
});
beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await applyD1Migrations(env.DB, env.TEST_CLOUD_MIGRATIONS);
  for (const table of ["cloud_connections", "cloud_enrollment_commits", "cloud_purchase_lineages", "cloud_devices", "cloud_businesses", "cloud_identities", "cloud_owners", "cloud_enrollment_challenges", "cloud_batch_guards"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});
async function active(appleIdentity = identity.appleIdentity, approvalNow = command().now) {
  const context = { ...command(), now: approvalNow, identity: { issuer, appleIdentity } };
  const accounts = createCloudAccountRepository(env.DB);
  const challengeHash = "1".repeat(64);
  await accounts.issueChallenge({ ...context, challengeHash, expiresAt: context.now + 1000 });
  const enrolled = await accounts.commitEnrollment({ challengeHash, now: context.now, evidence: {
    identity: context.identity, deviceKeyId: "device", purchase: { appSlug: "simpli-invoice", environment: "Sandbox", originalTransactionId: "lineage" },
  } });
  await createCloudConnectionRepository(env.DB).approve(context);
  return { ownerId: enrolled.ownerId, businessId: enrolled.businessId, connectionEpoch: 1, authorizationNamespace };
}
async function token(patch: JWTPayload = {}, signingKey = keys.privateKey, alg = "RS256", header: Record<string, unknown> = {}) {
  return new SignJWT({ iss: issuer, aud: audience, azp: clientId, sub: "auth0|subject", scope: "cloud:access",
    iat: 1_800_000_001, exp: 1_800_000_100, [appleClaim]: identity.appleIdentity, [epochClaim]: 1, [namespaceClaim]: authorizationNamespace, ...patch,
  }).setProtectedHeader({ alg, kid: "test-key", ...header }).sign(signingKey);
}
const authorize = (db = env.DB, clock = () => now, keys: JWTVerifyGetKey = resolveKey) => createCloudTokenAuthorizer(db, { authorizationNamespace, keys, now: clock });

it("accepts a real RS256 current signed epoch through real D1", async () => {
  const owner = await active();
  expect(await authorize()(await token())).toEqual(owner);
  expect(await authorize()(await token({ scope: "openid cloud:access profile", aud: [audience, `${issuer}userinfo`] }))).toEqual(owner);
});

it.each([false, true])("admits same-second private-hook issuance repeatedly despite an elevated legacy fence: %j", async (elevatedFence) => {
  const owner = await active(identity.appleIdentity, elevatedFence ? now + 60_100 : now + 100);
  const repo = createCloudConnectionRepository(env.DB);
  if (elevatedFence) {
    await repo.revoke({ ...command(), expectedRevision: 1, now: now + 60_200 });
    await repo.approve({ ...command(), expectedRevision: 2, now: now + 100 });
  }
  // Fresh initial authorization captures the hook's coherent pair after native
  // approval. This lookup never supplies authority to any previously issued JWT.
  const secret = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI";
  const hook = createEpochHook(env.DB, secret, authorizationNamespace);
  const response = await hook.request("https://simpli-invoice-native-dev.simplitica.co/api/internal/oauth/connection-epoch", {
    method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ appleIdentity: identity.appleIdentity }),
  });
  expect(response.status).toBe(200);
  const issued = await response.json() as { active: true; epoch: number; namespace: string };
  expect(issued).toEqual({ active: true, epoch: elevatedFence ? 3 : 1, namespace: authorizationNamespace });
  const bearer = await token({ iat: 1_800_000_010, [epochClaim]: issued.epoch, [namespaceClaim]: issued.namespace });
  const expected = { ...owner, connectionEpoch: elevatedFence ? 3 : 1 };
  // Approval .100, lookup/signing/admission .200: all protocol timestamps are
  // within the same second. The exact bearer must remain usable afterward.
  for (const admissionNow of [now + 200, now + 999, now + 1000, now + 89_999]) {
    expect(await authorize(env.DB, () => admissionNow)(bearer)).toEqual(expected);
  }
  expect(await authorize(env.DB, () => now + 90_000)(bearer)).toBeNull();
  await repo.revoke({ ...command(), expectedRevision: issued.epoch, now: now + 200 });
  expect(await authorize(env.DB, () => now + 200)(bearer)).toBeNull();
});

const invalidClaims: [string, JWTPayload][] = [
  ["issuer", { iss: "https://wrong.example/" }], ["audience", { aud: `${audience}-other` }],
  ["client", { azp: "another-client" }], ["missing client", { azp: undefined }],
  ["missing subject", { sub: undefined }], ["empty subject", { sub: "" }], ["malformed subject", { sub: "\ud800" }],
  ["missing exp", { exp: undefined }], ["expired", { exp: 1_800_000_010 }], ["future nbf", { nbf: 1_800_000_011 }],
  ["missing iat", { iat: undefined }], ["future iat", { iat: 1_800_000_011 }], ["negative iat", { iat: -1 }],
  ["fractional iat", { iat: 1_800_000_001.5 }], ["unsafe iat", { iat: Number.MAX_SAFE_INTEGER + 1 }],
  ["missing scope", { scope: undefined }], ["near scope", { scope: "cloud:accessor" }], ["scope array", { scope: ["cloud:access"] }],
  ["missing Apple identity", { [appleClaim]: undefined }], ["empty Apple identity", { [appleClaim]: "" }],
  ["non-string Apple identity", { [appleClaim]: ["apple|owner"] }], ["oversize Apple identity", { [appleClaim]: "x".repeat(1025) }],
  ["high surrogate", { [appleClaim]: "\ud800" }], ["low surrogate", { [appleClaim]: "\udfff" }],
  ["embedded surrogate", { [appleClaim]: "before\ud800after" }],
  ...[undefined, null, "1", true, {}, [], 0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1].map((value, index): [string, JWTPayload] => [`malformed epoch ${index}`, { [epochClaim]: value }]),
];
it.each(invalidClaims)("denies signed %s before D1", async (_name, patch) => {
  // An unavailable binding turns accidental DB admission into a thrown storage
  // failure; valid cryptographic verification remains real in every case.
  expect(await authorize(null as never)(await token(patch))).toBeNull();
});

it("denies another signed owner even with the active epoch", async () => {
  await active();
  expect(await authorize()(await token({ [appleClaim]: "other-owner" }))).toBeNull();
});

it("denies payload tampering and invalid signatures before D1", async () => {
  const signed = await token();
  const parts = signed.split(".");
  parts[1] = btoa(JSON.stringify({ iss: issuer, aud: audience, azp: clientId, sub: "auth0|subject", scope: "cloud:access", iat: 1_800_000_001, exp: 1_800_000_100, [appleClaim]: identity.appleIdentity, [epochClaim]: 3, [namespaceClaim]: authorizationNamespace })).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  expect(await authorize(null as never)(parts.join("."))).toBeNull();
  expect(await authorize(null as never)(await token({}, otherKeys.privateKey))).toBeNull();
});

it("rejects another algorithm even with a matching key and otherwise valid signed claims", async () => {
  const alternate = await generateKeyPair("ES256");
  const alternateResolver = createLocalJWKSet({ keys: [{ ...await exportJWK(alternate.publicKey), alg: "ES256", kid: "test-key" }] });
  const bearer = await token({}, alternate.privateKey, "ES256");
  expect((await jwtVerify(bearer, alternateResolver, { currentDate: new Date(now), algorithms: ["ES256"] })).payload[epochClaim]).toBe(1);
  expect(await authorize(null as never, () => now, alternateResolver)(bearer)).toBeNull();
  const unsigned = `${btoa('{"alg":"none"}').replace(/=/g, "")}.${(await token()).split(".")[1]}.`;
  expect(await authorize(null as never)(unsigned)).toBeNull();
});

it("never upgrades an old epoch after disconnect/reconnect despite delayed signing or a later iat", async () => {
  const owner = await active();
  const repo = createCloudConnectionRepository(env.DB);
  const originallyIssued = await token();
  await repo.revoke({ ...command(), expectedRevision: 1, now: now - 5000 });
  const disconnected = await token({ [epochClaim]: 2, iat: 1_800_000_008 });
  expect(await authorize()(originallyIssued)).toBeNull();
  expect(await authorize()(disconnected)).toBeNull();
  await repo.approve({ ...command(), expectedRevision: 2, now: now - 20_000 });
  expect(await authorize()(originallyIssued)).toBeNull();
  expect(await authorize()(disconnected)).toBeNull();
  expect(await authorize()(await token({ iat: 1_800_000_009 }))).toBeNull();
  expect(await authorize()(await token({ [epochClaim]: undefined, iat: 1_800_000_009 }))).toBeNull();
  expect(await authorize()(await token({ [epochClaim]: 3, iat: 1_800_000_006 }))).toEqual({ ...owner, connectionEpoch: 3 });
  expect(await authorize()(await token({ [epochClaim]: 3, iat: 1_800_000_005 }))).toEqual({ ...owner, connectionEpoch: 3 });
});

it("device revocation denies both issuer lookup and signed token admission", async () => {
  await active();
  const bearer = await token();
  const repo = createCloudConnectionRepository(env.DB);
  expect(await repo.getActiveEpoch(command())).toBe(1);
  await env.DB.prepare("UPDATE cloud_devices SET status = 'revoked' WHERE device_key_id = 'device'").run();
  expect(await repo.getActiveEpoch(command())).toBeNull();
  expect(await authorize()(bearer)).toBeNull();
});

it.each(["\ufffd", "😀", " apple|雪\u0000 ", "😀".repeat(512)])("preserves well-formed opaque identity %j exactly", async (appleIdentity) => {
  const owner = await active(appleIdentity);
  expect(await authorize()(await token({ [appleClaim]: appleIdentity }))).toEqual(owner);
  expect(await authorize()(await token({ [appleClaim]: `${appleIdentity}x` }))).toBeNull();
});

it.each([undefined, null, 42, "", "a.b.c", "x".repeat(12001)])("denies malformed runtime token %j before D1", async (bearer) => {
  expect(await authorize(null as never)(bearer as string)).toBeNull();
});

it("bounds a cryptographically valid oversized token before D1", async () => {
  await active();
  const bearer = await token({ filler: "x".repeat(9000) });
  expect(bearer.length).toBeGreaterThan(12000);
  expect(await authorize()(bearer)).toBeNull();
});

it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1])("denies invalid trusted clock value %j before D1", async (value) => {
  expect(await authorize(null as never, () => value)(await token())).toBeNull();
});

it("sanitizes actual D1 failure after successful signature and claims verification", async () => {
  await active();
  await env.DB.prepare("ALTER TABLE cloud_connections RENAME TO unavailable_connections").run();
  try {
    const failure = await authorize()(await token()).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(CloudConnectionError);
    expect(failure).toMatchObject({ code: "storage_unavailable", message: "storage_unavailable" });
    expect(failure).not.toHaveProperty("cause");
  } finally {
    await env.DB.prepare("ALTER TABLE unavailable_connections RENAME TO cloud_connections").run();
  }
});

it("sanitizes key resolver operational failures without reaching D1", async () => {
  const failing: JWTVerifyGetKey = async () => { throw new Error("private-provider-detail"); };
  expect(await authorize(null as never, () => now, failing)(await token())).toBeNull();
});

it("uses the fixed issuer JWKS anew per admission and ignores token jku", async () => {
  const owner = await active();
  const rotated = { keys: [{ ...await exportJWK(otherKeys.publicKey), kid: "test-key", alg: "RS256", use: "sig" }] };
  let calls = 0;
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    expect(String(input)).toBe(`${issuer}.well-known/jwks.json`);
    return Response.json(++calls === 1 ? jwks : rotated);
  });
  try {
    const verify = createCloudTokenAuthorizer(env.DB, { authorizationNamespace, now: () => now });
    expect(await verify(await token({}, keys.privateKey, "RS256", { jku: "https://untrusted.example/keys" }))).toEqual(owner);
    expect(await verify(await token({}, otherKeys.privateKey))).toEqual(owner);
    expect(await verify(await token())).toBeNull();
  } finally { fetcher.mockRestore(); }
});

it("bounds the default JWKS network request to two seconds and sanitizes failure", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("private-provider-timeout")), { once: true });
  }));
  try {
    const started = Date.now();
    expect(await createCloudTokenAuthorizer(null as never, { authorizationNamespace, now: () => now })(await token())).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
    expect(Date.now() - started).toBeLessThan(3000);
  } finally { fetcher.mockRestore(); }
});


it("rejects a pre-restore namespace despite the same active D1 epoch and accepts fresh namespace authority", async () => {
  const owner = await active();
  const oldToken = await token();
  expect(await authorize()(oldToken)).toMatchObject({ ownerId: owner.ownerId, businessId: owner.businessId, connectionEpoch: 1 });
  const restored = createCloudTokenAuthorizer(env.DB, { authorizationNamespace: restoredNamespace, keys: resolveKey, now: () => now });
  // The same D1 state models restoring/cloning a snapshot with revision 1.
  expect(await createCloudConnectionRepository(env.DB).getActiveEpoch(command())).toBe(1);
  expect(await restored(oldToken)).toBeNull();
  expect(await restored(await token({ [namespaceClaim]: restoredNamespace }))).toEqual({ ...owner, authorizationNamespace: restoredNamespace });
  expect(await restored(await token({ [namespaceClaim]: restoredNamespace, [epochClaim]: 2 }))).toBeNull();
  expect(await createCloudConnectionRepository(env.DB).getActiveEpoch(command())).toBe(1);
});

const invalidNamespaces = [undefined, null, 42, true, {}, [], "", "private-config-detail", "A".repeat(42), "A".repeat(44), "A".repeat(42) + "B", "A".repeat(42) + "=", "A".repeat(42) + "+", "A".repeat(42) + "/", "A".repeat(42) + "\ufffd"];
it.each(invalidNamespaces.map((value, index) => ({ value, index })))("rejects invalid trusted namespace configuration case $index before D1", ({ value }) => {
  let failure: unknown;
  try { createCloudTokenAuthorizer(null as never, { authorizationNamespace: value as string }); }
  catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toMatchObject({ code: "invalid_configuration", message: "invalid_configuration" });
  expect(failure).not.toHaveProperty("cause");
  expect(String(failure)).not.toContain("private-config-detail");
});

it.each([undefined, null, {}])("rejects omitted trusted namespace dependencies before D1 case %j", (dependencies) => {
  expect(() => createCloudTokenAuthorizer(null as never, dependencies as never)).toThrow("invalid_configuration");
});

it.each([...invalidNamespaces, restoredNamespace].map((value, index) => ({ value, index })))("denies signed missing, malformed or mismatched namespace case $index before D1", async ({ value }) => {
  expect(await authorize(null as never)(await token({ [namespaceClaim]: value }))).toBeNull();
});

it("rejects namespace tampering and a wrong signature before D1", async () => {
  const parts = (await token()).split(".");
  // Change only the payload's namespace; never re-sign the altered payload.
  const claims = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
  claims[namespaceClaim] = restoredNamespace;
  parts[1] = btoa(JSON.stringify(claims)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const restored = createCloudTokenAuthorizer(null as never, { authorizationNamespace: restoredNamespace, keys: resolveKey, now: () => now });
  expect(await restored(parts.join("."))).toBeNull();
  expect(await restored(await token({ [namespaceClaim]: restoredNamespace }, otherKeys.privateKey))).toBeNull();
});
