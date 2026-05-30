import type { FastifyInstance } from "fastify";
import type { AppContext } from "../db/context.js";
import { pingDatabase } from "../db/pool.js";

export async function registerHealthRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/health", async () => ({ ok: true }));

  app.get("/health/ready", async (_req, reply) => {
    if (!ctx.databaseUrl) {
      return { ok: true, database: "skipped" };
    }
    const ok = await pingDatabase(ctx.databaseUrl);
    if (!ok) {
      return reply.code(503).send({ ok: false, database: "unavailable" });
    }
    return { ok: true, database: "connected" };
  });
}
