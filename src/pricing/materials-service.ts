import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RetailPriceProvider } from "./home-depot-client.js";
import { PricingCache } from "./pricing-cache.js";

export type MaterialCatalogEntry = {
  search_query: string;
  fallback_price: number;
  default_item_id?: string | null;
  price_mode?: "per_sq_ft_proxy";
};

export type MaterialsPricingRequest = {
  materials: string[];
  region_hint?: string;
  zip_code?: string;
  quantity: number;
};

export type MaterialsPricingResponse = {
  total_cost: number;
  line_items: Record<string, number>;
  source: "home_depot" | "catalog_fallback";
};

const materialCatalog = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "material_catalog.json"), "utf8"),
) as Record<string, MaterialCatalogEntry>;

export class MaterialsPricingService {
  private readonly provider: RetailPriceProvider;
  private readonly cache: PricingCache;

  constructor(provider: RetailPriceProvider, cache = new PricingCache()) {
    this.provider = provider;
    this.cache = cache;
  }

  async quote(request: MaterialsPricingRequest): Promise<MaterialsPricingResponse> {
    const quantity = Math.max(request.quantity, 1);
    const zip = request.zip_code?.trim() || undefined;
    const lineItems: Record<string, number> = {};
    let usedLiveProvider = false;

    for (const key of request.materials) {
      const priced = await this.priceForMaterial(key, zip);
      lineItems[key] = roundMoney(priced.price * quantity);
      if (priced.live) usedLiveProvider = true;
    }

    const total = roundMoney(
      Object.values(lineItems).reduce((sum, value) => sum + value, 0),
    );

    return {
      total_cost: total,
      line_items: lineItems,
      source: usedLiveProvider ? "home_depot" : "catalog_fallback",
    };
  }

  private async priceForMaterial(
    materialKey: string,
    zipCode?: string,
  ): Promise<{ price: number; live: boolean }> {
    const entry = materialCatalog[materialKey];
    if (!entry) return { price: 0, live: false };

    const cacheKey = `${zipCode ?? "US"}:${materialKey}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return {
        price: cached,
        live: cached !== entry.fallback_price,
      };
    }

    let quote: { price: number } | null = null;
    if (entry.default_item_id) {
      quote = await this.provider.getProductById(entry.default_item_id, zipCode);
    }
    if (!quote) {
      quote = await this.provider.searchProduct(entry.search_query, zipCode);
    }

    if (quote) {
      this.cache.set(cacheKey, quote.price);
      return { price: quote.price, live: true };
    }

    this.cache.set(cacheKey, entry.fallback_price);
    return { price: entry.fallback_price, live: false };
  }
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function getMaterialCatalog(): Record<string, MaterialCatalogEntry> {
  return materialCatalog;
}
