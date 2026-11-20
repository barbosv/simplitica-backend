import { requireRecordAuthority, type CloudRecordAuthority } from "../records/authority.js";
import { createCloudRecordKernel } from "../records/kernel.js";
import { encodeRecordJSON } from "../records/json.js";
import type { VersionedRecord } from "../records/repository.js";
import { RecordError } from "../records/types.js";
import { invalid, object, uuid, type BusinessProfile, type Customer } from "../records/validation.js";
import { calculateDocumentV1, CalculationError } from "./calculator.js";
import { normalizeDocumentInput, readReferenceRevision } from "./validation.js";
import type { DocumentValue } from "./types.js";

export function buildDocumentPreview(input: unknown, business: VersionedRecord<BusinessProfile>, customer: VersionedRecord<Customer>): DocumentValue {
  const normalized = normalizeDocumentInput(input);
  const jobSite = normalized.jobSiteId === null ? null : customer.value.savedJobSites.find(site => site.id === normalized.jobSiteId);
  if (jobSite === undefined) return invalid();
  let calculation;
  try { calculation = calculateDocumentV1({ currency: "USD", lines: normalized.lines.map(({ quantity, unitPrice }) => ({ quantity, unitPrice })), discountAmount: normalized.discountAmount, taxRatePercent: business.value.tax.enabled ? business.value.tax.ratePercent : "0" }); }
  catch (error) { if (error instanceof CalculationError) return invalid(); throw error; }
  const { jobSiteId, lines, ...rest } = normalized;
  void jobSiteId;
  const result: DocumentValue = { ...rest, state: "draft", number: null, businessRevision: business.revision, businessSnapshot: business.value, customerId: customer.id, customerRevision: customer.revision, customerSnapshot: customer.value, jobSite, lines: lines.map((line, i) => ({ ...line, id: line.id ?? null, reportedProvenance: { ...line.reportedProvenance, reported: true }, lineTotal: calculation.lines[i].lineTotal })), calculationVersion: calculation.calculationVersion, currency: calculation.currency, subtotal: calculation.subtotal, discountApplied: calculation.discountApplied, taxRatePercent: calculation.taxRatePercent, taxAmount: calculation.taxAmount, total: calculation.total, requiresNativeReview: true, createdBy: "chatgpt", convertedFrom: null };
  return JSON.parse(encodeRecordJSON(result)) as DocumentValue;
}
type Row = { b_id: string; b_revision: number; b_created: number; b_updated: number; b_payload: string; c_id: string; c_revision: number; c_created: number; c_updated: number; c_payload: string };
export function createDocumentPreviewService(db: D1Database, dependencies: { authorizationNamespace: string; now?: () => number }) {
  const kernel = createCloudRecordKernel(db, dependencies);
  return { async previewDocument(authority: CloudRecordAuthority, request: unknown): Promise<DocumentValue> {
    requireRecordAuthority(authority, dependencies.authorizationNamespace);
    const r = object(request, ["businessRevision", "customerId", "customerRevision", "input"]);
    const businessRevision = readReferenceRevision(r.businessRevision), customerRevision = readReferenceRevision(r.customerRevision), customerId = uuid(r.customerId);
    const input = normalizeDocumentInput(r.input);
    const rows = await kernel.readAuthoring<Row>(authority, db.prepare(`SELECT b.id b_id,b.revision b_revision,b.created_at b_created,b.updated_at b_updated,b.payload b_payload,c.id c_id,c.revision c_revision,c.created_at c_created,c.updated_at c_updated,c.payload c_payload FROM cloud_business_profiles b JOIN cloud_customers c ON c.owner_id=b.owner_id WHERE b.owner_id=? AND b.id=? AND b.deleted_at IS NULL AND c.id=? AND c.deleted_at IS NULL`).bind(authority.ownerId, authority.businessId, customerId));
    const row = rows[0];
    if (!row) throw new RecordError("not_found");
    if (row.b_revision !== businessRevision || row.c_revision !== customerRevision) throw new RecordError("revision_conflict");
    let business: BusinessProfile, customer: Customer;
    try { business = JSON.parse(row.b_payload) as BusinessProfile; customer = JSON.parse(row.c_payload) as Customer; } catch { throw new RecordError("storage_unavailable"); }
    return buildDocumentPreview(input, { id: row.b_id, revision: row.b_revision, createdAt: row.b_created, updatedAt: row.b_updated, deletedAt: null, value: business }, { id: row.c_id, revision: row.c_revision, createdAt: row.c_created, updatedAt: row.c_updated, deletedAt: null, value: customer });
  } };
}
