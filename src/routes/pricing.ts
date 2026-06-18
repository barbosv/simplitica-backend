import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Env } from "../env.js";
import { createHomeDepotRetailClient } from "../pricing/home-depot-client.js";
import { MaterialsPricingService } from "../pricing/materials-service.js";
import { parseRequestBody } from "../middleware/parse-body.js";

const MaterialsRequestSchema = z.object({
  materials: z.array(z.string().min(1)).min(1),
  region_hint: z.string().optional(),
  zip_code: z.string().regex(/^\d{5}$/).optional(),
  quantity: z.coerce.number().positive().default(1),
});

export function registerPricingRoutes(app: FastifyInstance, env: Env) {
  const provider = createHomeDepotRetailClient(env);
  const service = new MaterialsPricingService(provider);

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
      return result;
    } catch (err) {
      req.log.error({ err }, "materials pricing failed");
      return reply.code(503).send({ error: "Materials pricing unavailable" });
    }
  });
}
