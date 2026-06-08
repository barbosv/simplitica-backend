import type Stripe from "stripe";

export type CreateCheckoutParams = {
  stripeAccountId: string;
  amountCents: number;
  currency: string;
  invoiceNumber: string;
  customerEmail?: string;
  successUrl: string;
  cancelUrl: string;
  businessId: string;
  invoiceId: string;
  idempotencyKey: string;
};

export async function createCheckoutSession(
  stripe: Stripe,
  params: CreateCheckoutParams,
): Promise<Stripe.Checkout.Session> {
  return stripe.checkout.sessions.create(
    {
      mode: "payment",
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      customer_email: params.customerEmail,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: params.currency,
            unit_amount: params.amountCents,
            product_data: {
              name: params.invoiceNumber,
            },
          },
        },
      ],
      metadata: {
        businessId: params.businessId,
        invoiceId: params.invoiceId,
      },
      payment_intent_data: {
        metadata: {
          businessId: params.businessId,
          invoiceId: params.invoiceId,
        },
      },
    },
    {
      stripeAccount: params.stripeAccountId,
      idempotencyKey: params.idempotencyKey,
    },
  );
}
