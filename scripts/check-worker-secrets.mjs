import console from "node:console";
import { readFileSync } from "node:fs";
import process from "node:process";
const names = new Set(
  JSON.parse(readFileSync(process.argv[2], "utf8")).map(
    (secret) => secret.name,
  ),
);
const required = ["SIMPLITICA_CLIENT_API_KEY", "SIMPLILIST_BACKEND_API_KEY"];
if (process.env.STRIPE_MODE === "live")
  required.push("STRIPE_SECRET_KEY_LIVE", "STRIPE_WEBHOOK_SECRET_LIVE");
else required.push("STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET");
const missing = required.filter((name) => !names.has(name));
if (missing.length) {
  console.error("Missing Worker secrets: " + missing.join(", "));
  process.exit(1);
}
