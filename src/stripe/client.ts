import Stripe from "stripe";
import type { Env } from "../env.js";
import { stripeSecretKey } from "../env.js";

let stripeClient: Stripe | null = null;
let stripeClientKey: string | null = null;

export function getStripe(env: Env): Stripe {
  const key = stripeSecretKey(env);
  if (!key) {
    throw new Error("Stripe is not configured");
  }
  if (!stripeClient || stripeClientKey !== key) {
    stripeClient = new Stripe(key);
    stripeClientKey = key;
  }
  return stripeClient;
}

export function resetStripeClientForTests(): void {
  stripeClient = null;
  stripeClientKey = null;
}
