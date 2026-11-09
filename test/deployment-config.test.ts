import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
function run(extra: Record<string, string>, target = "staging") {
  const dir = mkdtempSync(join(tmpdir(), "simplitica-config-"));
  dirs.push(dir);
  const output = join(dir, "wrangler.json");
  const result = spawnSync(
    process.execPath,
    ["scripts/prepare-worker-config.mjs", target, output],
    { encoding: "utf8", env: { PATH: process.env.PATH, ...extra } },
  );
  return { result, output };
}
it("rejects missing account/database configuration without deploying", () => {
  const { result } = run({});
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("CLOUDFLARE_ACCOUNT_ID");
});
it("produces a configured staging Worker without copying secrets into its config", () => {
  const { result, output } = run({
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    CLOUDFLARE_DATABASE_ID: "11111111-1111-4111-8111-111111111111",
    STRIPE_SECRET_KEY: "must-not-appear",
  });
  expect(result.status, result.stderr).toBe(0);
  const text = readFileSync(output, "utf8"),
    config = JSON.parse(text);
  expect(text).not.toContain("must-not-appear");
  expect(config.name).toBe("simplitica-backend-staging");
  expect(config.vars.STRIPE_MODE).toBe("test");
  expect(config.d1_databases[0].database_id).toBe(
    "11111111-1111-4111-8111-111111111111",
  );
});
it("requires Apple app ID and explicit payment mode for production", () => {
  const base = {
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    CLOUDFLARE_DATABASE_ID: "11111111-1111-4111-8111-111111111111",
  };
  expect(run(base, "production").result.status).toBe(1);
  const { result, output } = run(
    { ...base, SIMPLI_INVOICE_APP_APPLE_ID: "123456789", STRIPE_MODE: "test" },
    "production",
  );
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(output, "utf8")).vars).toMatchObject({
    APPLE_ENVIRONMENT: "Production",
    STRIPE_MODE: "test",
    SIMPLI_INVOICE_APP_APPLE_ID: "123456789",
  });
});

it("passes GitHub environment overrides through the workflow into generated config", () => {
  const workflow = parse(
    readFileSync(".github/workflows/deploy-worker.yml", "utf8"),
  );
  const vars: Record<string, string> = {
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    CLOUDFLARE_DATABASE_ID: "11111111-1111-4111-8111-111111111111",
    STRIPE_PLATFORM_COUNTRY: "CA",
    SIMPLILIST_RATE_LIMIT_PER_MINUTE: "7",
    PUBLIX_DEALS_CACHE_MS: "123000",
    PUBLIX_DEALS_FIXTURE: "true",
    RETAILERAPI_BASE_URL: "https://retailer.test/v1",
    HOME_DEPOT_DATA_API_BASE_URL: "https://home.test/v1",
    HOME_DEPOT_DATA_API_HOST: "home.test",
  };
  const environment: Record<string, string> = {};
  for (const [name, expression] of Object.entries(workflow.jobs.deploy.env)) {
    const variable = /^\$\{\{ vars\.(\w+) \}\}$/.exec(String(expression))?.[1];
    environment[name] = variable ? (vars[variable] ?? "") : "";
  }
  const { result, output } = run(environment);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(output, "utf8")).vars).toMatchObject({
    STRIPE_PLATFORM_COUNTRY: "CA",
    SIMPLILIST_RATE_LIMIT_PER_MINUTE: "7",
    PUBLIX_DEALS_CACHE_MS: "123000",
    PUBLIX_DEALS_FIXTURE: "true",
    RETAILERAPI_BASE_URL: "https://retailer.test/v1",
    HOME_DEPOT_DATA_API_BASE_URL: "https://home.test/v1",
    HOME_DEPOT_DATA_API_HOST: "home.test",
  });
});
