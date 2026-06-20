import type { Env } from "../env.js";
import {
  createHomeDepotRetailClient,
  isHomeDepotPricingConfigured,
  type RetailPriceProvider,
  type RetailProductQuote,
} from "./home-depot-client.js";
import { createRetailerApiClient, isRetailerApiConfigured } from "./retailer-api-client.js";

export class ChainedRetailPriceProvider implements RetailPriceProvider {
  constructor(private readonly providers: RetailPriceProvider[]) {}

  async searchProduct(query: string, zipCode?: string): Promise<RetailProductQuote | null> {
    for (const provider of this.providers) {
      const quote = await provider.searchProduct(query, zipCode);
      if (quote) return quote;
    }
    return null;
  }

  async lookupItem(search: string, zipCode?: string): Promise<RetailProductQuote | null> {
    for (const provider of this.providers) {
      const quote = await provider.lookupItem(search, zipCode);
      if (quote) return quote;
    }
    return null;
  }

  async getProductById(
    itemId: string,
    zipCode?: string,
    productUrl?: string,
  ): Promise<RetailProductQuote | null> {
    for (const provider of this.providers) {
      const quote = await provider.getProductById(itemId, zipCode, productUrl);
      if (quote) return quote;
    }
    return null;
  }
}

export function isLiveMaterialsPricingConfigured(env: Env): boolean {
  return isRetailerApiConfigured(env) || isHomeDepotPricingConfigured(env);
}

export function createRetailPriceProvider(env: Env): RetailPriceProvider {
  const providers: RetailPriceProvider[] = [];

  if (isRetailerApiConfigured(env)) {
    providers.push(createRetailerApiClient(env));
  }
  if (isHomeDepotPricingConfigured(env)) {
    providers.push(createHomeDepotRetailClient(env));
  }

  if (providers.length === 0) {
    return new ChainedRetailPriceProvider([]);
  }
  if (providers.length === 1) {
    return providers[0]!;
  }
  return new ChainedRetailPriceProvider(providers);
}
