import { beforeEach, expect, it } from "vitest";
import { env as workerEnv } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import Stripe from "stripe";
import { createD1Repositories } from "../../src/db/repositories/d1.js";
import { processD1StripeEvent } from "../../src/db/d1-events.js";
import { verifyWorkerStripeWebhook } from "../../src/worker/stripe-webhook.js";
import { createHmac } from "node:crypto";

const env = workerEnv as {
  DB: D1Database;
  TEST_MIGRATIONS: import("@cloudflare/vitest-plugin").D1Migration[];
};
beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

it("verifies exact Stripe request bytes and rejects a changed body or signing secret", async () => {
  const raw = new TextEncoder().encode(
    '{ "id": "evt_test", "object": "event", "type": "test" }',
  );
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = `t=${timestamp},v1=${createHmac("sha256", "whsec_test")
    .update(`${timestamp}.${new TextDecoder().decode(raw)}`)
    .digest("hex")}`;
  expect(
    await verifyWorkerStripeWebhook(raw, signature, "whsec_test"),
  ).toMatchObject({ id: "evt_test" });
  await expect(
    verifyWorkerStripeWebhook(
      new TextEncoder().encode("{}"),
      signature,
      "whsec_test",
    ),
  ).rejects.toThrow();
  await expect(
    verifyWorkerStripeWebhook(raw, signature, "whsec_wrong"),
  ).rejects.toThrow();
});

async function paymentEvent() {
  const repos = createD1Repositories(env.DB);
  const businessId = crypto.randomUUID(),
    invoiceId = crypto.randomUUID();
  await repos.businesses.getOrCreate(businessId);
  await repos.invoicePayments.upsert({
    businessId,
    invoiceId,
    idempotencyKey: crypto.randomUUID(),
    amountCents: 12345,
    currency: "usd",
    invoiceNumber: "INV-1",
    customerEmail: null,
    checkoutSessionId: "cs_test",
    paymentUrl: null,
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
  return { event, repos, businessId, invoiceId };
}
it("rolls back a failed event so a later delivery can retry", async () => {
  const { event, repos, businessId, invoiceId } = await paymentEvent();
  await env.DB.exec(
    "CREATE TRIGGER fail_payment BEFORE UPDATE ON invoice_payments BEGIN SELECT RAISE(ABORT, 'injected failure'); END;",
  );
  await expect(processD1StripeEvent(env.DB, event)).rejects.toThrow();
  expect(
    await env.DB.prepare("SELECT * FROM stripe_events WHERE event_id=?")
      .bind(event.id)
      .first(),
  ).toBeNull();
  await env.DB.exec("DROP TRIGGER fail_payment");
  expect(await processD1StripeEvent(env.DB, event)).toBe("processed");
  expect(await repos.invoicePayments.get(businessId, invoiceId)).toMatchObject({
    status: "paid",
    amountCents: 12345,
  });
});
it("processes concurrent duplicate deliveries once", async () => {
  const { event, repos, businessId, invoiceId } = await paymentEvent();
  const outcomes = await Promise.all([
    processD1StripeEvent(env.DB, event),
    processD1StripeEvent(env.DB, event),
  ]);
  expect(outcomes.sort()).toEqual(["duplicate", "processed"]);
  const first = await repos.invoicePayments.get(businessId, invoiceId);
  expect(await processD1StripeEvent(env.DB, event)).toBe("duplicate");
  expect(
    (await repos.invoicePayments.get(businessId, invoiceId))?.updatedAt,
  ).toBe(first?.updatedAt);
});

it("does not let late same-key or regenerated checkout saves undo a paid webhook", async () => {
  const { event, repos, businessId, invoiceId } = await paymentEvent();
  const pending = (await repos.invoicePayments.get(businessId, invoiceId))!;
  expect(await processD1StripeEvent(env.DB, event)).toBe("processed");
  const paid = (await repos.invoicePayments.get(businessId, invoiceId))!;
  const lateSave = pending;
  const outcomes = await Promise.all([
    repos.invoicePayments.upsert(lateSave),
    repos.invoicePayments.upsert({
      ...lateSave,
      idempotencyKey: crypto.randomUUID(),
      checkoutSessionId: "cs_regenerated",
      amountCents: 99999,
    }),
  ]);
  expect(outcomes).toEqual([paid, paid]);
  expect(await repos.invoicePayments.get(businessId, invoiceId)).toEqual(paid);
  expect(await processD1StripeEvent(env.DB, event)).toBe("duplicate");
});
it("ignores unpaid checkout events and accepts unknown events idempotently", async () => {
  const event = {
    id: "evt_" + crypto.randomUUID(),
    type: "checkout.session.completed",
    data: { object: { payment_status: "unpaid" } },
  } as unknown as Stripe.Event;
  expect(await processD1StripeEvent(env.DB, event)).toBe("processed");
  expect(await processD1StripeEvent(env.DB, event)).toBe("duplicate");
});

it("acks account.updated when no business is linked yet", async () => {
  const event = {
    id: "evt_" + crypto.randomUUID(),
    type: "account.updated",
    data: {
      object: {
        id: "acct_missing",
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true,
      },
    },
  } as unknown as Stripe.Event;
  expect(await processD1StripeEvent(env.DB, event)).toBe("processed");
  expect(
    await env.DB.prepare("SELECT type FROM stripe_events WHERE event_id=?")
      .bind(event.id)
      .first(),
  ).toEqual({ type: "account.updated" });
  expect(await processD1StripeEvent(env.DB, event)).toBe("duplicate");
});

it("updates a linked business from account.updated", async () => {
  const repos = createD1Repositories(env.DB);
  const businessId = crypto.randomUUID();
  await repos.businesses.getOrCreate(businessId);
  await repos.businesses.update(businessId, { stripeAccountId: "acct_linked" });
  const event = {
    id: "evt_" + crypto.randomUUID(),
    type: "account.updated",
    data: {
      object: {
        id: "acct_linked",
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true,
      },
    },
  } as unknown as Stripe.Event;
  expect(await processD1StripeEvent(env.DB, event)).toBe("processed");
  expect(await repos.businesses.getByBusinessId(businessId)).toMatchObject({
    connectState: "active",
    chargesEnabled: true,
    payoutsEnabled: true,
  });
});

it("retries payment webhooks until the invoice row exists", async () => {
  const event = {
    id: "evt_" + crypto.randomUUID(),
    type: "payment_intent.succeeded",
    data: {
      object: {
        metadata: {
          businessId: crypto.randomUUID(),
          invoiceId: crypto.randomUUID(),
        },
        amount_received: 100,
      },
    },
  } as unknown as Stripe.Event;
  await expect(processD1StripeEvent(env.DB, event)).rejects.toThrow(
    /not available yet/,
  );
  expect(
    await env.DB.prepare("SELECT 1 FROM stripe_events WHERE event_id=?")
      .bind(event.id)
      .first(),
  ).toBeNull();
});
