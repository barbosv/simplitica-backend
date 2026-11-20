import { isOpaqueIdentifier } from "../accounts/validation.js";
import { RecordError, type SqlCondition } from "../records/types.js";

// These plans are source-only. The caller must combine them with verified authority,
// domain predicates, and all domain writes in one unconditional checked batch.
type State = { next_index: number; generation: number; prefix: string; pad_length: number; initialized: number };
type Reservation = { id: string; deviceKeyId: string; startIndex: number; endIndex: number; prefix: string; padLength: number };
export type NumberMutationPlan = { number: string | null; index: number | null; reservation?: Reservation; condition: SqlCondition; statements: D1PreparedStatement[] };
type Builder = (at: number) => NumberMutationPlan;
const MAX = Number.MAX_SAFE_INTEGER;
const uuid = (v: unknown) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const safe = (v: unknown, min = 1): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min;
// Prefixes must reject ASCII and C1 control characters.
// eslint-disable-next-line no-control-regex
const validText = (v: unknown, max: number, empty = false): v is string => typeof v === "string" && (empty || v.length > 0) && !/[\uD800-\uDFFF]/u.test(v) && !/[\u0000-\u001f\u007f-\u009f]/u.test(v) && new TextEncoder().encode(v).length <= max;
const validNumber = (v: unknown): v is string => typeof v === "string" && v.length > 0 && !/[\uD800-\uDFFF]/u.test(v) && new TextEncoder().encode(v).length <= 128;
const format = (s: State | { prefix: string; pad_length: number }, i: number) => s.prefix + String(i).padStart(s.pad_length, "0");
const fail = (code: ConstructorParameters<typeof RecordError>[0]): never => { throw new RecordError(code); };
function inputs(owner: string, document?: string, device?: string, reservation?: string) {
  if (!isOpaqueIdentifier(owner) || (document !== undefined && !uuid(document)) || (device !== undefined && !isOpaqueIdentifier(device)) || (reservation !== undefined && !uuid(reservation))) fail("invalid_input");
}
// CAST alone accepts noncanonical strings, so membership also requires exact reformatting.
const freeSql = `NOT EXISTS (SELECT 1 FROM cloud_issued_numbers i WHERE i.owner_id=? AND i.formatted_number=c.n)
 AND NOT EXISTS (SELECT 1 FROM cloud_number_reservations r WHERE r.owner_id=? AND c.n=r.prefix || printf('%0*d',r.pad_length,CAST(substr(c.n,length(r.prefix)+1) AS INTEGER)) AND CAST(substr(c.n,length(r.prefix)+1) AS INTEGER) BETWEEN r.start_index AND r.end_index)`;
const candidateSql = `SELECT NOT EXISTS (SELECT 1 FROM (SELECT ? AS n) c WHERE NOT (${freeSql})) AS ok`;
const blockSql = `WITH RECURSIVE candidates(i) AS (SELECT ? UNION ALL SELECT i+1 FROM candidates WHERE i<?) SELECT NOT EXISTS (SELECT 1 FROM (SELECT ? || printf('%0*d',?,i) AS n FROM candidates) c WHERE NOT (${freeSql})) AS ok`;
// Search the complete bounded window in one D1 call. Each block contributes
// exactly width formatted strings, and every string must be unoccupied.
const windowSql = `WITH RECURSIVE offsets(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM offsets WHERE n<?), digits(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM digits WHERE i<?), formatted AS (SELECT offsets.n AS block, ? || printf('%0*d',?,?+offsets.n*?+digits.i) AS n FROM offsets CROSS JOIN digits) SELECT block FROM formatted c GROUP BY block HAVING SUM(CASE WHEN ${freeSql} THEN 0 ELSE 1 END)=0 ORDER BY block LIMIT 1`;
export function createNumberingPlanner(db: D1Database) {
  const read = (sql: string) => db.withSession("first-primary").prepare(sql);
  async function state(owner: string, ready: boolean): Promise<State> {
    const s = await read("SELECT next_index,generation,prefix,pad_length,initialized FROM cloud_number_state WHERE owner_id=?").bind(owner).first<State>();
    if (!s || (ready && s.initialized !== 1)) return fail("not_ready");
    if (!safe(s.next_index) || !safe(s.generation) || !validText(s.prefix,64,true) || !safe(s.pad_length) || s.pad_length > 12 || ![0,1].includes(s.initialized)) return fail("storage_unavailable");
    if (s.generation === MAX) return fail("numbering_exhausted");
    return s;
  }
  async function active(owner: string, device: string) {
    const row = await read("SELECT 1 AS ok FROM cloud_devices WHERE owner_id=? AND device_key_id=? AND status='active'").bind(owner,device).first();
    if (!row) fail("not_authorized");
  }
  async function isFree(owner: string, number: string) {
    const row = await read(candidateSql).bind(number,owner,owner).first<{ok:number}>();
    return row?.ok === 1;
  }
  async function selectOffset(owner: string, s: State, width: number): Promise<number | null> {
    const maxOffset=Math.min(255,Math.floor((MAX-1-s.next_index-(width-1))/width));
    if (maxOffset<0) return null;
    const row=await read(windowSql).bind(maxOffset,width-1,s.prefix,s.pad_length,s.next_index,width,owner,owner).first<{block:number}>();
    return row?.block ?? null;
  }
  async function docFree(owner: string, doc: string) {
    if (await read("SELECT 1 FROM cloud_issued_numbers WHERE owner_id=? AND document_id=?").bind(owner,doc).first()) fail("number_collision");
  }
  function base(owner: string, s: State, device?: string): SqlCondition {
    return { sql: `EXISTS (SELECT 1 FROM cloud_number_state WHERE owner_id=? AND generation=? AND next_index=? AND prefix=? AND pad_length=? AND initialized=?)${device ? " AND EXISTS (SELECT 1 FROM cloud_devices WHERE owner_id=? AND device_key_id=? AND status='active')" : ""}`, values: [owner,s.generation,s.next_index,s.prefix,s.pad_length,s.initialized,...(device ? [owner,device] : [])] };
  }
  function condition(owner: string, s: State, device?: string, extra = "", values: (string|number|null)[] = []): SqlCondition {
    const c = base(owner,s,device); return {sql: c.sql + extra, values: [...c.values,...values]};
  }
  function update(owner: string, next: number) { return db.prepare("UPDATE cloud_number_state SET next_index=?, generation=generation+1 WHERE owner_id=?").bind(next,owner); }
  function issue(owner: string, number: string, doc: string, index: number|null, reservation: string|null, at: number) { return db.prepare("INSERT INTO cloud_issued_numbers(owner_id,formatted_number,document_id,numeric_index,reservation_id,issued_at) VALUES (?,?,?,?,?,?)").bind(owner,number,doc,index,reservation,at); }
  function timestamp(at: number) { if (!safe(at,0)) fail("invalid_input"); }
  const freeCondition = ` AND (${candidateSql}) AND NOT EXISTS (SELECT 1 FROM cloud_issued_numbers WHERE owner_id=? AND document_id=?)`;
  const methods = {
    async prepareServerAllocation(owner: string, doc: string): Promise<Builder> {
      inputs(owner,doc); const s = await state(owner,true); await docFree(owner,doc);
      const offset=await selectOffset(owner,s,1); if (offset===null) return fail("numbering_exhausted");
      const index=s.next_index+offset, number=format(s,index);
      return at => { timestamp(at); return {number,index, condition:condition(owner,s,undefined,freeCondition,[number,owner,owner,owner,doc]),statements:[update(owner,index+1),issue(owner,number,doc,index,null,at)]}; };
    },
    async prepareReservation(owner: string, device: string, id: string): Promise<Builder> {
      inputs(owner,undefined,device,id); const s=await state(owner,true); await active(owner,device);
      if (await read("SELECT 1 FROM cloud_number_reservations WHERE owner_id=? AND id=?").bind(owner,id).first()) fail("number_collision");
      const offset=await selectOffset(owner,s,20); if (offset===null) return fail("numbering_exhausted");
      const start=s.next_index+offset*20, end=start+19;
      const reservation={id,deviceKeyId:device,startIndex:start,endIndex:end,prefix:s.prefix,padLength:s.pad_length};
      return at => { timestamp(at); return {number:null,index:null,reservation,condition:condition(owner,s,device,` AND (${blockSql}) AND NOT EXISTS (SELECT 1 FROM cloud_number_reservations WHERE owner_id=? AND id=?)`,[start,end,s.prefix,s.pad_length,owner,owner,owner,id]),statements:[update(owner,end+1),db.prepare("INSERT INTO cloud_number_reservations(owner_id,id,device_key_id,start_index,end_index,prefix,pad_length,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(owner,id,device,start,end,s.prefix,s.pad_length,at)]}; };
    },
    async prepareReservedIssuance(owner: string, device: string, id: string, index: number, doc: string): Promise<Builder> {
      inputs(owner,doc,device,id); if (!safe(index)) fail("invalid_input"); const s=await state(owner,true); await active(owner,device);
      const r=await read("SELECT device_key_id,start_index,end_index,prefix,pad_length FROM cloud_number_reservations WHERE owner_id=? AND id=?").bind(owner,id).first<{device_key_id:string;start_index:number;end_index:number;prefix:string;pad_length:number}>();
      if (!r) return fail("not_found"); if (r.device_key_id!==device) return fail("not_authorized"); if (index<r.start_index || index>r.end_index) return fail("invalid_input");
      if (!validText(r.prefix,64,true) || !safe(r.pad_length) || r.pad_length>12) return fail("storage_unavailable");
      const number=format(r,index); await docFree(owner,doc);
      if (await read("SELECT 1 FROM cloud_issued_numbers WHERE owner_id=? AND formatted_number=?").bind(owner,number).first()) fail("number_collision");
      return at => { timestamp(at); return {number,index,condition:condition(owner,s,device,` AND EXISTS (SELECT 1 FROM cloud_number_reservations WHERE owner_id=? AND id=? AND device_key_id=? AND start_index=? AND end_index=? AND prefix=? AND pad_length=?) AND NOT EXISTS (SELECT 1 FROM cloud_issued_numbers WHERE owner_id=? AND (formatted_number=? OR document_id=?))`,[owner,id,device,r.start_index,r.end_index,r.prefix,r.pad_length,owner,number,doc]),statements:[update(owner,s.next_index),issue(owner,number,doc,index,id,at)]}; };
    },
    async prepareHistoricalIssuance(owner: string, device: string, doc: string, number: string, hint: number|null): Promise<Builder> {
      inputs(owner,doc,device); if (!validNumber(number) || (hint!==null && !safe(hint))) fail("invalid_input");
      const s=await state(owner,false); await active(owner,device); await docFree(owner,doc); if (!await isFree(owner,number)) fail("number_collision");
      if (hint===MAX) fail("numbering_exhausted"); const next=hint===null?s.next_index:Math.max(s.next_index,hint+1);
      return at => { timestamp(at); return {number,index:hint,condition:condition(owner,s,device,freeCondition,[number,owner,owner,owner,doc]),statements:[update(owner,next),issue(owner,number,doc,hint,null,at)]}; };
    }
  };
  // Never leak provider or SQL details from a failed preparation.
  const protect = <A extends unknown[]>(fn: (...args: A) => Promise<Builder>) => async (...args: A): Promise<Builder> => {
    try { return await fn(...args); } catch (error) { if (error instanceof RecordError) throw error; return fail("storage_unavailable"); }
  };
  return {
    prepareServerAllocation: protect(methods.prepareServerAllocation),
    prepareReservation: protect(methods.prepareReservation),
    prepareReservedIssuance: protect(methods.prepareReservedIssuance),
    prepareHistoricalIssuance: protect(methods.prepareHistoricalIssuance),
  };
}
