import { beforeEach, expect, it } from "vitest";
import { env as workerEnv } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { createD1Repositories } from "../../src/db/repositories/d1.js";

const env = workerEnv as {
  DB: D1Database;
  TEST_MIGRATIONS: import("@cloudflare/vitest-plugin").D1Migration[];
};
beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

it("persists subscription upserts and returns the latest entitlement across repository instances", async () => {
  const repos = createD1Repositories(env.DB);
  const base = {
    appSlug: "simpli-invoice",
    appAccountToken: "token",
    originalTransactionId: "tx1",
    productId: "monthly",
    state: "active" as const,
  };
  expect(
    await repos.subscriptions.getEntitlement(
      base.appSlug,
      base.appAccountToken,
    ),
  ).toBeNull();
  await repos.subscriptions.upsert(base);
  await repos.subscriptions.upsert({
    ...base,
    productId: "annual",
    expiresAt: "2030-01-01T00:00:00.000Z",
  });
  expect(
    await createD1Repositories(env.DB).subscriptions.getEntitlement(
      base.appSlug,
      base.appAccountToken,
    ),
  ).toMatchObject({
    productId: "annual",
    expiresAt: "2030-01-01T00:00:00.000Z",
  });
});

it("creates a business atomically and preserves false, null, and timestamp behavior", async () => {
  const repos = createD1Repositories(env.DB);
  const id = crypto.randomUUID();
  const records = await Promise.all(
    Array.from({ length: 4 }, () => repos.businesses.getOrCreate(id)),
  );
  expect(records.every((record) => record.businessId === id)).toBe(true);
  await repos.businesses.update(id, {
    stripeAccountId: "acct_test",
    chargesEnabled: true,
    payoutsEnabled: true,
  });
  const next = await repos.businesses.update(id, {
    chargesEnabled: false,
    payoutsEnabled: false,
    stripeAccountId: null,
  });
  expect(next).toMatchObject({
    stripeAccountId: "acct_test",
    chargesEnabled: false,
    payoutsEnabled: false,
  });
  expect(next.createdAt).toMatch(/^\d{4}-.*Z$/);
  expect(
    await repos.businesses.getByStripeAccountId("acct_test"),
  ).toMatchObject({ businessId: id });
  expect(await repos.businesses.getByBusinessId("missing")).toBeNull();
  await expect(repos.businesses.update("missing", {})).rejects.toThrow();
});

it("preserves invoice cents, uniqueness, null fields, and paid lookups", async () => {
  const repos = createD1Repositories(env.DB);
  const businessId = crypto.randomUUID();
  await repos.businesses.getOrCreate(businessId);
  const record = {
    businessId,
    invoiceId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    amountCents: 12345,
    currency: "usd",
    invoiceNumber: "INV-1",
    customerEmail: null,
    checkoutSessionId: "cs_" + crypto.randomUUID(),
    paymentUrl: null,
    status: "pending" as const,
    paidAt: null,
    expiresAt: null,
  };
  expect(
    await repos.invoicePayments.get(businessId, record.invoiceId),
  ).toBeNull();
  expect(await repos.invoicePayments.upsert(record)).toMatchObject({
    amountCents: 12345,
    paidAt: null,
  });
  await expect(
    repos.invoicePayments.upsert({ ...record, invoiceId: crypto.randomUUID() }),
  ).rejects.toThrow();
  expect(
    await repos.invoicePayments.getByIdempotencyKey(record.idempotencyKey),
  ).toMatchObject({ invoiceId: record.invoiceId });
  await repos.invoicePayments.markPaid({
    businessId,
    invoiceId: record.invoiceId,
    paidAt: "2026-11-09T00:00:00.000Z",
    amountCents: 0,
  });
  expect(
    await repos.invoicePayments.get(businessId, record.invoiceId),
  ).toMatchObject({ status: "paid", amountCents: 0 });
  expect(
    await repos.invoicePayments.markPaidBySessionId(
      record.checkoutSessionId,
      "2026-11-10T00:00:00.000Z",
    ),
  ).toMatchObject({ paidAt: "2026-11-10T00:00:00.000Z" });
  expect(
    await repos.invoicePayments.markPaidBySessionId(
      "missing",
      "2026-11-10T00:00:00.000Z",
    ),
  ).toBeNull();
  const eventId = crypto.randomUUID();
  expect(await repos.stripeEvents.tryInsert(eventId, "test")).toBe(true);
  expect(await repos.stripeEvents.tryInsert(eventId, "test")).toBe(false);
});
