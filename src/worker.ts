import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { readWorkerEnv } from "./worker/env.js";
import type { WorkerBindings } from "./worker/bindings.js";
import { HttpError, routeAdapter } from "./worker/http.js";
import { createD1Repositories } from "./db/repositories/d1.js";
import { registerSubscriptionRoutes } from "./routes/subscriptions.js";
import { registerStripeConnectRoutes } from "./routes/stripe-connect.js";
import { registerStripeConnectLandingRoutes } from "./routes/stripe-connect-landing.js";
import { registerPricingRoutes } from "./routes/pricing.js";
import { registerSimplilistRoutes } from "./routes/simplilist.js";
import {
  createClientApiKeyHook,
  isClientApiKeyConfigured,
} from "./middleware/client-api-key.js";
import { isSimplilistBackendConfigured } from "./simplilist/auth.js";
import { isHomeDepotPricingConfigured } from "./pricing/home-depot-client.js";
import { isRetailerApiConfigured } from "./pricing/retailer-api-client.js";
import { isBLSWageConfigured } from "./pricing/bls-wage-service.js";
import { stripeWebhookSecret } from "./env.js";
import { verifyWorkerStripeWebhook } from "./worker/stripe-webhook.js";
import { processD1StripeEvent } from "./db/d1-events.js";
import { consumeRateLimit } from "./worker/rate-limit.js";
import { D1Cache, fingerprint, cleanupExpired } from "./worker/cache.js";
import type { ApiHandler } from "./http.js";

export async function createWorkerApp(bindings: WorkerBindings) {
  const env = readWorkerEnv(bindings);
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof HttpError)
      return new Response(JSON.stringify({ error: error.message }), {
        status: error.status,
        headers: { "Content-Type": "application/json" },
      });
    console.error("Worker request failed", error.name);
    return c.json({ error: "Internal Server Error" }, 500);
  });
  if (env.NODE_ENV === "production")
    app.use(
      "*",
      secureHeaders({
        strictTransportSecurity: "max-age=31536000; includeSubDomains",
        contentSecurityPolicy: {
          defaultSrc: ["'self'"],
          baseUri: ["'self'"],
          fontSrc: ["'self'", "https:", "data:"],
          formAction: ["'self'"],
          frameAncestors: ["'self'"],
          imgSrc: ["'self'", "data:"],
          objectSrc: ["'none'"],
          scriptSrc: ["'self'"],
          scriptSrcAttr: ["'none'"],
          styleSrc: ["'self'", "https:", "'unsafe-inline'"],
          upgradeInsecureRequests: [],
        },
      }),
    );
  const origins =
    env.CORS_ORIGIN?.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean) ?? [];
  if (origins.length) app.use("*", cors({ origin: origins }));
  app.use("*", async (c, next) => {
    if (c.req.path.startsWith("/health")) return next();
    const key =
      "global:" + fingerprint(c.req.header("CF-Connecting-IP") ?? "unknown");
    try {
      const limit = await consumeRateLimit(bindings.DB, key, 120);
      if (!limit.allowed) {
        c.header("Retry-After", String(limit.retryAfter));
        return c.json({ error: "Too Many Requests" }, 429);
      }
    } catch {
      return c.json({ error: "Rate limit unavailable" }, 503);
    }
    return next();
  });
  const quota =
    (key: string, limit: number): ApiHandler =>
    async (_req, reply) => {
      const result = await consumeRateLimit(bindings.DB, key, limit);
      if (!result.allowed)
        return reply.code(429).send({ error: "Too Many Requests" });
    };
  const cache = new D1Cache(
    bindings.DB,
    "v1:" +
      fingerprint({
        fixture: env.PUBLIX_DEALS_FIXTURE,
        retailer: env.RETAILERAPI_KEY,
        retailerUrl: env.RETAILERAPI_BASE_URL,
        homeDepot: env.HOME_DEPOT_DATA_API_KEY,
        homeDepotUrl: env.HOME_DEPOT_DATA_API_BASE_URL,
        homeDepotHost: env.HOME_DEPOT_DATA_API_HOST,
        bls: env.BLS_API_KEY,
      }),
  );
  const router = routeAdapter(app);
  const ctx = { repos: createD1Repositories(bindings.DB), databaseUrl: null };
  router.get("/health", async () => ({ ok: true }));
  router.get("/health/ready", async (_req, reply) => {
    const pricing = {
      home_depot_key_configured: isHomeDepotPricingConfigured(env),
      retailerapi_key_configured: isRetailerApiConfigured(env),
      bls_key_configured: isBLSWageConfigured(env),
      client_api_key_required: isClientApiKeyConfigured(env),
    };
    const simplilist = {
      backend_api_key_configured: isSimplilistBackendConfigured(env),
    };
    try {
      await bindings.DB.prepare("SELECT 1").first();
      return { ok: true, database: "connected", pricing, simplilist };
    } catch {
      return reply
        .code(503)
        .send({ ok: false, database: "unavailable", pricing, simplilist });
    }
  });
  await registerSubscriptionRoutes(router, env, ctx);
  await registerStripeConnectRoutes(
    routeAdapter(app, async (req, reply) =>
      quota(
        "stripe:" + fingerprint(req.headers["x-business-id"] ?? req.ip),
        10,
      )(req, reply),
    ),
    env,
    ctx,
  );
  registerStripeConnectLandingRoutes(router);
  registerPricingRoutes(
    routeAdapter(app, async (req, reply) => {
      const denied = await createClientApiKeyHook(env)(req, reply);
      if (denied) return denied;
      return quota(
        "pricing:" + fingerprint(req.headers["x-api-key"] ?? req.ip),
        30,
      )(req, reply);
    }),
    env,
    cache,
    cache,
  );
  await registerSimplilistRoutes(router, env, {
    cache,
    checkRateLimit: async (deviceId) =>
      (
        await consumeRateLimit(
          bindings.DB,
          "simplilist:" + fingerprint(deviceId),
          env.SIMPLILIST_RATE_LIMIT_PER_MINUTE,
        )
      ).allowed,
  });
  const secret = stripeWebhookSecret(env);
  if (secret)
    router.post("/v1/webhooks/stripe", async (req, reply) => {
      const signature = req.headers["stripe-signature"];
      if (!signature || typeof signature !== "string")
        return reply.code(400).send({ error: "Missing Stripe-Signature" });
      let event;
      try {
        event = await verifyWorkerStripeWebhook(
          req.rawBody ?? new Uint8Array(),
          signature,
          secret,
        );
      } catch {
        return reply.code(400).send({ error: "Invalid signature" });
      }
      try {
        const outcome = await processD1StripeEvent(bindings.DB, event);
        return outcome === "duplicate"
          ? { ok: true, duplicate: true }
          : { ok: true };
      } catch {
        return reply.code(500).send({ error: "Webhook processing failed" });
      }
    });
  return app;
}

/** One Hono app per isolate; Cloudflare keeps the same bindings object for the isolate lifetime. */
let cachedApp: {
  bindings: WorkerBindings;
  app: Awaited<ReturnType<typeof createWorkerApp>>;
} | null = null;

export function resetWorkerAppCacheForTests(): void {
  cachedApp = null;
}

async function getWorkerApp(bindings: WorkerBindings) {
  if (cachedApp?.bindings === bindings) return cachedApp.app;
  const app = await createWorkerApp(bindings);
  cachedApp = { bindings, app };
  return app;
}

export default {
  async fetch(request: Request, bindings: WorkerBindings): Promise<Response> {
    try {
      return await (await getWorkerApp(bindings)).fetch(request);
    } catch {
      cachedApp = null;
      return Response.json(
        { error: "Backend configuration unavailable" },
        { status: 503 },
      );
    }
  },
  async scheduled(
    _event: ScheduledController,
    bindings: WorkerBindings,
  ): Promise<void> {
    await cleanupExpired(bindings.DB);
  },
};
