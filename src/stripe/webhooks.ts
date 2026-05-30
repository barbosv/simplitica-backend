import type Stripe from "stripe";
import type { Repositories } from "../db/types.js";
import { syncBusinessFromStripeAccount } from "./connect.js";

export async function handleStripeWebhookEvent(
  repos: Repositories,
  event: Stripe.Event,
): Promise<void> {
  switch (event.type) {
    case "account.updated": {
      const account = event.data.object as Stripe.Account;
      const business = await repos.businesses.getByStripeAccountId(account.id);
      if (!business) return;
      const snapshot = await syncBusinessFromStripeAccount(account);
      await repos.businesses.update(business.businessId, snapshot);
      return;
    }
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.payment_status !== "paid") return;
      const businessId = session.metadata?.businessId;
      const invoiceId = session.metadata?.invoiceId;
      const paidAt = new Date((session.created ?? Math.floor(Date.now() / 1000)) * 1000).toISOString();
      if (businessId && invoiceId) {
        await repos.invoicePayments.markPaid({
          businessId,
          invoiceId,
          paidAt,
          sessionId: session.id,
          amountCents: session.amount_total ?? undefined,
        });
        return;
      }
      if (session.id) {
        await repos.invoicePayments.markPaidBySessionId(session.id, paidAt);
      }
      return;
    }
    case "payment_intent.succeeded": {
      const intent = event.data.object as Stripe.PaymentIntent;
      const businessId = intent.metadata?.businessId;
      const invoiceId = intent.metadata?.invoiceId;
      if (!businessId || !invoiceId) return;
      const paidAt = new Date().toISOString();
      await repos.invoicePayments.markPaid({
        businessId,
        invoiceId,
        paidAt,
        amountCents: intent.amount_received ?? undefined,
      });
      return;
    }
    default:
      return;
  }
}
