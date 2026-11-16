import { requireRecordAuthority, type CloudRecordAuthority } from "../records/authority.js";
import { createCloudRecordKernel } from "../records/kernel.js";
import { encodeRecordJSON } from "../records/json.js";
import type { VersionedRecord } from "../records/repository.js";
import { RecordError, type JsonValue, type SqlCondition } from "../records/types.js";
import { invalid, object, revision, uuid, type Customer } from "../records/validation.js";
import { createNumberingPlanner } from "./numbering.js";
import { buildDocumentPreview, createDocumentPreviewService } from "./preview.js";
import { normalizeDocumentInput, readReferenceRevision } from "./validation.js";
import type { DocumentValue } from "./types.js";

type Row = { id: string; revision: number; created_at: number; updated_at: number; deleted_at: number | null; payload: string; state: DocumentValue["state"]; document_type: "invoice" | "estimate" };
const json = (v: unknown): JsonValue => JSON.parse(encodeRecordJSON(v)) as JsonValue;
const rowRecord = (r: Row): VersionedRecord<DocumentValue> => {
  try { return { id: r.id, revision: r.revision, createdAt: r.created_at, updatedAt: r.updated_at, deletedAt: r.deleted_at, value: { ...JSON.parse(r.payload) as DocumentValue, state: r.state, documentType: r.document_type } }; }
  catch { throw new RecordError("storage_unavailable"); }
};
const source = (v: DocumentValue) => ({ documentType: v.documentType, issueDate: v.issueDate, serviceDate: v.serviceDate, dueDate: v.dueDate, title: v.title, notes: v.notes, paymentTermsSummary: v.paymentTermsSummary, jobSiteId: v.jobSite?.id ?? null, lines: v.lines.map(({ id, title, detail, quantity, unitPrice, unit, kind, reportedProvenance }) => ({ ...(id === null ? {} : { id }), title, detail, quantity, unitPrice, unit, kind, reportedProvenance: { kind: reportedProvenance.kind, reference: reportedProvenance.reference, asOf: reportedProvenance.asOf } })), discountAmount: v.discountAmount });
const fields = ["title", "issueDate", "serviceDate", "dueDate", "notes", "paymentTermsSummary", "lines", "discountAmount", "jobSiteId"];
const dummy = { documentType: "invoice", issueDate: "2000-01-01", serviceDate: null, dueDate: null, title: "placeholder", notes: null, paymentTermsSummary: null, jobSiteId: null, lines: [{ title: "placeholder", detail: null, quantity: "1", unitPrice: "0", unit: null, kind: "other" }], discountAmount: "0" };
// Normalize each patch before receipt lookup while deferring relationships between
// independently omitted dates and the stored document until it is loaded.
function normalizePatch(value: unknown) {
  const raw = object(value, [], [...fields, "customerSelection"]);
  if (!Object.keys(raw).length) return invalid();
  const out: Record<string, unknown> = {};
  for (const key of fields) if (Object.hasOwn(raw, key)) {
    const seed = { ...dummy, [key]: raw[key], ...(key === "dueDate" && raw[key] !== null ? { issueDate: "0001-01-01" } : {}) };
    out[key] = normalizeDocumentInput(seed)[key as keyof typeof dummy];
  }
  if (typeof out.issueDate === "string" && typeof out.dueDate === "string" && out.dueDate < out.issueDate) return invalid();
  if (Object.hasOwn(raw, "customerSelection")) {
    const c = object(raw.customerSelection, ["id", "expectedRevision"]);
    out.customerSelection = { id: uuid(c.id), expectedRevision: readReferenceRevision(c.expectedRevision) };
  }
  return out;
}
export function createCloudDocumentRepository(db: D1Database, dependencies: { authorizationNamespace: string; now?: () => number }) {
  const kernel = createCloudRecordKernel(db, dependencies), planner = createNumberingPlanner(db);
  const preview = createDocumentPreviewService(db, dependencies);
  const owned = async (a: CloudRecordAuthority, id: string, authoring: boolean) => {
    const read = authoring ? kernel.readAuthoring : kernel.readOwned;
    const rows = await read<Row>(a, db.prepare("SELECT id,revision,created_at,updated_at,deleted_at,payload,state,document_type FROM cloud_documents WHERE owner_id=? AND id=? AND deleted_at IS NULL").bind(a.ownerId,id));
    if (!rows[0]) throw new RecordError("not_found");
    return rows[0];
  };
  const documentCondition = (a: CloudRecordAuthority, id: string, rev: number, state?: string): SqlCondition => ({ sql: `EXISTS(SELECT 1 FROM cloud_documents WHERE owner_id=? AND id=? AND revision=? AND deleted_at IS NULL${state ? " AND state=?" : ""})`, values: [a.ownerId,id,rev,...(state ? [state] : [])] });
  const numbered = async (a: CloudRecordAuthority, command: { operationKey: string; kind: string; request: JsonValue }, prepare: () => Promise<(at: number) => import("../records/types.js").MutationPlan>, checkIntent: () => Promise<void>) => {
    for (let i=0; ; i++) {
      try { return await kernel.prepareAndCommit(a,command,prepare); }
      catch (e) { if (!(e instanceof RecordError) || e.code !== "revision_conflict" || i >= 2) throw e; await checkIntent(); }
    }
  };
  const insert = (a: CloudRecordAuthority, id: string, value: DocumentValue, at: number) => db.prepare("INSERT INTO cloud_documents(owner_id,id,number,document_type,state,revision,created_at,updated_at,payload) VALUES (?,?,?,?,?,1,?,?,?)").bind(a.ownerId,id,value.number,value.documentType,value.state,at,at,encodeRecordJSON(value));
  const event = (record: VersionedRecord<DocumentValue>) => ({ kind: "document", id: record.id, revision: record.revision, payload: json(record), tombstone: false });
  return {
    async getDocument(a: CloudRecordAuthority, rawId: string): Promise<VersionedRecord<DocumentValue>> {
      requireRecordAuthority(a,dependencies.authorizationNamespace);
      return rowRecord(await owned(a,uuid(rawId),false));
    },
    async createDocument(a: CloudRecordAuthority, request: unknown): Promise<VersionedRecord<DocumentValue>> {
      requireRecordAuthority(a,dependencies.authorizationNamespace);
      const r=object(request,["operationKey","businessRevision","customerId","customerRevision","input"]);
      const businessRevision=readReferenceRevision(r.businessRevision), customerId=uuid(r.customerId), customerRevision=readReferenceRevision(r.customerRevision), input=normalizeDocumentInput(r.input);
      const command={operationKey:r.operationKey as string,kind:"document.create",request:json({businessRevision,customerId,customerRevision,input})};
      return await numbered(a,command,async () => {
        const id=crypto.randomUUID();
        const value=await preview.previewDocument(a,{businessRevision,customerId,customerRevision,input});
        value.lines=value.lines.map(line=>({...line,id:line.id ?? crypto.randomUUID()}));
        const build=await planner.prepareServerAllocation(a.ownerId,id);
        return at => {
          const n=build(at); value.number=n.number;
          const record: VersionedRecord<DocumentValue>={id,revision:1,createdAt:at,updatedAt:at,deletedAt:null,value};
          return { condition:{sql:`(${n.condition.sql}) AND EXISTS(SELECT 1 FROM cloud_business_profiles WHERE owner_id=? AND id=? AND revision=? AND deleted_at IS NULL) AND EXISTS(SELECT 1 FROM cloud_customers WHERE owner_id=? AND id=? AND revision=? AND deleted_at IS NULL)`,values:[...n.condition.values,a.ownerId,a.businessId,businessRevision,a.ownerId,customerId,customerRevision]}, statements:[...n.statements,insert(a,id,value,at)],events:[event(record)],response:json(record) };
        };
      }, async () => { await preview.previewDocument(a,{businessRevision,customerId,customerRevision,input}); }) as VersionedRecord<DocumentValue>;
    },
    async updateDocument(a: CloudRecordAuthority, request: unknown): Promise<VersionedRecord<DocumentValue>> {
      requireRecordAuthority(a,dependencies.authorizationNamespace);
      const r=object(request,["operationKey","id","expectedRevision","patch"]), id=uuid(r.id), expectedRevision=revision(r.expectedRevision), patch=normalizePatch(r.patch);
      const command={operationKey:r.operationKey as string,kind:"document.update",request:json({id,expectedRevision,patch})};
      return await kernel.prepareAndCommit(a,command,async () => {
        const row=await owned(a,id,true); if (row.revision!==expectedRevision || row.state!=="draft") throw new RecordError("revision_conflict");
        const old=rowRecord(row), v=old.value;
        if (v.calculationVersion!=="usd-line-cents-v1" || v.createdBy!=="chatgpt") return invalid();
        const selection=patch.customerSelection as {id:string;expectedRevision:number}|undefined;
        let customer={id:v.customerId,revision:v.customerRevision,createdAt:0,updatedAt:0,deletedAt:null,value:v.customerSnapshot} as VersionedRecord<Customer>;
        if (selection) {
          const rows=await kernel.readAuthoring<{id:string;revision:number;created_at:number;updated_at:number;payload:string}>(a,db.prepare("SELECT id,revision,created_at,updated_at,payload FROM cloud_customers WHERE owner_id=? AND id=? AND deleted_at IS NULL").bind(a.ownerId,selection.id));
          if (!rows[0]) throw new RecordError("not_found"); if (rows[0].revision!==selection.expectedRevision) throw new RecordError("revision_conflict");
          try { customer={id:rows[0].id,revision:rows[0].revision,createdAt:rows[0].created_at,updatedAt:rows[0].updated_at,deletedAt:null,value:JSON.parse(rows[0].payload) as Customer}; } catch { throw new RecordError("storage_unavailable"); }
        }
        const { customerSelection: _selection, ...changes }=patch; void _selection;
        const merged={...source(v),...(selection && selection.id!==v.customerId && !Object.hasOwn(changes,"jobSiteId") ? {jobSiteId:null}:{}),...changes};
        const next=buildDocumentPreview(merged,{id:a.businessId,revision:v.businessRevision,createdAt:0,updatedAt:0,deletedAt:null,value:v.businessSnapshot},customer);
        next.lines=next.lines.map(line=>({...line,id:line.id ?? crypto.randomUUID()}));
        Object.assign(next,{number:v.number,state:v.state,requiresNativeReview:true,createdBy:v.createdBy,convertedFrom:v.convertedFrom});
        return at => {
          const record: VersionedRecord<DocumentValue>={id,revision:expectedRevision+1,createdAt:row.created_at,updatedAt:at,deletedAt:null,value:next};
          const c=documentCondition(a,id,expectedRevision,"draft");
          if (selection) { c.sql+=" AND EXISTS(SELECT 1 FROM cloud_customers WHERE owner_id=? AND id=? AND revision=? AND deleted_at IS NULL)"; c.values.push(a.ownerId,selection.id,selection.expectedRevision); }
          return {condition:c,statements:[db.prepare("UPDATE cloud_documents SET revision=?,updated_at=?,payload=? WHERE owner_id=? AND id=? AND revision=? AND state='draft' AND deleted_at IS NULL").bind(record.revision,at,encodeRecordJSON(next),a.ownerId,id,expectedRevision)],events:[event(record)],response:json(record)};
        };
      }) as VersionedRecord<DocumentValue>;
    },
    async convertEstimateToInvoice(a: CloudRecordAuthority, request: unknown): Promise<VersionedRecord<DocumentValue>> {
      requireRecordAuthority(a,dependencies.authorizationNamespace);
      const r=object(request,["operationKey","id","expectedRevision","issueDate","dueDate"]), id=uuid(r.id), expectedRevision=readReferenceRevision(r.expectedRevision);
      const dates=normalizeDocumentInput({...dummy,issueDate:r.issueDate,dueDate:r.dueDate});
      const command={operationKey:r.operationKey as string,kind:"document.convert",request:json({id,expectedRevision,issueDate:dates.issueDate,dueDate:dates.dueDate})};
      return await numbered(a,command,async () => {
        const row=await owned(a,id,true); if (row.revision!==expectedRevision || row.document_type!=="estimate") throw new RecordError("revision_conflict");
        const old=rowRecord(row).value; if (old.calculationVersion!=="usd-line-cents-v1" || old.createdBy!=="chatgpt") return invalid();
        const newId=crypto.randomUUID(), build=await planner.prepareServerAllocation(a.ownerId,newId);
        return at => {
          const n=build(at), value:DocumentValue={...old,documentType:"invoice",state:"draft",number:n.number,requiresNativeReview:true,issueDate:dates.issueDate,dueDate:dates.dueDate,convertedFrom:{id,revision:expectedRevision}};
          const record: VersionedRecord<DocumentValue>={id:newId,revision:1,createdAt:at,updatedAt:at,deletedAt:null,value};
          return {condition:{sql:`(${n.condition.sql}) AND EXISTS(SELECT 1 FROM cloud_documents WHERE owner_id=? AND id=? AND revision=? AND document_type='estimate' AND deleted_at IS NULL) AND NOT EXISTS(SELECT 1 FROM cloud_estimate_conversions WHERE owner_id=? AND estimate_id=?)`,values:[...n.condition.values,a.ownerId,id,expectedRevision,a.ownerId,id]},statements:[...n.statements,insert(a,newId,value,at),db.prepare("INSERT INTO cloud_estimate_conversions(owner_id,estimate_id,invoice_id,estimate_revision,created_at) VALUES (?,?,?,?,?)").bind(a.ownerId,id,newId,expectedRevision,at)],events:[event(record)],response:json(record)};
        };
      }, async () => {
        const row=await owned(a,id,true);
        if (row.revision!==expectedRevision || row.document_type!=="estimate") throw new RecordError("revision_conflict");
        const links=await kernel.readAuthoring<{present:number}>(a,db.prepare("SELECT 1 AS present FROM cloud_estimate_conversions WHERE owner_id=? AND estimate_id=?").bind(a.ownerId,id));
        if (links.length) throw new RecordError("revision_conflict");
      }) as VersionedRecord<DocumentValue>;
    }
  };
}
