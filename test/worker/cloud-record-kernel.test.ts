import { beforeEach, expect, it } from "vitest";
import { createCloudRecordKernel, pruneOwnerFeed } from "../../src/chatgpt/records/kernel.js";
import { createCloudRecordAuthorizer } from "../../src/chatgpt/records/authority.js";
import type { CloudRecordAuthority } from "../../src/chatgpt/records/authority.js";
import type { MutationPlan } from "../../src/chatgpt/records/types.js";
import { env, namespace, start, reset, setup, state } from "./cloud-record-fixtures.js";
beforeEach(reset);
const kernel = (now = () => start, db = env.DB) => createCloudRecordKernel(db, { authorizationNamespace: namespace, now });
const command = (operationKey = "op", request: unknown = { name: "Alice", revision: 0 }) => ({ operationKey, kind: "customer.create", request: request as never });
function plan(ownerId: string, id = crypto.randomUUID(), payload = { name: "Alice" }, fail = false): (at: number) => MutationPlan {
  return at => ({ condition: { sql: "NOT EXISTS (SELECT 1 FROM cloud_customers WHERE owner_id = ? AND id = ?)", values: [ownerId, id] }, statements: [env.DB.prepare("INSERT INTO cloud_customers (owner_id,id,revision,created_at,updated_at,deleted_at,payload,search_text) VALUES (?,?,1,?,?,NULL,?,'alice')").bind(ownerId, id, at, at, JSON.stringify(payload)), ...(fail ? [env.DB.prepare("INSERT INTO cloud_batch_guards VALUES ('intentional-failure',0)")] : [])], events: [{ kind: "customer", id, revision: 1, payload, tombstone: false }], response: { id, revision: 1, createdAt: at, value: payload } });
}
it("mints frozen signed authority; rejects copied authority and wrong configured namespace before D1", async () => {
  const { authority, token, resolveKey } = await setup();
  expect(Object.isFrozen(authority)).toBe(true);
  await expect(kernel(() => start, null as never).authorizeRead({ ...authority } as CloudRecordAuthority)).rejects.toMatchObject({ code: "not_authorized", message: "not_authorized" });
  await expect(createCloudRecordKernel(null as never, { authorizationNamespace: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE" }).authorizeRead(authority)).rejects.toMatchObject({ code: "not_authorized" });
  expect(await createCloudRecordAuthorizer(env.DB, { authorizationNamespace: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE", keys: resolveKey, now: () => start })(token)).toBeNull();
  await kernel().authorizeRead(authority);
});
it("commits entity receipt feed head atomically and replays the exact historical response", async () => {
  const { authority, owner } = await setup();
  const result = await kernel().commit(authority, command(), plan(owner.ownerId));
  await env.DB.prepare("UPDATE cloud_customers SET revision = 2").run();
  expect(await kernel().commit(authority, command("op", { revision: 0, name: "Alice" }), () => { throw new Error("must not build"); })).toEqual(result);
  await expect(kernel().commit(authority, command("op", { name: "Bob" }), plan(owner.ownerId))).rejects.toMatchObject({ code: "operation_conflict" });
  const current = await state();
  expect(current.cloud_mutation_receipts).toHaveLength(1);
  expect(current.cloud_record_feed).toHaveLength(1);
  expect(current.cloud_record_state[0].head_sequence).toBe(current.cloud_record_feed[0].sequence);
  expect(current.cloud_batch_guards).toEqual([]);
});
it("rolls every dependent row back on SQL failure and stale record predicate", async () => {
  const { authority, owner } = await setup();
  const before = await state();
  await expect(kernel().commit(authority, command(), plan(owner.ownerId, undefined, undefined, true))).rejects.toMatchObject({ code: "storage_unavailable", message: "storage_unavailable" });
  expect(await state()).toEqual(before);
  await expect(kernel().commit(authority, command(), at => ({ ...plan(owner.ownerId)(at), condition: { sql: "0", values: [] } }))).rejects.toMatchObject({ code: "revision_conflict" });
  expect(await state()).toEqual(before);
});
it.each(["connection", "device", "ready", "stale", "future", "expired"])("rechecks %s after asynchronous planning and denies replay", async reason => {
  const { authority, owner } = await setup();
  await kernel().commit(authority, command(), plan(owner.ownerId));
  if (reason === "connection") await env.DB.prepare("UPDATE cloud_connections SET status = 'revoked'").run();
  if (reason === "device") await env.DB.prepare("UPDATE cloud_devices SET status = 'revoked'").run();
  if (reason === "ready") await env.DB.prepare("UPDATE cloud_record_state SET phase = 'importing'").run();
  if (reason === "stale") await env.DB.prepare("UPDATE cloud_entitlements SET checked_at = ?").bind(start - 300001).run();
  if (reason === "future") await env.DB.prepare("UPDATE cloud_entitlements SET checked_at = ?").bind(start + 1).run();
  if (reason === "expired") await env.DB.prepare("UPDATE cloud_entitlements SET expires_at = ?").bind(start).run();
  const before = await state();
  const code = reason === "connection" || reason === "device" ? "not_authorized" : reason === "ready" ? "not_ready" : "entitlement_required";
  await expect(kernel().commit(authority, command("new"), plan(owner.ownerId))).rejects.toMatchObject({ code });
  await expect(kernel().commit(authority, command(), plan(owner.ownerId))).rejects.toMatchObject({ code });
  expect(await state()).toEqual(before);
  if (["stale", "future", "expired"].includes(reason)) await kernel().authorizeRead(authority);
});
it("resamples the clock after planning and before building", async () => {
  const { authority, owner } = await setup();
  let now = start;
  const k = kernel(() => now);
  await k.authorizeAuthoring(authority);
  now += 300001;
  const before = await state();
  await expect(k.commit(authority, command(), plan(owner.ownerId))).rejects.toMatchObject({ code: "entitlement_required" });
  expect(await state()).toEqual(before);
});
it("serializes equal and unequal operation-key races without orphan writes", async () => {
  const { authority, owner } = await setup();
  const equal = await Promise.all([kernel().commit(authority, command(), plan(owner.ownerId)), kernel().commit(authority, command(), plan(owner.ownerId))]);
  expect(equal[0]).toEqual(equal[1]);
  const race = await Promise.allSettled([kernel().commit(authority, command("race", { name: "Bob" }), plan(owner.ownerId)), kernel().commit(authority, command("race", { name: "Carol" }), plan(owner.ownerId))]);
  expect(race.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(race.find(r => r.status === "rejected")).toMatchObject({ reason: { code: "operation_conflict" } });
  const s = await state();
  for (const table of ["cloud_customers", "cloud_mutation_receipts", "cloud_record_feed"]) expect(s[table]).toHaveLength(2);
  expect(s.cloud_batch_guards).toEqual([]);
});
it("reads bounded large pages from one snapshot, preserves cursors, tombstones and pruning head", async () => {
  const { authority, owner } = await setup();
  const other = await setup("two");
  const epoch = (await kernel().authorizeRead(authority)).syncEpoch;
  for (let i = 0; i < 3; i++) await kernel().commit(authority, command(`op${i}`), plan(owner.ownerId, undefined, { name: "x".repeat(900000) }));
  const page = await kernel().readFeed(authority, { epoch, after: 0 }, 100);
  expect(page.changes).toHaveLength(1);
  expect(page.hasMore).toBe(true);
  const next = await kernel().readFeed(authority, page.nextCursor, 100);
  expect(next.changes).toHaveLength(1);
  expect(next.changes[0].sequence).toBeGreaterThan(page.changes[0].sequence);
  const last = await kernel().readFeed(authority, next.nextCursor, 100);
  expect(last.hasMore).toBe(false);
  expect(last.head).toBe(page.head);
  await pruneOwnerFeed(env.DB, owner.ownerId, epoch, page.nextCursor.after);
  await expect(kernel().readFeed(authority, { epoch, after: 0 }, 10)).rejects.toMatchObject({ code: "resync_required" });
  await expect(kernel().readFeed(authority, { epoch: crypto.randomUUID(), after: page.head }, 10)).rejects.toMatchObject({ code: "resync_required" });
  await expect(kernel().readFeed(authority, { epoch, after: page.head + 1 }, 10)).rejects.toMatchObject({ code: "invalid_input" });
  await expect(kernel().readFeed(authority, { epoch, after: page.head }, 101)).rejects.toMatchObject({ code: "invalid_input" });
  expect((await kernel().readFeed(authority, { epoch, after: page.head }, 10)).changes).toEqual([]);
  const otherEpoch = (await kernel().authorizeRead(other.authority)).syncEpoch;
  expect((await kernel().readFeed(other.authority, { epoch: otherEpoch, after: 0 }, 100)).changes).toEqual([]);
  await kernel().commit(authority, command("delete"), at => ({ condition: { sql: "1", values: [] }, statements: [], events: [{ kind: "customer", id: crypto.randomUUID(), revision: 2, payload: { deletedAt: at }, tombstone: true }], response: { ok: true } }));
  const deleted = await kernel().readFeed(authority, last.nextCursor, 10);
  expect(deleted.changes[0].tombstone).toBe(true);
  expect(deleted.changes[0].sequence).toBeGreaterThan(page.head);
});
it.each([NaN, 0.1, Number.MAX_SAFE_INTEGER + 1, new Date(), { x: undefined }, { x: BigInt(1) }, "x".repeat(1048577)])("rejects unsupported or oversized request case %#", async request => {
  const { authority, owner } = await setup();
  await expect(kernel().commit(authority, command("op", request), plan(owner.ownerId))).rejects.toMatchObject({ code: "invalid_input" });
  expect((await state()).cloud_record_feed).toEqual([]);
});
it("rejects cyclic input and operation key without writes", async () => {
  const { authority, owner } = await setup();
  const request: Record<string, unknown> = {}; request.self = request;
  await expect(kernel().commit(authority, command("op", request), plan(owner.ownerId))).rejects.toMatchObject({ code: "invalid_input" });
  await expect(kernel().commit(authority, command("bad key"), plan(owner.ownerId))).rejects.toMatchObject({ code: "invalid_input" });
});
it("sanitizes invalid trusted authorizer configuration", () => {
  expect(() => createCloudRecordAuthorizer(env.DB, { authorizationNamespace: "invalid" })).toThrowError("invalid_configuration");
});
it.each(["connection", "device", "ready", "entitlement", "revision"])("rolls back when %s changes immediately before the real D1 batch", async reason => {
  const { authority, owner } = await setup();
  const before = await state();
  const db = new Proxy(env.DB, { get(target, property) {
    if (property === "batch") return async (statements: D1PreparedStatement[]) => {
      if (reason === "connection") await target.prepare("UPDATE cloud_connections SET revision = revision + 1").run();
      if (reason === "device") await target.prepare("UPDATE cloud_devices SET status = 'revoked'").run();
      if (reason === "ready") await target.prepare("UPDATE cloud_record_state SET phase = 'importing'").run();
      if (reason === "entitlement") await target.prepare("UPDATE cloud_entitlements SET state = 'revoked'").run();
      if (reason === "revision") await target.prepare("INSERT INTO cloud_customers(owner_id,id,revision,created_at,updated_at,payload,search_text) VALUES (?, ?, 1, ?, ?, '{}', '')").bind(owner.ownerId, "00000000-0000-4000-8000-000000000001", start, start).run();
      return target.batch(statements);
    };
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  await expect(kernel(() => start, db).commit(authority, command(), plan(owner.ownerId, "00000000-0000-4000-8000-000000000001"))).rejects.toMatchObject({ code: reason === "connection" || reason === "device" ? "not_authorized" : reason === "ready" ? "not_ready" : reason === "entitlement" ? "entitlement_required" : "revision_conflict" });
  const after = await state();
  expect(after.cloud_mutation_receipts).toEqual([]);
  expect(after.cloud_record_feed).toEqual([]);
  expect(after.cloud_batch_guards).toEqual([]);
  expect(after.cloud_record_state[0].head_sequence).toBe(before.cloud_record_state[0].head_sequence);
  expect(after.cloud_customers).toHaveLength(reason === "revision" ? 1 : 0);
});
it("fits a maximum-size event without skipping it and checks persisted payload byte lengths", async () => {
  const { authority } = await setup();
  const k = kernel();
  const epoch = (await k.authorizeRead(authority)).syncEpoch;
  await k.commit(authority, command(), () => ({ condition: { sql: "1", values: [] }, statements: [], events: [{ kind: "customer", id: crypto.randomUUID(), revision: 1, payload: "x".repeat(1048574), tombstone: false }], response: { ok: true } }));
  const page = await k.readFeed(authority, { epoch, after: 0 }, 100);
  expect(page.changes).toHaveLength(1);
  expect(page.hasMore).toBe(false);
  expect((page.changes[0].payload as string).length).toBe(1048574);
  await expect(env.DB.prepare("UPDATE cloud_record_feed SET payload_bytes = payload_bytes - 1").run()).rejects.toThrow();
});
it("preserves the other owner's feed and committed sequence allocation through pruning", async () => {
  const one = await setup();
  const two = await setup("two");
  const k = kernel();
  await k.commit(one.authority, command(), plan(one.owner.ownerId));
  await k.commit(two.authority, command(), plan(two.owner.ownerId));
  const s1 = await k.authorizeRead(one.authority);
  const s2 = await k.authorizeRead(two.authority);
  const otherBefore = await k.readFeed(two.authority, { epoch: s2.syncEpoch, after: 0 }, 100);
  await pruneOwnerFeed(env.DB, one.owner.ownerId, s1.syncEpoch, s1.head);
  expect(await k.readFeed(two.authority, { epoch: s2.syncEpoch, after: 0 }, 100)).toEqual(otherBefore);
  await expect(pruneOwnerFeed(env.DB, one.owner.ownerId, crypto.randomUUID(), s1.head)).rejects.toMatchObject({ code: "resync_required" });
  await expect(pruneOwnerFeed(env.DB, one.owner.ownerId, s1.syncEpoch, s1.head + 1)).rejects.toMatchObject({ code: "invalid_input" });
  await k.commit(one.authority, command("later"), plan(one.owner.ownerId));
  const page = await k.readFeed(one.authority, { epoch: s1.syncEpoch, after: s1.head }, 100);
  expect(page.changes[0].sequence).toBeGreaterThan(s2.head);
  expect((await state()).cloud_batch_guards).toEqual([]);
});
