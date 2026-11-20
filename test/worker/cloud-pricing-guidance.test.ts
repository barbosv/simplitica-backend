import { beforeEach, expect, it } from "vitest";
import { createPricingGuidanceService } from "../../src/chatgpt/pricing/guidance.js";
import { env, namespace, reset, setup, start } from "./cloud-record-fixtures.js";

beforeEach(reset);
const service = () => createPricingGuidanceService(env.DB, { authorizationNamespace: namespace, now: () => start });
const request = { query: "WORK", unit: "hour", kind: "labor", limit: 20 };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
async function rate(owner: string, n: number, title = "Work", price = "1.123456", unit = "hour", kind = "labor") {
  await env.DB.prepare("INSERT INTO cloud_saved_rates VALUES (?,?,1,1,?,NULL,?,?)").bind(owner, id(n), n, JSON.stringify({ title, unitPrice: price, unit, kind, defaultQuantity: "1" }), title).run();
}
async function document(owner: string, n: number, lines: unknown[], state = "paid", type = "invoice", version = "usd-line-cents-v1", deleted: number | null = null) {
  const doc = id(n), number = `INV-${n}`;
  await env.DB.prepare("INSERT INTO cloud_issued_numbers(owner_id,formatted_number,document_id,issued_at) VALUES (?,?,?,1)").bind(owner, number, doc).run();
  await env.DB.prepare("INSERT INTO cloud_documents VALUES (?,?,?,?,?,1,1,?,?,?)").bind(owner, doc, number, type, state, n, deleted, JSON.stringify({ calculationVersion: version, lines, customerSnapshot: { email: "secret" } })).run();
}
const line = (title = "Work", unit = "hour", kind = "labor") => ({ id: id(900), title, unitPrice: "2.123456", unit, kind });
it("uses owned exact normalized saved rates before history with precision and stable bounds", async () => {
  const a = await setup(), b = await setup("two");
  await rate(a.owner.ownerId, 1, "Ｗｏｒｋ"); await rate(a.owner.ownerId, 2, "Work", "9", "day"); await rate(b.owner.ownerId, 3);
  await document(a.owner.ownerId, 4, [line()]);
  const result = await service().getPricingGuidance(a.authority, { ...request, limit: 1 });
  expect(result).toMatchObject({ currency: "USD", mode: "saved_rate", marketGuidanceAvailable: false, requiresNativeReview: true, coverage: { savedRateCandidateLimit: 100, historyDocumentLimit: 50, historyLineCandidateLimit: 200 }, options: [{ title: "Ｗｏｒｋ", unitPrice: "1.123456", unit: "hour", kind: "labor", source: "saved_rate", reference: { id: id(1), revision: 1, lineId: null }, asOf: 1 }] });
  expect(result.options).toHaveLength(1);
});
it("returns reviewed invoice history only, and no owner or contact fields", async () => {
  const { authority, owner } = await setup();
  await document(owner.ownerId, 1, [line()]); await document(owner.ownerId, 2, [line()], "draft"); await document(owner.ownerId, 3, [line()], "paid", "estimate"); await document(owner.ownerId, 4, [line()], "paid", "invoice", "v0"); await document(owner.ownerId, 5, [line()], "paid", "invoice", "usd-line-cents-v1", 5);
  const result = await service().getPricingGuidance(authority, request);
  expect(result).toMatchObject({ mode: "history", options: [{ source: "history", unitPrice: "2.123456", reference: { id: id(1), lineId: id(900), revision: 1 } }] });
  expect(result.options).toHaveLength(1); expect(JSON.stringify(result)).not.toContain("secret"); expect(JSON.stringify(result)).not.toContain(owner.ownerId);
});
it("clarifies missing units and prices, rejects bad input and checks current access", async () => {
  const { authority, owner } = await setup();
  expect(await service().getPricingGuidance(authority, { ...request, unit: null })).toMatchObject({ mode: "clarification", options: [], clarification: { code: "unit_required" } });
  expect(await service().getPricingGuidance(authority, request)).toMatchObject({ mode: "clarification", options: [], clarification: { code: "price_required" } });
  for (const invalid of [{ ...request, query: "" }, { ...request, query: "x\n" }, { ...request, query: "a".repeat(201) }, { ...request, unit: "meter" }, { ...request, kind: "tax" }, { ...request, limit: 21 }, { ...request, extra: true }, { ...request, unit: undefined }]) await expect(service().getPricingGuidance(authority, invalid)).rejects.toMatchObject({ code: "invalid_input" });
  await expect(service().getPricingGuidance(null as never, request)).rejects.toMatchObject({ code: "not_authorized" });
  await env.DB.prepare("UPDATE cloud_entitlements SET state='lapsed' WHERE owner_id=?").bind(owner.ownerId).run();
  await expect(service().getPricingGuidance(authority, { ...request, unit: null })).rejects.toMatchObject({ code: "entitlement_required" });
  await env.DB.prepare("UPDATE cloud_record_state SET phase='importing' WHERE owner_id=?").bind(owner.ownerId).run();
  await expect(service().getPricingGuidance(authority, request)).rejects.toMatchObject({ code: "not_ready" });
  await env.DB.prepare("UPDATE cloud_devices SET status='revoked' WHERE owner_id=?").bind(owner.ownerId).run();
  await expect(service().getPricingGuidance(authority, request)).rejects.toMatchObject({ code: "not_authorized" });
});
it("limits candidate windows before title matching and preserves stable ordering", async () => {
  const { authority, owner } = await setup();
  const statements = Array.from({ length: 101 }, (_, i) => env.DB.prepare("INSERT INTO cloud_saved_rates VALUES (?,?,1,1,?,NULL,?,?)").bind(owner.ownerId, id(i + 1), i + 1, JSON.stringify({ title: i === 0 ? "Work" : "Other", unitPrice: "4", unit: "hour", kind: "labor" }), ""));
  await env.DB.batch(statements);
  expect((await service().getPricingGuidance(authority, request)).mode).toBe("clarification");
  await document(owner.ownerId, 500, [line()]);
  const docs = Array.from({ length: 50 }, (_, i) => i + 501);
  for (const n of docs) await document(owner.ownerId, n, [line("Other")]);
  expect((await service().getPricingGuidance(authority, request)).mode).toBe("clarification");
  await document(owner.ownerId, 600, Array.from({ length: 200 }, () => line("Other")));
  await document(owner.ownerId, 599, [line()]);
  expect((await service().getPricingGuidance(authority, request)).mode).toBe("clarification");
});
it("does not mutate source, receipt, feed or number state and rejects malformed matched storage", async () => {
  const { authority, owner } = await setup();
  const tables = ["cloud_saved_rates", "cloud_documents", "cloud_mutation_receipts", "cloud_record_feed", "cloud_record_state", "cloud_number_state", "cloud_number_reservations", "cloud_issued_numbers"];
  const snapshot = async () => Promise.all(tables.map(async table => (await env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results));
  await rate(owner.ownerId, 1); const before = await snapshot();
  await service().getPricingGuidance(authority, request); expect(await snapshot()).toEqual(before);
  await env.DB.prepare("UPDATE cloud_saved_rates SET payload=? WHERE owner_id=?").bind(JSON.stringify({ title: "Work", unit: "hour", kind: "labor", unitPrice: "1e9" }), owner.ownerId).run();
  await expect(service().getPricingGuidance(authority, request)).rejects.toMatchObject({ code: "storage_unavailable" });
});
it("requires matching kind and unit and orders equal timestamps by stable identifier", async () => {
  const { authority, owner } = await setup();
  await rate(owner.ownerId, 1, "Work", "1", "hour", "materials");
  await rate(owner.ownerId, 2, "Work", "2", "day", "labor");
  await rate(owner.ownerId, 3, "Work", "3", "meter", "labor");
  await document(owner.ownerId, 8, [line("Work", "day"), line("Work", "hour", "materials"), line()]);
  const fallback = await service().getPricingGuidance(authority, request);
  expect(fallback.options).toHaveLength(1); expect(fallback.options[0]).toMatchObject({ source: "history", reference: { id: id(8) } });
  await rate(owner.ownerId, 4, "Work", "4"); await rate(owner.ownerId, 5, "Work", "5");
  await env.DB.prepare("UPDATE cloud_saved_rates SET updated_at=10 WHERE owner_id=? AND id IN (?,?)").bind(owner.ownerId, id(4), id(5)).run();
  const result = await service().getPricingGuidance(authority, request);
  expect(result.options.map(o => o.reference.id)).toEqual([id(4), id(5)]);
});
