export type RetailProductQuote = {
  price: number;
  name: string;
};

export interface RetailPriceProvider {
  searchProduct(query: string, zipCode?: string): Promise<RetailProductQuote | null>;
  lookupItem(search: string, zipCode?: string): Promise<RetailProductQuote | null>;
  getProductById(itemId: string, zipCode?: string): Promise<RetailProductQuote | null>;
}

type AuthMode = "openweb" | "rapidapi";

type HomeDepotClientOptions = {
  apiKey?: string;
  baseUrl: string;
  apiHost?: string;
  authMode: AuthMode;
  fetchImpl?: typeof fetch;
};

const OPENWEB_DEFAULT_BASE_URL = "https://api.openwebninja.com/realtime-homedepot-data";
const RAPIDAPI_DEFAULT_BASE_URL = "https://real-time-home-depot-data.p.rapidapi.com";
const RAPIDAPI_DEFAULT_HOST = "real-time-home-depot-data.p.rapidapi.com";

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[^0-9.]/g, ""));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

export function isApiErrorPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const status = (payload as Record<string, unknown>).status;
  return typeof status === "string" && status.toUpperCase() === "ERROR";
}

export function extractPrice(payload: unknown): number | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  if (isApiErrorPayload(payload)) return undefined;
  const root = payload as Record<string, unknown>;

  const direct = asNumber(root.price ?? root.current_price ?? root.sale_price);
  if (direct) return direct;

  const pricing = root.pricing;
  if (pricing && typeof pricing === "object") {
    const p = pricing as Record<string, unknown>;
    const nested = asNumber(p.current_price ?? p.current ?? p.price ?? p.value);
    if (nested) return nested;
  }

  const products = root.products ?? root.results ?? root.items ?? root.search_results;
  if (Array.isArray(products) && products.length > 0) {
    return extractPrice(products[0]);
  }

  const result = root.result;
  if (result && typeof result === "object") {
    return extractPrice(result);
  }

  const data = root.data;
  if (Array.isArray(data) && data.length > 0) {
    return extractPrice(data[0]);
  }
  if (data && typeof data === "object") {
    const nested = data as Record<string, unknown>;
    const list = nested.products ?? nested.results ?? nested.items;
    if (Array.isArray(list) && list.length > 0) {
      return extractPrice(list[0]);
    }
    return extractPrice(data);
  }

  const product = root.product;
  if (product && typeof product === "object") {
    return extractPrice(product);
  }

  return undefined;
}

export function extractName(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const root = payload as Record<string, unknown>;
  const direct = root.title ?? root.name ?? root.product_name;
  if (typeof direct === "string" && direct.trim()) return direct.trim();

  const products = root.products ?? root.results ?? root.items;
  if (Array.isArray(products) && products.length > 0) {
    return extractName(products[0]);
  }

  const data = root.data;
  if (Array.isArray(data) && data.length > 0) {
    return extractName(data[0]);
  }
  if (data && typeof data === "object") {
    const nested = data as Record<string, unknown>;
    const list = nested.products ?? nested.results ?? nested.items;
    if (Array.isArray(list) && list.length > 0) {
      return extractName(list[0]);
    }
    return extractName(data);
  }

  const product = root.product;
  if (product && typeof product === "object") {
    return extractName(product);
  }

  return undefined;
}

export class HomeDepotRetailClient implements RetailPriceProvider {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly apiHost?: string;
  private readonly authMode: AuthMode;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HomeDepotClientOptions) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiHost = options.apiHost?.trim() || undefined;
    this.authMode = options.authMode;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async searchProduct(query: string, zipCode?: string): Promise<RetailProductQuote | null> {
    if (!this.apiKey) return null;

    const searchUrl = new URL(`${this.baseUrl}/search`);
    searchUrl.searchParams.set("query", query);
    searchUrl.searchParams.set("page", "1");
    searchUrl.searchParams.set("items_per_page", "1");
    searchUrl.searchParams.set("sort_by", "best_match");
    this.applyLocalization(searchUrl, zipCode);

    const searchQuote = await this.request(searchUrl);
    if (searchQuote) return searchQuote;

    const lookupUrl = new URL(`${this.baseUrl}/item-lookup`);
    lookupUrl.searchParams.set("search", query);
    lookupUrl.searchParams.set("page", "1");
    lookupUrl.searchParams.set("items_per_page", "1");
    this.applyLocalization(lookupUrl, zipCode);
    return this.request(lookupUrl);
  }

  async lookupItem(search: string, zipCode?: string): Promise<RetailProductQuote | null> {
    if (!this.apiKey) return null;

    const lookupUrl = new URL(`${this.baseUrl}/item-lookup`);
    lookupUrl.searchParams.set("search", search);
    lookupUrl.searchParams.set("page", "1");
    lookupUrl.searchParams.set("items_per_page", "1");
    this.applyLocalization(lookupUrl, zipCode);
    return this.request(lookupUrl);
  }

  async getProductById(itemId: string, zipCode?: string): Promise<RetailProductQuote | null> {
    if (!this.apiKey) return null;

    const detailsUrl = new URL(`${this.baseUrl}/product-details`);
    detailsUrl.searchParams.set("item_id", itemId);
    this.applyLocalization(detailsUrl, zipCode);

    const detailsQuote = await this.request(detailsUrl);
    if (detailsQuote) return detailsQuote;

    const lookupUrl = new URL(`${this.baseUrl}/item-lookup`);
    lookupUrl.searchParams.set("search", itemId);
    lookupUrl.searchParams.set("page", "1");
    lookupUrl.searchParams.set("items_per_page", "1");
    this.applyLocalization(lookupUrl, zipCode);
    return this.request(lookupUrl);
  }

  private applyLocalization(url: URL, zipCode?: string, storeId?: string): void {
    const zip = zipCode?.trim();
    if (zip) {
      url.searchParams.set("zipcode", zip);
    }
    const store = storeId?.trim();
    if (store) {
      url.searchParams.set("store_id", store);
    }
  }

  private async request(url: URL): Promise<RetailProductQuote | null> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (this.authMode === "rapidapi") {
      headers["X-RapidAPI-Key"] = this.apiKey!;
      headers["X-RapidAPI-Host"] = this.apiHost ?? RAPIDAPI_DEFAULT_HOST;
    } else {
      headers["x-api-key"] = this.apiKey!;
    }

    const response = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(12_000) });
    let payload: unknown;
    try {
      payload = (await response.json()) as unknown;
    } catch {
      return null;
    }

    if (isApiErrorPayload(payload)) {
      console.warn(
        `[pricing] Home Depot API error for ${url.pathname}${url.search}: ${JSON.stringify((payload as Record<string, unknown>).error ?? "unknown")}`,
      );
      return null;
    }

    if (!response.ok) {
      console.warn(
        `[pricing] Home Depot API ${response.status} for ${url.pathname}${url.search}`,
      );
      return null;
    }

    const price = extractPrice(payload);
    if (!price) {
      console.warn(`[pricing] Home Depot API returned no parseable price for ${url.pathname}`);
      return null;
    }
    return {
      price,
      name: extractName(payload) ?? "Home Depot item",
    };
  }
}

export function resolveHomeDepotClientConfig(env: {
  HOME_DEPOT_DATA_API_KEY?: string;
  HOME_DEPOT_DATA_API_BASE_URL?: string;
  HOME_DEPOT_DATA_API_HOST?: string;
}): HomeDepotClientOptions {
  const apiKey = env.HOME_DEPOT_DATA_API_KEY?.trim() || undefined;
  const explicitHost = env.HOME_DEPOT_DATA_API_HOST?.trim();
  const explicitBase = env.HOME_DEPOT_DATA_API_BASE_URL?.trim();

  if (explicitHost) {
    return {
      apiKey,
      baseUrl: explicitBase || RAPIDAPI_DEFAULT_BASE_URL,
      apiHost: explicitHost,
      authMode: "rapidapi",
    };
  }

  const useOpenWeb =
    apiKey?.startsWith("ak_") ||
    explicitBase?.includes("openwebninja.com") ||
    !explicitBase;

  return {
    apiKey,
    baseUrl: explicitBase || OPENWEB_DEFAULT_BASE_URL,
    apiHost: undefined,
    authMode: useOpenWeb ? "openweb" : "rapidapi",
  };
}

export function isHomeDepotPricingConfigured(env: {
  HOME_DEPOT_DATA_API_KEY?: string;
}): boolean {
  const key = env.HOME_DEPOT_DATA_API_KEY?.trim();
  return Boolean(key);
}

export function createHomeDepotRetailClient(env: {
  HOME_DEPOT_DATA_API_KEY?: string;
  HOME_DEPOT_DATA_API_BASE_URL?: string;
  HOME_DEPOT_DATA_API_HOST?: string;
}): RetailPriceProvider {
  return new HomeDepotRetailClient(resolveHomeDepotClientConfig(env));
}
