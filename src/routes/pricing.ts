import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Env } from "../env.js";
import { BLSWageService } from "../pricing/bls-wage-service.js";
import { createHomeDepotRetailClient, isHomeDepotPricingConfigured } from "../pricing/home-depot-client.js";
import { MaterialsPricingService } from "../pricing/materials-service.js";
import { parseRequestBody } from "../middleware/parse-body.js";

const MaterialsRequestSchema = z.object({
  materials: z.array(z.string().min(1)).min(1),
  region_hint: z.string().optional(),
  zip_code: z.string().regex(/^\d{5}$/).optional(),
  quantity: z.coerce.number().positive().default(1),
});

const WageRequestSchema = z.object({
  soc_code: z.string().min(1),
  state_code: z.string().length(2).optional(),
  fallback: z.coerce.number().nonnegative().default(0),
});

export function registerPricingRoutes(app: FastifyInstance, env: Env) {
  const provider = createHomeDepotRetailClient(env);
  const liveLookupAvailable = isHomeDepotPricingConfigured(env);
  const service = new MaterialsPricingService(provider, liveLookupAvailable);
  const wageService = new BLSWageService({ apiKey: env.BLS_API_KEY });

  app.post("/v1/pricing/wages", async (req, reply) => {
    const body = parseRequestBody(WageRequestSchema, req.body);
    if (!body) {
      return reply.code(400).send({ error: "Invalid request body" });
    }

    try {
      return await wageService.lookup({
        soc_code: body.soc_code,
        state_code: body.state_code,
        fallback: body.fallback,
      });
    } catch (err) {
      req.log.error({ err }, "wage pricing failed");
      return reply.code(503).send({ error: "Wage pricing unavailable" });
    }
  });

  app.post("/v1/pricing/materials", async (req, reply) => {
    const body = parseRequestBody(MaterialsRequestSchema, req.body);
    if (!body) {
      return reply.code(400).send({ error: "Invalid request body" });
    }

    try {
      const result = await service.quote({
        materials: body.materials,
        region_hint: body.region_hint,
        zip_code: body.zip_code,
        quantity: body.quantity,
      });
      if (result.source === "catalog_fallback") {
        req.log.warn(
          {
            homeDepotKeyConfigured: liveLookupAvailable,
            liveLookupAttempted: result.live_lookup_attempted,
            materials: body.materials,
          },
          "materials pricing used catalog fallback",
        );
      }
      return result;
    } catch (err) {
      req.log.error({ err }, "materials pricing failed");
      return reply.code(503).send({ error: "Materials pricing unavailable" });
    }
  });
}
