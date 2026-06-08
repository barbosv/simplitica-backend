import { describe, expect, it } from "vitest";
import { createMemoryRepositories } from "../src/db/repositories/memory.js";
import { createTestContext } from "../src/db/context.js";
import { buildApp } from "../src/app.js";
import { testEnv } from "./test-helpers.js";
import { handleStripeWebhookEvent } from "../src/stripe/webhooks.js";
import type Stripe from "stripe";

const businessId = "550e8400-e29b-41d4-a716-446655440000";
const invoiceId = "660e8400-e29b-41d4-a716-446655440001";

describe("stripe connect routes", () => {
  it("returns 503 when stripe is not configured", async () => {
    const app = buildApp({ env: testEnv(), ctx: createTestContext() });
    const res = await app.inject({
      method: "POST",
      url: "/v1/stripe/connect/onboard",
      headers: { "x-business-id": businessId },
    });
    expect(res.statusCode).toBe(503);
  });

  it("returns 400 without business id", async () => {
    const app = buildApp({ env: testEnv(), ctx: createTestContext() });
    const res = await app.inject({
      method: "GET",
      url: "/v1/stripe/connect/status",
    });
    expect(res.statusCode).toBe(400);
  });

  it("serves Stripe Connect onboarding landing pages", async () => {
    const app = buildApp({ env: testEnv(), ctx: createTestContext() });
    const returnRes = await app.inject({ method: "GET", url: "/stripe/return" });
    expect(returnRes.statusCode).toBe(200);
    expect(returnRes.headers["content-type"]).toContain("text/html");
    expect(returnRes.body).toContain("Stripe setup complete");
    expect(returnRes.body).toContain("simpli-invoice://settings/stripe");
    expect(returnRes.body).toContain("Open Simpli Invoice");

    const refreshRes = await app.inject({ method: "GET", url: "/stripe/refresh" });
    expect(refreshRes.statusCode).toBe(200);
    expect(refreshRes.body).toContain("Continue Stripe setup");
    expect(refreshRes.body).toContain("simpli-invoice://settings/stripe");
  });

  it("serves Stripe Checkout payment landing pages", async () => {
    const app = buildApp({ env: testEnv(), ctx: createTestContext() });
    const successRes = await app.inject({
      method: "GET",
      url: `/payment/success?invoiceId=${invoiceId}`,
    });
    expect(successRes.statusCode).toBe(200);
    expect(successRes.body).toContain("Payment received");
    expect(successRes.body).toContain(`simpli-invoice://payment/success?invoiceId=${invoiceId}`);

    const cancelRes = await app.inject({
      method: "GET",
      url: `/payment/cancel?invoiceId=${invoiceId}`,
    });
    expect(cancelRes.statusCode).toBe(200);
    expect(cancelRes.body).toContain("Payment canceled");
    expect(cancelRes.body).toContain(`simpli-invoice://payment/cancel?invoiceId=${invoiceId}`);
  });

  it("returns 503 for payment-status when stripe is not configured", async () => {
    const app = buildApp({ env: testEnv(), ctx: createTestContext() });
    const res = await app.inject({
      method: "GET",
      url: `/v1/invoices/${invoiceId}/payment-status`,
      headers: { "x-business-id": businessId },
    });
    expect(res.statusCode).toBe(503);
  });
});

describe("stripe webhook handler", () => {
  it("marks invoice paid on checkout.session.completed", async () => {
    const repos = createMemoryRepositories();
    await repos.businesses.getOrCreate(businessId);
    await repos.businesses.update(businessId, { stripeAccountId: "acct_test" });
    await repos.invoicePayments.upsert({
      businessId,
      invoiceId,
      idempotencyKey: `${invoiceId}:1`,
      amountCents: 1000,
      currency: "usd",
      invoiceNumber: "INV-1",
      customerEmail: null,
      checkoutSessionId: "cs_test_123",
      paymentUrl: "https://checkout.stripe.com/pay/cs_test_123",
      status: "pending",
      paidAt: null,
      expiresAt: null,
    });

    const event = {
      id: "evt_test_1",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_123",
          payment_status: "paid",
          created: Math.floor(Date.now() / 1000),
          metadata: { businessId, invoiceId },
        },
      },
    } as unknown as Stripe.Event;

    await handleStripeWebhookEvent(repos, event);
    const payment = await repos.invoicePayments.get(businessId, invoiceId);
    expect(payment?.status).toBe("paid");
    expect(payment?.paidAt).toBeTruthy();
  });

  it("marks invoice paid on checkout.session.async_payment_succeeded", async () => {
    const repos = createMemoryRepositories();
    await repos.businesses.getOrCreate(businessId);
    await repos.invoicePayments.upsert({
      businessId,
      invoiceId,
      idempotencyKey: `${invoiceId}:2`,
      amountCents: 1000,
      currency: "usd",
      invoiceNumber: "INV-2",
      customerEmail: null,
      checkoutSessionId: "cs_test_async",
      paymentUrl: "https://checkout.stripe.com/pay/cs_test_async",
      status: "pending",
      paidAt: null,
      expiresAt: null,
    });

    const event = {
      id: "evt_test_async",
      type: "checkout.session.async_payment_succeeded",
      data: {
        object: {
          id: "cs_test_async",
          payment_status: "paid",
          created: Math.floor(Date.now() / 1000),
          metadata: { businessId, invoiceId },
        },
      },
    } as unknown as Stripe.Event;

    await handleStripeWebhookEvent(repos, event);
    const payment = await repos.invoicePayments.get(businessId, invoiceId);
    expect(payment?.status).toBe("paid");
  });

  it("marks invoice paid by session id when metadata is missing", async () => {
    const repos = createMemoryRepositories();
    await repos.businesses.getOrCreate(businessId);
    await repos.invoicePayments.upsert({
      businessId,
      invoiceId,
      idempotencyKey: `${invoiceId}:3`,
      amountCents: 1000,
      currency: "usd",
      invoiceNumber: "INV-3",
      customerEmail: null,
      checkoutSessionId: "cs_test_no_meta",
      paymentUrl: "https://checkout.stripe.com/pay/cs_test_no_meta",
      status: "pending",
      paidAt: null,
      expiresAt: null,
    });

    const event = {
      id: "evt_test_no_meta",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_no_meta",
          payment_status: "paid",
          created: Math.floor(Date.now() / 1000),
          metadata: {},
        },
      },
    } as unknown as Stripe.Event;

    await handleStripeWebhookEvent(repos, event);
    const payment = await repos.invoicePayments.get(businessId, invoiceId);
    expect(payment?.status).toBe("paid");
  });

  it("deduplicates stripe events", async () => {
    const repos = createMemoryRepositories();
    expect(await repos.stripeEvents.tryInsert("evt_dup", "test.event")).toBe(true);
    expect(await repos.stripeEvents.tryInsert("evt_dup", "test.event")).toBe(false);
  });
});
