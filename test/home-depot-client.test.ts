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

  it("extracts price from OpenWeb OK item-lookup payloads", () => {
    const payload = {
      status: "OK",
      data: [
        {
          item_id: "326680222",
          title: "ONE+ 18V Cordless Drill/Driver Kit",
          pricing: { current_price: 49.97, currency: "USD" },
        },
      ],
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

  it("extracts price from search_results offers.primary", () => {
    const payload = {
      search_results: [
        {
          product: { title: "Kitchen Faucet" },
          offers: { primary: { price: 88.5, currency: "USD" } },
        },
      ],
    };
    expect(extractPrice(payload)).toBe(88.5);
    expect(extractName(payload)).toBe("Kitchen Faucet");
  });

  it("rejects OpenWeb ERROR payloads", () => {
    expect(
      extractPrice({
        status: "ERROR",
        error: { message: "Home Depot returned no search data.", code: 502 },
      }),
    ).toBeUndefined();
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

  it("sends x-api-key header and OpenWeb search query params", async () => {
    const capturedUrls: string[] = [];
    let capturedHeaders: Record<string, string> = {};
    const client = new HomeDepotRetailClient({
      apiKey: "ak_test",
      baseUrl: "https://api.openwebninja.com/realtime-homedepot-data",
      authMode: "openweb",
      fetchImpl: async (url, init) => {
        capturedUrls.push(url.toString());
        capturedHeaders = init?.headers as Record<string, string>;
        if (url.toString().includes("/search")) {
          return new Response(
            JSON.stringify({ status: "ERROR", error: { message: "no search data", code: 502 } }),
            { status: 502, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            status: "OK",
            data: [{ title: "Faucet", pricing: { current_price: 88.5 } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });

    const quote = await client.searchProduct("kitchen faucet", "30309");
    expect(capturedHeaders["x-api-key"]).toBe("ak_test");
    expect(capturedUrls[0]).toContain("/search?");
    expect(capturedUrls[0]).toContain("items_per_page=1");
    expect(capturedUrls[0]).toContain("zipcode=30309");
    expect(capturedUrls[0]).not.toContain("limit=");
    expect(capturedUrls[1]).toContain("/item-lookup?");
    expect(quote).toEqual({ price: 88.5, name: "Faucet" });
  });

  it("uses product-details then item-lookup for item ids", async () => {
    const requested: string[] = [];
    const lookupQueries: string[] = [];
    const client = new HomeDepotRetailClient({
      apiKey: "ak_test",
      baseUrl: "https://api.openwebninja.com/realtime-homedepot-data",
      authMode: "openweb",
      fetchImpl: async (url) => {
        const parsed = new URL(url instanceof URL ? url : String(url));
        requested.push(parsed.pathname);
        if (parsed.pathname.endsWith("/item-lookup")) {
          lookupQueries.push(parsed.searchParams.get("item_id") ?? parsed.searchParams.get("search") ?? "");
        }
        if (parsed.pathname.endsWith("/product-details")) {
          return new Response(
            JSON.stringify({ status: "ERROR", error: { message: "no product", code: 502 } }),
            { status: 502, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            status: "OK",
            data: [{ title: "Drill", pricing: { current_price: 49.97 } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });

    const quote = await client.getProductById("326680222", "30301");
    expect(requested).toEqual([
      "/realtime-homedepot-data/product-details",
      "/realtime-homedepot-data/item-lookup",
    ]);
    expect(lookupQueries).toEqual(["326680222"]);
    expect(quote).toEqual({ price: 49.97, name: "Drill" });
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
            status: "OK",
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
