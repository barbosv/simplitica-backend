import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Env } from "../env.js";
import type { AppContext } from "../db/context.js";
import { isStripeConfigured } from "../env.js";
import { getStripe } from "../stripe/client.js";
import { businessStatusResponse, syncBusinessFromStripeAccount } from "../stripe/connect.js";
import { createCheckoutSession } from "../stripe/checkout.js";
import { requireBusinessId } from "../middleware/business-id.js";
import { parseRequestBody } from "../middleware/parse-body.js";

function stripeUnavailable(reply: import("fastify").FastifyReply) {
  return reply.code(503).send({ error: "Stripe unavailable" });
}

export async function registerStripeConnectRoutes(app: FastifyInstance, env: Env, ctx: AppContext) {
  const stripeConfigured = isStripeConfigured(env);
  const stripe = stripeConfigured ? getStripe(env) : null;

  app.post("/v1/stripe/connect/onboard", async (req, reply) => {
    if (!requireBusinessId(req, reply)) return;
    if (!stripe || !env.STRIPE_CONNECT_RETURN_URL || !env.STRIPE_CONNECT_REFRESH_URL) {
      return stripeUnavailable(reply);
    }

    try {
      let business = await ctx.repos.businesses.getOrCreate(req.businessId);
      if (!business.stripeAccountId) {
        const account = await stripe.accounts.create({
          type: "express",
          country: env.STRIPE_PLATFORM_COUNTRY,
          metadata: { businessId: req.businessId },
        });
        business = await ctx.repos.businesses.update(req.businessId, {
          stripeAccountId: account.id,
          connectState: "pending",
        });
      }

      const link = await stripe.accountLinks.create({
        account: business.stripeAccountId!,
        type: "account_onboarding",
        return_url: env.STRIPE_CONNECT_RETURN_URL,
        refresh_url: env.STRIPE_CONNECT_REFRESH_URL,
      });

      return {
        onboardingUrl: link.url,
        expiresAt: link.expires_at ? new Date(link.expires_at * 1000).toISOString() : undefined,
      };
    } catch (err) {
      req.log.error({ err }, "stripe onboard failed");
      return reply.code(503).send({ error: "Stripe unavailable" });
    }
  });

  app.get("/v1/stripe/connect/status", async (req, reply) => {
    if (!requireBusinessId(req, reply)) return;
    if (!stripe) return stripeUnavailable(reply);

    const business = await ctx.repos.businesses.getByBusinessId(req.businessId);
    if (!business?.stripeAccountId) {
      return businessStatusResponse({
        businessId: req.businessId,
        stripeAccountId: null,
        connectState: "not_started",
        chargesEnabled: false,
        payoutsEnabled: false,
        dashboardUrl: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    try {
      const account = await stripe.accounts.retrieve(business.stripeAccountId);
      const snapshot = await syncBusinessFromStripeAccount(account);
      let dashboardUrl: string | null = business.dashboardUrl;
      if (snapshot.connectState === "active") {
        try {
          const login = await stripe.accounts.createLoginLink(business.stripeAccountId);
          dashboardUrl = login.url;
        } catch {
          dashboardUrl = business.dashboardUrl;
        }
      }
      const updated = await ctx.repos.businesses.update(req.businessId, {
        ...snapshot,
        dashboardUrl,
      });
      return businessStatusResponse(updated);
    } catch (err) {
      req.log.error({ err }, "stripe status failed");
      return reply.code(503).send({ error: "Stripe unavailable" });
    }
  });

  const PaymentLinkBody = z.object({
    amountCents: z.number().int().positive(),
    currency: z.string().min(3).max(3),
    invoiceNumber: z.string().min(1),
    customerEmail: z.string().email().optional(),
    successUrl: z.string().url(),
    cancelUrl: z.string().url(),
  });

  app.post("/v1/invoices/:invoiceId/payment-link", async (req, reply) => {
    if (!requireBusinessId(req, reply)) return;
    if (!stripe) return stripeUnavailable(reply);
    const invoiceId = (req.params as { invoiceId: string }).invoiceId.toLowerCase();
    if (!z.string().uuid().safeParse(invoiceId).success) {
      return reply.code(400).send({ error: "Invalid invoice id" });
    }

    const idempotencyKey = req.headers["idempotency-key"];
    const idem = Array.isArray(idempotencyKey) ? idempotencyKey[0] : idempotencyKey;
    if (!idem) {
      return reply.code(400).send({ error: "Missing Idempotency-Key" });
    }

    const existing = await ctx.repos.invoicePayments.getByIdempotencyKey(idem);
    if (existing && existing.paymentUrl && existing.checkoutSessionId) {
      return {
        paymentUrl: existing.paymentUrl,
        sessionId: existing.checkoutSessionId,
        expiresAt: existing.expiresAt ?? undefined,
      };
    }

    const body = parseRequestBody(PaymentLinkBody, req.body);
    if (!body) return reply.code(400).send({ error: "Invalid request body" });

    const business = await ctx.repos.businesses.getByBusinessId(req.businessId);
    if (!business?.stripeAccountId || business.connectState !== "active" || !business.chargesEnabled) {
      return reply.code(400).send({ error: "Stripe Connect account is not ready for payments" });
    }

    try {
      const session = await createCheckoutSession(stripe, {
        stripeAccountId: business.stripeAccountId,
        amountCents: body.amountCents,
        currency: body.currency.toLowerCase(),
        invoiceNumber: body.invoiceNumber,
        customerEmail: body.customerEmail,
        successUrl: body.successUrl,
        cancelUrl: body.cancelUrl,
        businessId: req.businessId,
        invoiceId,
        idempotencyKey: idem,
      });

      const paymentUrl = session.url;
      if (!paymentUrl) {
        return reply.code(503).send({ error: "Stripe unavailable" });
      }

      const expiresAt = session.expires_at
        ? new Date(session.expires_at * 1000).toISOString()
        : null;

      await ctx.repos.invoicePayments.upsert({
        businessId: req.businessId,
        invoiceId,
        idempotencyKey: idem,
        amountCents: body.amountCents,
        currency: body.currency.toLowerCase(),
        invoiceNumber: body.invoiceNumber,
        customerEmail: body.customerEmail ?? null,
        checkoutSessionId: session.id,
        paymentUrl,
        status: "pending",
        paidAt: null,
        expiresAt,
      });

      return {
        paymentUrl,
        sessionId: session.id,
        expiresAt: expiresAt ?? undefined,
      };
    } catch (err) {
      req.log.error({ err }, "payment link failed");
      return reply.code(503).send({ error: "Stripe unavailable" });
    }
  });

  app.get("/v1/invoices/:invoiceId/payment-status", async (req, reply) => {
    if (!requireBusinessId(req, reply)) return;
    if (!stripe) return stripeUnavailable(reply);
    const invoiceId = (req.params as { invoiceId: string }).invoiceId.toLowerCase();
    if (!z.string().uuid().safeParse(invoiceId).success) {
      return reply.code(400).send({ error: "Invalid invoice id" });
    }

    let payment = await ctx.repos.invoicePayments.get(req.businessId, invoiceId);
    if (!payment) {
      return { status: "unpaid", paidAt: undefined, amountCents: undefined, sessionId: undefined };
    }

    if (payment.status !== "paid" && payment.checkoutSessionId) {
      try {
        const business = await ctx.repos.businesses.getByBusinessId(req.businessId);
        if (business?.stripeAccountId) {
          const session = await stripe.checkout.sessions.retrieve(
            payment.checkoutSessionId,
            undefined,
            { stripeAccount: business.stripeAccountId },
          );
          if (session.payment_status === "paid") {
            const paidAt = new Date().toISOString();
            payment = (await ctx.repos.invoicePayments.markPaid({
              businessId: req.businessId,
              invoiceId,
              paidAt,
              sessionId: session.id,
              amountCents: session.amount_total ?? payment.amountCents,
            })) ?? payment;
          }
        }
      } catch (err) {
        req.log.warn({ err }, "payment status reconcile failed");
      }
    }

    return {
      status: payment.status,
      paidAt: payment.paidAt ?? undefined,
      amountCents: payment.amountCents,
      sessionId: payment.checkoutSessionId ?? undefined,
    };
  });
}
