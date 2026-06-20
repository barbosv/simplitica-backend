import { z } from "zod";

const BaseEnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APPLE_ENVIRONMENT: z.enum(["Sandbox", "Production"]).default("Sandbox"),
  SIMPLI_INVOICE_BUNDLE_ID: z.string().default("co.simplitica.simpli-invoice"),
  SIMPLI_INVOICE_APP_APPLE_ID: z
    .preprocess((value) => (value === "" || value === undefined ? undefined : value), z.coerce.number().int().positive())
    .optional(),
  STORAGE_BACKEND: z.enum(["postgres", "file"]).default("postgres"),
  DATABASE_URL: z.string().optional(),
  RUN_MIGRATIONS: z.coerce.boolean().default(false),
  STRIPE_MODE: z.enum(["test", "live"]).default("test"),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_SECRET_KEY_LIVE: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_WEBHOOK_SECRET_LIVE: z.string().optional(),
  STRIPE_CONNECT_RETURN_URL: z.string().url().optional(),
  STRIPE_CONNECT_REFRESH_URL: z.string().url().optional(),
  STRIPE_PLATFORM_COUNTRY: z.string().default("US"),
  CORS_ORIGIN: z.string().optional(),
  HOME_DEPOT_DATA_API_KEY: z.string().optional(),
  HOME_DEPOT_DATA_API_BASE_URL: z.string().url().optional(),
  HOME_DEPOT_DATA_API_HOST: z.string().optional(),
  RETAILERAPI_KEY: z.string().optional(),
  RETAILERAPI_BASE_URL: z.string().url().optional(),
  BLS_API_KEY: z.string().optional(),
  /** When set, `/v1/pricing/*` requires matching `X-API-Key` header (iOS app build secret). */
  SIMPLITICA_CLIENT_API_KEY: z.string().optional(),
});

export type Env = z.infer<typeof BaseEnvSchema>;

export function readEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const normalized: NodeJS.ProcessEnv = { ...raw };
  if (normalized.SIMPLI_INVOICE_APP_APPLE_ID === "") {
    delete normalized.SIMPLI_INVOICE_APP_APPLE_ID;
  }

  const parsed = BaseEnvSchema.parse(normalized);

  if (parsed.NODE_ENV === "production") {
    if (parsed.STORAGE_BACKEND === "postgres" && !parsed.DATABASE_URL) {
      throw new Error("DATABASE_URL is required in production with postgres storage");
    }
    if (!parsed.STRIPE_SECRET_KEY && !parsed.STRIPE_SECRET_KEY_LIVE) {
      throw new Error("STRIPE_SECRET_KEY or STRIPE_SECRET_KEY_LIVE is required in production");
    }
    if (!parsed.STRIPE_WEBHOOK_SECRET && !parsed.STRIPE_WEBHOOK_SECRET_LIVE) {
      throw new Error("STRIPE_WEBHOOK_SECRET or STRIPE_WEBHOOK_SECRET_LIVE is required in production");
    }
    if (!parsed.STRIPE_CONNECT_RETURN_URL || !parsed.STRIPE_CONNECT_REFRESH_URL) {
      throw new Error("STRIPE_CONNECT_RETURN_URL and STRIPE_CONNECT_REFRESH_URL are required in production");
    }
  }

  return parsed;
}

export function stripeSecretKey(env: Env): string | null {
  if (env.STRIPE_MODE === "live") {
    return env.STRIPE_SECRET_KEY_LIVE ?? env.STRIPE_SECRET_KEY ?? null;
  }
  return env.STRIPE_SECRET_KEY ?? null;
}

export function stripeWebhookSecret(env: Env): string | null {
  if (env.STRIPE_MODE === "live") {
    return env.STRIPE_WEBHOOK_SECRET_LIVE ?? env.STRIPE_WEBHOOK_SECRET ?? null;
  }
  return env.STRIPE_WEBHOOK_SECRET ?? null;
}

export function isStripeConfigured(env: Env): boolean {
  return Boolean(stripeSecretKey(env) && stripeWebhookSecret(env));
}
