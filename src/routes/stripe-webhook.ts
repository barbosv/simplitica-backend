import type { FastifyInstance } from "fastify";
import type { Env } from "../env.js";
import type { AppContext } from "../db/context.js";
import { stripeWebhookSecret } from "../env.js";
import { getStripe } from "../stripe/client.js";
import { handleStripeWebhookEvent } from "../stripe/webhooks.js";

export async function registerStripeWebhookRoutes(app: FastifyInstance, env: Env, ctx: AppContext) {
  const secret = stripeWebhookSecret(env);
  if (!secret) return;

  const stripe = getStripe(env);

  app.post(
    "/v1/webhooks/stripe",
    { config: { rawBody: true } },
    async (req, reply) => {
      const signature = req.headers["stripe-signature"];
      if (!signature || typeof signature !== "string") {
        return reply.code(400).send({ error: "Missing Stripe-Signature" });
      }

      const rawBody = req.rawBody;
      if (!rawBody) {
        return reply.code(400).send({ error: "Missing raw body" });
      }

      let event;
      try {
        event = stripe.webhooks.constructEvent(rawBody, signature, secret);
      } catch (err) {
        req.log.warn({ err }, "stripe webhook signature invalid");
        return reply.code(400).send({ error: "Invalid signature" });
      }

      const inserted = await ctx.repos.stripeEvents.tryInsert(event.id, event.type);
      if (!inserted) {
        return reply.code(200).send({ ok: true, duplicate: true });
      }

      try {
        await handleStripeWebhookEvent(ctx.repos, event);
      } catch (err) {
        req.log.error({ err, eventId: event.id }, "stripe webhook handler failed");
        return reply.code(500).send({ error: "Webhook processing failed" });
      }

      return reply.code(200).send({ ok: true });
    },
  );
}
