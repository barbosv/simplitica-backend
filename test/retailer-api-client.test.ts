import { describe, expect, it } from "vitest";
import {
  RetailerApiRetailClient,
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

  it("sends Bearer auth and retailer=homedepot for item_id lookup", async () => {
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
    expect(capturedUrl).toContain("retailer=homedepot");
  });

  it("prefers homedepot product URL as identifier", async () => {
    let capturedUrl = "";

    const fetchImpl: typeof fetch = async (input) => {
      capturedUrl = String(input);
      return new Response(
        JSON.stringify({ title: "Supply Lines", current_price: 28 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const client = new RetailerApiRetailClient({
      apiKey: "rk_live_test",
      fetchImpl,
    });

    const productUrl =
      "https://www.homedepot.com/p/HOMEWERKS-Faucet-Supply-Line-2-Pack/205708840";
    const quote = await client.getProductById("205708840", undefined, productUrl);
    expect(quote?.price).toBe(28);
    expect(capturedUrl).toContain(encodeURIComponent(productUrl));
  });

  it("returns null on 404", async () => {
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
