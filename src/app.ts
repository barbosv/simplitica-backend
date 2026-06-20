import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { Env } from "./env.js";
import type { AppContext } from "./db/context.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerSubscriptionRoutes } from "./routes/subscriptions.js";
import { registerStripeConnectRoutes } from "./routes/stripe-connect.js";
import { registerStripeConnectLandingRoutes } from "./routes/stripe-connect-landing.js";
import { registerStripeWebhookRoutes } from "./routes/stripe-webhook.js";
import { registerPricingRoutes } from "./routes/pricing.js";
import { createClientApiKeyHook } from "./middleware/client-api-key.js";
import { registerSimplilistRoutes } from "./routes/simplilist.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export type BuildAppOptions = {
  env: Env;
  ctx: AppContext;
};

export function buildApp({ env, ctx }: BuildAppOptions) {
  const app = Fastify({
    logger: env.NODE_ENV !== "test",
    bodyLimit: 256 * 1024,
  });

  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    try {
      const raw = body as Buffer;
      req.rawBody = raw;
      const json = JSON.parse(raw.toString("utf8")) as unknown;
      done(null, json);
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  if (env.NODE_ENV === "production") {
    void app.register(helmet);
  }

  const corsOrigin = env.CORS_ORIGIN?.trim();
  void app.register(cors, {
    origin: corsOrigin ? corsOrigin.split(",").map((o) => o.trim()) : false,
  });

  void app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
  });

  void app.register(async (scoped) => {
    await scoped.register(rateLimit, {
      max: 10,
      timeWindow: "1 minute",
      keyGenerator: (req) => {
        const businessId = req.headers["x-business-id"];
        const value = Array.isArray(businessId) ? businessId[0] : businessId;
        return value ? `biz:${value}` : req.ip;
      },
    });
    await registerStripeConnectRoutes(scoped, env, ctx);
  });

  void registerHealthRoutes(app, env, ctx);
  registerStripeConnectLandingRoutes(app);
  void registerSubscriptionRoutes(app, env, ctx);
  void registerStripeWebhookRoutes(app, env, ctx);

  void app.register(async (scoped) => {
    scoped.addHook("onRequest", createClientApiKeyHook(env));
    await scoped.register(rateLimit, {
      max: 30,
      timeWindow: "1 minute",
      keyGenerator: (req) => {
        const apiKey = req.headers["x-api-key"];
        const value = Array.isArray(apiKey) ? apiKey[0] : apiKey;
        return value ? `pricing:${value}` : `pricing:ip:${req.ip}`;
      },
    });
    registerPricingRoutes(scoped, env);
  });

  void app.register(async (scoped) => {
    await registerSimplilistRoutes(scoped, env);
  });

  return app;
}
