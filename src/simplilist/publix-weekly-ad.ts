import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Env } from "../env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "fixtures/publix-bogo-sample.json");

const STORE_LOCATOR_URL = "https://services.publix.com/api/v1/storelocation";
const SAVINGS_GRAPHQL_URL = "https://services.publix.com/search/api/search/storeproductssavings/";
const PUBLIX_ORIGIN = "https://www.publix.com";

const BOGO_RE =
  /\bbogo\b|buy\s*one\s*get\s*one|buy\s*1\s*get\s*1|\bb1g1\b|buy\s*two\s*get\s*one|buy\s*2\s*get\s*1/i;

const PUBLIX_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: PUBLIX_ORIGIN,
  Referer: `${PUBLIX_ORIGIN}/savings/weekly-ad/bogo`,
};

export type PublixStore = {
  storeNumber: string;
  name: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  distanceMiles: string;
};

export type PublixDeal = {
  id: string;
  title: string;
  description: string;
  savings: string;
  department: string;
  brand: string;
  imageURL: string | null;
  promoText: string;
  validThrough: string | null;
};

export type PublixBOGOCatalog = {
  storeNumber: string;
  validFrom: string | null;
  validThrough: string | null;
  source: string;
  deals: PublixDeal[];
  fallbackReason?: string;
};

type CacheRow = { expiresAt: number; payload: PublixBOGOCatalog };

const bogoCache = new Map<string, CacheRow>();

function useFixture(env: Env): boolean {
  return env.PUBLIX_DEALS_FIXTURE;
}

function cacheTTL(env: Env): number {
  return env.PUBLIX_DEALS_CACHE_MS;
}

function normalizeStoreNumber(raw: unknown): string | null {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (!digits) return null;
  const n = Number.parseInt(digits, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return String(n);
}

function stableDealID(parts: Array<string | undefined>): string {
  return createHash("sha1").update(parts.filter(Boolean).join("|")).digest("hex").slice(0, 16);
}

export function isBOGOPromoText(text: string): boolean {
  return BOGO_RE.test(String(text || ""));
}

function pickString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function normalizeDeal(raw: Record<string, unknown>, index = 0): PublixDeal | null {
  const title = pickString(raw.title, raw.Title, raw.name, raw.Name, raw.productName, raw.ProductName);
  if (!title) return null;

  const promoText = pickString(
    raw.promoText,
    raw.promoMsg,
    raw.promoMessage,
    raw.savingLine,
    raw.SavingLine,
    raw.promotionText,
    raw.PromotionText,
    raw.dealText,
    raw.DealText,
  );
  const description = pickString(raw.description, raw.Description, raw.subtitle, raw.Subtitle);
  const savings = pickString(raw.savings, raw.Savings, raw.savingAmount, raw.SavingAmount);
  const department = pickString(raw.department, raw.Department, raw.category, raw.Category);
  const brand = pickString(raw.brand, raw.Brand);
  const imageURL = pickString(raw.imageURL, raw.ImageUrl, raw.imageUrl, raw.image, raw.Image);
  const validThrough = pickString(
    raw.validThrough,
    raw.ValidThrough,
    raw.WA_EndDate,
    raw.endDate,
    raw.EndDate,
  );

  const id =
    pickString(raw.id, raw.Id, raw.productId, raw.ProductId) ||
    stableDealID([title, promoText, savings, String(index)]);

  return {
    id,
    title,
    description,
    savings: savings.replace(/^\$/, ""),
    department,
    brand,
    imageURL: imageURL || null,
    promoText: promoText || "Buy One Get One Free",
    validThrough: validThrough || null,
  };
}

function filterBOGODeals(deals: PublixDeal[]): PublixDeal[] {
  return deals.filter((deal) => isBOGOPromoText(deal.promoText) || isBOGOPromoText(deal.title));
}

function collectDealCandidates(node: unknown, out: PublixDeal[] = []): PublixDeal[] {
  if (node == null) return out;
  if (Array.isArray(node)) {
    for (const item of node) collectDealCandidates(item, out);
    return out;
  }
  if (typeof node !== "object") return out;

  const record = node as Record<string, unknown>;
  const title = pickString(record.title, record.Title, record.name, record.Name, record.productName);
  const promo = pickString(
    record.promoText,
    record.promoMsg,
    record.savingLine,
    record.SavingLine,
    record.promotionText,
    record.PromotionText,
  );
  if (title && (promo || record.savings || record.Savings || record.department || record.Department)) {
    const normalized = normalizeDeal(record, out.length);
    if (normalized) out.push(normalized);
  }

  for (const value of Object.values(record)) {
    if (value && typeof value === "object") collectDealCandidates(value, out);
  }
  return out;
}

function dedupeDeals(deals: PublixDeal[]): PublixDeal[] {
  const seen = new Set<string>();
  const out: PublixDeal[] = [];
  for (const deal of deals) {
    const key = `${deal.title.toLowerCase()}|${deal.promoText.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(deal);
  }
  return out;
}

function loadFixtureCatalog(storeNumber: string): PublixBOGOCatalog {
  const parsed = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as PublixBOGOCatalog;
  return {
    ...parsed,
    storeNumber: normalizeStoreNumber(storeNumber) || parsed.storeNumber,
    source: "fixture",
  };
}

function readCache(storeNumber: string): PublixBOGOCatalog | null {
  const row = bogoCache.get(`bogo:${storeNumber}`);
  if (!row) return null;
  if (Date.now() > row.expiresAt) {
    bogoCache.delete(`bogo:${storeNumber}`);
    return null;
  }
  return row.payload;
}

function writeCache(env: Env, storeNumber: string, payload: PublixBOGOCatalog): void {
  bogoCache.set(`bogo:${storeNumber}`, {
    expiresAt: Date.now() + cacheTTL(env),
    payload,
  });
}

export async function findStoresByZip(zipCode: string): Promise<PublixStore[]> {
  const zip = String(zipCode || "").trim();
  if (!/^\d{5}$/.test(zip)) {
    throw Object.assign(new Error("invalid_zip"), { code: "invalid_zip" });
  }

  const url = new URL(STORE_LOCATOR_URL);
  url.searchParams.set("types", "R,G,H,N,S");
  url.searchParams.set("option", "");
  url.searchParams.set("count", "15");
  url.searchParams.set("includeOpenAndCloseDates", "true");
  url.searchParams.set("isWebsite", "true");
  url.searchParams.set("zipCode", zip);

  const response = await fetch(url, { headers: PUBLIX_HEADERS });
  if (!response.ok) {
    throw Object.assign(new Error(`publix_store_locator_${response.status}`), {
      code: "upstream",
      status: response.status,
    });
  }

  const body = (await response.json()) as { Stores?: Array<Record<string, unknown>> };
  const stores = Array.isArray(body?.Stores) ? body.Stores : [];
  return stores
    .map((store) => ({
      storeNumber: normalizeStoreNumber(store.KEY) || "",
      name: pickString(store.NAME, store.SHORTNAME) || "Publix",
      address: [store.ADDR, store.CITY, store.STATE, store.ZIP].filter(Boolean).join(", "),
      city: pickString(store.CITY),
      state: pickString(store.STATE),
      zip: pickString(store.ZIP),
      phone: pickString(store.PHONE),
      distanceMiles: pickString(store.DISTANCE),
    }))
    .filter((store) => store.storeNumber);
}

async function fetchWeeklyAdDeals(storeNumber: string): Promise<{
  storeNumber: string;
  validFrom: string | null;
  validThrough: string | null;
  source: string;
  deals: PublixDeal[];
}> {
  const body = {
    operationName: "SearchStoreProductsSavings",
    variables: {
      storeNumber,
      categoryId: "bogo",
      pageNumber: 1,
      pageSize: 200,
      language: "en",
    },
    query: `query SearchStoreProductsSavings($storeNumber: String!, $categoryId: String, $pageNumber: Int, $pageSize: Int, $language: String) {
      searchStoreProductsSavings(
        storeNumber: $storeNumber
        categoryId: $categoryId
        pageNumber: $pageNumber
        pageSize: $pageSize
        language: $language
      ) {
        items {
          id
          title
          description
          savings
          department
          brand
          imageUrl
          promoText
          validThrough
          validFrom
        }
        validFrom
        validThrough
      }
    }`,
  };

  const response = await fetch(SAVINGS_GRAPHQL_URL, {
    method: "POST",
    headers: {
      ...PUBLIX_HEADERS,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw Object.assign(new Error(`publix_graphql_${response.status}`), {
      code: "upstream",
      status: response.status,
    });
  }

  const json = (await response.json()) as {
    errors?: unknown[];
    data?: { searchStoreProductsSavings?: Record<string, unknown> };
  };
  if (json?.errors?.length) {
    throw Object.assign(new Error("publix_graphql_errors"), { code: "upstream", details: json.errors });
  }

  const root = json?.data?.searchStoreProductsSavings ?? json?.data ?? json;
  const rootRecord = root as Record<string, unknown>;
  const items = Array.isArray(rootRecord?.items)
    ? (rootRecord.items as Record<string, unknown>[])
    : collectDealCandidates(json?.data ?? json);

  const deals = dedupeDeals(
    items.map((item, index) => normalizeDeal(item, index)).filter((deal): deal is PublixDeal => deal != null),
  );

  return {
    storeNumber,
    validFrom: pickString(rootRecord?.validFrom, rootRecord?.WA_StartDate) || null,
    validThrough: pickString(rootRecord?.validThrough, rootRecord?.WA_EndDate) || null,
    source: "publix",
    deals,
  };
}

export async function fetchBOGOCatalog(
  env: Env,
  storeNumberRaw: string,
  { forceRefresh = false }: { forceRefresh?: boolean } = {},
): Promise<PublixBOGOCatalog> {
  const storeNumber = normalizeStoreNumber(storeNumberRaw);
  if (!storeNumber) {
    throw Object.assign(new Error("invalid_store_number"), { code: "invalid_store_number" });
  }

  if (!forceRefresh) {
    const cached = readCache(storeNumber);
    if (cached) return cached;
  }

  if (useFixture(env)) {
    const fixture = loadFixtureCatalog(storeNumber);
    writeCache(env, storeNumber, fixture);
    return fixture;
  }

  try {
    const catalog = await fetchWeeklyAdDeals(storeNumber);
    const bogoDeals = filterBOGODeals(catalog.deals);
    const payload: PublixBOGOCatalog = {
      storeNumber,
      validFrom: catalog.validFrom,
      validThrough: catalog.validThrough,
      source: catalog.source,
      deals: bogoDeals,
    };
    if (payload.deals.length === 0) {
      throw Object.assign(new Error("no_bogo_deals"), { code: "no_bogo_deals" });
    }
    writeCache(env, storeNumber, payload);
    return payload;
  } catch (error) {
    if (env.NODE_ENV !== "production") {
      const fixture = loadFixtureCatalog(storeNumber);
      fixture.fallbackReason = String((error as Error)?.message || error);
      writeCache(env, storeNumber, fixture);
      return fixture;
    }
    throw error;
  }
}
