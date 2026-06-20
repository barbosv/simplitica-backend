import type { FastifyInstance } from "fastify";
import type { AppContext } from "../db/context.js";
import type { Env } from "../env.js";
import { pingDatabase } from "../db/pool.js";
import { isHomeDepotPricingConfigured } from "../pricing/home-depot-client.js";
import { isBLSWageConfigured } from "../pricing/bls-wage-service.js";
import { isClientApiKeyConfigured } from "../middleware/client-api-key.js";

export async function registerHealthRoutes(app: FastifyInstance, env: Env, ctx: AppContext) {
  app.get("/health", async () => ({ ok: true }));

  app.get("/health/ready", async (_req, reply) => {
    const pricing = {
      home_depot_key_configured: isHomeDepotPricingConfigured(env),
      bls_key_configured: isBLSWageConfigured(env),
      client_api_key_required: isClientApiKeyConfigured(env),
    };
    if (!ctx.databaseUrl) {
      return { ok: true, database: "skipped", pricing };
    }
    const ok = await pingDatabase(ctx.databaseUrl);
    if (!ok) {
      return reply.code(503).send({ ok: false, database: "unavailable", pricing });
    }
    return { ok: true, database: "connected", pricing };
  });
}
