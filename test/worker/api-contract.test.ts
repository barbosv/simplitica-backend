import { beforeEach, expect, it } from "vitest";
import { env as workerEnv } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import worker from "../../src/worker.js";
import { createD1Repositories } from "../../src/db/repositories/d1.js";

const env = workerEnv as {
  DB: D1Database;
  TEST_MIGRATIONS: import("@cloudflare/vitest-plugin").D1Migration[];
};
beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
const config = () => ({
  DB: env.DB,
  NODE_ENV: "test",
  STORAGE_BACKEND: "d1",
  PUBLIX_DEALS_FIXTURE: "true",
});
const request = (path: string, init: RequestInit = {}, overrides = {}) =>
  worker.fetch(new Request("https://api.test" + path, init), {
    ...config(),
    ...overrides,
  });

it("serves health and D1 readiness with configuration indicators", async () => {
  expect(await (await request("/health")).json()).toEqual({ ok: true });
  expect(await (await request("/health/ready")).json()).toMatchObject({
    ok: true,
    database: "connected",
    pricing: { client_api_key_required: false },
    simplilist: { backend_api_key_configured: false },
  });
});
it("preserves missing-token errors and reads persisted entitlements", async () => {
  expect(await (await request("/v1/entitlements")).json()).toEqual({
    error: "Missing X-App-Account-Token",
  });
  await createD1Repositories(env.DB).subscriptions.upsert({
    appSlug: "simpli-invoice",
    appAccountToken: "token",
    originalTransactionId: "123",
    productId: "monthly",
    state: "active",
  });
  expect(
    await (
      await request("/v1/entitlements", {
        headers: { "X-App-Account-Token": "token" },
      })
    ).json(),
  ).toMatchObject({ entitlement: { state: "active" } });
});
it("preserves subscription validation and rejects invalid signed payloads", async () => {
  for (const path of ["/v1/subscriptions/sync", "/v1/webhooks/app-store"]) {
    expect(
      (
        await request(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(400);
  }
  const result = await request("/v1/subscriptions/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appAccountToken: crypto.randomUUID(),
      signedTransactionInfo: "invalid.signed.data",
    }),
  });
  expect(await result.json()).toEqual({
    error: "Invalid signedTransactionInfo",
  });
});
it("preserves pricing auth and materials fallback contracts", async () => {
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ materials: ["drywall"], quantity: 1 }),
  };
  expect(
    (
      await request("/v1/pricing/materials", init, {
        SIMPLITICA_CLIENT_API_KEY: "private",
      })
    ).status,
  ).toBe(401);
  const result = await request(
    "/v1/pricing/materials",
    { ...init, headers: { ...init.headers, "X-API-Key": "private" } },
    { SIMPLITICA_CLIENT_API_KEY: "private" },
  );
  expect(await result.json()).toMatchObject({
    source: "catalog_fallback",
    live_lookup_attempted: false,
  });
  expect(
    (await request("/v1/pricing/wages", { ...init, body: "{}" })).status,
  ).toBe(400);
});
it("preserves SimpliList configuration, auth, device, and fixture contracts", async () => {
  const path = "/v1/deals/publix/bogo?storeNumber=123&zip=33101";
  expect(await (await request(path)).json()).toEqual({
    error: "simplilist_not_configured",
  });
  expect(
    (await request(path, {}, { SIMPLILIST_BACKEND_API_KEY: "private" })).status,
  ).toBe(401);
  expect(
    await (
      await request(
        path,
        { headers: { Authorization: "Bearer private" } },
        { SIMPLILIST_BACKEND_API_KEY: "private" },
      )
    ).json(),
  ).toEqual({ error: "missing_x_device_id" });
  expect(
    await (
      await request(
        path,
        {
          headers: { Authorization: "Bearer private", "X-Device-Id": "device" },
        },
        { SIMPLILIST_BACKEND_API_KEY: "private" },
      )
    ).json(),
  ).toMatchObject({ source: "fixture", storeNumber: "123" });
});
it("preserves invoice validation and every public landing page", async () => {
  expect((await request("/v1/stripe/connect/status")).status).toBe(400);
  expect(
    (
      await request("/v1/stripe/connect/status", {
        headers: { "X-Business-Id": crypto.randomUUID() },
      })
    ).status,
  ).toBe(503);
  for (const path of [
    "/stripe/return",
    "/stripe/refresh",
    "/payment/success",
    "/payment/cancel",
  ]) {
    const result = await request(path);
    expect(result.status).toBe(200);
    expect(result.headers.get("Content-Type")).toContain("text/html");
  }
  expect((await request("/missing")).status).toBe(404);
});

it("returns malformed JSON and oversized-body errors through the real route", async () => {
  expect(
    (
      await request("/v1/subscriptions/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request("/v1/subscriptions/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "x".repeat(262145),
      })
    ).status,
  ).toBe(413);
});
it("applies allowed CORS origins and production security headers", async () => {
  const production = {
    NODE_ENV: "production",
    STRIPE_SECRET_KEY: "sk_test_fixture",
    STRIPE_WEBHOOK_SECRET: "whsec_fixture",
    STRIPE_CONNECT_RETURN_URL: "https://api.test/stripe/return",
    STRIPE_CONNECT_REFRESH_URL: "https://api.test/stripe/refresh",
    CORS_ORIGIN: "https://allowed.test",
  };
  const result = await request(
    "/health",
    { headers: { Origin: "https://allowed.test" } },
    production,
  );
  expect(result.headers.get("Access-Control-Allow-Origin")).toBe(
    "https://allowed.test",
  );
  expect(result.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(result.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
  const forbidden = await request(
    "/health",
    { headers: { Origin: "https://forbidden.test" } },
    production,
  );
  expect(forbidden.headers.get("Access-Control-Allow-Origin")).not.toBe(
    "https://forbidden.test",
  );
});

it("enforces persistent pricing and SimpliList quotas across fresh app instances", async () => {
  const ip = crypto.randomUUID();
  for (let index = 0; index < 30; index++)
    expect(
      (
        await request("/v1/pricing/wages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "CF-Connecting-IP": ip,
          },
          body: "{}",
        })
      ).status,
    ).toBe(400);
  expect(
    (
      await request("/v1/pricing/wages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
        body: "{}",
      })
    ).status,
  ).toBe(429);
  const device = crypto.randomUUID(),
    override = {
      SIMPLILIST_BACKEND_API_KEY: "private",
      SIMPLILIST_RATE_LIMIT_PER_MINUTE: "2",
    };
  const init = {
    headers: {
      Authorization: "Bearer private",
      "X-Device-Id": device,
      "CF-Connecting-IP": ip,
    },
  };
  expect(
    (await request("/v1/deals/publix/stores?zip=bad", init, override)).status,
  ).toBe(400);
  expect(
    (await request("/v1/deals/publix/stores?zip=bad", init, override)).status,
  ).toBe(400);
  expect(
    (await request("/v1/deals/publix/stores?zip=bad", init, override)).status,
  ).toBe(429);
});

it("reuses upstream caches only after authentication and separates lookup inputs", async () => {
  const override = {
    SIMPLILIST_BACKEND_API_KEY: "cache-test",
    PUBLIX_DEALS_FIXTURE: "false",
  };
  const init = {
    headers: {
      Authorization: "Bearer cache-test",
      "X-Device-Id": crypto.randomUUID(),
      "CF-Connecting-IP": crypto.randomUUID(),
    },
  };
  const first = await (
    await request("/v1/deals/publix/stores?zip=90210", init, override)
  ).json();
  expect(
    await (
      await request("/v1/deals/publix/stores?zip=90210", init, override)
    ).json(),
  ).toEqual(first);
  expect(
    await (
      await request("/v1/deals/publix/stores?zip=90211", init, override)
    ).json(),
  ).not.toEqual(first);
  expect(
    (await request("/v1/deals/publix/stores?zip=90210", {}, override)).status,
  ).toBe(401);
  const path = "/v1/deals/publix/bogo?zip=90210&storeNumber=1";
  const catalog = await (await request(path, init, override)).json();
  expect(catalog).toMatchObject({ source: "publix", storeNumber: "1" });
  expect(await (await request(path, init, override)).json()).toEqual(catalog);
  expect(
    await (
      await request(
        path.replace("storeNumber=1", "storeNumber=2"),
        init,
        override,
      )
    ).json(),
  ).toMatchObject({ storeNumber: "2" });
  const refreshed = await (
    await request(path + "&refresh=true", init, override)
  ).json();
  expect(refreshed).not.toEqual(catalog);
  expect(await (await request(path, init, override)).json()).toEqual(refreshed);
});
