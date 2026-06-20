import type { RetailPriceProvider, RetailProductQuote } from "./home-depot-client.js";

const DEFAULT_BASE_URL = "https://api.retailerapi.com/v1";
const HOME_DEPOT_RETAILER = "homedepot";

type RetailerApiClientOptions = {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

type LookupAttempt = {
  identifier: string;
  format?: "item_id";
};

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[^0-9.]/g, ""));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

export function extractRetailerApiPrice(payload: unknown): number | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const root = payload as Record<string, unknown>;
  return asNumber(root.current_price ?? root.buybox_price ?? root.price);
}

export function extractRetailerApiName(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const title = (payload as Record<string, unknown>).title;
  return typeof title === "string" && title.trim() ? title.trim() : undefined;
}

export function buildRetailerApiLookupAttempts(
  itemId: string,
  productUrl?: string,
): LookupAttempt[] {
  const attempts: LookupAttempt[] = [];
  const id = itemId.trim();
  const url = productUrl?.trim();
  const seen = new Set<string>();

  const add = (identifier: string, format?: "item_id") => {
    const key = `${format ?? "auto"}:${identifier}`;
    if (!identifier || seen.has(key)) return;
    seen.add(key);
    attempts.push({ identifier, format });
  };

  if (id) {
    add(id, "item_id");
  }
  if (url && url.includes("homedepot.com")) {
    add(url);
  }
  if (id) {
    add(`https://www.homedepot.com/p/${id}`);
  }

  return attempts;
}

export class RetailerApiRetailClient implements RetailPriceProvider {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RetailerApiClientOptions) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async searchProduct(_query: string, _zipCode?: string): Promise<RetailProductQuote | null> {
    return null;
  }

  async lookupItem(_search: string, _zipCode?: string): Promise<RetailProductQuote | null> {
    return null;
  }

  async getProductById(
    itemId: string,
    _zipCode?: string,
    productUrl?: string,
  ): Promise<RetailProductQuote | null> {
    if (!this.apiKey) return null;

    const attempts = buildRetailerApiLookupAttempts(itemId, productUrl);
    for (const attempt of attempts) {
      const quote = await this.lookupOnce(attempt);
      if (quote) return quote;
    }
    return null;
  }

  private async lookupOnce(attempt: LookupAttempt): Promise<RetailProductQuote | null> {
    const path = `/products/${encodeURIComponent(attempt.identifier)}`;
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set("retailer", HOME_DEPOT_RETAILER);
    if (attempt.format) {
      url.searchParams.set("format", attempt.format);
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers,
        signal: AbortSignal.timeout(12_000),
      });
    } catch (err) {
      console.warn(`[pricing] RetailerAPI request failed for ${path}: ${String(err)}`);
      return null;
    }

    let payload: unknown;
    let rawText = "";
    try {
      rawText = await response.text();
      payload = rawText ? (JSON.parse(rawText) as unknown) : undefined;
    } catch {
      console.warn(`[pricing] RetailerAPI invalid JSON for ${path}`);
      return null;
    }

    if (response.status === 404) {
      const snippet = rawText.slice(0, 200);
      console.warn(
        `[pricing] RetailerAPI product not found for ${path} (body=${snippet || "empty"})`,
      );
      return null;
    }

    if (response.status === 429) {
      console.warn(`[pricing] RetailerAPI rate limited for ${path}`);
      return null;
    }

    if (!response.ok) {
      console.warn(`[pricing] RetailerAPI ${response.status} for ${path}`);
      return null;
    }

    const price = extractRetailerApiPrice(payload);
    if (!price) {
      const root = payload as Record<string, unknown>;
      console.warn(
        `[pricing] RetailerAPI returned no parseable price for ${path} ` +
          `(keys=${Object.keys(root ?? {}).join(",")})`,
      );
      return null;
    }

    return {
      price,
      name: extractRetailerApiName(payload) ?? "Home Depot item",
    };
  }
}

export function isRetailerApiConfigured(env: { RETAILERAPI_KEY?: string }): boolean {
  return Boolean(env.RETAILERAPI_KEY?.trim());
}

export function createRetailerApiClient(env: {
  RETAILERAPI_KEY?: string;
  RETAILERAPI_BASE_URL?: string;
}): RetailPriceProvider {
  return new RetailerApiRetailClient({
    apiKey: env.RETAILERAPI_KEY,
    baseUrl: env.RETAILERAPI_BASE_URL,
  });
}
