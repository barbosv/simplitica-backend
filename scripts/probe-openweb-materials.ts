#!/usr/bin/env tsx
/**
 * Probe OpenWeb Ninja Home Depot endpoints with a local API key.
 *
 * Usage:
 *   HOME_DEPOT_DATA_API_KEY=ak_... npx tsx scripts/probe-openweb-materials.ts faucet supply_lines
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHomeDepotRetailClient } from "../src/pricing/home-depot-client.js";

type CatalogEntry = {
  search_query: string;
  fallback_price: number;
  default_item_id?: string;
};

const catalog = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/pricing/material_catalog.json"), "utf8"),
) as Record<string, CatalogEntry>;

const keys = process.argv.slice(2);
const materials = keys.length > 0 ? keys : ["faucet", "supply_lines"];
const zip = process.env.PROBE_ZIP_CODE ?? "30075";

const client = createHomeDepotRetailClient({
  HOME_DEPOT_DATA_API_KEY: process.env.HOME_DEPOT_DATA_API_KEY,
});

if (!process.env.HOME_DEPOT_DATA_API_KEY?.trim()) {
  console.error("Set HOME_DEPOT_DATA_API_KEY (ak_...) to probe OpenWeb Ninja.");
  process.exit(1);
}

for (const key of materials) {
  const entry = catalog[key];
  if (!entry) {
    console.log(`\n[${key}] unknown material key`);
    continue;
  }

  console.log(`\n[${key}] fallback=$${entry.fallback_price} item=${entry.default_item_id ?? "none"}`);

  if (entry.default_item_id) {
    const byId = await client.getProductById(entry.default_item_id, zip);
    console.log(`  product-details → ${byId ? `$${byId.price} (${byId.name})` : "miss"}`);
  }

  const byLookup = await client.lookupItem(entry.search_query, zip);
  console.log(`  item-lookup     → ${byLookup ? `$${byLookup.price} (${byLookup.name})` : "miss"}`);

  const bySearch = await client.searchProduct(entry.search_query, zip);
  console.log(`  search          → ${bySearch ? `$${bySearch.price} (${bySearch.name})` : "miss"}`);
}
