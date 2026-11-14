import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { env as workerEnv } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import worker from "../../src/worker.js";
const env = workerEnv as {
  DB: D1Database;
  TEST_MIGRATIONS: import("@cloudflare/vitest-plugin").D1Migration[];
};
beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("retries a mixed quote's fallback after five minutes while reusing its live material", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2026-11-09T12:00:00Z");
  let recovered = false,
    faucetCalls = 0,
    supplyCalls = 0;
  vi.stubGlobal("fetch", async (input: string | URL) => {
    if (String(input).includes("100037089")) {
      faucetCalls++;
      return Response.json({ price: 100 });
    }
    supplyCalls++;
    return recovered
      ? Response.json({ price: 40 })
      : new Response("unavailable", { status: 503 });
  });
  const quote = async () => {
    const response = await worker.fetch(
      new Request("https://api.test/v1/pricing/materials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          materials: ["faucet", "supply_lines"],
          quantity: 1,
        }),
      }),
      {
        DB: env.DB,
        NODE_ENV: "test",
        RETAILERAPI_KEY: "rk_test_cache",
        RETAILERAPI_BASE_URL: "https://retailer.test/v1",
      },
    );
    expect(response.status).toBe(200);
    return response.json();
  };
  expect(await quote()).toMatchObject({
    source: "home_depot",
    line_items: { faucet: 100, supply_lines: 25 },
  });
  const originalFaucetCalls = faucetCalls,
    originalSupplyCalls = supplyCalls;
  recovered = true;
  vi.setSystemTime("2026-11-09T12:05:01Z");
  expect(await quote()).toMatchObject({
    line_items: { faucet: 100, supply_lines: 40 },
  });
  expect(faucetCalls).toBe(originalFaucetCalls);
  expect(supplyCalls).toBeGreaterThan(originalSupplyCalls);
});
