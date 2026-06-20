export type EntitlementState =
  | "unknown"
  | "inactive"
  | "trial"
  | "active"
  | "gracePeriod";

export type SubscriptionRecord = {
  appSlug: string;
  appAccountToken: string;
  originalTransactionId: string;
  productId: string;
  state: EntitlementState;
  expiresAt?: string;
  environment?: string;
  latestSignedTransactionInfo?: string;
  latestSignedRenewalInfo?: string;
  updatedAt: string;
};

export type ConnectState = "not_started" | "pending" | "active" | "restricted";

export type BusinessRecord = {
  businessId: string;
  stripeAccountId: string | null;
  connectState: ConnectState;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  dashboardUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export type InvoicePaymentStatus = "unpaid" | "pending" | "paid" | "failed";

export type InvoicePaymentRecord = {
  businessId: string;
  invoiceId: string;
  idempotencyKey: string;
  amountCents: number;
  currency: string;
  invoiceNumber: string;
  customerEmail: string | null;
  checkoutSessionId: string | null;
  paymentUrl: string | null;
  status: InvoicePaymentStatus;
  paidAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Repositories = {
  subscriptions: {
    upsert(record: Omit<SubscriptionRecord, "updatedAt">): Promise<SubscriptionRecord>;
    getEntitlement(appSlug: string, appAccountToken: string): Promise<SubscriptionRecord | null>;
  };
  businesses: {
    getOrCreate(businessId: string): Promise<BusinessRecord>;
    getByBusinessId(businessId: string): Promise<BusinessRecord | null>;
    getByStripeAccountId(stripeAccountId: string): Promise<BusinessRecord | null>;
    update(
      businessId: string,
      patch: Partial<
        Pick<
          BusinessRecord,
          "stripeAccountId" | "connectState" | "chargesEnabled" | "payoutsEnabled" | "dashboardUrl"
        >
      >,
    ): Promise<BusinessRecord>;
  };
  invoicePayments: {
    getByIdempotencyKey(key: string): Promise<InvoicePaymentRecord | null>;
    get(businessId: string, invoiceId: string): Promise<InvoicePaymentRecord | null>;
    upsert(record: Omit<InvoicePaymentRecord, "createdAt" | "updatedAt">): Promise<InvoicePaymentRecord>;
    markPaid(params: {
      businessId: string;
      invoiceId: string;
      paidAt: string;
      sessionId?: string;
      amountCents?: number;
    }): Promise<InvoicePaymentRecord | null>;
    markPaidBySessionId(sessionId: string, paidAt: string): Promise<InvoicePaymentRecord | null>;
  };
  stripeEvents: {
    tryInsert(eventId: string, type: string): Promise<boolean>;
  };
};
