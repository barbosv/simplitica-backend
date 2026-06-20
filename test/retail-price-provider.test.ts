import { describe, expect, it } from "vitest";
import type { RetailPriceProvider, RetailProductQuote } from "../src/pricing/home-depot-client.js";
import {
  ChainedRetailPriceProvider,
  createRetailPriceProvider,
  isLiveMaterialsPricingConfigured,
} from "../src/pricing/retail-price-provider.js";
import { testEnv } from "./test-helpers.js";

class StubProvider implements RetailPriceProvider {
  constructor(
    private readonly name: string,
    private readonly quotes: Partial<Record<string, RetailProductQuote>>,
  ) {}

  async searchProduct(query: string): Promise<RetailProductQuote | null> {
    return this.quotes[`search:${query}`] ?? null;
  }

  async lookupItem(search: string): Promise<RetailProductQuote | null> {
    return this.quotes[`lookup:${search}`] ?? null;
  }

  async getProductById(itemId: string): Promise<RetailProductQuote | null> {
    return this.quotes[`id:${itemId}`] ?? null;
  }

  label(): string {
    return this.name;
  }
}

describe("retail-price-provider", () => {
  it("returns first non-null quote from chain", async () => {
    const chain = new ChainedRetailPriceProvider([
      new StubProvider("retailerapi", {}),
      new StubProvider("openweb", {
        "id:100037089": { price: 85, name: "faucet" },
      }),
    ]);

    const quote = await chain.getProductById("100037089");
    expect(quote).toEqual({ price: 85, name: "faucet" });
  });

  it("prefers earlier provider when both return quotes", async () => {
    const chain = new ChainedRetailPriceProvider([
      new StubProvider("retailerapi", {
        "id:100037089": { price: 92, name: "faucet-live" },
      }),
      new StubProvider("openweb", {
        "id:100037089": { price: 85, name: "faucet-fallback" },
      }),
    ]);

    const quote = await chain.getProductById("100037089");
    expect(quote?.price).toBe(92);
    expect(quote?.name).toBe("faucet-live");
  });

  it("isLiveMaterialsPricingConfigured is true with either key", () => {
    expect(isLiveMaterialsPricingConfigured(testEnv())).toBe(false);
    expect(
      isLiveMaterialsPricingConfigured(testEnv({ RETAILERAPI_KEY: "rk_live_test" })),
    ).toBe(true);
    expect(
      isLiveMaterialsPricingConfigured(testEnv({ HOME_DEPOT_DATA_API_KEY: "ak_test" })),
    ).toBe(true);
  });

  it("createRetailPriceProvider returns chain when both keys are set", () => {
    const provider = createRetailPriceProvider(
      testEnv({
        RETAILERAPI_KEY: "rk_live_test",
        HOME_DEPOT_DATA_API_KEY: "ak_test",
      }),
    );
    expect(provider).toBeInstanceOf(ChainedRetailPriceProvider);
  });

  it("createRetailPriceProvider returns a single client when only RetailerAPI is set", () => {
    const provider = createRetailPriceProvider(testEnv({ RETAILERAPI_KEY: "rk_live_test" }));
    expect(provider).not.toBeInstanceOf(ChainedRetailPriceProvider);
  });
});
