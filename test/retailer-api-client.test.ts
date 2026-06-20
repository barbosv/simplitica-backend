import { describe, expect, it } from "vitest";
import {
  RetailerApiRetailClient,
  buildRetailerApiLookupAttempts,
  extractRetailerApiName,
  extractRetailerApiPrice,
} from "../src/pricing/retailer-api-client.js";

describe("retailer-api-client", () => {
  it("extracts current_price and buybox_price", () => {
    expect(extractRetailerApiPrice({ current_price: 119.99 })).toBe(119.99);
    expect(extractRetailerApiPrice({ buybox_price: 88.5 })).toBe(88.5);
    expect(extractRetailerApiPrice({ current_price: null, buybox_price: 42 })).toBe(42);
  });

  it("extracts title", () => {
    expect(extractRetailerApiName({ title: "MOEN Kitchen Faucet" })).toBe("MOEN Kitchen Faucet");
  });

  it("builds lookup attempts in priority order", () => {
    const productUrl =
      "https://www.homedepot.com/p/HOMEWERKS-Faucet-Supply-Line-2-Pack/205708840";
    const attempts = buildRetailerApiLookupAttempts("205708840", productUrl);
    expect(attempts).toEqual([
      { identifier: "205708840", format: "item_id" },
      { identifier: productUrl },
      { identifier: "https://www.homedepot.com/p/205708840" },
    ]);
  });

  it("sends Bearer auth, format=item_id, and retailer=homedepot for item_id lookup", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};

    const fetchImpl: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      return new Response(
        JSON.stringify({
          item_id: "100037089",
          title: "MOEN Kitchen Faucet",
          current_price: 92.5,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const client = new RetailerApiRetailClient({
      apiKey: "rk_live_test",
      fetchImpl,
    });

    const quote = await client.getProductById("100037089", "30075");
    expect(quote).toEqual({ price: 92.5, name: "MOEN Kitchen Faucet" });
    expect(capturedHeaders.authorization).toBe("Bearer rk_live_test");
    expect(capturedUrl).toContain("/products/100037089");
    expect(capturedUrl).toContain("format=item_id");
    expect(capturedUrl).toContain("retailer=homedepot");
  });

  it("retries with homedepot product URL after item_id 404", async () => {
    const calls: string[] = [];
    const productUrl =
      "https://www.homedepot.com/p/HOMEWERKS-Faucet-Supply-Line-2-Pack/205708840";

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("format=item_id")) {
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }
      if (url.includes(encodeURIComponent(productUrl))) {
        return new Response(
          JSON.stringify({ title: "Supply Lines", current_price: 28 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    };

    const client = new RetailerApiRetailClient({ apiKey: "rk_live_test", fetchImpl });
    const quote = await client.getProductById("205708840", undefined, productUrl);
    expect(quote?.price).toBe(28);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls[0]).toContain("format=item_id");
    expect(calls.some((call) => call.includes(encodeURIComponent(productUrl)))).toBe(true);
  });

  it("returns null when all attempts fail", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: "not found" }), { status: 404 });

    const client = new RetailerApiRetailClient({ apiKey: "rk_live_test", fetchImpl });
    expect(await client.getProductById("999999999")).toBeNull();
  });

  it("returns null on 429 and 502", async () => {
    const makeClient = (status: number) =>
      new RetailerApiRetailClient({
        apiKey: "rk_live_test",
        fetchImpl: async () => new Response("{}", { status }),
      });

    expect(await makeClient(429).getProductById("100037089")).toBeNull();
    expect(await makeClient(502).getProductById("100037089")).toBeNull();
  });

  it("searchProduct returns null", async () => {
    const client = new RetailerApiRetailClient({ apiKey: "rk_live_test" });
    expect(await client.searchProduct("drill")).toBeNull();
  });
});
