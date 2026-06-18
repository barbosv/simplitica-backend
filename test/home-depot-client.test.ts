import { describe, expect, it } from "vitest";
import {
  HomeDepotRetailClient,
  extractName,
  extractPrice,
  resolveHomeDepotClientConfig,
} from "../src/pricing/home-depot-client.js";

describe("home-depot-client", () => {
  it("extracts OpenWeb Ninja pricing.current_price", () => {
    const payload = {
      item_id: "326680222",
      title: "ONE+ 18V Cordless Drill/Driver Kit",
      pricing: {
        current_price: 49.97,
        original_price: null,
        currency: "USD",
      },
    };
    expect(extractPrice(payload)).toBe(49.97);
    expect(extractName(payload)).toBe("ONE+ 18V Cordless Drill/Driver Kit");
  });

  it("extracts price from nested data products list", () => {
    const payload = {
      data: [
        {
          title: "Kitchen Faucet",
          pricing: { current_price: 119.99 },
        },
      ],
    };
    expect(extractPrice(payload)).toBe(119.99);
    expect(extractName(payload)).toBe("Kitchen Faucet");
  });

  it("defaults to OpenWeb direct for ak_ keys", () => {
    const config = resolveHomeDepotClientConfig({
      HOME_DEPOT_DATA_API_KEY: "ak_test_key",
    });
    expect(config.authMode).toBe("openweb");
    expect(config.baseUrl).toBe("https://api.openwebninja.com/realtime-homedepot-data");
    expect(config.apiHost).toBeUndefined();
  });

  it("uses RapidAPI when host is explicitly set", () => {
    const config = resolveHomeDepotClientConfig({
      HOME_DEPOT_DATA_API_KEY: "rapid-key",
      HOME_DEPOT_DATA_API_HOST: "real-time-home-depot-data.p.rapidapi.com",
    });
    expect(config.authMode).toBe("rapidapi");
    expect(config.apiHost).toBe("real-time-home-depot-data.p.rapidapi.com");
  });

  it("sends x-api-key header for OpenWeb direct requests", async () => {
    let capturedHeaders: Record<string, string> = {};
    const client = new HomeDepotRetailClient({
      apiKey: "ak_test",
      baseUrl: "https://api.openwebninja.com/realtime-homedepot-data",
      authMode: "openweb",
      fetchImpl: async (_url, init) => {
        capturedHeaders = init?.headers as Record<string, string>;
        return new Response(
          JSON.stringify({
            data: [{ title: "Faucet", pricing: { current_price: 88.5 } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });

    const quote = await client.searchProduct("kitchen faucet", "30075");
    expect(capturedHeaders["x-api-key"]).toBe("ak_test");
    expect(quote).toEqual({ price: 88.5, name: "Faucet" });
  });
});
