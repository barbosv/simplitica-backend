import type { BusinessRecord, InvoicePaymentRecord, Repositories, SubscriptionRecord } from "../types.js";

export function createMemoryRepositories(): Repositories {
  const subscriptions: SubscriptionRecord[] = [];
  const businesses = new Map<string, BusinessRecord>();
  const invoicePayments = new Map<string, InvoicePaymentRecord>();
  const invoiceByIdempotency = new Map<string, InvoicePaymentRecord>();
  const stripeEvents = new Set<string>();

  const invoiceKey = (businessId: string, invoiceId: string) => `${businessId}:${invoiceId}`;

  return {
    subscriptions: {
      async upsert(next) {
        const updatedAt = new Date().toISOString();
        const rec: SubscriptionRecord = { ...next, updatedAt };
        const idx = subscriptions.findIndex(
          (s) =>
            s.appSlug === rec.appSlug &&
            s.appAccountToken === rec.appAccountToken &&
            s.originalTransactionId === rec.originalTransactionId,
        );
        if (idx >= 0) subscriptions[idx] = rec;
        else subscriptions.push(rec);
        return rec;
      },

      async getEntitlement(appSlug, appAccountToken) {
        const subs = subscriptions
          .filter((s) => s.appSlug === appSlug && s.appAccountToken === appAccountToken)
          .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
        return subs[0] ?? null;
      },
    },

    businesses: {
      async getOrCreate(businessId) {
        const existing = await this.getByBusinessId(businessId);
        if (existing) return existing;
        const now = new Date().toISOString();
        const rec: BusinessRecord = {
          businessId,
          stripeAccountId: null,
          connectState: "not_started",
          chargesEnabled: false,
          payoutsEnabled: false,
          dashboardUrl: null,
          createdAt: now,
          updatedAt: now,
        };
        businesses.set(businessId, rec);
        return rec;
      },

      async getByBusinessId(businessId) {
        return businesses.get(businessId) ?? null;
      },

      async getByStripeAccountId(stripeAccountId) {
        for (const b of businesses.values()) {
          if (b.stripeAccountId === stripeAccountId) return b;
        }
        return null;
      },

      async update(businessId, patch) {
        const current = await this.getByBusinessId(businessId);
        if (!current) throw new Error(`Business not found: ${businessId}`);
        const updated: BusinessRecord = {
          ...current,
          ...patch,
          stripeAccountId: patch.stripeAccountId !== undefined ? patch.stripeAccountId : current.stripeAccountId,
          dashboardUrl: patch.dashboardUrl !== undefined ? patch.dashboardUrl : current.dashboardUrl,
          updatedAt: new Date().toISOString(),
        };
        businesses.set(businessId, updated);
        return updated;
      },
    },

    invoicePayments: {
      async getByIdempotencyKey(key) {
        return invoiceByIdempotency.get(key) ?? null;
      },

      async get(businessId, invoiceId) {
        return invoicePayments.get(invoiceKey(businessId, invoiceId)) ?? null;
      },

      async upsert(record) {
        const now = new Date().toISOString();
        const existing = invoicePayments.get(invoiceKey(record.businessId, record.invoiceId));
        const rec: InvoicePaymentRecord = {
          ...record,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        invoicePayments.set(invoiceKey(record.businessId, record.invoiceId), rec);
        invoiceByIdempotency.set(record.idempotencyKey, rec);
        return rec;
      },

      async markPaid({ businessId, invoiceId, paidAt, sessionId, amountCents }) {
        const rec = invoicePayments.get(invoiceKey(businessId, invoiceId));
        if (!rec) return null;
        const updated: InvoicePaymentRecord = {
          ...rec,
          status: "paid",
          paidAt,
          checkoutSessionId: sessionId ?? rec.checkoutSessionId,
          amountCents: amountCents ?? rec.amountCents,
          updatedAt: new Date().toISOString(),
        };
        invoicePayments.set(invoiceKey(businessId, invoiceId), updated);
        invoiceByIdempotency.set(rec.idempotencyKey, updated);
        return updated;
      },

      async markPaidBySessionId(sessionId, paidAt) {
        for (const rec of invoicePayments.values()) {
          if (rec.checkoutSessionId === sessionId) {
            return this.markPaid({
              businessId: rec.businessId,
              invoiceId: rec.invoiceId,
              paidAt,
              sessionId,
            });
          }
        }
        return null;
      },
    },

    stripeEvents: {
      async tryInsert(eventId, _type) {
        if (stripeEvents.has(eventId)) return false;
        stripeEvents.add(eventId);
        return true;
      },
    },
  };
}
