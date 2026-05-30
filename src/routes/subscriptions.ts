import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Env } from "../env.js";
import type { AppContext } from "../db/context.js";
import { buildAppsRegistry } from "../apps.js";
import { verifyNotificationForConfiguredApps } from "../apple/verify-notification.js";
import { buildSignedDataVerifier } from "../apple/verifier.js";
import { entitlementStateFromDecodedTransaction } from "../subscription-state.js";
import { parseRequestBody } from "../middleware/parse-body.js";

export async function registerSubscriptionRoutes(app: FastifyInstance, env: Env, ctx: AppContext) {
  const apps = buildAppsRegistry(env);

  app.get("/v1/entitlements", async (req, reply) => {
    const bundleId = req.headers["x-bundle-id"] as string | undefined;
    const appSlugHeader = req.headers["x-app-slug"] as string | undefined;
    const appSlug = (bundleId && apps.byBundleId[bundleId]?.slug) ?? appSlugHeader ?? "simpli-invoice";
    const token = req.headers["x-app-account-token"] as string | undefined;
    if (!token) return reply.code(400).send({ error: "Missing X-App-Account-Token" });
    const ent = await ctx.repos.subscriptions.getEntitlement(appSlug, token);
    return { entitlement: ent };
  });

  app.post("/v1/subscriptions/sync", async (req, reply) => {
    const Body = z.object({
      appSlug: z.string().optional(),
      bundleId: z.string().optional(),
      appAccountToken: z.string().uuid(),
      signedTransactionInfo: z.string().min(10),
      signedRenewalInfo: z.string().min(10).optional(),
    });
    const body = parseRequestBody(Body, req.body);
    if (!body) return reply.code(400).send({ error: "Invalid request body" });

    const appCfg =
      (body.bundleId ? apps.byBundleId[body.bundleId] : undefined) ??
      (body.appSlug ? apps.bySlug[body.appSlug] : undefined) ??
      apps.bySlug["simpli-invoice"];
    if (!appCfg) return reply.code(400).send({ error: "Unknown app" });

    const verifier = buildSignedDataVerifier({
      app: appCfg,
      environment: env.APPLE_ENVIRONMENT,
      enableOnlineChecks: env.NODE_ENV === "production",
    });

    let decoded;
    try {
      decoded = await verifier.verifyAndDecodeTransaction(body.signedTransactionInfo);
    } catch {
      return reply.code(400).send({ error: "Invalid signedTransactionInfo" });
    }
    const productId = decoded.productId;
    const originalTransactionId = decoded.originalTransactionId;
    if (!productId || !originalTransactionId) {
      return reply.code(400).send({ error: "Missing productId/originalTransactionId in transaction" });
    }

    const expiresAtMs = decoded.expiresDate;
    const expiresAt = typeof expiresAtMs === "number" ? new Date(expiresAtMs).toISOString() : undefined;
    const state = entitlementStateFromDecodedTransaction(decoded);

    const saved = await ctx.repos.subscriptions.upsert({
      appSlug: appCfg.slug,
      appAccountToken: body.appAccountToken,
      originalTransactionId,
      productId,
      state,
      expiresAt,
      environment: decoded.environment,
      latestSignedTransactionInfo: body.signedTransactionInfo,
      latestSignedRenewalInfo: body.signedRenewalInfo,
    });

    return { subscription: saved };
  });

  app.post("/v1/webhooks/app-store", async (req, reply) => {
    const Body = z.object({
      signedPayload: z.string().min(10),
      appSlug: z.string().optional(),
    });
    const body = parseRequestBody(Body, req.body);
    if (!body) return reply.code(400).send({ error: "Invalid request body" });

    let decodedNotification;
    let appCfg;
    try {
      const verified = await verifyNotificationForConfiguredApps({
        signedPayload: body.signedPayload,
        apps: apps.list,
        env,
      });
      decodedNotification = verified.decoded;
      appCfg = verified.app;
    } catch {
      return reply.code(400).send({ error: "Invalid signedPayload" });
    }

    if (body.appSlug && body.appSlug !== appCfg.slug) {
      return reply.code(400).send({ error: "appSlug does not match notification" });
    }

    const verifier = buildSignedDataVerifier({
      app: appCfg,
      environment: env.APPLE_ENVIRONMENT,
      enableOnlineChecks: env.NODE_ENV === "production",
    });

    const data = decodedNotification.data;
    const signedTx = data?.signedTransactionInfo;
    if (!signedTx) return reply.code(200).send({ ok: true });

    let decodedTx;
    try {
      decodedTx = await verifier.verifyAndDecodeTransaction(signedTx);
    } catch {
      return reply.code(400).send({ error: "Invalid signedTransactionInfo" });
    }
    const productId = decodedTx.productId;
    const originalTransactionId = decodedTx.originalTransactionId;
    const appAccountToken = decodedTx.appAccountToken;

    if (!productId || !originalTransactionId || !appAccountToken) {
      return reply.code(200).send({ ok: true });
    }

    const expiresAtMs = decodedTx.expiresDate;
    const expiresAt = typeof expiresAtMs === "number" ? new Date(expiresAtMs).toISOString() : undefined;
    const state = entitlementStateFromDecodedTransaction(decodedTx);

    await ctx.repos.subscriptions.upsert({
      appSlug: appCfg.slug,
      appAccountToken,
      originalTransactionId,
      productId,
      state,
      expiresAt,
      environment: decodedTx.environment,
      latestSignedTransactionInfo: signedTx,
      latestSignedRenewalInfo: data?.signedRenewalInfo,
    });

    return { ok: true };
  });
}
