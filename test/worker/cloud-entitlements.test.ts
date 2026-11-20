import { beforeEach, expect, it } from "vitest";
import { applyVerifiedEntitlement, initializeVerifiedOwnerRecords } from "../../src/chatgpt/records/entitlements.js";
import { createCloudRecordKernel } from "../../src/chatgpt/records/kernel.js";
import { env, namespace, start, reset, setup, fact } from "./cloud-record-fixtures.js";
beforeEach(reset);
it("initializes importing once without entitlement or readiness and guards owner/device pairs", async () => {
  const { owner, deviceKeyId, authority } = await setup("one", false);
  const before = await env.DB.prepare("SELECT * FROM cloud_record_state").all();
  await initializeVerifiedOwnerRecords(env.DB, owner, deviceKeyId);
  expect((await env.DB.prepare("SELECT * FROM cloud_record_state").all()).results).toEqual(before.results);
  await expect(createCloudRecordKernel(env.DB, { authorizationNamespace: namespace, now: () => start }).authorizeRead(authority)).rejects.toMatchObject({ code: "not_ready" });
  const other = await setup("two");
  await expect(initializeVerifiedOwnerRecords(env.DB, { ...owner, businessId: other.owner.businessId }, deviceKeyId)).rejects.toMatchObject({ code: "not_authorized" });
  await expect(initializeVerifiedOwnerRecords(env.DB, owner, other.deviceKeyId)).rejects.toMatchObject({ code: "not_authorized" });
  await env.DB.prepare("UPDATE cloud_devices SET status = 'revoked'").run();
  await expect(initializeVerifiedOwnerRecords(env.DB, owner, deviceKeyId)).rejects.toMatchObject({ code: "not_authorized" });
});
it("enforces signed ordering, monotonic checked time and equal signed fact consistency", async () => {
  const { owner } = await setup();
  const revoked = { ...fact(), state: "revoked" as const, signedAt: start + 1, checkedAt: start + 1 };
  await applyVerifiedEntitlement(env.DB, owner, revoked, start + 10);
  await applyVerifiedEntitlement(env.DB, owner, { ...fact(), checkedAt: start + 2 }, start + 10);
  expect(await env.DB.prepare("SELECT state FROM cloud_entitlements").first("state")).toBe("revoked");
  await expect(applyVerifiedEntitlement(env.DB, owner, { ...revoked, state: "active" }, start + 10)).rejects.toMatchObject({ code: "operation_conflict", message: "operation_conflict" });
  await applyVerifiedEntitlement(env.DB, owner, { ...revoked, checkedAt: start + 3 }, start + 10);
  await applyVerifiedEntitlement(env.DB, owner, { ...revoked, signedAt: start + 5, checkedAt: start + 2 }, start + 10);
  expect(await env.DB.prepare("SELECT signed_at, checked_at FROM cloud_entitlements").first()).toEqual({ signed_at: start + 1, checked_at: start + 3 });
});
it("cannot borrow another owner's lineage and rejects future or malformed facts", async () => {
  const { owner } = await setup();
  await setup("two");
  await expect(applyVerifiedEntitlement(env.DB, owner, fact("two"), start)).rejects.toMatchObject({ code: "not_authorized" });
  for (const patch of [{ checkedAt: start + 1 }, { signedAt: -1 }, { expiresAt: 0.5 }, { appSlug: "other" }, { state: "invented" }]) await expect(applyVerifiedEntitlement(env.DB, owner, { ...fact(), ...patch } as never, start)).rejects.toMatchObject({ code: "invalid_input" });
});
it.each(["active", "trial", "grace", "billing_retry", "lapsed", "revoked", "unknown"] as const)("authoring eligibility for %s is independent of reads", async state => {
  const { owner, authority } = await setup();
  await applyVerifiedEntitlement(env.DB, owner, { ...fact(), state, graceExpiresAt: start + 1000, signedAt: start + 1, checkedAt: start + 1 }, start + 1);
  const k = createCloudRecordKernel(env.DB, { authorizationNamespace: namespace, now: () => start + 1 });
  await k.authorizeRead(authority);
  if (["active", "trial", "grace"].includes(state)) await k.authorizeAuthoring(authority);
  else await expect(k.authorizeAuthoring(authority)).rejects.toMatchObject({ code: "entitlement_required" });
});
