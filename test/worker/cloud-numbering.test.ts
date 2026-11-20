import { beforeEach, expect, it } from "vitest";
import { createNumberingPlanner } from "../../src/chatgpt/documents/numbering.js";
import { env, reset, setup } from "./cloud-record-fixtures.js";
beforeEach(reset);
it("plans a server allocation from initialized owner state", async () => {
  const { owner } = await setup();
  await env.DB.prepare("INSERT INTO cloud_number_state VALUES (?,1,1,'',1,1)").bind(owner.ownerId).run();
  const build = await createNumberingPlanner(env.DB).prepareServerAllocation(owner.ownerId, crypto.randomUUID());
  expect(build(1).number).toBe("1");
});

import { createCloudRecordKernel } from "../../src/chatgpt/records/kernel.js";
import { namespace, start } from "./cloud-record-fixtures.js";
import type { NumberMutationPlan } from "../../src/chatgpt/documents/numbering.js";
const planner = () => createNumberingPlanner(env.DB);
const id = () => crypto.randomUUID();
async function seed(owner: string, next = 1, prefix = "", pad = 1, initialized = 1) {
  await env.DB.prepare("INSERT INTO cloud_number_state VALUES (?,?,1,?,?,?)").bind(owner,next,prefix,pad,initialized).run();
}
// Internal guarded fixture only: this is not native device proof.
async function guarded(p: NumberMutationPlan, fail = false) {
  const guard=id();
  return env.DB.batch([
    env.DB.prepare(`INSERT INTO cloud_batch_guards(operation_id,permitted) SELECT ?, CASE WHEN (${p.condition.sql}) THEN 1 ELSE 0 END`).bind(guard,...p.condition.values),
    ...p.statements,
    ...(fail ? [env.DB.prepare("INSERT INTO cloud_batch_guards VALUES ('fail',0)")] : []),
    env.DB.prepare("DELETE FROM cloud_batch_guards WHERE operation_id=?").bind(guard),
  ]);
}
it("allocates padded Unicode numbers per owner and rejects duplicate documents", async () => {
  const a=await setup(), b=await setup("two"); await seed(a.owner.ownerId,1,"票-",3); await seed(b.owner.ownerId,1,"票-",3);
  const doc=id(), p=await planner().prepareServerAllocation(a.owner.ownerId,doc); expect(p(start).number).toBe("票-001"); await guarded(p(start));
  const other=await planner().prepareServerAllocation(b.owner.ownerId,id()); expect(other(start).number).toBe("票-001"); await guarded(other(start));
  await expect(planner().prepareServerAllocation(a.owner.ownerId,doc)).rejects.toMatchObject({code:"number_collision"});
});
it("reserves exactly twenty and consumes only the owned device range", async () => {
  const a=await setup(), b=await setup("two"); await seed(a.owner.ownerId,10,"A",2); await seed(b.owner.ownerId);
  const rid=id(), p=(await planner().prepareReservation(a.owner.ownerId,a.deviceKeyId,rid))(start);
  expect(p.reservation).toMatchObject({startIndex:10,endIndex:29,prefix:"A",padLength:2}); await guarded(p);
  await expect(planner().prepareReservedIssuance(a.owner.ownerId,b.deviceKeyId,rid,10,id())).rejects.toMatchObject({code:"not_authorized"});
  await expect(planner().prepareReservedIssuance(a.owner.ownerId,a.deviceKeyId,rid,30,id())).rejects.toMatchObject({code:"invalid_input"});
  const issue=(await planner().prepareReservedIssuance(a.owner.ownerId,a.deviceKeyId,rid,10,id()))(start); expect(issue.number).toBe("A10"); await guarded(issue);
  await expect(planner().prepareReservedIssuance(a.owner.ownerId,a.deviceKeyId,rid,10,id())).rejects.toMatchObject({code:"number_collision"});
  await env.DB.prepare("UPDATE cloud_devices SET status='revoked' WHERE device_key_id=?").bind(a.deviceKeyId).run();
  await expect(planner().prepareReservedIssuance(a.owner.ownerId,a.deviceKeyId,rid,11,id())).rejects.toMatchObject({code:"not_authorized"});
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_number_reservations WHERE owner_id=?").bind(a.owner.ownerId).first("n")).toBe(1);
});
it("detects cross-format issued and unissued reservation collisions and preserves imports", async () => {
  const a=await setup(); const owner=a.owner.ownerId; await seed(owner,10,"1",1);
  const r=(await planner().prepareReservation(owner,a.deviceKeyId,id()))(start); await guarded(r);
  await env.DB.prepare("UPDATE cloud_number_state SET next_index=110,prefix='',generation=generation+1 WHERE owner_id=?").bind(owner).run();
  await expect(planner().prepareHistoricalIssuance(owner,a.deviceKeyId,id(),"110",null)).rejects.toMatchObject({code:"number_collision"});
  const next=(await planner().prepareServerAllocation(owner,id()))(start); expect(next.number).toBe("130"); await guarded(next);
  const imported=(await planner().prepareHistoricalIssuance(owner,a.deviceKeyId,id(),"  exact-01 ",150))(start); expect(imported.number).toBe("  exact-01 "); await guarded(imported);
  await expect(planner().prepareHistoricalIssuance(owner,a.deviceKeyId,id(),"130",null)).rejects.toMatchObject({code:"number_collision"});
  expect(await env.DB.prepare("SELECT next_index FROM cloud_number_state WHERE owner_id=?").bind(owner).first("next_index")).toBe(151);
});
it("stale plans and later failures roll back all numbering changes", async () => {
  const a=await setup(); await seed(a.owner.ownerId);
  const first=(await planner().prepareServerAllocation(a.owner.ownerId,id()))(start), stale=(await planner().prepareServerAllocation(a.owner.ownerId,id()))(start);
  await guarded(first); await expect(guarded(stale)).rejects.toThrow();
  const later=(await planner().prepareServerAllocation(a.owner.ownerId,id()))(start); await expect(guarded(later,true)).rejects.toThrow();
  expect(await env.DB.prepare("SELECT next_index FROM cloud_number_state WHERE owner_id=?").bind(a.owner.ownerId).first("next_index")).toBe(2);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_issued_numbers WHERE owner_id=?").bind(a.owner.ownerId).first("n")).toBe(1);
});
it("composes numbering with authorized kernel entity receipt and feed rollback", async () => {
  const a=await setup(); const owner=a.owner.ownerId; await seed(owner);
  const k=createCloudRecordKernel(env.DB,{authorizationNamespace:namespace,now:()=>start}); const doc=id();
  const build=await planner().prepareServerAllocation(owner,doc);
  const command={operationKey:"number-test",kind:"document.create",request:{doc}};
  await expect(k.commit(a.authority,command,at=>{const p=build(at); return {...p,statements:[...p.statements,env.DB.prepare("INSERT INTO cloud_customers(owner_id,id,revision,created_at,updated_at,payload,search_text) VALUES (?,?,1,?,?,?,?)").bind(owner,doc,at,at,"{}",""),env.DB.prepare("INSERT INTO cloud_batch_guards VALUES ('failure',0)")],events:[{kind:"document",id:doc,revision:1,payload:{number:p.number},tombstone:false}],response:{number:p.number}};})).rejects.toMatchObject({code:"storage_unavailable"});
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_issued_numbers").first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_customers").first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_mutation_receipts").first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_record_feed").first("n")).toBe(0);
  await k.commit(a.authority,command,at=>{const p=build(at); return {...p,events:[{kind:"document",id:doc,revision:1,payload:{number:p.number},tombstone:false}],response:{number:p.number}};});
});
it("rejects unavailable state, unsafe limits and revoked devices", async () => {
  const a=await setup(); await expect(planner().prepareServerAllocation(a.owner.ownerId,id())).rejects.toMatchObject({code:"not_ready"});
  await seed(a.owner.ownerId,Number.MAX_SAFE_INTEGER);
  await expect(planner().prepareServerAllocation(a.owner.ownerId,id())).rejects.toMatchObject({code:"numbering_exhausted"});
  await expect(planner().prepareReservation(a.owner.ownerId,a.deviceKeyId,id())).rejects.toMatchObject({code:"numbering_exhausted"});
  await env.DB.prepare("UPDATE cloud_devices SET status='revoked'").run();
  await expect(planner().prepareHistoricalIssuance(a.owner.ownerId,a.deviceKeyId,id(),"old",null)).rejects.toMatchObject({code:"not_authorized"});
});
it("rechecks device activity after planning and rejects a stale plan", async () => {
  const a=await setup(); await seed(a.owner.ownerId);
  const p=(await planner().prepareReservation(a.owner.ownerId,a.deviceKeyId,id()))(start);
  await env.DB.prepare("UPDATE cloud_devices SET status='revoked' WHERE device_key_id=?").bind(a.deviceKeyId).run();
  await expect(guarded(p)).rejects.toThrow();
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_number_reservations").first("n")).toBe(0);
});
it("skips issued cross-format numbers when choosing an entire block", async () => {
  const a=await setup(); const owner=a.owner.ownerId; await seed(owner,10,"1");
  await guarded((await planner().prepareServerAllocation(owner,id()))(start));
  await env.DB.prepare("UPDATE cloud_number_state SET next_index=110,prefix='',generation=generation+1 WHERE owner_id=?").bind(owner).run();
  const p=(await planner().prepareReservation(owner,a.deviceKeyId,id()))(start);
  expect(p.reservation?.startIndex).toBe(130); await guarded(p);
});
it("supports importing state and exact historical strings with safe errors", async () => {
  const a=await setup(); await seed(a.owner.ownerId,1,"",1,0);
  await expect(planner().prepareServerAllocation(a.owner.ownerId,id())).rejects.toMatchObject({code:"not_ready"});
  const exact="old\nnumber"; const p=(await planner().prepareHistoricalIssuance(a.owner.ownerId,a.deviceKeyId,id(),exact,null))(start); await guarded(p);
  expect(await env.DB.prepare("SELECT formatted_number FROM cloud_issued_numbers").first("formatted_number")).toBe(exact);
  await expect(planner().prepareHistoricalIssuance(a.owner.ownerId,a.deviceKeyId,id(),"x",Number.MAX_SAFE_INTEGER)).rejects.toMatchObject({code:"numbering_exhausted"});
  await expect(createNumberingPlanner(null as never).prepareServerAllocation(a.owner.ownerId,id())).rejects.toMatchObject({code:"storage_unavailable",message:"storage_unavailable"});
});
it("stops after 256 occupied candidates without modifying state", async () => {
  const a=await setup(); const owner=a.owner.ownerId; await seed(owner);
  const rows=Array.from({length:256},(_,i)=>env.DB.prepare("INSERT INTO cloud_issued_numbers(owner_id,formatted_number,document_id,issued_at) VALUES (?,?,?,?)").bind(owner,String(i+1),id(),start));
  await env.DB.batch(rows);
  await expect(planner().prepareServerAllocation(owner,id())).rejects.toMatchObject({code:"numbering_exhausted"});
  expect(await env.DB.prepare("SELECT next_index FROM cloud_number_state WHERE owner_id=?").bind(owner).first("next_index")).toBe(1);
});

// A forwarding adapter counts binding executions, while all SQL still runs on real D1.
// The simulated Free limit is deliberately larger than the planner's eight-call budget.
function budgetDb() {
  let calls=0;
  const count = () => { if (++calls > 50) throw new Error("simulated invocation query limit"); };
  const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
    get(target, key) {
      if (key === "bind") return (...args: unknown[]) => wrapStatement(target.bind(...args));
      if (key === "first" || key === "all" || key === "run" || key === "raw") return (...args: unknown[]) => { count(); return (target[key] as (...args: unknown[]) => unknown).apply(target,args); };
      const value=Reflect.get(target,key,target); return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const db = new Proxy(env.DB, { get(target,key) {
    if (key === "withSession") return (...args: Parameters<D1Database["withSession"]>) => {
      const session=target.withSession(...args);
      return new Proxy(session, { get(s,k) {
        if (k === "prepare") return (sql: string) => wrapStatement(s.prepare(sql));
        if (k === "batch") return (...batchArgs: Parameters<D1DatabaseSession["batch"]>) => { count(); return s.batch(...batchArgs); };
        const value=Reflect.get(s,k,s); return typeof value === "function" ? value.bind(s) : value;
      }});
    };
    if (key === "prepare") return (sql: string) => wrapStatement(target.prepare(sql));
    if (key === "batch") return (...args: Parameters<D1Database["batch"]>) => { count(); return target.batch(...args); };
    const value=Reflect.get(target,key,target); return typeof value === "function" ? value.bind(target) : value;
  }});
  return {db,calls:()=>calls};
}
async function occupy(owner: string, numbers: number[]) {
  await env.DB.batch(numbers.map(n=>env.DB.prepare("INSERT INTO cloud_issued_numbers(owner_id,formatted_number,document_id,issued_at) VALUES (?,?,?,?)").bind(owner,String(n),id(),start)));
}
it.each(["server-late", "server-exhausted", "reservation-late", "reservation-exhausted"])("bounds real D1 prepare calls for %s", async scenario => {
  const a=await setup(), owner=a.owner.ownerId; await seed(owner);
  const reservation=scenario.startsWith("reservation"), exhausted=scenario.endsWith("exhausted");
  const count=exhausted ? 256 : 200;
  await occupy(owner,Array.from({length:count},(_,i)=>reservation ? 1+i*20 : 1+i));
  const before=await env.DB.prepare("SELECT * FROM cloud_number_state WHERE owner_id=?").bind(owner).first();
  const budget=budgetDb(), p=createNumberingPlanner(budget.db);
  const attempt=reservation ? p.prepareReservation(owner,a.deviceKeyId,id()) : p.prepareServerAllocation(owner,id());
  if (exhausted) await expect(attempt).rejects.toMatchObject({code:"numbering_exhausted"});
  else {
    const plan=(await attempt)(start);
    expect(reservation ? plan.reservation?.startIndex : plan.index).toBe(reservation ? 4001 : 201);
  }
  expect(budget.calls()).toBeLessThanOrEqual(8);
  expect(await env.DB.prepare("SELECT * FROM cloud_number_state WHERE owner_id=?").bind(owner).first()).toEqual(before);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_number_reservations WHERE owner_id=?").bind(owner).first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_issued_numbers WHERE owner_id=?").bind(owner).first("n")).toBe(count);
});
it("requires an owner in numbering state at the storage boundary", async () => {
  await expect(env.DB.prepare("INSERT INTO cloud_number_state VALUES (NULL,1,1,'',1,1)").run()).rejects.toThrow();
});
it("commits exactly one concurrently competing cloud kernel plan", async () => {
  const a=await setup(), owner=a.owner.ownerId; await seed(owner);
  const docs=[id(),id()], builds=await Promise.all(docs.map(doc=>planner().prepareServerAllocation(owner,doc)));
  const k=createCloudRecordKernel(env.DB,{authorizationNamespace:namespace,now:()=>start});
  const race=await Promise.allSettled(builds.map((build,i)=>k.commit(a.authority,{operationKey:`number-race-${i}`,kind:"document.create",request:{id:docs[i]}},at=>{
    const p=build(at); return {...p,statements:[...p.statements,env.DB.prepare("INSERT INTO cloud_customers(owner_id,id,revision,created_at,updated_at,payload,search_text) VALUES (?,?,1,?,?,?,?)").bind(owner,docs[i],at,at,"{}","")],events:[{kind:"document",id:docs[i],revision:1,payload:{number:p.number},tombstone:false}],response:{id:docs[i],number:p.number}};
  })));
  expect(race.filter(x=>x.status==="fulfilled")).toHaveLength(1);
  expect(race.filter(x=>x.status==="rejected")).toHaveLength(1);
  const numbers=(await env.DB.prepare("SELECT * FROM cloud_issued_numbers WHERE owner_id=?").bind(owner).all<{document_id:string}>()).results;
  const customers=(await env.DB.prepare("SELECT id FROM cloud_customers WHERE owner_id=?").bind(owner).all<{id:string}>()).results;
  const receipts=(await env.DB.prepare("SELECT response_snapshot FROM cloud_mutation_receipts WHERE owner_id=?").bind(owner).all<{response_snapshot:string}>()).results;
  const feed=(await env.DB.prepare("SELECT * FROM cloud_record_feed WHERE owner_id=?").bind(owner).all<{id:string;sequence:number}>()).results;
  expect(numbers).toHaveLength(1); expect(customers).toHaveLength(1); expect(receipts).toHaveLength(1); expect(feed).toHaveLength(1);
  expect(customers[0].id).toBe(numbers[0].document_id); expect(feed[0].id).toBe(numbers[0].document_id);
  expect(JSON.parse(receipts[0].response_snapshot)).toEqual({id:numbers[0].document_id,number:"1"});
  expect(await env.DB.prepare("SELECT head_sequence FROM cloud_record_state WHERE owner_id=?").bind(owner).first("head_sequence")).toBe(feed[0].sequence);
  expect(await env.DB.prepare("SELECT next_index FROM cloud_number_state WHERE owner_id=?").bind(owner).first("next_index")).toBe(2);
  expect(await env.DB.prepare("SELECT generation FROM cloud_number_state WHERE owner_id=?").bind(owner).first("generation")).toBe(2);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_batch_guards").first("n")).toBe(0);
});
