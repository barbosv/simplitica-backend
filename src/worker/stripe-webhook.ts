import Stripe from "stripe";

export async function verifyWorkerStripeWebhook(
  raw: Uint8Array,
  signature: string,
  secret: string,
): Promise<Stripe.Event> {
  const stripe = new Stripe("sk_test_verification_only", {
    httpClient: Stripe.createFetchHttpClient(),
  });
  return stripe.webhooks.constructEventAsync(
    raw,
    signature,
    secret,
    undefined,
    Stripe.createSubtleCryptoProvider(),
  );
}
