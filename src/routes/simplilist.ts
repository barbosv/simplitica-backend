import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../db/context.js";
import type { Env } from "../env.js";
import { parseRequestBody } from "../middleware/parse-body.js";
import {
  decodeJWSPayload,
  fetchAppleTransaction,
  isAppleIAPLookupConfigured,
  transactionIndicatesPro,
} from "../simplilist/apple-iap.js";
import { createSimplilistAuthHook } from "../simplilist/auth.js";
import { isOpenAIConfigured, openAIGroceryCategory, openAIReceiptLines, openAIVoiceItems } from "../simplilist/openai.js";
import { fetchBOGOCatalog, findStoresByZip } from "../simplilist/publix-weekly-ad.js";
import { SimplilistQuotaStore } from "../simplilist/quota.js";

function deviceId(req: { simplilistDeviceId?: string }): string {
  return req.simplilistDeviceId ?? "";
}

function logInfo(msg: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
}

export async function registerSimplilistRoutes(app: FastifyInstance, env: Env, ctx: AppContext) {
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

  const requirePro = async (
    req: { simplilistDeviceId?: string },
    reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  ) => {
    const row = await ctx.repos.simplilistDeviceEntitlements.get(deviceId(req));
    if (!row?.pro) {
      return reply.code(403).send({ error: "pro_required" });
    }
  };

  const enforceAiQuota = async (
    req: { simplilistDeviceId?: string },
    reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  ) => {
    if (!quotaStore.consumeAiQuota(deviceId(req))) {
      return reply.code(429).send({ error: "ai_daily_quota" });
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
    const query = req.query as { storeNumber?: string; refresh?: string };
    const storeNumber = String(query?.storeNumber ?? "").trim();
    if (!storeNumber) {
      return reply.code(400).send({ error: "invalid_store_number" });
    }
    const refresh = String(query?.refresh ?? "").toLowerCase() === "true";
    logInfo("publix_bogo_request", { deviceId: deviceId(req), storeNumber, refresh });
    try {
      return await fetchBOGOCatalog(env, storeNumber, { forceRefresh: refresh });
    } catch (error) {
      const code = (error as { code?: string })?.code || "upstream";
      logInfo("publix_bogo_error", { message: String((error as Error)?.message || error), code });
      if (code === "invalid_store_number") return reply.code(400).send({ error: code });
      if (code === "no_bogo_deals") return reply.code(404).send({ error: code });
      return reply.code(502).send({ error: "upstream" });
    }
  });

  app.post("/v1/iap/register", withSimplilistGuards, async (req, reply) => {
    const Body = z.object({
      transactionIds: z.array(z.union([z.string(), z.number()])).optional(),
      signedTransactionInfos: z.array(z.string()).optional(),
    });
    const body = parseRequestBody(Body, req.body);
    if (!body) return reply.code(400).send({ error: "Invalid request body" });

    const ids = body.transactionIds ?? [];
    const signedInfos = body.signedTransactionInfos ?? [];
    if (ids.length === 0 && signedInfos.length === 0) {
      return reply.code(400).send({ error: "transaction_payload_required" });
    }

    let pro = false;
    let lastOriginal: string | undefined;

    for (const jws of signedInfos.slice(0, 8)) {
      const payload = decodeJWSPayload(jws);
      logInfo("iap_register_jws", {
        deviceId: deviceId(req),
        productId: payload?.productId,
        hasPayload: Boolean(payload),
      });
      if (transactionIndicatesPro(env, payload)) {
        pro = true;
        lastOriginal = payload?.originalTransactionId || payload?.originalTransactionID;
        break;
      }
    }

    if (!pro && ids.length > 0) {
      if (!isAppleIAPLookupConfigured(env)) {
        logInfo("iap_register_skipped_no_apple_config", { deviceId: deviceId(req) });
        return reply.code(503).send({ error: "server_apple_not_configured" });
      }
      for (const raw of ids.slice(0, 20)) {
        const tid = String(raw).trim();
        if (!/^\d+$/.test(tid)) continue;
        const payload = await fetchAppleTransaction(env, tid);
        logInfo("iap_register_tx", {
          deviceId: deviceId(req),
          productId: payload?.productId,
          hasPayload: Boolean(payload),
        });
        if (transactionIndicatesPro(env, payload)) {
          pro = true;
          lastOriginal = payload?.originalTransactionId || payload?.originalTransactionID;
          break;
        }
      }
    }

    await ctx.repos.simplilistDeviceEntitlements.upsert({
      deviceId: deviceId(req),
      pro,
      originalTransactionId: lastOriginal,
    });
    return { pro, originalTransactionId: lastOriginal };
  });

  const aiGuards = {
    onRequest: [authHook, enforceRateLimit, requirePro, enforceAiQuota],
  };

  app.post("/v1/ai/voice-items", aiGuards, async (req, reply) => {
    if (!isOpenAIConfigured(env)) return reply.code(503).send({ error: "openai_not_configured" });
    const Body = z.object({ transcript: z.string() });
    const body = parseRequestBody(Body, req.body);
    if (!body) return reply.code(400).send({ error: "Invalid request body" });
    const transcript = body.transcript.trim();
    if (!transcript || transcript.length > 8000) {
      return reply.code(400).send({ error: "invalid_transcript" });
    }
    logInfo("ai_voice_request", { deviceId: deviceId(req), transcriptLen: transcript.length });
    try {
      const items = await openAIVoiceItems(env, transcript);
      return { items };
    } catch (error) {
      logInfo("ai_voice_error", { message: String((error as Error)?.message || error) });
      return reply.code(502).send({ error: "upstream" });
    }
  });

  app.post("/v1/ai/grocery-category", aiGuards, async (req, reply) => {
    if (!isOpenAIConfigured(env)) return reply.code(503).send({ error: "openai_not_configured" });
    const Body = z.object({ name: z.string() });
    const body = parseRequestBody(Body, req.body);
    if (!body) return reply.code(400).send({ error: "Invalid request body" });
    const name = body.name.trim();
    if (!name || name.length > 200) {
      return reply.code(400).send({ error: "invalid_name" });
    }
    logInfo("ai_grocery_category_request", { deviceId: deviceId(req), nameLen: name.length });
    try {
      const category = await openAIGroceryCategory(env, name);
      return { category };
    } catch (error) {
      logInfo("ai_grocery_category_error", { message: String((error as Error)?.message || error) });
      return reply.code(502).send({ error: "upstream" });
    }
  });

  app.post("/v1/ai/receipt-line-items", aiGuards, async (req, reply) => {
    if (!isOpenAIConfigured(env)) return reply.code(503).send({ error: "openai_not_configured" });
    const Body = z.object({
      imageBase64: z.string(),
      mimeType: z.string().optional(),
      tripItemNames: z.array(z.string()).optional(),
    });
    const body = parseRequestBody(Body, req.body);
    if (!body) return reply.code(400).send({ error: "Invalid request body" });
    const b64 = body.imageBase64;
    const mime = body.mimeType?.trim() || "image/jpeg";
    const tripItemNames = body.tripItemNames ?? [];
    if (!b64 || b64.length > 11_000_000) {
      return reply.code(400).send({ error: "invalid_image" });
    }
    logInfo("ai_receipt_request", { deviceId: deviceId(req), mime, b64len: b64.length });
    try {
      const lines = await openAIReceiptLines(env, b64, mime, tripItemNames);
      return { lines };
    } catch (error) {
      logInfo("ai_receipt_error", { message: String((error as Error)?.message || error) });
      return reply.code(502).send({ error: "upstream" });
    }
  });
}
