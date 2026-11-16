import { beforeEach, expect, it } from "vitest";
import { createCloudRecordRepository } from "../../src/chatgpt/records/repository.js";
import { createCloudDocumentRepository } from "../../src/chatgpt/documents/repository.js";
import { env, namespace, reset, setup, start } from "./cloud-record-fixtures.js";
beforeEach(reset);
const customerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const business = { businessName: "Business", addressLines: [], tax: { enabled: false, ratePercent: "10", label: "Tax" }, timezone: "America/New_York" };
const customer = { name: "Client", billingAddressLines: [], savedJobSites: [] };
const input = { documentType: "invoice", issueDate: "2024-02-29", serviceDate: null, dueDate: null, title: "Invoice", notes: null, paymentTermsSummary: null, jobSiteId: null, lines: [{ title: "Work", detail: null, quantity: "2", unitPrice: "4", unit: "hour", kind: "labor" }], discountAmount: "0" };
it("creates an atomic numbered draft from signed current authority", async () => {
  const { authority, owner } = await setup();
  const records = createCloudRecordRepository(env.DB, { authorizationNamespace: namespace, now: () => start });
  await records.putBusinessProfile(authority, { operationKey: "business", expectedRevision: 0, value: business });
  await records.createCustomer(authority, { operationKey: "customer", expectedRevision: 0, id: customerId, value: customer });
  await env.DB.prepare("INSERT INTO cloud_number_state VALUES (?,1,1,'INV-',3,1)").bind(owner.ownerId).run();
  const repo = createCloudDocumentRepository(env.DB, { authorizationNamespace: namespace, now: () => start });
  const result = await repo.createDocument(authority, { operationKey: "create", businessRevision: 1, customerId, customerRevision: 1, input });
  expect(result).toMatchObject({ revision: 1, value: { number: "INV-001", taxAmount: "0.00", total: "8.00", businessSnapshot: { tax: { ratePercent: "10" } } } });
});

async function fixture() {
  const setupResult = await setup();
  const records = createCloudRecordRepository(env.DB, { authorizationNamespace: namespace, now: () => start });
  await records.putBusinessProfile(setupResult.authority, { operationKey: "business", expectedRevision: 0, value: business });
  await records.createCustomer(setupResult.authority, { operationKey: "customer", expectedRevision: 0, id: customerId, value: customer });
  await env.DB.prepare("INSERT INTO cloud_number_state VALUES (?,1,1,'N-',3,1)").bind(setupResult.owner.ownerId).run();
  return { ...setupResult, records, repo: createCloudDocumentRepository(env.DB, { authorizationNamespace: namespace, now: () => start }) };
}
const request = (operationKey: string, documentType = "invoice") => ({ operationKey, businessRevision: 1, customerId, customerRevision: 1, input: { ...input, documentType } });
it("replays the original create after an edit and enforces owner and entitlement", async () => {
  const f = await fixture(); const other = await setup("two");
  const created = await f.repo.createDocument(f.authority, request("create"));
  const updated = await f.repo.updateDocument(f.authority, { operationKey: "update", id: created.id, expectedRevision: 1, patch: { title: "Changed" } });
  expect(updated).toMatchObject({ revision: 2, value: { title: "Changed", number: "N-001" } });
  expect(await f.repo.createDocument(f.authority, request("create"))).toEqual(created);
  await expect(f.repo.createDocument(f.authority, { ...request("create"), customerRevision: 2 })).rejects.toMatchObject({ code: "operation_conflict" });
  await expect(f.repo.getDocument(other.authority, created.id)).rejects.toMatchObject({ code: "not_found" });
  await env.DB.prepare("UPDATE cloud_entitlements SET state='lapsed' WHERE owner_id=?").bind(f.owner.ownerId).run();
  expect(await f.repo.getDocument(f.authority, created.id)).toEqual(updated);
  await expect(f.repo.createDocument(f.authority, request("new"))).rejects.toMatchObject({ code: "entitlement_required" });
  await env.DB.prepare("UPDATE cloud_devices SET status='revoked' WHERE owner_id=?").bind(f.owner.ownerId).run();
  await expect(f.repo.getDocument(f.authority, created.id)).rejects.toMatchObject({ code: "not_authorized" });
});
it("freezes snapshots, resets customer sites, and restricts edits to drafts", async () => {
  const f = await fixture();
  const site = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", nextCustomer = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  await f.records.updateCustomer(f.authority,{operationKey:"site",id:customerId,expectedRevision:1,value:{...customer,savedJobSites:[{id:site,addressKind:"jobSite",displayAddress:"Old site"}]}});
  await f.records.createCustomer(f.authority,{operationKey:"other",expectedRevision:0,id:nextCustomer,value:{...customer,name:"Next"}});
  const created=await f.repo.createDocument(f.authority,{...request("create"),customerRevision:2,input:{...input,jobSiteId:site}});
  await f.records.putBusinessProfile(f.authority,{operationKey:"business-change",expectedRevision:1,value:{...business,businessName:"New",tax:{enabled:true,ratePercent:"20",label:"Tax"}}});
  const updated=await f.repo.updateDocument(f.authority,{operationKey:"change",id:created.id,expectedRevision:1,patch:{customerSelection:{id:nextCustomer,expectedRevision:1},title:"Changed"}});
  expect(updated.value).toMatchObject({customerSnapshot:{name:"Next"},jobSite:null,businessSnapshot:{businessName:"Business",tax:{ratePercent:"10"}},taxAmount:"0.00"});
  await expect(f.repo.updateDocument(f.authority,{operationKey:"stale",id:created.id,expectedRevision:1,patch:{title:"bad"}})).rejects.toMatchObject({code:"revision_conflict"});
  await expect(f.repo.updateDocument(f.authority,{operationKey:"bad",id:created.id,expectedRevision:2,patch:{state:"paid"}})).rejects.toMatchObject({code:"invalid_input"});
  await env.DB.prepare("UPDATE cloud_documents SET state='paid' WHERE owner_id=? AND id=?").bind(f.owner.ownerId,created.id).run();
  await expect(f.repo.updateDocument(f.authority,{operationKey:"paid",id:created.id,expectedRevision:2,patch:{title:"bad"}})).rejects.toMatchObject({code:"revision_conflict"});
});
it.each(["draft","finalized","sent"])("converts a %s estimate once without changing its source", async state => {
  const f=await fixture(); const estimate=await f.repo.createDocument(f.authority,request("estimate","estimate"));
  await env.DB.prepare("UPDATE cloud_documents SET state=? WHERE owner_id=? AND id=?").bind(state,f.owner.ownerId,estimate.id).run();
  const before=await env.DB.prepare("SELECT * FROM cloud_documents WHERE owner_id=? AND id=?").bind(f.owner.ownerId,estimate.id).first();
  const args={operationKey:"convert",id:estimate.id,expectedRevision:1,issueDate:"2024-03-01",dueDate:null};
  const invoice=await f.repo.convertEstimateToInvoice(f.authority,args);
  expect(invoice.value).toMatchObject({documentType:"invoice",state:"draft",number:"N-002",convertedFrom:{id:estimate.id,revision:1},lines:estimate.value.lines,total:estimate.value.total});
  expect(await f.repo.convertEstimateToInvoice(f.authority,args)).toEqual(invoice);
  await expect(f.repo.convertEstimateToInvoice(f.authority,{...args,operationKey:"second"})).rejects.toMatchObject({code:"revision_conflict"});
  expect(await env.DB.prepare("SELECT * FROM cloud_documents WHERE owner_id=? AND id=?").bind(f.owner.ownerId,estimate.id).first()).toEqual(before);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_estimate_conversions").first("n")).toBe(1);
});
it("serializes concurrent numbered creates and equal operation retries", async () => {
  const f=await fixture();
  const [a,b]=await Promise.all([f.repo.createDocument(f.authority,request("a")),f.repo.createDocument(f.authority,request("b"))]);
  expect(new Set([a.value.number,b.value.number])).toEqual(new Set(["N-001","N-002"]));
  const [c,d]=await Promise.all([f.repo.createDocument(f.authority,request("same")),f.repo.createDocument(f.authority,request("same"))]);
  expect(c).toEqual(d);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_documents").first("n")).toBe(3);
});
it("rolls back numbering and all domain writes on a real failing late statement", async () => {
  const f=await fixture();
  const before=await Promise.all(["cloud_number_state","cloud_issued_numbers","cloud_documents","cloud_estimate_conversions","cloud_mutation_receipts","cloud_record_feed","cloud_record_state","cloud_batch_guards"].map(async table=>(await env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results));
  const db=new Proxy(env.DB,{get(target,key){ if(key==="batch") return (statements:D1PreparedStatement[])=>target.batch([...statements, target.prepare("INSERT INTO cloud_batch_guards VALUES ('failure',0)")]); const v=Reflect.get(target,key,target); return typeof v==="function"?v.bind(target):v; }});
  const repo=createCloudDocumentRepository(db,{authorizationNamespace:namespace,now:()=>start});
  await expect(repo.createDocument(f.authority,request("failure"))).rejects.toMatchObject({code:"storage_unavailable"});
  const after=await Promise.all(["cloud_number_state","cloud_issued_numbers","cloud_documents","cloud_estimate_conversions","cloud_mutation_receipts","cloud_record_feed","cloud_record_state","cloud_batch_guards"].map(async table=>(await env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results));
  expect(after).toEqual(before);
});
it("does not rebase changed source revisions after planning", async () => {
  const f=await fixture(); let calls=0;
  const db=new Proxy(env.DB,{get(target,key){ if(key==="batch") return async (statements:D1PreparedStatement[])=>{ calls++; await target.prepare("UPDATE cloud_customers SET revision=revision+1 WHERE owner_id=? AND id=?").bind(f.owner.ownerId,customerId).run(); return target.batch(statements); }; const v=Reflect.get(target,key,target); return typeof v==="function"?v.bind(target):v; }});
  const repo=createCloudDocumentRepository(db,{authorizationNamespace:namespace,now:()=>start});
  await expect(repo.createDocument(f.authority,request("source-change"))).rejects.toMatchObject({code:"revision_conflict"});
  expect(calls).toBe(1);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_documents").first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT next_index FROM cloud_number_state").first("next_index")).toBe(1);
});
it("bounds number conflict attempts to three without changing source intent", async () => {
  const f=await fixture(); let calls=0;
  const db=new Proxy(env.DB,{get(target,key){ if(key==="batch") return async (statements:D1PreparedStatement[])=>{ calls++; await target.prepare("UPDATE cloud_number_state SET generation=generation+1 WHERE owner_id=?").bind(f.owner.ownerId).run(); return target.batch(statements); }; const v=Reflect.get(target,key,target); return typeof v==="function"?v.bind(target):v; }});
  const repo=createCloudDocumentRepository(db,{authorizationNamespace:namespace,now:()=>start});
  await expect(repo.createDocument(f.authority,request("conflicts"))).rejects.toMatchObject({code:"revision_conflict"});
  expect(calls).toBe(3);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_documents").first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT next_index FROM cloud_number_state").first("next_index")).toBe(1);
});
it("rejects legacy conversions instead of recalculating historical amounts", async () => {
  const f=await fixture(); const estimate=await f.repo.createDocument(f.authority,request("estimate","estimate"));
  await env.DB.prepare("UPDATE cloud_documents SET payload=json_set(payload,'$.calculationVersion','legacy') WHERE owner_id=? AND id=?").bind(f.owner.ownerId,estimate.id).run();
  await expect(f.repo.convertEstimateToInvoice(f.authority,{operationKey:"legacy",id:estimate.id,expectedRevision:1,issueDate:"2024-03-01",dueDate:null})).rejects.toMatchObject({code:"invalid_input"});
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_estimate_conversions").first("n")).toBe(0);
});
it("allows only one invoice under competing conversion operations", async () => {
  const f=await fixture(), estimate=await f.repo.createDocument(f.authority,request("estimate","estimate"));
  const args={id:estimate.id,expectedRevision:1,issueDate:"2024-03-01",dueDate:null};
  const outcomes=await Promise.allSettled([f.repo.convertEstimateToInvoice(f.authority,{...args,operationKey:"one"}),f.repo.convertEstimateToInvoice(f.authority,{...args,operationKey:"two"})]);
  expect(outcomes.filter(x=>x.status==="fulfilled")).toHaveLength(1);
  expect(outcomes.filter(x=>x.status==="rejected")).toHaveLength(1);
  const rejection=outcomes.find(x=>x.status==="rejected") as PromiseRejectedResult;
  expect(rejection.reason).toMatchObject({code:"revision_conflict"});
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_estimate_conversions").first("n")).toBe(1);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_documents").first("n")).toBe(2);
});
it("replays receipts after deletion and validates max source references", async () => {
  const f=await fixture();
  await env.DB.prepare("UPDATE cloud_business_profiles SET revision=? WHERE owner_id=?").bind(Number.MAX_SAFE_INTEGER,f.owner.ownerId).run();
  await env.DB.prepare("UPDATE cloud_customers SET revision=? WHERE owner_id=?").bind(Number.MAX_SAFE_INTEGER,f.owner.ownerId).run();
  const args={...request("max"),businessRevision:Number.MAX_SAFE_INTEGER,customerRevision:Number.MAX_SAFE_INTEGER};
  const created=await f.repo.createDocument(f.authority,args);
  await env.DB.prepare("UPDATE cloud_documents SET deleted_at=? WHERE owner_id=? AND id=?").bind(start,f.owner.ownerId,created.id).run();
  expect(await f.repo.createDocument(f.authority,args)).toEqual(created);
  await expect(f.repo.getDocument(f.authority,created.id)).rejects.toMatchObject({code:"not_found"});
});
it("replays equal concurrent conversions and rejects unequal requests with the same key", async () => {
  const f=await fixture(), estimate=await f.repo.createDocument(f.authority,request("estimate","estimate"));
  const args={operationKey:"convert",id:estimate.id,expectedRevision:1,issueDate:"2024-03-01",dueDate:null};
  const [one,two]=await Promise.all([f.repo.convertEstimateToInvoice(f.authority,args),f.repo.convertEstimateToInvoice(f.authority,args)]);
  expect(one).toEqual(two);
  await expect(f.repo.convertEstimateToInvoice(f.authority,{...args,dueDate:"2024-03-02"})).rejects.toMatchObject({code:"operation_conflict"});
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_estimate_conversions").first("n")).toBe(1);
});
it("rolls back the conversion link and issued number on a late real D1 failure", async () => {
  const f=await fixture(), estimate=await f.repo.createDocument(f.authority,request("estimate","estimate"));
  const tables=["cloud_number_state","cloud_issued_numbers","cloud_documents","cloud_estimate_conversions","cloud_mutation_receipts","cloud_record_feed","cloud_record_state","cloud_batch_guards"];
  const snapshot=()=>Promise.all(tables.map(async table=>(await env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results));
  const before=await snapshot();
  const db=new Proxy(env.DB,{get(target,key){ if(key==="batch") return (statements:D1PreparedStatement[])=>target.batch([...statements,target.prepare("INSERT INTO cloud_batch_guards VALUES ('failure',0)")]); const v=Reflect.get(target,key,target); return typeof v==="function"?v.bind(target):v; }});
  const repo=createCloudDocumentRepository(db,{authorizationNamespace:namespace,now:()=>start});
  await expect(repo.convertEstimateToInvoice(f.authority,{operationKey:"fail",id:estimate.id,expectedRevision:1,issueDate:"2024-03-01",dueDate:null})).rejects.toMatchObject({code:"storage_unavailable"});
  expect(await snapshot()).toEqual(before);
});
it("rejects a non-authored estimate even when it claims v1", async () => {
  const f=await fixture(), estimate=await f.repo.createDocument(f.authority,request("estimate","estimate"));
  await env.DB.prepare("UPDATE cloud_documents SET payload=json_set(payload,'$.createdBy','native') WHERE owner_id=? AND id=?").bind(f.owner.ownerId,estimate.id).run();
  await expect(f.repo.convertEstimateToInvoice(f.authority,{operationKey:"native",id:estimate.id,expectedRevision:1,issueDate:"2024-03-01",dueDate:null})).rejects.toMatchObject({code:"invalid_input"});
});
it("separates numbers by owner and rejects unequal concurrent use of one operation key", async () => {
  const f=await fixture(), other=await setup("two");
  await f.records.putBusinessProfile(other.authority,{operationKey:"business",expectedRevision:0,value:business});
  await f.records.createCustomer(other.authority,{operationKey:"customer",expectedRevision:0,id:customerId,value:customer});
  await env.DB.prepare("INSERT INTO cloud_number_state VALUES (?,1,1,'N-',3,1)").bind(other.owner.ownerId).run();
  const race=await Promise.allSettled([f.repo.createDocument(f.authority,request("race")),f.repo.createDocument(f.authority,{...request("race"),input:{...input,title:"Different"}})]);
  expect(race.filter(x=>x.status==="fulfilled")).toHaveLength(1);
  const rejected=race.find(x=>x.status==="rejected") as PromiseRejectedResult;
  expect(rejected.reason).toMatchObject({code:"operation_conflict"});
  const otherDocument=await f.repo.createDocument(other.authority,request("own"));
  expect(otherDocument.value.number).toBe("N-001");
});
it("rejects incrementing a maximum document revision", async () => {
  const f=await fixture(), created=await f.repo.createDocument(f.authority,request("create"));
  await env.DB.prepare("UPDATE cloud_documents SET revision=? WHERE owner_id=? AND id=?").bind(Number.MAX_SAFE_INTEGER,f.owner.ownerId,created.id).run();
  await expect(f.repo.updateDocument(f.authority,{operationKey:"max-update",id:created.id,expectedRevision:Number.MAX_SAFE_INTEGER,patch:{title:"changed"}})).rejects.toMatchObject({code:"invalid_input"});
});
