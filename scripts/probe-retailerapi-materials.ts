#!/usr/bin/env tsx
/**
 * Probe RetailerAPI Home Depot product lookups with a local API key.
 *
 * Usage:
 *   RETAILERAPI_KEY=rk_live_... npx tsx scripts/probe-retailerapi-materials.ts faucet supply_lines
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRetailerApiClient } from "../src/pricing/retailer-api-client.js";

type CatalogEntry = {
  search_query: string;
  fallback_price: number;
  default_item_id?: string;
  default_product_url?: string;
};

const catalog = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/pricing/material_catalog.json"), "utf8"),
) as Record<string, CatalogEntry>;

const keys = process.argv.slice(2);
const materials = keys.length > 0 ? keys : ["faucet", "supply_lines"];
const zip = process.env.PROBE_ZIP_CODE ?? "30075";

if (!process.env.RETAILERAPI_KEY?.trim()) {
  console.error("Set RETAILERAPI_KEY (rk_live_...) to probe RetailerAPI.");
  process.exit(1);
}

const client = createRetailerApiClient({
  RETAILERAPI_KEY: process.env.RETAILERAPI_KEY,
  RETAILERAPI_BASE_URL: process.env.RETAILERAPI_BASE_URL,
});

for (const key of materials) {
  const entry = catalog[key];
  if (!entry) {
    console.log(`\n[${key}] unknown material key`);
    continue;
  }

  console.log(`\n[${key}] fallback=$${entry.fallback_price} item=${entry.default_item_id ?? "none"}`);

  if (!entry.default_item_id) {
    console.log("  retailerapi → skip (no default_item_id; keyword search not supported)");
    continue;
  }

  const quote = await client.getProductById(
    entry.default_item_id,
    zip,
    entry.default_product_url ?? undefined,
  );
  console.log(
    `  retailerapi → ${quote ? `$${quote.price} (${quote.name})` : "miss"}`,
  );
}
