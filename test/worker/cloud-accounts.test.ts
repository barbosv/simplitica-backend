import { beforeEach, expect, it } from "vitest";
import { env as workerEnv } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { createCloudAccountRepository } from "../../src/chatgpt/accounts/d1.js";
import { CloudAccountError, type VerifiedEnrollmentEvidence } from "../../src/chatgpt/accounts/types.js";
import { createD1Repositories } from "../../src/db/repositories/d1.js";

const env = workerEnv as {
  DB: D1Database;
  TEST_MIGRATIONS: import("@cloudflare/vitest-plugin").D1Migration[];
  TEST_CLOUD_MIGRATIONS: import("@cloudflare/vitest-plugin").D1Migration[];
};
const tables = ["cloud_owners", "cloud_identities", "cloud_businesses", "cloud_devices", "cloud_purchase_lineages", "cloud_enrollment_challenges", "cloud_enrollment_commits", "cloud_batch_guards"] as const;
const now = 1_800_000_000_000;
const hash = (n = 1) => n.toString(16).padStart(64, "0");
const evidence = (): VerifiedEnrollmentEvidence => ({
  identity: { issuer: "https://issuer.example/", appleIdentity: "apple|opaque-owner" },
  deviceKeyId: "device-key-1",
  purchase: { appSlug: "simpli-invoice", environment: "Sandbox", originalTransactionId: "original-transaction-1" },
});
const repo = () => createCloudAccountRepository(env.DB);
const issue = (value = evidence(), key = hash(), issuedAt = now) => repo().issueChallenge({ challengeHash: key, identity: value.identity, deviceKeyId: value.deviceKeyId, now: issuedAt, expiresAt: issuedAt + 300_000 });
const commit = (value = evidence(), key = hash(), at = now + 1) => repo().commitEnrollment({ challengeHash: key, evidence: value, now: at });

async function snapshot() {
  const existing = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
  const names = new Set(existing.results.map((r) => r.name));
  return Object.fromEntries(await Promise.all(tables.map(async (table) => [table, names.has(table) ? (await env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results : []])));
}
async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(CloudAccountError);
  expect(error).toMatchObject({ code, message: code });
  expect(error).not.toHaveProperty("cause");
}
async function expectSingleAccount(challengeCount: number) {
  const state = await snapshot();
  for (const table of tables.slice(0, 5)) expect(state[table], table).toHaveLength(1);
  expect(state.cloud_enrollment_challenges).toHaveLength(challengeCount);
  expect(state.cloud_enrollment_commits).toHaveLength(1);
  expect(state.cloud_batch_guards).toEqual([]);
  expect((state.cloud_enrollment_challenges as { consumed_at: number | null }[]).filter((r) => r.consumed_at !== null)).toHaveLength(1);
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await applyD1Migrations(env.DB, env.TEST_CLOUD_MIGRATIONS);
  // The installed Worker test plugin shares D1 state between tests in this file.
  const existing = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
  const names = new Set(existing.results.map((r) => r.name));
  for (const table of ["cloud_enrollment_commits", "cloud_purchase_lineages", "cloud_devices", "cloud_businesses", "cloud_identities", "cloud_owners", "cloud_enrollment_challenges", "cloud_batch_guards"]) {
    if (names.has(table)) await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

it("commits owner, exact identity, business, active device and purchase lineage together", async () => {
  await issue();
  const receipt = await commit();
  expect(receipt.ownerId).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  expect(receipt.businessId).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  expect(receipt.deviceKeyId).toBe("device-key-1");
  expect(receipt.ownerId).not.toBe(receipt.businessId);
  expect(await repo().findOwner(evidence().identity)).toEqual({ ownerId: receipt.ownerId, businessId: receipt.businessId });
  const state = await snapshot();
  expect(state.cloud_identities[0]).toMatchObject({ owner_id: receipt.ownerId, issuer: "https://issuer.example/", apple_identity: "apple|opaque-owner" });
  expect(state.cloud_businesses[0]).toMatchObject({ owner_id: receipt.ownerId, business_id: receipt.businessId });
  expect(state.cloud_devices[0]).toMatchObject({ owner_id: receipt.ownerId, device_key_id: "device-key-1", status: "active" });
  expect(state.cloud_purchase_lineages[0]).toMatchObject({ owner_id: receipt.ownerId, app_slug: "simpli-invoice", store_environment: "Sandbox", original_transaction_id: "original-transaction-1" });
  expect(state.cloud_enrollment_challenges[0]).toMatchObject({ challenge_hash: hash(), consumed_at: now + 1 });
  await expectSingleAccount(1);
});

it("replays the exact committed response across repository instances after response loss and expiry", async () => {
  await issue();
  const original = await commit();
  const before = await snapshot();
  expect(await commit(evidence(), hash(), now + 999_999)).toEqual(original);
  expect(await snapshot()).toEqual(before);
  const ledger = before.cloud_enrollment_commits[0] as { evidence_hash: string; response_snapshot: string };
  // Hand-derived fixed order: issuer, Apple identity, device, app, environment, lineage.
  const expectedHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode('["https://issuer.example/","apple|opaque-owner","device-key-1","simpli-invoice","Sandbox","original-transaction-1"]'));
  expect(ledger.evidence_hash).toBe(Array.from(new Uint8Array(expectedHash), (b) => b.toString(16).padStart(2, "0")).join(""));
  expect(JSON.parse(ledger.response_snapshot)).toEqual(original);
});

it.each(["issuer", "appleIdentity", "deviceKeyId", "appSlug", "environment", "originalTransactionId"] as const)("rejects replay with changed %s without writes", async (field) => {
  await issue();
  await commit();
  const altered = evidence();
  if (field === "issuer" || field === "appleIdentity") altered.identity[field] += "changed";
  else if (field === "deviceKeyId") altered.deviceKeyId += "changed";
  else if (field === "environment") altered.purchase.environment = "Production";
  else altered.purchase[field] += "changed";
  const before = await snapshot();
  await expectCode(commit(altered), "enrollment_conflict");
  expect(await snapshot()).toEqual(before);
});

it.each(["expired", "wrong issuer", "wrong identity", "wrong device", "unknown", "consumed"])("rejects %s challenge and preserves every cloud table", async (kind) => {
  await issue();
  const value = evidence();
  if (kind === "wrong issuer") value.identity.issuer += "other";
  if (kind === "wrong identity") value.identity.appleIdentity += "other";
  if (kind === "wrong device") value.deviceKeyId += "other";
  if (kind === "consumed") await env.DB.prepare("UPDATE cloud_enrollment_challenges SET consumed_at = ? WHERE challenge_hash = ?").bind(now, hash()).run();
  const before = await snapshot();
  await expectCode(commit(value, kind === "unknown" ? hash(2) : hash(), kind === "expired" ? now + 300_000 : now + 1), "challenge_invalid");
  expect(await snapshot()).toEqual(before);
});

it("returns one exact receipt for simultaneous equal requests on one challenge", async () => {
  await issue();
  const results = await Promise.all(Array.from({ length: 8 }, () => commit()));
  for (const result of results) expect(result).toEqual(results[0]);
  await expectSingleAccount(1);
});

it("allows one winner for unequal simultaneous requests on one challenge", async () => {
  await issue();
  const changed = evidence();
  changed.purchase.originalTransactionId = "other-lineage";
  const results = await Promise.allSettled([commit(), commit(changed)]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const failure = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  expect(failure.reason).toMatchObject({ code: "enrollment_conflict" });
  await expectSingleAccount(1);
});

it.each(["identity", "lineage", "device"])("rolls back the loser of concurrent different challenges claiming one %s", async (shared) => {
  const first = evidence();
  const second = evidence();
  if (shared !== "identity") second.identity.appleIdentity = "other-owner";
  if (shared !== "lineage") second.purchase.originalTransactionId = "other-lineage";
  if (shared !== "device") second.deviceKeyId = "other-device";
  await issue(first, hash(1));
  await issue(second, hash(2));
  const results = await Promise.allSettled([commit(first, hash(1)), commit(second, hash(2))]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const failure = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  expect(failure.reason).toMatchObject({ code: "enrollment_conflict" });
  await expectSingleAccount(2);
});

it("fails closed when an existing owner attempts enrollment of a new device", async () => {
  await issue();
  await commit();
  const changed = evidence();
  changed.deviceKeyId = "new-device";
  await issue(changed, hash(2));
  const before = await snapshot();
  await expectCode(commit(changed, hash(2)), "enrollment_conflict");
  expect(await snapshot()).toEqual(before);
});

it("preserves opaque Unicode, whitespace and SQL-looking identifiers exactly", async () => {
  const value: VerifiedEnrollmentEvidence = {
    identity: { issuer: " Issuer'雪; DROP TABLE cloud_owners;-- ", appleIdentity: "apple|😀e\u0301\u0000尾" },
    deviceKeyId: " \tkey'雪 ",
    purchase: { appSlug: " app'雪 ", environment: "Production", originalTransactionId: " txn'); DELETE FROM cloud_owners;--😀 " },
  };
  await issue(value);
  const receipt = await commit(value);
  expect(await repo().findOwner(value.identity)).toEqual({ ownerId: receipt.ownerId, businessId: receipt.businessId });
  expect(await repo().findOwner({ ...value.identity, issuer: value.identity.issuer.trim() })).toBeNull();
  expect((await snapshot()).cloud_identities[0]).toMatchObject({ issuer: value.identity.issuer, apple_identity: value.identity.appleIdentity });
  expect(await commit(value)).toEqual(receipt);
  await expectSingleAccount(1);
});

it("distinguishes exact identity case, provider prefixes, app and store environment", async () => {
  const first = evidence();
  const second = evidence();
  second.identity.appleIdentity = "apple|Opaque-owner";
  second.deviceKeyId = "other-device";
  second.purchase.environment = "Production";
  await issue(first, hash(1));
  await issue(second, hash(2));
  const a = await commit(first, hash(1));
  const b = await commit(second, hash(2));
  expect(a.ownerId).not.toBe(b.ownerId);
  expect(await repo().findOwner({ ...first.identity, appleIdentity: "opaque-owner" })).toBeNull();
  expect(await repo().findOwner({ ...first.identity, issuer: "https://ISSUER.example/" })).toBeNull();
  const third = evidence();
  third.identity.appleIdentity = "third-owner";
  third.deviceKeyId = "third-device";
  third.purchase.appSlug = "Simpli-invoice";
  await issue(third, hash(3));
  await commit(third, hash(3));
  expect((await snapshot()).cloud_owners).toHaveLength(3);
});

it("does not derive ownership from legacy subscriptions, appAccountToken or business ID", async () => {
  await createD1Repositories(env.DB).subscriptions.upsert({ appSlug: "simpli-invoice", appAccountToken: "apple|opaque-owner", originalTransactionId: "original-transaction-1", productId: "monthly", state: "active" });
  await createD1Repositories(env.DB).businesses.getOrCreate("apple|opaque-owner");
  expect(await repo().findOwner(evidence().identity)).toBeNull();
  expect((await snapshot()).cloud_owners).toEqual([]);
  await issue();
  await commit();
  await expectSingleAccount(1);
});

it.each(["", "a".repeat(63), "A".repeat(64), "g".repeat(64), "a".repeat(65), " a".repeat(32)])("rejects malformed challenge hash %j before writes", async (challengeHash) => {
  const before = await snapshot();
  await expectCode(repo().issueChallenge({ challengeHash, identity: evidence().identity, deviceKeyId: "device", now, expiresAt: now + 1 }), "invalid_input");
  await expectCode(repo().commitEnrollment({ challengeHash, evidence: evidence(), now }), "invalid_input");
  expect(await snapshot()).toEqual(before);
});

it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid timestamp %s before writes", async (time) => {
  const before = await snapshot();
  await expectCode(repo().issueChallenge({ challengeHash: hash(), identity: evidence().identity, deviceKeyId: "device", now: time, expiresAt: now + 1 }), "invalid_input");
  await expectCode(repo().issueChallenge({ challengeHash: hash(), identity: evidence().identity, deviceKeyId: "device", now, expiresAt: time }), "invalid_input");
  await expectCode(commit(evidence(), hash(), time), "invalid_input");
  expect(await snapshot()).toEqual(before);
});

it.each([0, 300_001])("rejects challenge lifetime %s outside the allowed interval", async (lifetime) => {
  const before = await snapshot();
  await expectCode(repo().issueChallenge({ challengeHash: hash(), identity: evidence().identity, deviceKeyId: "device", now, expiresAt: now + lifetime }), "invalid_input");
  expect(await snapshot()).toEqual(before);
});

it.each(["issuer", "appleIdentity", "deviceKeyId", "appSlug", "originalTransactionId", "environment"] as const)("rejects empty or oversized %s", async (field) => {
  const before = await snapshot();
  for (const invalid of ["", "a".repeat(1025)]) {
    const value = evidence();
    if (field === "issuer" || field === "appleIdentity") value.identity[field] = invalid;
    else if (field === "deviceKeyId") value.deviceKeyId = invalid;
    else Object.assign(value.purchase, { [field]: invalid });
    await expectCode(commit(value), "invalid_input");
    if (field === "issuer" || field === "appleIdentity" || field === "deviceKeyId") await expectCode(issue(value), "invalid_input");
  }
  expect(await snapshot()).toEqual(before);
});

it("accepts 1024 UTF-16 code units without trimming or normalizing", async () => {
  const value = evidence();
  value.identity.appleIdentity = "😀".repeat(512);
  value.deviceKeyId = " ".repeat(1024);
  await issue(value);
  const result = await commit(value);
  expect(result.deviceKeyId).toBe(value.deviceKeyId);
  expect(await repo().findOwner(value.identity)).not.toBeNull();
});

it("does not replace or extend an existing challenge hash", async () => {
  await issue();
  const before = await snapshot();
  await expectCode(issue(evidence(), hash(), now + 1), "enrollment_conflict");
  expect(await snapshot()).toEqual(before);
});

it("sanitizes real D1 storage failures without leaking SQL or input", async () => {
  await env.DB.prepare("ALTER TABLE cloud_enrollment_commits RENAME TO unavailable_commits").run();
  try {
    await expectCode(commit(), "storage_unavailable");
  } finally {
    await env.DB.prepare("ALTER TABLE unavailable_commits RENAME TO cloud_enrollment_commits").run();
  }
});

it("rolls back every entity, ledger entry and guard if a late batch statement fails", async () => {
  await issue();
  const before = await snapshot();
  // Fail after entity and ledger inserts, through real SQLite within workerd.
  await env.DB.prepare("CREATE TRIGGER reject_test_consumption BEFORE UPDATE ON cloud_enrollment_challenges BEGIN SELECT RAISE(ABORT, 'private SQL failure'); END").run();
  try {
    await expectCode(commit(), "storage_unavailable");
    expect(await snapshot()).toEqual(before);
  } finally {
    await env.DB.prepare("DROP TRIGGER reject_test_consumption").run();
  }
  await commit();
  await expectSingleAccount(1);
});

it("sanitizes real D1 challenge and owner lookup failures", async () => {
  await env.DB.prepare("ALTER TABLE cloud_enrollment_challenges RENAME TO unavailable_challenges").run();
  try {
    await expectCode(issue(), "storage_unavailable");
  } finally {
    await env.DB.prepare("ALTER TABLE unavailable_challenges RENAME TO cloud_enrollment_challenges").run();
  }
  await env.DB.prepare("ALTER TABLE cloud_identities RENAME TO unavailable_identities").run();
  try {
    await expectCode(repo().findOwner(evidence().identity), "storage_unavailable");
  } finally {
    await env.DB.prepare("ALTER TABLE unavailable_identities RENAME TO cloud_identities").run();
  }
});

it("rejects malformed runtime evidence and identities with fixed errors", async () => {
  const before = await snapshot();
  const malformedEvidence: unknown[] = [null, undefined, {}, { identity: {} }, { identity: evidence().identity, deviceKeyId: 42 }];
  for (const invalid of malformedEvidence) {
    await expectCode(repo().commitEnrollment({ challengeHash: hash(), evidence: invalid as VerifiedEnrollmentEvidence, now }), "invalid_input");
  }
  for (const identity of [null, undefined, {}, { issuer: 42, appleIdentity: "owner" }, { issuer: "issuer", appleIdentity: "" }]) {
    await expectCode(repo().findOwner(identity as VerifiedEnrollmentEvidence["identity"]), "invalid_input");
  }
  const value = evidence();
  Object.assign(value.purchase, { environment: "sandbox" });
  await expectCode(commit(value), "invalid_input");
  expect(await snapshot()).toEqual(before);
});

it("rejects use before challenge issuance without writes", async () => {
  await issue();
  const before = await snapshot();
  await expectCode(commit(evidence(), hash(), now - 1), "challenge_invalid");
  expect(await snapshot()).toEqual(before);
});

it.each([0, Number.MAX_SAFE_INTEGER - 1])("accepts safe epoch boundary %s with one-millisecond lifetime", async (time) => {
  await repo().issueChallenge({ challengeHash: hash(), identity: evidence().identity, deviceKeyId: evidence().deviceKeyId, now: time, expiresAt: time + 1 });
  await commit(evidence(), hash(), time);
  await expectSingleAccount(1);
});

it("preserves leading NUL identifiers without interpreting them as empty strings", async () => {
  const value = evidence();
  value.identity.issuer = "\u0000issuer";
  value.identity.appleIdentity = "\u0000owner";
  value.deviceKeyId = "\u0000device";
  value.purchase.appSlug = "\u0000app";
  value.purchase.originalTransactionId = "\u0000lineage";
  await issue(value);
  const receipt = await commit(value);
  expect(await commit(value)).toEqual(receipt);
  expect(await repo().findOwner(value.identity)).toEqual({ ownerId: receipt.ownerId, businessId: receipt.businessId });
  await expectSingleAccount(1);
});

it("enforces owner relationships, one business/identity/lineage per owner and valid device status in SQL", async () => {
  await issue();
  const receipt = await commit();
  const before = await snapshot();
  const invalidWrites = [
    env.DB.prepare("INSERT INTO cloud_devices (device_key_id, owner_id, status) VALUES ('orphan', 'missing-owner', 'active')"),
    env.DB.prepare("UPDATE cloud_devices SET status = 'unknown' WHERE device_key_id = ?").bind(receipt.deviceKeyId),
    env.DB.prepare("INSERT INTO cloud_businesses (business_id, owner_id) VALUES ('second-business', ?)").bind(receipt.ownerId),
    env.DB.prepare("INSERT INTO cloud_identities (issuer, apple_identity, owner_id) VALUES ('other-issuer', 'other-identity', ?)").bind(receipt.ownerId),
    env.DB.prepare("INSERT INTO cloud_purchase_lineages (app_slug, store_environment, original_transaction_id, owner_id) VALUES ('other-app', 'Sandbox', 'other-lineage', ?)").bind(receipt.ownerId),
    env.DB.prepare("UPDATE cloud_enrollment_commits SET business_id = 'missing-business'"),
  ];
  for (const invalidWrite of invalidWrites) {
    await expect(invalidWrite.run()).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  }
});
