/** Normalizes OpenAI JSON responses for grocery voice/receipt endpoints. */

const MAX_ITEM_NAME_LEN = 120;
const MAX_RECEIPT_NAME_LEN = 200;

export function normalizeItemName(raw: unknown): string {
  if (raw == null) return "";
  return String(raw).trim().replace(/\s+/g, " ");
}

export function normalizeReceiptPrice(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  let cleaned = s.replace(/[^\d.,-]/g, "");
  if (/^\d+,\d{1,2}$/.test(cleaned)) {
    cleaned = cleaned.replace(",", ".");
  } else {
    cleaned = cleaned.replace(/,/g, "");
  }
  return cleaned.length > 0 ? cleaned : null;
}

export function parseVoiceItemsJSON(content: string): string[] {
  if (!content.trim()) return [];
  let parsed: { items?: unknown };
  try {
    parsed = JSON.parse(content) as { items?: unknown };
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.items)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of parsed.items) {
    const name = normalizeItemName(row);
    if (!name || name.length > MAX_ITEM_NAME_LEN) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

export function parseReceiptLinesJSON(content: string): Array<{ name: string; price: string | null }> {
  if (!content.trim()) return [];
  let parsed: { lines?: Array<{ name?: unknown; price?: unknown }> };
  try {
    parsed = JSON.parse(content) as { lines?: Array<{ name?: unknown; price?: unknown }> };
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.lines)) return [];
  const seen = new Set<string>();
  const out: Array<{ name: string; price: string | null }> = [];
  for (const row of parsed.lines) {
    const name = normalizeItemName(row?.name);
    if (!name || name.length > MAX_RECEIPT_NAME_LEN) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, price: normalizeReceiptPrice(row?.price) });
  }
  return out;
}

export function parseCategoryJSON(content: string, allowedCategories: string[]): string {
  if (!content.trim()) throw new Error("no_content");
  let parsed: { category?: unknown };
  try {
    parsed = JSON.parse(content) as { category?: unknown };
  } catch {
    throw new Error("invalid_json");
  }
  const raw = String(parsed.category ?? "")
    .trim()
    .toLowerCase();
  const ok = new Set(allowedCategories);
  if (!ok.has(raw)) throw new Error("invalid_category");
  return raw;
}
