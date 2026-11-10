import { URL, fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import console from "node:console";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import process from "node:process";

const target = process.argv[2];
function fail(message) {
  console.error(message);
  process.exit(1);
}
if (!["staging", "production"].includes(target))
  fail("Choose staging or production");
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const database = process.env.CLOUDFLARE_DATABASE_ID;
if (!/^[a-f0-9]{32}$/i.test(account ?? ""))
  fail("Set CLOUDFLARE_ACCOUNT_ID to the owning account's ID");
if (
  !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
    database ?? "",
  )
)
  fail("Set CLOUDFLARE_DATABASE_ID to an existing D1 database ID");
if (
  target === "production" &&
  !/^[1-9]\d*$/.test(process.env.SIMPLI_INVOICE_APP_APPLE_ID ?? "")
)
  fail("Set SIMPLI_INVOICE_APP_APPLE_ID before production deployment");
if (
  target === "production" &&
  !["test", "live"].includes(process.env.STRIPE_MODE)
)
  fail("Explicitly choose STRIPE_MODE=test or live for production");
const errors = [];
const source = parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"), errors, {allowTrailingComma:true});
if (errors.length) fail("Invalid Wrangler configuration");
const selected = source.env[target];
if (process.env.WORKER_SMOKE_URL) {
  let url;
  try {url=new URL(process.env.WORKER_SMOKE_URL);} catch {fail("Invalid WORKER_SMOKE_URL");}
  if (url.protocol !== "https:" || !url.hostname.startsWith(selected.name+".") || !url.hostname.endsWith(".workers.dev") || url.username || url.password || url.search || url.hash || url.pathname !== "/") fail("WORKER_SMOKE_URL must be this environment's workers.dev URL");
}
const root = fileURLToPath(new URL("../", import.meta.url));
const vars = { ...selected.vars };
for (const name of [
  "SIMPLI_INVOICE_APP_APPLE_ID",
  "SIMPLI_INVOICE_BUNDLE_ID",
  "STRIPE_PLATFORM_COUNTRY",
  "STRIPE_CONNECT_RETURN_URL",
  "STRIPE_CONNECT_REFRESH_URL",
  "CORS_ORIGIN",
  "SIMPLILIST_RATE_LIMIT_PER_MINUTE",
  "PUBLIX_DEALS_CACHE_MS",
  "PUBLIX_DEALS_FIXTURE",
  "RETAILERAPI_BASE_URL",
  "HOME_DEPOT_DATA_API_BASE_URL",
  "HOME_DEPOT_DATA_API_HOST",
]) {
  if (process.env[name]) vars[name] = process.env[name];
}
vars.STRIPE_MODE = target === "staging" ? "test" : process.env.STRIPE_MODE;
const config = {
  name: selected.name,
  main: resolve(root, source.main),
  account_id: account,
  compatibility_date: source.compatibility_date,
  compatibility_flags: source.compatibility_flags,
  alias: {
    "node-fetch": resolve(root, source.alias["node-fetch"]),
    jsrsasign: resolve(root, source.alias.jsrsasign),
  },
  vars,
  triggers: { crons: ["*/5 * * * *"] },
  d1_databases: [
    {
      ...selected.d1_databases[0],
      database_id: database,
      migrations_dir: resolve(root, "migrations/d1"),
    },
  ],
};
const output = resolve(process.argv[3] ?? `.wrangler/deploy-${target}.json`);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(config, null, 2) + "\n");
console.log(output);
