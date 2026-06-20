import type { FastifyInstance } from "fastify";
import type { Env } from "../env.js";
import { createSimplilistAuthHook } from "../simplilist/auth.js";
import { fetchBOGOCatalog, findStoresByZip } from "../simplilist/publix-weekly-ad.js";
import { SimplilistQuotaStore } from "../simplilist/quota.js";

function deviceId(req: { simplilistDeviceId?: string }): string {
  return req.simplilistDeviceId ?? "";
}

function logInfo(msg: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
}

export async function registerSimplilistRoutes(app: FastifyInstance, env: Env) {
  const authHook = createSimplilistAuthHook(env);
  const quotaStore = new SimplilistQuotaStore(env);

  const enforceRateLimit = async (
    req: { simplilistDeviceId?: string },
    reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  ) => {
    const id = deviceId(req);
    if (!quotaStore.checkRateLimit(id)) {
      return reply.code(429).send({ error: "rate_limited" });
    }
  };

  const withSimplilistGuards = {
    onRequest: [authHook, enforceRateLimit],
  };

  app.get("/v1/deals/publix/stores", withSimplilistGuards, async (req, reply) => {
    const zip = String((req.query as { zip?: string })?.zip ?? "").trim();
    if (!/^\d{5}$/.test(zip)) {
      return reply.code(400).send({ error: "invalid_zip" });
    }
    logInfo("publix_stores_request", { deviceId: deviceId(req), zip });
    try {
      const stores = await findStoresByZip(zip);
      return { stores };
    } catch (error) {
      const code = (error as { code?: string })?.code || "upstream";
      logInfo("publix_stores_error", { message: String((error as Error)?.message || error), code });
      if (code === "invalid_zip") return reply.code(400).send({ error: code });
      return reply.code(502).send({ error: "upstream" });
    }
  });

  app.get("/v1/deals/publix/bogo", withSimplilistGuards, async (req, reply) => {
    const query = req.query as { storeNumber?: string; zip?: string; refresh?: string };
    const storeNumber = String(query?.storeNumber ?? "").trim();
    if (!storeNumber) {
      return reply.code(400).send({ error: "invalid_store_number" });
    }
    const zip = String(query?.zip ?? "").trim();
    const refresh = String(query?.refresh ?? "").toLowerCase() === "true";
    logInfo("publix_bogo_request", { deviceId: deviceId(req), storeNumber, zip, refresh });
    try {
      return await fetchBOGOCatalog(env, storeNumber, { zip, forceRefresh: refresh });
    } catch (error) {
      const code = (error as { code?: string })?.code || "upstream";
      logInfo("publix_bogo_error", { message: String((error as Error)?.message || error), code });
      if (code === "invalid_store_number") return reply.code(400).send({ error: code });
      if (code === "no_bogo_deals") return reply.code(404).send({ error: code });
      return reply.code(502).send({ error: "upstream" });
    }
  });
}
