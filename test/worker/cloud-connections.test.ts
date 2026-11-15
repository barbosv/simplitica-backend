import { beforeEach, expect, it } from "vitest";
import { env as workerEnv } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { createCloudAccountRepository } from "../../src/chatgpt/accounts/d1.js";
import { CloudConnectionError, createCloudConnectionRepository } from "../../src/chatgpt/accounts/connections.js";
import type { VerifiedEnrollmentEvidence } from "../../src/chatgpt/accounts/types.js";
import { createD1Repositories } from "../../src/db/repositories/d1.js";

const env = workerEnv as {
  DB: D1Database;
  TEST_MIGRATIONS: import("@cloudflare/vitest-plugin").D1Migration[];
  TEST_CLOUD_MIGRATIONS: import("@cloudflare/vitest-plugin").D1Migration[];
};
const now = 1_800_000_000_123;
const identity = { issuer: "https://issuer.example/", appleIdentity: "apple|owner" };
const command = () => ({ identity: { ...identity }, deviceKeyId: "device", clientId: "chatgpt", now, expectedRevision: 0 });
const claims = () => ({ identity: { ...identity }, clientId: "chatgpt", connectionEpoch: 1, tokenIssuedAt: 1_800_000_001, now: now + 1000 });
const repo = () => createCloudConnectionRepository(env.DB);
const tables = ["cloud_connections", "cloud_enrollment_commits", "cloud_purchase_lineages", "cloud_devices", "cloud_businesses", "cloud_identities", "cloud_owners", "cloud_enrollment_challenges", "cloud_batch_guards"];
async function snapshot() {
  const existing = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
  const names = new Set(existing.results.map((r) => r.name));
  return Object.fromEntries(await Promise.all(tables.map(async (table) => [table, names.has(table) ? (await env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results : []])));
}
async function enroll(value = command(), key = 1) {
  const accounts = createCloudAccountRepository(env.DB);
  const challengeHash = key.toString(16).padStart(64, "0");
  const evidence: VerifiedEnrollmentEvidence = { identity: value.identity, deviceKeyId: value.deviceKeyId, purchase: { appSlug: "simpli-invoice", environment: "Sandbox", originalTransactionId: `lineage-${key}` } };
  await accounts.issueChallenge({ challengeHash, identity: value.identity, deviceKeyId: value.deviceKeyId, now, expiresAt: now + 300_000 });
  const { ownerId, businessId } = await accounts.commitEnrollment({ challengeHash, evidence, now });
  return { ownerId, businessId };
}
async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(CloudConnectionError);
  expect(error).toMatchObject({ code, message: code });
  expect(error).not.toHaveProperty("cause");
}
beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await applyD1Migrations(env.DB, env.TEST_CLOUD_MIGRATIONS);
  const state = await snapshot();
  for (const table of tables) if (state[table].length) await env.DB.prepare(`DELETE FROM ${table}`).run();
});

it("denies unknown identity and missing connection without creating authority", async () => {
  expect(await repo().authorize(claims())).toBeNull();
  await enroll();
  const before = await snapshot();
  expect(await repo().authorize(claims())).toBeNull();
  expect(await snapshot()).toEqual(before);
});

it("requires subsequent token issuance and persists one owner/client approval across instances", async () => {
  const owner = await enroll();
  await repo().approve(command());
  expect(await repo().authorize({ ...claims(), tokenIssuedAt: 1_800_000_000 })).toBeNull();
  expect(await repo().authorize(claims())).toEqual(owner);
  await repo().approve({ ...command(), expectedRevision: 1, now: now - 10_000 });
  expect(await repo().authorize({ ...claims(), tokenIssuedAt: 1_800_000_000 })).toBeNull();
  const state = await snapshot();
  expect(state.cloud_connections).toHaveLength(1);
  expect(state.cloud_connections[0]).toMatchObject({ owner_id: owner.ownerId, client_id: "chatgpt", approving_device_key_id: "device", status: "active", token_not_before: 1_800_000_001 });
  expect(state.cloud_batch_guards).toEqual([]);
});

it.each(["approve", "revoke"] as const)("%s requires an active device owned by this exact identity", async (method) => {
  const owner = await enroll();
  await repo().approve(command());
  const before = await snapshot();
  for (const value of [
    { ...command(), deviceKeyId: "missing" },
    { ...command(), identity: { ...identity, appleIdentity: "other" } },
    { ...command(), identity: { ...identity, issuer: "https://ISSUER.example/" } },
  ]) await expectCode(repo()[method](value), "device_denied");
  const other = { ...command(), identity: { ...identity, appleIdentity: "other" }, deviceKeyId: "other-device" };
  await enroll(other, 2);
  await expectCode(repo()[method]({ ...other, deviceKeyId: "device" }), "device_denied");
  await env.DB.prepare("UPDATE cloud_devices SET status = 'revoked' WHERE owner_id = ?").bind(owner.ownerId).run();
  const revokedState = await snapshot();
  await expectCode(repo()[method](command()), "device_denied");
  expect(await snapshot()).toEqual(revokedState);
  expect((await snapshot()).cloud_connections).toEqual(before.cloud_connections);
});

it("scopes revocation to owner and client while preserving native account data", async () => {
  await enroll();
  const other = { ...command(), identity: { ...identity, appleIdentity: "other" }, deviceKeyId: "other-device" };
  const otherOwner = await enroll(other, 2);
  await repo().approve(command());
  await repo().approve(other);
  const before = await snapshot();
  expect(await repo().authorize({ ...claims(), clientId: "other-client" })).toBeNull();
  await repo().revoke({ ...command(), clientId: "other-client" });
  const withOtherClient = await snapshot();
  expect(withOtherClient.cloud_connections).toHaveLength(3);
  expect(withOtherClient.cloud_connections[2]).toMatchObject({ client_id: "other-client", revision: 1, status: "revoked" });
  await repo().revoke({ ...command(), expectedRevision: 1, now: now + 2000 });
  expect(await repo().authorize(claims())).toBeNull();
  expect(await repo().authorize({ ...claims(), identity: other.identity })).toEqual(otherOwner);
  const after = await snapshot();
  for (const table of tables.filter((t) => t !== "cloud_connections")) expect(after[table]).toEqual(before[table]);
  expect(after.cloud_connections[1]).toEqual(before.cloud_connections[1]);
});

it("revokes idempotently and reconnects without reviving pre-disconnect tokens", async () => {
  const owner = await enroll();
  await repo().approve(command());
  expect(await repo().authorize(claims())).toEqual(owner);
  const disconnect = { ...command(), expectedRevision: 1, now: now + 2500 };
  await repo().revoke(disconnect);
  const before = await snapshot();
  await repo().revoke(disconnect);
  expect(await snapshot()).toEqual(before);
  expect(await repo().authorize({ ...claims(), now: now + 10_000 })).toBeNull();
  await repo().approve({ ...command(), expectedRevision: 2, now: now + 3000 });
  expect(await repo().authorize({ ...claims(), now: now + 10_000 })).toBeNull();
  expect(await repo().authorize({ ...claims(), connectionEpoch: 3, tokenIssuedAt: 1_800_000_004, now: now + 4000 })).toEqual(owner);
  await repo().approve({ ...command(), expectedRevision: 3 });
  expect((await snapshot()).cloud_connections[0]).toMatchObject({ revision: 4, token_not_before: 1_800_000_004 });
});

it("keeps the disconnect token fence even when a reconnect command has an older clock", async () => {
  const owner = await enroll();
  await repo().approve(command());
  await repo().revoke({ ...command(), expectedRevision: 1, now: now + 5000 });
  await repo().approve({ ...command(), expectedRevision: 2 });
  expect(await repo().authorize({ ...claims(), tokenIssuedAt: 1_800_000_005, now: now + 6000 })).toBeNull();
  expect(await repo().authorize({ ...claims(), connectionEpoch: 3, tokenIssuedAt: 1_800_000_006, now: now + 6000 })).toEqual(owner);
});

it.each([undefined, null, "1800000001", NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 1_800_000_002])("denies malformed, missing or future iat %j", async (tokenIssuedAt) => {
  await enroll();
  await repo().approve(command());
  expect(await repo().authorize({ ...claims(), tokenIssuedAt: tokenIssuedAt as number })).toBeNull();
});

it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])("fails closed on invalid epoch milliseconds %j", async (time) => {
  const before = await snapshot();
  await expectCode(repo().approve({ ...command(), now: time }), "invalid_input");
  await expectCode(repo().revoke({ ...command(), now: time }), "invalid_input");
  expect(await repo().authorize({ ...claims(), now: time })).toBeNull();
  expect(await snapshot()).toEqual(before);
});

it.each([0, Number.MAX_SAFE_INTEGER])("accepts safe millisecond boundary %j while respecting whole seconds", async (time) => {
  await enroll();
  await repo().approve({ ...command(), now: time });
  expect(await repo().authorize({ ...claims(), tokenIssuedAt: time === 0 ? 0 : 9_007_199_254_740, now: time })).toBeNull();
  expect((await snapshot()).cloud_connections[0]).toMatchObject({ token_not_before: time === 0 ? 1 : 9_007_199_254_741 });
});

it("denies an existing connection as soon as its approving device is revoked", async () => {
  await enroll();
  await repo().approve(command());
  await env.DB.prepare("UPDATE cloud_devices SET status = 'revoked' WHERE device_key_id = 'device'").run();
  const before = await snapshot();
  expect(await repo().authorize(claims())).toBeNull();
  expect(await snapshot()).toEqual(before);
});

it("concurrent authorization cannot reactivate a revoked connection", async () => {
  await enroll();
  await repo().approve(command());
  await Promise.all([repo().revoke({ ...command(), expectedRevision: 1 }), ...Array.from({ length: 12 }, () => repo().authorize(claims()))]);
  const before = await snapshot();
  const results = await Promise.all(Array.from({ length: 12 }, () => repo().authorize(claims())));
  expect(results).toEqual(Array(12).fill(null));
  expect(await snapshot()).toEqual(before);
  expect(before.cloud_connections[0]).toMatchObject({ status: "revoked" });
  expect(before.cloud_batch_guards).toEqual([]);
});

it("concurrent same-generation approvals accept exactly one command", async () => {
  const owner = await enroll();
  const results = await Promise.allSettled([6000, 1000, 4000, 0].map((offset) => repo().approve({ ...command(), now: now + offset })));
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  for (const result of results) if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "connection_conflict" });
  const state = await snapshot();
  expect(state.cloud_connections).toHaveLength(1);
  expect(state.cloud_connections[0]).toMatchObject({ revision: 1, status: "active" });
  expect(state.cloud_batch_guards).toEqual([]);
  const accepted = results.findIndex((result) => result.status === "fulfilled");
  const fence = [1_800_000_007, 1_800_000_002, 1_800_000_005, 1_800_000_001][accepted];
  expect(state.cloud_connections[0]).toMatchObject({ token_not_before: fence });
  expect(await repo().authorize({ ...claims(), tokenIssuedAt: fence - 1, now: now + 7000 })).toBeNull();
  expect(await repo().authorize({ ...claims(), tokenIssuedAt: fence, now: now + 7000 })).toEqual(owner);
});

it("legacy subscriptions and businesses cannot approve a cloud connection", async () => {
  await createD1Repositories(env.DB).subscriptions.upsert({ appSlug: "simpli-invoice", appAccountToken: identity.appleIdentity, originalTransactionId: "legacy-lineage", productId: "monthly", state: "active" });
  await createD1Repositories(env.DB).businesses.getOrCreate(identity.appleIdentity);
  const before = await snapshot();
  await expectCode(repo().approve(command()), "device_denied");
  await expectCode(repo().revoke(command()), "device_denied");
  expect(await repo().authorize(claims())).toBeNull();
  expect(await snapshot()).toEqual(before);
});

const fields = ["issuer", "appleIdentity", "deviceKeyId", "clientId"] as const;
function withField(field: typeof fields[number], value: unknown) {
  const input = command();
  if (field === "issuer" || field === "appleIdentity") Object.assign(input.identity, { [field]: value });
  else Object.assign(input, { [field]: value });
  return input;
}
const invalidIdentifiers = ["", "x".repeat(1025), undefined, null, 42, "\ud800", "\udfff", "before\ud800after", "before\udfffafter"];
it.each(fields.flatMap((field) => invalidIdentifiers.map((invalid, index) => ({ field, invalid, index }))))("rejects malformed $field case $index before touching D1", async ({ field, invalid }) => {
  // An unavailable real binding proves rejection happens before prepare/bind,
  // rather than relying on a spy that merely asserts its own call count.
  const unavailable = createCloudConnectionRepository(undefined as never);
  const input = withField(field, invalid);
  await expectCode(unavailable.approve(input), "invalid_input");
  await expectCode(unavailable.revoke(input), "invalid_input");
  if (field !== "deviceKeyId") {
    expect(await unavailable.authorize({ ...claims(), identity: input.identity, clientId: input.clientId })).toBeNull();
    expect(await unavailable.getActiveEpoch({ identity: input.identity, clientId: input.clientId })).toBeNull();
    expect(await unavailable.getState({ identity: input.identity, clientId: input.clientId })).toBeNull();
  }
});

it("denies malformed runtime context before touching D1", async () => {
  const unavailable = createCloudConnectionRepository(undefined as never);
  const malformed: unknown[] = [null, undefined, {}, { identity: null }];
  for (const value of malformed) {
    await expectCode(unavailable.approve(value as ReturnType<typeof command>), "invalid_input");
    await expectCode(unavailable.revoke(value as ReturnType<typeof command>), "invalid_input");
    expect(await unavailable.authorize(value as ReturnType<typeof claims>)).toBeNull();
    expect(await unavailable.getState(value as ReturnType<typeof command>)).toBeNull();
    expect(await unavailable.getActiveEpoch(value as ReturnType<typeof command>)).toBeNull();
  }
});

it.each(fields)("preserves U+FFFD and supplementary characters in %s without malformed aliases", async (field) => {
  const valid = withField(field, "\ufffd");
  const owner = await enroll(valid);
  await repo().approve(valid);
  const authorized = { ...claims(), identity: valid.identity, clientId: valid.clientId };
  expect(await repo().authorize(authorized)).toEqual(owner);
  expect(await repo().getState({ identity: valid.identity, clientId: valid.clientId })).toEqual({ revision: 1, status: "active" });
  const before = await snapshot();
  for (const invalid of ["\ud800", "\udfff"]) {
    const malformed = withField(field, invalid);
    await expectCode(repo().approve(malformed), "invalid_input");
    await expectCode(repo().revoke(malformed), "invalid_input");
    if (field !== "deviceKeyId") expect(await repo().authorize({ ...authorized, identity: malformed.identity, clientId: malformed.clientId })).toBeNull();
  }
  expect(await snapshot()).toEqual(before);
  const supplementary = withField(field, "😀");
  if (field !== "clientId") {
    if (field === "deviceKeyId") supplementary.identity.appleIdentity = "other-owner";
    else supplementary.deviceKeyId = "other-device";
    await enroll(supplementary, 2);
  }
  await repo().approve(supplementary);
  expect(await repo().authorize({ ...claims(), identity: supplementary.identity, clientId: supplementary.clientId })).not.toBeNull();
  expect(await repo().getState({ identity: supplementary.identity, clientId: supplementary.clientId })).toEqual({ revision: 1, status: "active" });
});

it("keeps SQL-looking, NUL, whitespace, case and maximum-length client identifiers exact", async () => {
  const owner = await enroll();
  for (const clientId of ["\u0000", " '; DROP TABLE cloud_owners;--雪 ", "😀".repeat(512), "CHATGPT"]) {
    await repo().approve({ ...command(), clientId });
    expect(await repo().authorize({ ...claims(), clientId })).toEqual(owner);
  }
  expect(await repo().authorize(claims())).toBeNull();
  expect((await snapshot()).cloud_connections).toHaveLength(4);
});

it.each(["approve", "revoke"] as const)("rolls back %s and the assertion guard on a late D1 failure", async (method) => {
  await enroll();
  if (method === "revoke") await repo().approve(command());
  const input = { ...command(), expectedRevision: method === "revoke" ? 1 : 0 };
  const before = await snapshot();
  await env.DB.prepare("CREATE TRIGGER reject_connection_guard_delete BEFORE DELETE ON cloud_batch_guards BEGIN SELECT RAISE(ABORT, 'private SQL failure'); END").run();
  try {
    await expectCode(repo()[method](input), "storage_unavailable");
    expect(await snapshot()).toEqual(before);
  } finally {
    await env.DB.prepare("DROP TRIGGER reject_connection_guard_delete").run();
  }
  await repo()[method](input);
  expect((await snapshot()).cloud_batch_guards).toEqual([]);
});

it("concurrent device revocation and approval leave no authorized connection", async () => {
  await enroll();
  const results = await Promise.allSettled([
    repo().approve(command()),
    env.DB.prepare("UPDATE cloud_devices SET status = 'revoked' WHERE device_key_id = 'device'").run(),
  ]);
  if (results[0].status === "rejected") expect(results[0].reason).toMatchObject({ code: "device_denied" });
  expect(results[1].status).toBe("fulfilled");
  expect(await repo().authorize(claims())).toBeNull();
  expect((await snapshot()).cloud_batch_guards).toEqual([]);
});

it("sanitizes real D1 mutation and authorization failures", async () => {
  await enroll();
  await env.DB.prepare("ALTER TABLE cloud_connections RENAME TO unavailable_connections").run();
  try {
    await expectCode(repo().approve(command()), "storage_unavailable");
    await expectCode(repo().revoke(command()), "storage_unavailable");
    await expectCode(repo().authorize(claims()), "storage_unavailable");
    await expectCode(repo().getState(command()), "storage_unavailable");
    await expectCode(repo().getActiveEpoch(command()), "storage_unavailable");
  } finally {
    await env.DB.prepare("ALTER TABLE unavailable_connections RENAME TO cloud_connections").run();
  }
});

it("sanitizes failed authority re-reads after a mutation batch failure", async () => {
  await env.DB.prepare("ALTER TABLE cloud_identities RENAME TO unavailable_identities").run();
  try {
    await expectCode(repo().approve(command()), "storage_unavailable");
    await expectCode(repo().revoke(command()), "storage_unavailable");
    await expectCode(repo().authorize(claims()), "storage_unavailable");
    await expectCode(repo().getState(command()), "storage_unavailable");
    await expectCode(repo().getActiveEpoch(command()), "storage_unavailable");
  } finally {
    await env.DB.prepare("ALTER TABLE unavailable_identities RENAME TO cloud_identities").run();
  }
});


it("rejects a delayed approval carrying the pre-disconnect revision even with a later clock", async () => {
  await enroll();
  await repo().approve(command());
  const delayed = { ...command(), expectedRevision: 1, now: now + 10_000 };
  await repo().revoke({ ...command(), expectedRevision: 1, now: now + 2000 });
  const before = await snapshot();
  await expectCode(repo().approve(delayed), "connection_conflict");
  expect(await snapshot()).toEqual(before);
});

it("records a first revoke tombstone that blocks a delayed initial approval", async () => {
  await enroll();
  await repo().revoke(command());
  const before = await snapshot();
  expect(before.cloud_connections).toHaveLength(1);
  expect(before.cloud_connections[0]).toMatchObject({ revision: 1, status: "revoked" });
  await expectCode(repo().approve({ ...command(), now: now + 5000 }), "connection_conflict");
  expect(await snapshot()).toEqual(before);
});

it("never authorizes a token issued while disconnected through a stale approval", async () => {
  await enroll();
  await repo().approve(command());
  await repo().revoke({ ...command(), expectedRevision: 1, now: now + 2000 });
  await repo().approve({ ...command(), expectedRevision: 1, now: now + 1000 }).catch(() => undefined);
  const disconnectedToken = { ...claims(), tokenIssuedAt: 1_800_000_004, now: now + 7000 };
  expect(await repo().authorize(disconnectedToken)).toBeNull();
  await repo().approve({ ...command(), expectedRevision: 2, now: now + 6000 });
  expect(await repo().authorize(disconnectedToken)).toBeNull();
  expect(await repo().authorize({ ...disconnectedToken, connectionEpoch: 3, tokenIssuedAt: 1_800_000_007 })).not.toBeNull();
});


it("reads unknown, unapproved, active and revoked state without creating data", async () => {
  const before = await snapshot();
  expect(await repo().getState(command())).toBeNull();
  expect(await snapshot()).toEqual(before);
  await enroll();
  const unapproved = await snapshot();
  expect(await repo().getState(command())).toEqual({ revision: 0, status: "unapproved" });
  expect(await snapshot()).toEqual(unapproved);
  await repo().approve(command());
  expect(await repo().getState(command())).toEqual({ revision: 1, status: "active" });
  expect(await repo().getState({ ...command(), clientId: "other-client" })).toEqual({ revision: 0, status: "unapproved" });
  expect(await repo().getState({ ...command(), identity: { ...identity, issuer: "https://ISSUER.example/" } })).toBeNull();
  await repo().revoke({ ...command(), expectedRevision: 1 });
  expect(await repo().getState(command())).toEqual({ revision: 2, status: "revoked" });
});

it.each([undefined, null, "0", true, {}, NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])("rejects malformed revision %j before D1 access", async (expectedRevision) => {
  const unavailable = createCloudConnectionRepository(undefined as never);
  const input = { ...command(), expectedRevision: expectedRevision as number };
  await expectCode(unavailable.approve(input), "invalid_input");
  await expectCode(unavailable.revoke(input), "invalid_input");
});

it("rejects an omitted expectedRevision before D1 access", async () => {
  const unavailable = createCloudConnectionRepository(undefined as never);
  const input = { identity, deviceKeyId: "device", clientId: "chatgpt", now };
  await expectCode(unavailable.approve(input as ReturnType<typeof command>), "invalid_input");
  await expectCode(unavailable.revoke(input as ReturnType<typeof command>), "invalid_input");
});

it.each(["approve", "revoke"] as const)("rejects future %s revisions without table changes", async (method) => {
  await enroll();
  const before = await snapshot();
  await expectCode(repo()[method]({ ...command(), expectedRevision: 1 }), "connection_conflict");
  expect(await snapshot()).toEqual(before);
});

it("stale revoke cannot undo a newer explicit approval", async () => {
  await enroll();
  await repo().approve(command());
  await repo().revoke({ ...command(), expectedRevision: 1 });
  await repo().approve({ ...command(), expectedRevision: 2 });
  const before = await snapshot();
  await expectCode(repo().revoke({ ...command(), expectedRevision: 1, now: now + 50_000 }), "connection_conflict");
  expect(await snapshot()).toEqual(before);
  expect(await repo().getState(command())).toEqual({ revision: 3, status: "active" });
});

it("revoked tombstones allow only validated no-op revokes without raising their fence", async () => {
  const owner = await enroll();
  await env.DB.prepare("INSERT INTO cloud_devices (device_key_id, owner_id, status) VALUES ('second-device', ?, 'active')").bind(owner.ownerId).run();
  await repo().revoke(command());
  const before = await snapshot();
  for (const expectedRevision of [0, 1]) {
    await repo().revoke({ ...command(), deviceKeyId: "second-device", expectedRevision, now: now + 50_000 });
    expect(await snapshot()).toEqual(before);
  }
  await expectCode(repo().revoke({ ...command(), expectedRevision: 2 }), "connection_conflict");
  await expectCode(repo().revoke({ ...command(), deviceKeyId: "missing" }), "device_denied");
  await env.DB.prepare("UPDATE cloud_devices SET status = 'revoked' WHERE device_key_id = 'second-device'").run();
  const revokedDevice = await snapshot();
  await expectCode(repo().revoke({ ...command(), deviceKeyId: "second-device" }), "device_denied");
  expect(await snapshot()).toEqual(revokedDevice);
});

it.each([0, 1])("concurrent approve/revoke at revision %j has one atomic winner", async (expectedRevision) => {
  await enroll();
  if (expectedRevision === 1) await repo().approve(command());
  const results = await Promise.allSettled([
    repo().approve({ ...command(), expectedRevision, now: now + 1000 }),
    repo().revoke({ ...command(), expectedRevision, now: now + 5000 }),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  for (const result of results) if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "connection_conflict" });
  const winner = results[0].status === "fulfilled" ? "active" : "revoked";
  expect(await repo().getState(command())).toEqual({ revision: expectedRevision + 1, status: winner });
  const before = await snapshot();
  expect(before.cloud_connections[0]).toMatchObject({ token_not_before: winner === "active" ? 1_800_000_002 : 1_800_000_006 });
  expect(before.cloud_batch_guards).toEqual([]);
  await expectCode(repo().approve({ ...command(), expectedRevision }), "connection_conflict");
  if (winner === "active") await expectCode(repo().revoke({ ...command(), expectedRevision }), "connection_conflict");
  else await repo().revoke({ ...command(), expectedRevision });
  expect(await snapshot()).toEqual(before);
});

it("concurrent repeated revokes increment an active generation once", async () => {
  await enroll();
  await repo().approve(command());
  await Promise.all(Array.from({ length: 8 }, () => repo().revoke({ ...command(), expectedRevision: 1, now: now + 2000 })));
  expect(await repo().getState(command())).toEqual({ revision: 2, status: "revoked" });
  expect((await snapshot()).cloud_connections[0]).toMatchObject({ token_not_before: 1_800_000_003 });
});

it("revision exhaustion fails closed while an exhausted tombstone permits a no-op", async () => {
  await enroll();
  await repo().approve(command());
  await env.DB.prepare("UPDATE cloud_connections SET revision = ?").bind(Number.MAX_SAFE_INTEGER - 1).run();
  await repo().approve({ ...command(), expectedRevision: Number.MAX_SAFE_INTEGER - 1 });
  expect(await repo().getState(command())).toEqual({ revision: Number.MAX_SAFE_INTEGER, status: "active" });
  const before = await snapshot();
  for (const method of ["approve", "revoke"] as const) await expectCode(repo()[method]({ ...command(), expectedRevision: Number.MAX_SAFE_INTEGER }), "connection_conflict");
  expect(await snapshot()).toEqual(before);
  await env.DB.prepare("UPDATE cloud_connections SET status = 'revoked'").run();
  const tombstone = await snapshot();
  await repo().revoke({ ...command(), expectedRevision: Number.MAX_SAFE_INTEGER, now: now + 5000 });
  expect(await snapshot()).toEqual(tombstone);
  await expectCode(repo().approve({ ...command(), expectedRevision: Number.MAX_SAFE_INTEGER }), "connection_conflict");
  expect(await snapshot()).toEqual(tombstone);
});

it.each([0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])("D1 rejects invalid persisted revision %j", async (revision) => {
  await enroll();
  await repo().approve(command());
  const before = await snapshot();
  await expect(env.DB.prepare("UPDATE cloud_connections SET revision = ?").bind(revision).run()).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
});


it.each([undefined, null, "1", true, {}, NaN, Infinity, -1, 0, 0.5, Number.MAX_SAFE_INTEGER + 1])("denies missing or malformed signed epoch %j before D1", async (connectionEpoch) => {
  const unavailable = createCloudConnectionRepository(undefined as never);
  expect(await unavailable.authorize({ ...claims(), connectionEpoch: connectionEpoch as number })).toBeNull();
});

it("denies omitted signed epoch even with a recent iat on an active connection", async () => {
  await enroll();
  await repo().approve(command());
  const { connectionEpoch: omitted, ...unsigned } = claims();
  expect(omitted).toBe(1);
  expect(await repo().authorize(unsigned as ReturnType<typeof claims>)).toBeNull();
});

it("cannot upgrade disconnected or delayed old issuance through a new iat or backward reconnect clock", async () => {
  const owner = await enroll();
  await repo().approve(command());
  const delayedOldGrant = { ...claims(), tokenIssuedAt: 1_800_000_020, now: now + 20_000 };
  await repo().revoke({ ...command(), expectedRevision: 1, now: now + 5000 });
  const disconnectedToken = { ...claims(), connectionEpoch: 2, tokenIssuedAt: 1_800_000_010, now: now + 20_000 };
  expect(await repo().authorize(disconnectedToken)).toBeNull();
  await repo().approve({ ...command(), expectedRevision: 2, now: now - 10_000 });
  expect(await repo().authorize(delayedOldGrant)).toBeNull();
  expect(await repo().authorize(disconnectedToken)).toBeNull();
  expect(await repo().authorize({ ...claims(), connectionEpoch: 3, tokenIssuedAt: 1_800_000_006, now: now + 6000 })).toEqual(owner);
});

it("looks up only an active epoch for the exact identity/client and owned active device", async () => {
  expect(await repo().getActiveEpoch(command())).toBeNull();
  await enroll();
  expect(await repo().getActiveEpoch(command())).toBeNull();
  await repo().approve(command());
  const before = await snapshot();
  expect(await repo().getActiveEpoch(command())).toBe(1);
  expect(await repo().getActiveEpoch({ ...command(), clientId: "other" })).toBeNull();
  expect(await repo().getActiveEpoch({ ...command(), identity: { ...identity, appleIdentity: "other" } })).toBeNull();
  expect(await repo().getActiveEpoch({ ...command(), identity: { ...identity, issuer: "https://ISSUER.example/" } })).toBeNull();
  expect(await snapshot()).toEqual(before);
  await repo().revoke({ ...command(), expectedRevision: 1 });
  expect(await repo().getActiveEpoch(command())).toBeNull();
  await repo().approve({ ...command(), expectedRevision: 2 });
  expect(await repo().getActiveEpoch(command())).toBe(3);
  await env.DB.prepare("UPDATE cloud_devices SET status = 'revoked' WHERE device_key_id = 'device'").run();
  expect(await repo().getActiveEpoch(command())).toBeNull();
});
