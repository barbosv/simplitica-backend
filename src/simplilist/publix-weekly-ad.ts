import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Env } from "../env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "fixtures/publix-bogo-sample.json");

const STORE_LOCATOR_URL = "https://services.publix.com/api/v1/storelocation";
const PUBLIX_ORIGIN = "https://www.publix.com";

// Publix's own savings endpoint is behind Akamai bot protection (HTTP 403 for
// server-side calls). Publix's weekly ad is also published via Flipp/Wishabi,
// whose API returns plain JSON without bot protection, so we source BOGO deals
// from there. `PUBLIX_FLIPP_MERCHANT_ID` is Publix's merchant id on Flipp.
const FLIPP_BASE_URL = "https://backflipp.wishabi.com/flipp";
const FLIPP_LOCALE = "en-us";
const PUBLIX_FLIPP_MERCHANT_ID = 2361;

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

const FLIPP_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
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

function toDayString(raw: unknown): string | null {
  const match = String(raw ?? "").match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

function toHttps(url: string): string {
  return url.startsWith("http://") ? `https://${url.slice("http://".length)}` : url;
}

/** Strips Publix's trailing ad markers ("BOGO*", "†", "*") from an item name. */
function cleanDealTitle(name: string): string {
  return name
    .replace(/\bbogo\b\*?/gi, "")
    .replace(/[†*]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Maps a Flipp flyer item to a `PublixDeal`. Returns null when no usable title. */
function normalizeFlippItem(raw: Record<string, unknown>): PublixDeal | null {
  const rawName = pickString(raw.name, raw.short_name, raw.Name);
  if (!rawName) return null;
  const title = cleanDealTitle(rawName);
  if (!title) return null;

  const brand = pickString(raw.brand, raw.Brand);
  const savings = pickString(raw.sale_story, raw.savings)
    .replace(/^save up to\s*/i, "")
    .replace(/^\$/, "");
  const image = pickString(raw.cutout_image_url, raw.clean_image_url, raw.clipping_image_url);
  const validThrough = toDayString(pickString(raw.valid_to, raw.available_to, raw.validThrough));
  const id =
    pickString(String(raw.id ?? ""), String(raw.flyer_item_id ?? "")) || stableDealID([title, brand]);

  return {
    id,
    title,
    description: "",
    savings,
    department: "",
    brand,
    imageURL: image ? toHttps(image) : null,
    promoText: "Buy One Get One Free",
    validThrough,
  };
}

function isBOGOItem(raw: Record<string, unknown>): boolean {
  return isBOGOPromoText(pickString(raw.name, raw.short_name)) || isBOGOPromoText(pickString(raw.sale_story));
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

type FlippFlyer = {
  id: number;
  merchant_id?: number;
  name?: string;
  valid_from?: string;
  valid_to?: string;
};

function upstreamError(message: string, status?: number): Error {
  return Object.assign(new Error(message), { code: "upstream", status });
}

/** Finds Publix's English "Weekly Ad" flyer (the BOGO source) for a ZIP via Flipp. */
async function findPublixWeeklyAdFlyer(zip: string): Promise<FlippFlyer> {
  const url = new URL(`${FLIPP_BASE_URL}/flyers`);
  url.searchParams.set("locale", FLIPP_LOCALE);
  url.searchParams.set("postal_code", zip);

  const response = await fetch(url, { headers: FLIPP_HEADERS });
  if (!response.ok) {
    throw upstreamError(`flipp_flyers_${response.status}`, response.status);
  }

  const body = (await response.json()) as { flyers?: FlippFlyer[] } | FlippFlyer[];
  const flyers = Array.isArray(body) ? body : (body.flyers ?? []);
  const publix = flyers.filter((flyer) => flyer.merchant_id === PUBLIX_FLIPP_MERCHANT_ID);

  // Prefer the English "Weekly Ad"; skip the Spanish "Anuncio Semanal" duplicate
  // and the "Extra Savings"/"Liquor" flyers when a weekly ad is present.
  const weekly =
    publix.find((flyer) => /weekly ad/i.test(flyer.name ?? "")) ??
    publix.find((flyer) => !/espa|anuncio|liquor/i.test(flyer.name ?? "")) ??
    publix[0];

  if (!weekly?.id) {
    throw upstreamError("flipp_no_publix_flyer");
  }
  return weekly;
}

async function fetchFlyerItems(flyerId: number, zip: string): Promise<Record<string, unknown>[]> {
  const url = new URL(`${FLIPP_BASE_URL}/flyers/${flyerId}`);
  url.searchParams.set("locale", FLIPP_LOCALE);
  url.searchParams.set("postal_code", zip);

  const response = await fetch(url, { headers: FLIPP_HEADERS });
  if (!response.ok) {
    throw upstreamError(`flipp_flyer_items_${response.status}`, response.status);
  }

  const body = (await response.json()) as { items?: unknown };
  return Array.isArray(body?.items) ? (body.items as Record<string, unknown>[]) : [];
}

async function fetchWeeklyAdDeals(zip: string): Promise<{
  validFrom: string | null;
  validThrough: string | null;
  source: string;
  deals: PublixDeal[];
}> {
  const flyer = await findPublixWeeklyAdFlyer(zip);
  const items = await fetchFlyerItems(flyer.id, zip);

  const deals = dedupeDeals(
    items
      .filter(isBOGOItem)
      .map((item) => normalizeFlippItem(item))
      .filter((deal): deal is PublixDeal => deal != null),
  );

  return {
    validFrom: toDayString(flyer.valid_from),
    validThrough: toDayString(flyer.valid_to),
    source: "publix",
    deals,
  };
}

export async function fetchBOGOCatalog(
  env: Env,
  storeNumberRaw: string,
  { zip = "", forceRefresh = false }: { zip?: string; forceRefresh?: boolean } = {},
): Promise<PublixBOGOCatalog> {
  const storeNumber = normalizeStoreNumber(storeNumberRaw);
  if (!storeNumber) {
    throw Object.assign(new Error("invalid_store_number"), { code: "invalid_store_number" });
  }

  // Publix BOGOs are regional (shared across stores in an ad zone), so the ad is
  // resolved by ZIP. Cache by ZIP when available to share results across stores.
  const normalizedZip = /^\d{5}$/.test(zip.trim()) ? zip.trim() : null;
  const cacheId = normalizedZip ?? storeNumber;

  if (!forceRefresh) {
    const cached = readCache(cacheId);
    if (cached) return cached;
  }

  if (useFixture(env)) {
    const fixture = loadFixtureCatalog(storeNumber);
    writeCache(env, cacheId, fixture);
    return fixture;
  }

  try {
    if (!normalizedZip) {
      throw upstreamError("missing_zip");
    }
    const catalog = await fetchWeeklyAdDeals(normalizedZip);
    const payload: PublixBOGOCatalog = {
      storeNumber,
      validFrom: catalog.validFrom,
      validThrough: catalog.validThrough,
      source: catalog.source,
      deals: catalog.deals,
    };
    if (payload.deals.length === 0) {
      throw Object.assign(new Error("no_bogo_deals"), { code: "no_bogo_deals" });
    }
    writeCache(env, cacheId, payload);
    return payload;
  } catch (error) {
    // A genuinely empty BOGO week from a reachable upstream should surface as
    // "no deals" rather than be masked by stale sample data.
    if ((error as { code?: string })?.code === "no_bogo_deals") {
      throw error;
    }
    // The Flipp upstream (or ZIP lookup) failed. Serve the bundled sample
    // catalog (tagged source:"fixture") so the app still shows deals instead of
    // an error. Clients can distinguish live vs. sample data via `source`.
    const fixture = loadFixtureCatalog(storeNumber);
    fixture.fallbackReason = String((error as Error)?.message || error);
    writeCache(env, cacheId, fixture);
    return fixture;
  }
}
