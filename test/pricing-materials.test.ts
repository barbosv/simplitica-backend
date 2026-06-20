import { describe, expect, it } from "vitest";
import { buildTestApp, testEnv } from "./test-helpers.js";
import type { RetailPriceProvider, RetailProductQuote } from "../src/pricing/home-depot-client.js";
import { MaterialsPricingService } from "../src/pricing/materials-service.js";
import { buildApp } from "../src/app.js";
import { createTestContext } from "../src/db/context.js";

class StubRetailProvider implements RetailPriceProvider {
  constructor(private readonly prices: Record<string, number>) {}

  async searchProduct(query: string): Promise<RetailProductQuote | null> {
    if (query.includes("supply lines")) {
      return { price: this.prices.supply_lines ?? 28, name: "supply_lines" };
    }
    if (query.includes("faucet")) {
      return { price: this.prices.faucet ?? 92, name: "faucet" };
    }
    return null;
  }

  async getProductById(itemId: string): Promise<RetailProductQuote | null> {
    if (itemId === "100037089") {
      return { price: this.prices.faucet ?? 92, name: "faucet" };
    }
    if (itemId === "205708840") {
      return { price: this.prices.supply_lines ?? 28, name: "supply_lines" };
    }
    return null;
  }

  async lookupItem(): Promise<RetailProductQuote | null> {
    return null;
  }
}

describe("pricing materials", () => {
  it("returns 400 for invalid body", async () => {
    const app = buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/pricing/materials",
      payload: { materials: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("uses catalog fallback when provider has no API key", async () => {
    const app = buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/pricing/materials",
      payload: {
        materials: ["faucet", "supply_lines"],
        quantity: 1,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      total_cost: 110,
      line_items: { faucet: 85, supply_lines: 25 },
      source: "catalog_fallback",
      live_lookup_attempted: false,
    });
  });

  it("returns live home depot totals from stub provider", async () => {
    const provider = new StubRetailProvider({
      faucet: 92,
      "supply lines": 28,
    });
    const service = new MaterialsPricingService(provider, true);
    const result = await service.quote({
      materials: ["faucet", "supply_lines"],
      quantity: 1,
      zip_code: "30075",
    });
    expect(result.source).toBe("home_depot");
    expect(result.live_lookup_attempted).toBe(true);
    expect(result.total_cost).toBe(120);
    expect(result.line_items).toEqual({ faucet: 92, supply_lines: 28 });
  });

  it("registers route on app", async () => {
    const env = testEnv();
    const ctx = createTestContext();
    const app = buildApp({ env, ctx });
    const res = await app.inject({
      method: "POST",
      url: "/v1/pricing/materials",
      payload: { materials: ["faucet"], quantity: 2 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().total_cost).toBeGreaterThan(0);
  });

  it("returns wage fallback when BLS key is missing", async () => {
    const app = buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/pricing/wages",
      payload: { soc_code: "47-2031", state_code: "GA", fallback: 24 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      hourly_wage: 24,
      source: "template_fallback",
      live_lookup_attempted: false,
    });
  });

  it("ignores empty state_code on wages (treats as national lookup)", async () => {
    const app = buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/pricing/wages",
      payload: { soc_code: "47-2031", state_code: "", fallback: 24 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().source).toBe("template_fallback");
  });
});
