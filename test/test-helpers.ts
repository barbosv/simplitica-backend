import type { Env } from "../src/env.js";
import { createAppContext, createTestContext, type AppContext } from "../src/db/context.js";
import { buildApp } from "../src/app.js";

export function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    PORT: 3000,
    NODE_ENV: "test",
    APPLE_ENVIRONMENT: "Sandbox",
    SIMPLI_INVOICE_BUNDLE_ID: "co.simplitica.simpli-invoice",
    SIMPLI_INVOICE_APP_APPLE_ID: undefined,
    STORAGE_BACKEND: "file",
    DATABASE_URL: undefined,
    RUN_MIGRATIONS: false,
    STRIPE_MODE: "test",
    STRIPE_SECRET_KEY: undefined,
    STRIPE_SECRET_KEY_LIVE: undefined,
    STRIPE_WEBHOOK_SECRET: undefined,
    STRIPE_WEBHOOK_SECRET_LIVE: undefined,
    STRIPE_CONNECT_RETURN_URL: undefined,
    STRIPE_CONNECT_REFRESH_URL: undefined,
    STRIPE_PLATFORM_COUNTRY: "US",
    CORS_ORIGIN: undefined,
    ...overrides,
  };
}

export async function createTestContextFromEnv(overrides: Partial<Env> = {}): Promise<{
  env: Env;
  ctx: AppContext;
}> {
  const env = testEnv(overrides);
  const ctx = await createAppContext(env);
  return { env, ctx };
}

export function buildTestAppWithContext(env: Env, ctx: AppContext) {
  return buildApp({ env, ctx });
}

/** In-memory context for Stripe unit tests that do not need file storage. */
export function buildTestApp(overrides: Partial<Env> = {}) {
  const env = testEnv(overrides);
  const ctx = createTestContext();
  return buildApp({ env, ctx });
}
