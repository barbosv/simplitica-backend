import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { env as workerEnv } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import worker from "../../src/worker.js";
import { createD1Repositories } from "../../src/db/repositories/d1.js";
import { processD1StripeEvent } from "../../src/db/d1-events.js";
import type Stripe from "stripe";
import { resetStripeClientForTests } from "../../src/stripe/client.js";
const env = workerEnv as {
  DB: D1Database;
  TEST_MIGRATIONS: import("@cloudflare/vitest-plugin").D1Migration[];
};
beforeEach(async () => {
  resetStripeClientForTests();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
afterEach(() => vi.unstubAllGlobals());
const config = {
  DB: env.DB,
  NODE_ENV: "test",
  STRIPE_MODE: "test",
  STRIPE_SECRET_KEY: "sk_test_worker",
  STRIPE_WEBHOOK_SECRET: "whsec_worker",
  STRIPE_CONNECT_RETURN_URL: "https://api.test/stripe/return",
  STRIPE_CONNECT_REFRESH_URL: "https://api.test/stripe/refresh",
};
const request = (
  path: string,
  businessId: string,
  body?: object,
  key?: string,
) =>
  worker.fetch(
    new Request("https://api.test" + path, {
      method: body ? "POST" : "GET",
      headers: {
        "X-Business-Id": businessId,
        "Content-Type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
    config,
  );

it("creates connected-account checkout sessions through Stripe's real fetch client and reuses the saved link", async () => {
  const repos = createD1Repositories(env.DB),
    businessId = crypto.randomUUID(),
    invoiceId = crypto.randomUUID(),
    key = crypto.randomUUID();
  await repos.businesses.getOrCreate(businessId);
  await repos.businesses.update(businessId, {
    stripeAccountId: "acct_worker",
    connectState: "active",
    chargesEnabled: true,
  });
  let calls = 0;
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    expect(String(input)).toContain("/v1/checkout/sessions");
    const headers = new Headers(init.headers);
    expect(headers.get("Stripe-Account")).toBe("acct_worker");
    expect(headers.get("Idempotency-Key")).toBe(key);
    const form = new URLSearchParams(String(init.body));
    expect(form.get("line_items[0][price_data][unit_amount]")).toBe("12345");
    expect(form.get("metadata[businessId]")).toBe(businessId);
    calls++;
    return Response.json({
      id: "cs_worker",
      object: "checkout.session",
      url: "https://checkout.stripe.com/test",
      expires_at: 2000000000,
    });
  });
  const body = {
    amountCents: 12345,
    currency: "USD",
    invoiceNumber: "INV-1",
    successUrl: "https://api.test/payment/success",
    cancelUrl: "https://api.test/payment/cancel",
  };
  const first = await request(
    `/v1/invoices/${invoiceId}/payment-link`,
    businessId,
    body,
    key,
  );
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({
    sessionId: "cs_worker",
    paymentUrl: "https://checkout.stripe.com/test",
  });
  expect(
    (
      await request(
        `/v1/invoices/${invoiceId}/payment-link`,
        businessId,
        body,
        key,
      )
    ).status,
  ).toBe(200);
  expect(calls).toBe(1);
  expect(await repos.invoicePayments.get(businessId, invoiceId)).toMatchObject({
    amountCents: 12345,
    currency: "usd",
    status: "pending",
  });
  expect(
    (
      await request(
        `/v1/invoices/${crypto.randomUUID()}/payment-link`,
        crypto.randomUUID(),
        body,
        key,
      )
    ).status,
  ).toBe(409);
});

it("rejects an already-paid invoice and a checkout save racing with a paid webhook", async () => {
  const repos = createD1Repositories(env.DB),
    businessId = crypto.randomUUID(),
    invoiceId = crypto.randomUUID();
  await repos.businesses.getOrCreate(businessId);
  await repos.businesses.update(businessId, {
    stripeAccountId: "acct_race",
    connectState: "active",
    chargesEnabled: true,
  });
  await repos.invoicePayments.upsert({
    businessId,
    invoiceId,
    idempotencyKey: crypto.randomUUID(),
    amountCents: 12345,
    currency: "usd",
    invoiceNumber: "INV-RACE",
    customerEmail: null,
    checkoutSessionId: "cs_original",
    paymentUrl: "https://checkout.stripe.com/original",
    status: "pending",
    paidAt: null,
    expiresAt: null,
  });
  const event = {
    id: "evt_" + crypto.randomUUID(),
    type: "payment_intent.succeeded",
    data: {
      object: { metadata: { businessId, invoiceId }, amount_received: 12345 },
    },
  } as unknown as Stripe.Event;
  let calls = 0;
  vi.stubGlobal("fetch", async () => {
    calls++;
    await processD1StripeEvent(env.DB, event);
    return Response.json({
      id: "cs_late",
      object: "checkout.session",
      url: "https://checkout.stripe.com/late",
    });
  });
  const body = {
    amountCents: 12345,
    currency: "usd",
    invoiceNumber: "INV-RACE",
    successUrl: "https://api.test/payment/success",
    cancelUrl: "https://api.test/payment/cancel",
  };
  expect(
    (
      await request(
        `/v1/invoices/${invoiceId}/payment-link`,
        businessId,
        body,
        crypto.randomUUID(),
      )
    ).status,
  ).toBe(409);
  expect(await repos.invoicePayments.get(businessId, invoiceId)).toMatchObject({
    status: "paid",
    checkoutSessionId: "cs_original",
    amountCents: 12345,
  });
  expect(
    (
      await request(
        `/v1/invoices/${invoiceId}/payment-link`,
        businessId,
        body,
        crypto.randomUUID(),
      )
    ).status,
  ).toBe(409);
  expect(calls).toBe(1);
});
