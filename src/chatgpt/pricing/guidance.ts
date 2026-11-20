import { requireRecordAuthority, type CloudRecordAuthority } from "../records/authority.js";
import { createCloudRecordKernel } from "../records/kernel.js";
import { RecordError } from "../records/types.js";
import { invalid, object, rateValue, searchText, text, uuid, type SavedRate } from "../records/validation.js";
import { CALCULATION_VERSION } from "../documents/calculator.js";

const units = ["each", "hour", "day", "sq_ft", "linear_ft", "cu_yd", "lb", "gal", "job"];
const kinds = ["service", "labor", "materials", "fee", "other"];
type Row = { source: "saved_rate" | "history"; id: string; revision: number; asOf: number; title: unknown; unitPrice: unknown; unit: unknown; kind: unknown; lineId: unknown };
type Option = { title: string; unitPrice: string; unit: SavedRate["unit"]; kind: SavedRate["kind"]; source: Row["source"]; reference: { id: string; revision: number; lineId: string | null }; asOf: number };
const coverage = { savedRateCandidateLimit: 100, historyDocumentLimit: 50, historyLineCandidateLimit: 200 } as const;
export function createPricingGuidanceService(db: D1Database, dependencies: { authorizationNamespace: string; now?: () => number }) {
  const kernel = createCloudRecordKernel(db, dependencies);
  return { async getPricingGuidance(authority: CloudRecordAuthority, input: unknown) {
    requireRecordAuthority(authority, dependencies.authorizationNamespace);
    const v = object(input, ["query", "unit", "kind", "limit"]);
    const query = searchText(text(v.query, 200));
    if (!query || (v.unit !== null && (typeof v.unit !== "string" || !units.includes(v.unit))) || typeof v.kind !== "string" || !kinds.includes(v.kind) || typeof v.limit !== "number" || !Number.isInteger(v.limit) || v.limit < 1 || v.limit > 20) return invalid();
    const rows = await kernel.readAuthoring<Row>(authority, db.prepare(`WITH
      rates AS MATERIALIZED (SELECT id,revision,updated_at,payload FROM cloud_saved_rates WHERE owner_id=? AND deleted_at IS NULL ORDER BY updated_at DESC,id ASC LIMIT 100),
      docs AS MATERIALIZED (SELECT id,revision,updated_at,payload FROM cloud_documents WHERE owner_id=? AND deleted_at IS NULL AND document_type='invoice' AND state IN ('finalized','sent','paid') AND json_extract(payload,'$.calculationVersion')=? ORDER BY updated_at DESC,id ASC LIMIT 50),
      lines AS MATERIALIZED (SELECT d.id,d.revision,d.updated_at,j.key AS position,j.value AS line FROM docs d,json_each(d.payload,'$.lines') j WHERE json_type(d.payload,'$.lines')='array' AND CAST(j.key AS INTEGER) BETWEEN 0 AND 199 AND json_extract(j.value,'$.unit')=? AND json_extract(j.value,'$.kind')=? ORDER BY d.updated_at DESC,d.id ASC,CAST(j.key AS INTEGER) ASC LIMIT 200)
      SELECT 'saved_rate' AS source,id,revision,updated_at AS asOf,json_extract(payload,'$.title') AS title,json_extract(payload,'$.unitPrice') AS unitPrice,json_extract(payload,'$.unit') AS unit,json_extract(payload,'$.kind') AS kind,NULL AS lineId,0 AS position FROM rates
      UNION ALL SELECT 'history',id,revision,updated_at,json_extract(line,'$.title'),json_extract(line,'$.unitPrice'),json_extract(line,'$.unit'),json_extract(line,'$.kind'),json_extract(line,'$.id'),position FROM lines
      ORDER BY source DESC,asOf DESC,id ASC,position ASC`).bind(authority.ownerId, authority.ownerId, CALCULATION_VERSION, v.unit, v.kind));
    const options: Option[] = [];
    if (v.unit !== null) for (const row of rows) {
      if (row.unit !== v.unit || row.kind !== v.kind) continue;
      let option: Option;
      try {
        const value = rateValue({ title: row.title, unitPrice: row.unitPrice, unit: row.unit, kind: row.kind, defaultQuantity: "1" });
        const id = uuid(row.id), lineId = row.lineId === null ? null : uuid(row.lineId);
        if (!Number.isSafeInteger(row.revision) || row.revision < 1 || !Number.isSafeInteger(row.asOf) || row.asOf < 0) throw new Error();
        option = { title: value.title, unitPrice: value.unitPrice, unit: value.unit, kind: value.kind, source: row.source, reference: { id, revision: row.revision, lineId }, asOf: row.asOf };
      } catch { throw new RecordError("storage_unavailable"); }
      if (option.unit === v.unit && option.kind === v.kind && searchText(option.title) === query) options.push(option);
    }
    const saved = options.filter(o => o.source === "saved_rate"), history = options.filter(o => o.source === "history");
    const selected = (saved.length ? saved : history).slice(0, v.limit);
    const mode = selected.length ? selected[0].source : "clarification";
    const clarification = mode !== "clarification" ? null : v.unit === null ? { code: "unit_required" as const, message: "Please specify a unit for this price." } : { code: "price_required" as const, message: "Please provide a price; no match was found in the covered candidate window." };
    return { currency: "USD" as const, mode, options: selected, clarification, marketGuidanceAvailable: false as const, requiresNativeReview: true as const, coverage };
  } };
}
