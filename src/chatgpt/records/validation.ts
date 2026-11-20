import { calculateDocumentV1, CalculationError } from "../documents/calculator.js";
import { encodeRecordJSON, utf8Bytes } from "./json.js";
import { RecordError } from "./types.js";

export type BusinessProfile = { businessName: string; addressLines: string[]; phone: string | null; email: string | null; website: string | null; tax: { enabled: boolean; ratePercent: string; label: string }; paymentTermsSummary: string | null; timezone: string };
export type Customer = { name: string; email: string | null; phone: string | null; billingAddressLines: string[]; savedJobSites: { id: string; recipientName: string | null; addressKind: "jobSite" | "shipTo"; displayAddress: string }[] };
export type SavedRate = { title: string; detail: string | null; defaultQuantity: string; unitPrice: string; unit: "each" | "hour" | "day" | "sq_ft" | "linear_ft" | "cu_yd" | "lb" | "gal" | "job" | null; kind: "service" | "labor" | "materials" | "fee" | "other" };
export function invalid(): never { throw new RecordError("invalid_input"); }
export function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || ![...required, ...optional].includes(key) || !("value" in Object.getOwnPropertyDescriptor(value, key)!)) return invalid();
  }
  if (required.some(key => !Object.hasOwn(value, key))) return invalid();
  return value as Record<string, unknown>;
}
export function text(value: unknown, max: number, required = true, multiline = false): string {
  if (typeof value !== "string") return invalid();
  // JSON validation also rejects unmatched UTF16 surrogates.
  encodeRecordJSON(value);
  const normalized = value.trim();
  // eslint-disable-next-line no-control-regex -- Intentionally reject control characters in user contact text.
  if (utf8Bytes(normalized) > max || (required && !normalized) || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f\u0085\u2028\u2029]/).test(value)) return invalid();
  return normalized;
}
const optionalText = (value: unknown, max: number, multiline = false) => value === null || value === undefined ? null : text(value, max, false, multiline) || null;
const addresses = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length > 10) return invalid();
  return value.map(line => text(line, 1024));
};
export function uuid(value: unknown): string {
  if (typeof value !== "string" || !/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/.test(value)) return invalid();
  return value.toLowerCase();
}
export function revision(value: unknown, allowZero = false): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value === Number.MAX_SAFE_INTEGER) return invalid();
  return value;
}
function calculation(quantity: unknown, unitPrice: unknown, taxRatePercent: unknown) {
  try { return calculateDocumentV1({ currency: "USD", lines: [{ quantity, unitPrice }], discountAmount: "0", taxRatePercent }); }
  catch (error) { if (error instanceof CalculationError) return invalid(); throw error; }
}
export function businessValue(value: unknown): BusinessProfile {
  const v = object(value, ["businessName", "addressLines", "tax", "timezone"], ["phone", "email", "website", "paymentTermsSummary"]);
  const tax = object(v.tax, ["enabled", "ratePercent", "label"]);
  if (typeof tax.enabled !== "boolean") return invalid();
  const rate = calculation("1", "0", tax.ratePercent).taxRatePercent;
  const zone = text(v.timezone, 128);
  if (!/^[A-Za-z][A-Za-z0-9_+/-]*$/.test(zone)) return invalid();
  let timezone: string;
  try { timezone = new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone; }
  catch { return invalid(); }
  return { businessName: text(v.businessName, 256), addressLines: addresses(v.addressLines), phone: optionalText(v.phone, 64), email: optionalText(v.email, 254), website: optionalText(v.website, 2048), tax: { enabled: tax.enabled, ratePercent: rate, label: text(tax.label, 256) }, paymentTermsSummary: optionalText(v.paymentTermsSummary, 2048, true), timezone };
}
export function customerValue(value: unknown): Customer {
  const v = object(value, ["name", "billingAddressLines", "savedJobSites"], ["email", "phone"]);
  if (!Array.isArray(v.savedJobSites) || v.savedJobSites.length > 20) return invalid();
  const ids = new Set<string>();
  const savedJobSites: Customer["savedJobSites"] = v.savedJobSites.map(site => {
    const s = object(site, ["id", "addressKind", "displayAddress"], ["recipientName"]);
    const id = uuid(s.id);
    if (ids.has(id) || (s.addressKind !== "jobSite" && s.addressKind !== "shipTo")) return invalid();
    ids.add(id);
    return { id, recipientName: optionalText(s.recipientName, 256), addressKind: s.addressKind, displayAddress: text(s.displayAddress, 1024) };
  });
  return { name: text(v.name, 256), email: optionalText(v.email, 254), phone: optionalText(v.phone, 64), billingAddressLines: addresses(v.billingAddressLines), savedJobSites };
}
export function rateValue(value: unknown): SavedRate {
  const v = object(value, ["title", "defaultQuantity", "unitPrice", "kind"], ["detail", "unit"]);
  if (v.unit !== null && v.unit !== undefined && !["each", "hour", "day", "sq_ft", "linear_ft", "cu_yd", "lb", "gal", "job"].includes(v.unit as string)) return invalid();
  if (!["service", "labor", "materials", "fee", "other"].includes(v.kind as string)) return invalid();
  const line = calculation(v.defaultQuantity, v.unitPrice, "0").lines[0];
  return { title: text(v.title, 256), detail: optionalText(v.detail, 2048, true), defaultQuantity: line.quantity, unitPrice: line.unitPrice, unit: (v.unit ?? null) as SavedRate["unit"], kind: v.kind as SavedRate["kind"] };
}
export const searchText = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
export function searchInput(value: unknown) {
  const v = object(value, ["query", "limit"], ["afterId"]);
  const query = searchText(text(v.query, 200, false));
  if (typeof v.limit !== "number" || !Number.isInteger(v.limit) || v.limit < 1 || v.limit > 100) return invalid();
  return { query, limit: v.limit, afterId: v.afterId === undefined ? "" : uuid(v.afterId) };
}
