import { beforeEach, describe, expect, it } from "vitest";
import { createCloudRecordKernel } from "../../src/chatgpt/records/kernel.js";
import { env, namespace, reset, setup, start } from "./cloud-record-fixtures.js";

beforeEach(reset);
describe("record preparation and reads", () => {
  it("replays before asynchronous entity planning after a later deletion", async () => {
    const { authority } = await setup();
    const kernel = createCloudRecordKernel(env.DB, { authorizationNamespace: namespace, now: () => start });
    const command = { operationKey: "prepare:one", kind: "customer.create", request: { name: "First" } };
    let prepared = 0;
    const prepare = async () => {
      prepared++;
      if (prepared > 1) throw new Error("entity subsequently deleted");
      return () => ({ condition: { sql: "1", values: [] }, statements: [], events: [{ kind: "customer", id: "id", revision: 1, payload: { name: "First" }, tombstone: false }], response: { name: "First" } });
    };
    expect(await kernel.prepareAndCommit(authority, command, prepare)).toEqual({ name: "First" });
    expect(await kernel.prepareAndCommit(authority, command, prepare)).toEqual({ name: "First" });
    expect(prepared).toBe(1);
  });
  it("does not disclose snapshot rows after current connection revocation", async () => {
    const { authority } = await setup();
    const kernel = createCloudRecordKernel(env.DB, { authorizationNamespace: namespace, now: () => start });
    const query = env.DB.prepare("SELECT owner_id FROM cloud_owners WHERE owner_id=?").bind(authority.ownerId);
    expect(await kernel.readOwned(authority, query)).toHaveLength(1);
    await env.DB.prepare("UPDATE cloud_connections SET status='revoked' WHERE owner_id=?").bind(authority.ownerId).run();
    await expect(kernel.readOwned(authority, query)).rejects.toMatchObject({ code: "not_authorized" });
  });
});

import { createCloudRecordRepository } from "../../src/chatgpt/records/repository.js";
const id = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
const customer = { name: "  Client %_  ", email: "", phone: null, billingAddressLines: ["1 Main Street"], savedJobSites: [{ id, recipientName: "Client", addressKind: "jobSite", displayAddress: "2 Main Street" }] };
const business = { businessName: "Business", addressLines: [], email: null, phone: null, website: null, tax: { enabled: false, ratePercent: "10.0000", label: "Sales tax" }, paymentTermsSummary: null, timezone: "America/New_York" };
const rate = { title: "Labor", detail: null, defaultQuantity: "01.000000", unitPrice: "20.500000", unit: "hour", kind: "labor" };
const repository = () => createCloudRecordRepository(env.DB, { authorizationNamespace: namespace, now: () => start });

describe("owned business customer and explicit rates", () => {
  it("creates normalized customers and returns exact receipt after updates and deletion", async () => {
    const { authority } = await setup(); const repo = repository();
    const command = { operationKey: "c:create", expectedRevision: 0, id, value: customer };
    const created = await repo.createCustomer(authority, command);
    expect(created).toMatchObject({ id: id.toLowerCase(), revision: 1, value: { name: "Client %_", email: null } });
    await repo.updateCustomer(authority, { operationKey: "c:update", id, expectedRevision: 1, value: { ...customer, name: "Changed" } });
    await repo.deleteCustomer(authority, { operationKey: "c:delete", id, expectedRevision: 2 });
    expect(await repo.createCustomer(authority, command)).toEqual(created);
    await expect(repo.getCustomer(authority, id)).rejects.toMatchObject({ code: "not_found" });
    await expect(repo.createCustomer(authority, { ...command, operationKey: "c:resurrect" })).rejects.toMatchObject({ code: "revision_conflict" });
    const events = (await env.DB.prepare("SELECT tombstone,revision FROM cloud_record_feed ORDER BY sequence").all()).results;
    expect(events).toEqual([{ tombstone: 0, revision: 1 }, { tombstone: 0, revision: 2 }, { tombstone: 1, revision: 3 }]);
  });
  it("scopes literal searches, stable pagination and customer reads to the owner", async () => {
    const one = await setup(); const two = await setup("two"); const repo = repository();
    await repo.createCustomer(one.authority, { operationKey: "create", expectedRevision: 0, id, value: customer });
    await repo.createCustomer(one.authority, { operationKey: "next", expectedRevision: 0, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", value: customer });
    expect((await repo.searchCustomers(two.authority, { query: "", limit: 10 })).records).toEqual([]);
    await expect(repo.getCustomer(two.authority, id)).rejects.toMatchObject({ code: "not_found" });
    const page = await repo.searchCustomers(one.authority, { query: "%_", limit: 1 });
    expect(page.records.map(r => r.id)).toEqual([id.toLowerCase()]);
    expect((await repo.searchCustomers(one.authority, { query: "%_", limit: 1, afterId: page.nextAfterId! })).records.map(r => r.id)).toEqual(["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]);
    expect((await repo.searchCustomers(one.authority, { query: "' OR 1=1 --", limit: 10 })).records).toEqual([]);
  });
  it("uses a single business identity and shared exact tax normalization", async () => {
    const { authority } = await setup(); const repo = repository();
    const saved = await repo.putBusinessProfile(authority, { operationKey: "business", expectedRevision: 0, value: business });
    expect(saved.id).toBe(authority.businessId);
    expect(saved.value.tax).toEqual({ enabled: false, ratePercent: "0", label: "Sales tax" });
    expect(await repo.getBusinessContext(authority)).toEqual(saved);
    await expect(repo.putBusinessProfile(authority, { operationKey: "stale", expectedRevision: 0, value: business })).rejects.toMatchObject({ code: "revision_conflict" });
  });
  it("requires explicit rate consent and normalizes using shared line arithmetic", async () => {
    const { authority } = await setup(); const repo = repository();
    await expect(repo.putSavedRate(authority, { operationKey: "rate", id, expectedRevision: 0, value: rate, explicitUserRequest: false })).rejects.toMatchObject({ code: "invalid_input" });
    const saved = await repo.putSavedRate(authority, { operationKey: "rate", id, expectedRevision: 0, value: rate, explicitUserRequest: true });
    expect(saved.value).toMatchObject({ defaultQuantity: "1", unitPrice: "20.50" });
    expect(await repo.getSavedRate(authority, id)).toEqual(saved);
    expect((await repo.searchSavedRates(authority, { query: "labor", limit: 10 })).records).toEqual([saved]);
    await repo.deleteSavedRate(authority, { operationKey: "delete", id, expectedRevision: 1 });
    await expect(repo.getSavedRate(authority, id)).rejects.toMatchObject({ code: "not_found" });
  });
  it("allows lapsed reads while denying mutations and revokes both with the approving device", async () => {
    const { authority } = await setup(); const repo = repository();
    await repo.createCustomer(authority, { operationKey: "create", expectedRevision: 0, id, value: customer });
    await env.DB.prepare("UPDATE cloud_entitlements SET state='lapsed'").run();
    expect((await repo.getCustomer(authority, id)).revision).toBe(1);
    await expect(repo.deleteCustomer(authority, { operationKey: "delete", id, expectedRevision: 1 })).rejects.toMatchObject({ code: "entitlement_required" });
    await env.DB.prepare("UPDATE cloud_devices SET status='revoked'").run();
    await expect(repo.getCustomer(authority, id)).rejects.toMatchObject({ code: "not_authorized" });
  });
  it.each([
    { ...customer, taxId: "secret" }, { ...customer, name: "" }, { ...customer, name: "\ud800" },
    { ...customer, name: "x\ny" }, { ...customer, email: "a".repeat(255) },
    { ...customer, billingAddressLines: Array(11).fill("x") },
    { ...customer, savedJobSites: [{ ...customer.savedJobSites[0], latitude: 1 }] },
    { ...customer, savedJobSites: [{ ...customer.savedJobSites[0], addressKind: "residential" }] },
  ])("rejects strict invalid customer shape without writes %#", async value => {
    const { authority } = await setup();
    await expect(repository().createCustomer(authority, { operationKey: "invalid", expectedRevision: 0, id, value })).rejects.toMatchObject({ code: "invalid_input" });
    expect((await env.DB.prepare("SELECT count(*) AS n FROM cloud_record_feed").first<{n:number}>())?.n).toBe(0);
  });
});

it("indexes contact values rather than JSON property names", async () => {
  const { authority } = await setup(); const repo = repository();
  await repo.createCustomer(authority, { operationKey: "create", expectedRevision: 0, value: customer });
  expect((await repo.searchCustomers(authority, { query: "billingAddressLines", limit: 10 })).records).toEqual([]);
});
it("recovers an equal concurrent receipt when async preparation fails", async () => {
  const { authority } = await setup();
  const kernel = createCloudRecordKernel(env.DB, { authorizationNamespace: namespace, now: () => start });
  const command = { operationKey: "concurrent", kind: "customer.create", request: { name: "Original" } };
  const result = await kernel.prepareAndCommit(authority, command, async () => {
    await kernel.commit(authority, command, () => ({ condition: { sql: "1", values: [] }, statements: [], events: [{ kind: "customer", id: "id", revision: 1, payload: {}, tombstone: false }], response: { name: "Original" } }));
    throw new Error("current row no longer available");
  });
  expect(result).toEqual({ name: "Original" });
});
it("resamples authoring eligibility after asynchronous preparation", async () => {
  const { authority } = await setup(); let now = start;
  const kernel = createCloudRecordKernel(env.DB, { authorizationNamespace: namespace, now: () => now });
  await expect(kernel.prepareAndCommit(authority, { operationKey: "expired", kind: "customer.create", request: {} }, async () => {
    now += 300001;
    return () => ({ condition: { sql: "1", values: [] }, statements: [], events: [{ kind: "customer", id: "id", revision: 1, payload: {}, tombstone: false }], response: {} });
  })).rejects.toMatchObject({ code: "entitlement_required" });
  expect((await env.DB.prepare("SELECT count(*) AS n FROM cloud_record_feed").first<{n:number}>())?.n).toBe(0);
});
it("serializes revision races without partial receipts or feed rows", async () => {
  const { authority } = await setup(); const repo = repository();
  await repo.createCustomer(authority, { operationKey: "create", expectedRevision: 0, id, value: customer });
  const outcomes = await Promise.allSettled(["A", "B"].map(name => repo.updateCustomer(authority, { operationKey: name, id, expectedRevision: 1, value: { ...customer, name } })));
  expect(outcomes.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.find(r => r.status === "rejected")).toMatchObject({ reason: { code: "revision_conflict" } });
  expect((await env.DB.prepare("SELECT count(*) AS n FROM cloud_record_feed").first<{n:number}>())?.n).toBe(2);
  expect((await env.DB.prepare("SELECT count(*) AS n FROM cloud_mutation_receipts").first<{n:number}>())?.n).toBe(2);
  expect((await env.DB.prepare("SELECT * FROM cloud_batch_guards").all()).results).toEqual([]);
});
it.each([
  { ...business, timezone: "Not/AZone" }, { ...business, tax: { ...business.tax, ratePercent: "101" } },
  { ...business, businessName: "é".repeat(129) }, { ...business, addressLines: ["x".repeat(1025)] },
  { ...business, paymentTermsSummary: "x".repeat(2049) }, { ...business, website: "x".repeat(2049) },
  { ...business, phone: "x".repeat(65) }, { ...business, tax: { ...business.tax, enabled: "false" } },
])("rejects invalid business values %#", async value => {
  const { authority } = await setup();
  await expect(repository().putBusinessProfile(authority, { operationKey: "invalid", expectedRevision: 0, value })).rejects.toMatchObject({ code: "invalid_input" });
});
it.each([
  { ...rate, unit: "meters" }, { ...rate, kind: "unknown" }, { ...rate, defaultQuantity: "0" },
  { ...rate, unitPrice: 20 }, { ...rate, unitPrice: "1e3" }, { ...rate, detail: "x".repeat(2049) },
  { ...rate, title: "x".repeat(257) }, { ...rate, unitPrice: "0.0000001" },
])("rejects invalid saved rates %#", async value => {
  const { authority } = await setup();
  await expect(repository().putSavedRate(authority, { operationKey: "invalid", expectedRevision: 0, id, explicitUserRequest: true, value })).rejects.toMatchObject({ code: "invalid_input" });
});
it.each([{ query: "x".repeat(201), limit: 1 }, { query: "", limit: 0 }, { query: "", limit: 101 }, { query: "", limit: 1, afterId: "bad" }])("bounds search inputs %#", async input => {
  const { authority } = await setup();
  await expect(repository().searchCustomers(authority, input)).rejects.toMatchObject({ code: "invalid_input" });
});
it("normalizes semantically equal retries and conflicts on different operation intent", async () => {
  const { authority } = await setup(); const repo = repository();
  const created = await repo.createCustomer(authority, { operationKey: "normalized", expectedRevision: 0, id, value: customer });
  expect(await repo.createCustomer(authority, { operationKey: "normalized", expectedRevision: 0, id: id.toLowerCase(), value: { ...customer, name: "Client %_", email: null } })).toEqual(created);
  await expect(repo.createCustomer(authority, { operationKey: "normalized", expectedRevision: 0, id, value: { ...customer, name: "Different" } })).rejects.toMatchObject({ code: "operation_conflict" });
});
it("rolls repository writes back when device revocation wins the final batch", async () => {
  const { authority } = await setup();
  const db = new Proxy(env.DB, { get(target, property) {
    if (property === "batch") return async (statements: D1PreparedStatement[]) => {
      await target.prepare("UPDATE cloud_devices SET status='revoked' WHERE owner_id=?").bind(authority.ownerId).run();
      return target.batch(statements);
    };
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const repo = createCloudRecordRepository(db, { authorizationNamespace: namespace, now: () => start });
  await expect(repo.createCustomer(authority, { operationKey: "revoked", expectedRevision: 0, id, value: customer })).rejects.toMatchObject({ code: "not_authorized" });
  for (const table of ["cloud_customers", "cloud_mutation_receipts", "cloud_record_feed", "cloud_batch_guards"]) expect((await env.DB.prepare(`SELECT * FROM ${table}`).all()).results).toEqual([]);
});
it("preserves unknown units and never creates a second business record", async () => {
  const one = await setup(); const two = await setup("two"); const repo = repository();
  await repo.putBusinessProfile(one.authority, { operationKey: "business", expectedRevision: 0, value: business });
  await expect(repo.getBusinessContext(two.authority)).rejects.toMatchObject({ code: "not_found" });
  await repo.putBusinessProfile(one.authority, { operationKey: "update", expectedRevision: 1, value: { ...business, businessName: "New" } });
  expect((await env.DB.prepare("SELECT * FROM cloud_business_profiles").all()).results).toHaveLength(1);
  const saved = await repo.putSavedRate(one.authority, { operationKey: "rate", expectedRevision: 0, id, explicitUserRequest: true, value: { ...rate, unit: null } });
  expect(saved.value.unit).toBeNull();
});
