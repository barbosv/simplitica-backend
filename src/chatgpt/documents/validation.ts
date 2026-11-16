import { calculateDocumentV1, CalculationError } from "./calculator.js";
import { encodeRecordJSON } from "../records/json.js";
import { invalid, object, text, uuid } from "../records/validation.js";
import type { NormalizedDocumentInput, NormalizedSourceLine, ReportedProvenance } from "./types.js";

const nullableText = (value: unknown, max: number) => value === null ? null : text(value, max, false, true) || null;
function date(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return invalid();
  const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) return invalid();
  return value;
}
export function normalizeDocumentInput(input: unknown): NormalizedDocumentInput {
  encodeRecordJSON(input);
  const v = object(input, ["documentType", "issueDate", "serviceDate", "dueDate", "title", "notes", "paymentTermsSummary", "jobSiteId", "lines", "discountAmount"]);
  if (v.documentType !== "invoice" && v.documentType !== "estimate") return invalid();
  const issueDate = date(v.issueDate), serviceDate = v.serviceDate === null ? null : date(v.serviceDate), dueDate = v.dueDate === null ? null : date(v.dueDate);
  if (dueDate !== null && dueDate < issueDate) return invalid();
  if (!Array.isArray(v.lines) || v.lines.length < 1 || v.lines.length > 200) return invalid();
  const ids = new Set<string>();
  const lines: NormalizedSourceLine[] = v.lines.map(raw => {
    const l = object(raw, ["title", "detail", "quantity", "unitPrice", "unit", "kind"], ["id", "reportedProvenance"]);
    const id = l.id === undefined ? null : uuid(l.id);
    if (id && ids.has(id)) return invalid();
    if (id) ids.add(id);
    if (l.unit !== null && !["each", "hour", "day", "sq_ft", "linear_ft", "cu_yd", "lb", "gal", "job"].includes(l.unit as string)) return invalid();
    if (!["service", "labor", "materials", "fee", "other"].includes(l.kind as string)) return invalid();
    const p = l.reportedProvenance === undefined ? { kind: "unspecified", reference: null, asOf: null } : object(l.reportedProvenance, ["kind", "reference", "asOf"]);
    if (!["explicit", "saved_rate", "history", "guidance", "estimate", "unspecified"].includes(p.kind as string)) return invalid();
    if (p.asOf !== null && (typeof p.asOf !== "number" || !Number.isSafeInteger(p.asOf) || p.asOf <= 0)) return invalid();
    return { ...(id === null ? {} : { id }), title: text(l.title, 256), detail: nullableText(l.detail, 2048), quantity: l.quantity as string, unitPrice: l.unitPrice as string, unit: l.unit as NormalizedSourceLine["unit"], kind: l.kind as NormalizedSourceLine["kind"], reportedProvenance: { kind: p.kind as ReportedProvenance["kind"], reference: nullableText(p.reference, 2048), asOf: p.asOf as number | null } };
  });
  let calculation;
  try { calculation = calculateDocumentV1({ currency: "USD", lines: lines.map(({ quantity, unitPrice }) => ({ quantity, unitPrice })), discountAmount: v.discountAmount, taxRatePercent: "0" }); }
  catch (error) { if (error instanceof CalculationError) return invalid(); throw error; }
  return { documentType: v.documentType, issueDate, serviceDate, dueDate, title: text(v.title, 256), notes: nullableText(v.notes, 2048), paymentTermsSummary: nullableText(v.paymentTermsSummary, 2048), jobSiteId: v.jobSiteId === null ? null : uuid(v.jobSiteId), lines: lines.map((line, i) => ({ ...line, quantity: calculation.lines[i].quantity, unitPrice: calculation.lines[i].unitPrice })), discountAmount: calculation.discountRequested };
}
