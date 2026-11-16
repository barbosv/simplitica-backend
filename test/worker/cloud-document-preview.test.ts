import { beforeEach, expect, it } from "vitest";
import { createCloudRecordRepository } from "../../src/chatgpt/records/repository.js";
import { createDocumentPreviewService } from "../../src/chatgpt/documents/preview.js";
import { env, namespace, reset, setup, start } from "./cloud-record-fixtures.js";

beforeEach(reset);
const customerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const business = { businessName: "Business", addressLines: [], tax: { enabled: true, ratePercent: "6", label: "Tax" }, timezone: "America/New_York" };
const customer = { name: "Client", billingAddressLines: [], savedJobSites: [] };
const input = { documentType: "invoice", issueDate: "2024-02-29", serviceDate: null, dueDate: null, title: "Invoice", notes: null, paymentTermsSummary: null, jobSiteId: null, lines: [{ title: "Work", detail: null, quantity: "200", unitPrice: "4", unit: "hour", kind: "labor" }], discountAmount: "50" };
it("previews a signed owner's current records without writes", async () => {
  const { authority } = await setup();
  const repo = createCloudRecordRepository(env.DB, { authorizationNamespace: namespace, now: () => start });
  await repo.putBusinessProfile(authority, { operationKey: "business", expectedRevision: 0, value: business });
  await repo.createCustomer(authority, { operationKey: "customer", expectedRevision: 0, id: customerId, value: customer });
  const service = createDocumentPreviewService(env.DB, { authorizationNamespace: namespace, now: () => start });
  const before = (await env.DB.prepare("SELECT * FROM cloud_record_feed").all()).results;
  const result = await service.previewDocument(authority, { businessRevision: 1, customerId, customerRevision: 1, input });
  expect(result).toMatchObject({ number: null, subtotal: "800.00", discountApplied: "50.00", taxAmount: "45.00", total: "795.00", requiresNativeReview: true, lines: [{ id: null, lineTotal: "800.00", reportedProvenance: { reported: true, kind: "unspecified" } }] });
  expect((await env.DB.prepare("SELECT * FROM cloud_record_feed").all()).results).toEqual(before);
});
it("enforces same-owner issued number and conversion references", async () => {
  const { authority } = await setup();
  const doc = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const insert = () => env.DB.prepare("INSERT INTO cloud_documents(owner_id,id,number,document_type,state,revision,created_at,updated_at,payload) VALUES (?,?,?,'invoice','draft',1,1,1,'{}')").bind(authority.ownerId, doc, "INV-1").run();
  await expect(insert()).rejects.toThrow();
  await env.DB.prepare("INSERT INTO cloud_issued_numbers(owner_id,formatted_number,document_id,issued_at) VALUES (?,?,?,1)").bind(authority.ownerId, "INV-1", doc).run();
  await expect(insert()).resolves.toBeDefined();
  const other = await setup("two");
  await expect(env.DB.prepare("INSERT INTO cloud_documents(owner_id,id,number,document_type,state,revision,created_at,updated_at,payload) VALUES (?,?,?,'invoice','draft',1,1,1,'{}')").bind(other.authority.ownerId, doc, "INV-1").run()).rejects.toThrow();
  await expect(env.DB.prepare("INSERT INTO cloud_estimate_conversions(owner_id,estimate_id,invoice_id,estimate_revision,created_at) VALUES (?,?,?,?,1)").bind(other.authority.ownerId, doc, doc, 1).run()).rejects.toThrow();
});

import { normalizeDocumentInput } from "../../src/chatgpt/documents/validation.js";
const line = input.lines[0];
it.each([
  { ...input, issueDate: "1900-02-29" }, { ...input, issueDate: "0000-01-01" },
  { ...input, issueDate: "2024-04-31" }, { ...input, issueDate: "02/29/2024" },
  { ...input, dueDate: "2024-02-28" }, { ...input, lines: [] },
  { ...input, lines: Array(201).fill(line) }, { ...input, title: "\ud800" },
  { ...input, notes: "x".repeat(2049) }, { ...input, state: "paid" },
  { ...input, lines: [{ ...line, unit: "meter" }] }, { ...input, lines: [{ ...line, kind: "tax" }] },
  { ...input, lines: [{ ...line, unitPrice: "1e3" }] }, { ...input, lines: [{ ...line, quantity: "0" }] },
  { ...input, lines: [{ ...line, unitPrice: "0.0000001" }] },
  { ...input, lines: [{ ...line, reportedProvenance: { kind: "explicit", reference: null, asOf: 0 } }] },
  { ...input, lines: [{ ...line, reportedProvenance: { kind: "explicit", reference: null, asOf: null, verified: true } }] },
  { ...input, lines: [{ ...line, id: customerId }, { ...line, id: customerId.toUpperCase() }] },
])("rejects invalid source values %#", value => {
  expect(() => normalizeDocumentInput(value)).toThrow(expect.objectContaining({ code: "invalid_input" }));
});
it("normalizes source decimals and preserves reported but untrusted provenance", () => {
  const value = normalizeDocumentInput({ ...input, issueDate: "2000-02-29", lines: [{ ...line, id: customerId.toUpperCase(), quantity: "002.000", unitPrice: "04", reportedProvenance: { kind: "guidance", reference: "https://example.com", asOf: 42 } }] });
  expect(value.lines[0]).toMatchObject({ id: customerId, quantity: "2", unitPrice: "4.00", reportedProvenance: { kind: "guidance", reference: "https://example.com", asOf: 42 } });
});
it("enforces current authority, owner, revisions and pure repeated previews", async () => {
  const one = await setup(); const two = await setup("two");
  const repo = createCloudRecordRepository(env.DB, { authorizationNamespace: namespace, now: () => start });
  await repo.putBusinessProfile(one.authority, { operationKey: "business", expectedRevision: 0, value: { ...business, tax: { ...business.tax, enabled: false, ratePercent: "10" } } });
  await repo.createCustomer(one.authority, { operationKey: "customer", expectedRevision: 0, id: customerId, value: customer });
  await repo.putBusinessProfile(two.authority, { operationKey: "business", expectedRevision: 0, value: business });
  const service = createDocumentPreviewService(env.DB, { authorizationNamespace: namespace, now: () => start });
  const request = { businessRevision: 1, customerId, customerRevision: 1, input };
  const tables = ["cloud_documents", "cloud_estimate_conversions", "cloud_business_profiles", "cloud_customers", "cloud_saved_rates", "cloud_number_state", "cloud_number_reservations", "cloud_issued_numbers", "cloud_mutation_receipts", "cloud_record_feed", "cloud_record_state"];
  const snapshot = async () => Promise.all(tables.map(async table => (await env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results));
  const before = await snapshot();
  const result = await service.previewDocument(one.authority, request);
  expect(result).toMatchObject({ taxAmount: "0.00", taxRatePercent: "0", businessSnapshot: { tax: { enabled: false, ratePercent: "10" } } });
  expect(await service.previewDocument(one.authority, request)).toEqual(result);
  await expect(service.previewDocument(two.authority, request)).rejects.toMatchObject({ code: "not_found" });
  await expect(service.previewDocument(one.authority, { ...request, businessRevision: 2 })).rejects.toMatchObject({ code: "revision_conflict" });
  await expect(service.previewDocument(one.authority, { ...request, customerRevision: 2 })).rejects.toMatchObject({ code: "revision_conflict" });
  await expect(service.previewDocument(one.authority, { ...request, input: { ...input, jobSiteId: customerId } })).rejects.toMatchObject({ code: "invalid_input" });
  expect(await snapshot()).toEqual(before);
  await env.DB.prepare("UPDATE cloud_entitlements SET state='lapsed' WHERE owner_id=?").bind(one.authority.ownerId).run();
  await expect(service.previewDocument(one.authority, request)).rejects.toMatchObject({ code: "entitlement_required" });
  await env.DB.prepare("UPDATE cloud_record_state SET phase='importing' WHERE owner_id=?").bind(two.authority.ownerId).run();
  await expect(service.previewDocument(two.authority, request)).rejects.toMatchObject({ code: "not_ready" });
  await env.DB.prepare("UPDATE cloud_devices SET status='revoked' WHERE owner_id=?").bind(one.authority.ownerId).run();
  await expect(service.previewDocument(one.authority, request)).rejects.toMatchObject({ code: "not_authorized" });
});
it("rejects an oversized preview built from valid bounded sources without writes", async () => {
  const { authority } = await setup();
  const repo = createCloudRecordRepository(env.DB, { authorizationNamespace: namespace, now: () => start });
  const sites = Array.from({ length: 20 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, addressKind: "jobSite", displayAddress: "a".repeat(1024) }));
  await repo.putBusinessProfile(authority, { operationKey: "business", expectedRevision: 0, value: { ...business, addressLines: Array(10).fill("b".repeat(1024)) } });
  await repo.createCustomer(authority, { operationKey: "customer", expectedRevision: 0, id: customerId, value: { ...customer, savedJobSites: sites } });
  const huge = "x\n".repeat(830);
  const largeInput = { ...input, lines: Array.from({ length: 200 }, () => ({ ...line, detail: huge, reportedProvenance: { kind: "explicit", reference: huge, asOf: null } })) };
  const canonical = normalizeDocumentInput(largeInput);
  expect(new TextEncoder().encode(JSON.stringify(largeInput)).byteLength).toBeLessThan(1_048_576);
  expect(new TextEncoder().encode(JSON.stringify(canonical)).byteLength).toBeLessThan(1_048_576);
  const tables = ["cloud_documents", "cloud_estimate_conversions", "cloud_business_profiles", "cloud_customers", "cloud_saved_rates", "cloud_number_state", "cloud_number_reservations", "cloud_issued_numbers", "cloud_mutation_receipts", "cloud_record_feed", "cloud_record_state"];
  const snapshot = async () => Promise.all(tables.map(async table => (await env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results));
  const before = await snapshot();
  const service = createDocumentPreviewService(env.DB, { authorizationNamespace: namespace, now: () => start });
  await expect(service.previewDocument(authority, { businessRevision: 1, customerId, customerRevision: 1, input: largeInput })).rejects.toMatchObject({ code: "invalid_input" });
  expect(await snapshot()).toEqual(before);
});
it("normalizes source intent idempotently for receipt hashing", () => {
  const normalized = normalizeDocumentInput(input);
  expect(normalizeDocumentInput(normalized)).toEqual(normalized);
});
it("freezes preview snapshots against later source mutation", async () => {
  const { authority } = await setup();
  const repo = createCloudRecordRepository(env.DB, { authorizationNamespace: namespace, now: () => start });
  const b = await repo.putBusinessProfile(authority, { operationKey: "business", expectedRevision: 0, value: business });
  const c = await repo.createCustomer(authority, { operationKey: "customer", expectedRevision: 0, id: customerId, value: customer });
  const { buildDocumentPreview } = await import("../../src/chatgpt/documents/preview.js");
  const preview = buildDocumentPreview(input, b, c);
  b.value.businessName = "Changed";
  c.value.name = "Changed";
  expect(preview.businessSnapshot.businessName).toBe("Business");
  expect(preview.customerSnapshot.name).toBe("Client");
});
it("rejects a missing authority with a fixed error", async () => {
  const service = createDocumentPreviewService(env.DB, { authorizationNamespace: namespace, now: () => start });
  await expect(service.previewDocument(null as never, { businessRevision: 1, customerId, customerRevision: 1, input })).rejects.toMatchObject({ code: "not_authorized" });
});
it("selects an owned postal site and rejects a deleted source", async () => {
  const { authority } = await setup();
  const repo = createCloudRecordRepository(env.DB, { authorizationNamespace: namespace, now: () => start });
  await repo.putBusinessProfile(authority, { operationKey: "business", expectedRevision: 0, value: business });
  await repo.createCustomer(authority, { operationKey: "customer", expectedRevision: 0, id: customerId, value: { ...customer, savedJobSites: [{ id: customerId, addressKind: "shipTo", displayAddress: "123 Main" }] } });
  const service = createDocumentPreviewService(env.DB, { authorizationNamespace: namespace, now: () => start });
  const request = { businessRevision: 1, customerId, customerRevision: 1, input: { ...input, jobSiteId: customerId.toUpperCase() } };
  expect((await service.previewDocument(authority, request)).jobSite).toMatchObject({ id: customerId, addressKind: "shipTo", displayAddress: "123 Main" });
  await repo.deleteCustomer(authority, { operationKey: "delete", id: customerId, expectedRevision: 1 });
  await expect(service.previewDocument(authority, request)).rejects.toMatchObject({ code: "not_found" });
});
it("previews schema-valid maximum source revisions", async () => {
  const { authority } = await setup();
  const repo = createCloudRecordRepository(env.DB, { authorizationNamespace: namespace, now: () => start });
  await repo.putBusinessProfile(authority, { operationKey: "business", expectedRevision: 0, value: business });
  await repo.createCustomer(authority, { operationKey: "customer", expectedRevision: 0, id: customerId, value: customer });
  await env.DB.prepare("UPDATE cloud_business_profiles SET revision=? WHERE owner_id=?").bind(Number.MAX_SAFE_INTEGER, authority.ownerId).run();
  await env.DB.prepare("UPDATE cloud_customers SET revision=? WHERE owner_id=?").bind(Number.MAX_SAFE_INTEGER, authority.ownerId).run();
  const service = createDocumentPreviewService(env.DB, { authorizationNamespace: namespace, now: () => start });
  expect(await service.previewDocument(authority, { businessRevision: Number.MAX_SAFE_INTEGER, customerId, customerRevision: Number.MAX_SAFE_INTEGER, input })).toMatchObject({ businessRevision: Number.MAX_SAFE_INTEGER, customerRevision: Number.MAX_SAFE_INTEGER });
});
