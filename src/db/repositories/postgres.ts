import type pg from "pg";
import type {
  BusinessRecord,
  ConnectState,
  InvoicePaymentRecord,
  InvoicePaymentStatus,
  Repositories,
  SubscriptionRecord,
} from "../types.js";

function rowToSubscription(row: Record<string, unknown>): SubscriptionRecord {
  return {
    appSlug: row.app_slug as string,
    appAccountToken: row.app_account_token as string,
    originalTransactionId: row.original_transaction_id as string,
    productId: row.product_id as string,
    state: row.state as SubscriptionRecord["state"],
    expiresAt: row.expires_at ? new Date(row.expires_at as string).toISOString() : undefined,
    environment: (row.environment as string) ?? undefined,
    latestSignedTransactionInfo: (row.latest_signed_transaction_info as string) ?? undefined,
    latestSignedRenewalInfo: (row.latest_signed_renewal_info as string) ?? undefined,
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

function rowToBusiness(row: Record<string, unknown>): BusinessRecord {
  return {
    businessId: row.business_id as string,
    stripeAccountId: (row.stripe_account_id as string) ?? null,
    connectState: row.connect_state as ConnectState,
    chargesEnabled: Boolean(row.charges_enabled),
    payoutsEnabled: Boolean(row.payouts_enabled),
    dashboardUrl: (row.dashboard_url as string) ?? null,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

function rowToInvoicePayment(row: Record<string, unknown>): InvoicePaymentRecord {
  return {
    businessId: row.business_id as string,
    invoiceId: row.invoice_id as string,
    idempotencyKey: row.idempotency_key as string,
    amountCents: row.amount_cents as number,
    currency: row.currency as string,
    invoiceNumber: row.invoice_number as string,
    customerEmail: (row.customer_email as string) ?? null,
    checkoutSessionId: (row.checkout_session_id as string) ?? null,
    paymentUrl: (row.payment_url as string) ?? null,
    status: row.status as InvoicePaymentStatus,
    paidAt: row.paid_at ? new Date(row.paid_at as string).toISOString() : null,
    expiresAt: row.expires_at ? new Date(row.expires_at as string).toISOString() : null,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

export function createPostgresRepositories(pool: pg.Pool): Repositories {
  return {
    subscriptions: {
      async upsert(next) {
        const updatedAt = new Date().toISOString();
        const result = await pool.query(
          `
          INSERT INTO subscriptions (
            app_slug, app_account_token, original_transaction_id, product_id,
            state, expires_at, environment,
            latest_signed_transaction_info, latest_signed_renewal_info, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT (app_slug, app_account_token, original_transaction_id)
          DO UPDATE SET
            product_id = EXCLUDED.product_id,
            state = EXCLUDED.state,
            expires_at = EXCLUDED.expires_at,
            environment = EXCLUDED.environment,
            latest_signed_transaction_info = EXCLUDED.latest_signed_transaction_info,
            latest_signed_renewal_info = EXCLUDED.latest_signed_renewal_info,
            updated_at = EXCLUDED.updated_at
          RETURNING *
          `,
          [
            next.appSlug,
            next.appAccountToken,
            next.originalTransactionId,
            next.productId,
            next.state,
            next.expiresAt ?? null,
            next.environment ?? null,
            next.latestSignedTransactionInfo ?? null,
            next.latestSignedRenewalInfo ?? null,
            updatedAt,
          ],
        );
        return rowToSubscription(result.rows[0] as Record<string, unknown>);
      },

      async getEntitlement(appSlug, appAccountToken) {
        const result = await pool.query(
          `
          SELECT * FROM subscriptions
          WHERE app_slug = $1 AND app_account_token = $2
          ORDER BY updated_at DESC
          LIMIT 1
          `,
          [appSlug, appAccountToken],
        );
        if (!result.rows[0]) return null;
        return rowToSubscription(result.rows[0] as Record<string, unknown>);
      },
    },

    businesses: {
      async getOrCreate(businessId) {
        const existing = await this.getByBusinessId(businessId);
        if (existing) return existing;

        const result = await pool.query(
          `
          INSERT INTO businesses (business_id)
          VALUES ($1)
          ON CONFLICT (business_id) DO NOTHING
          RETURNING *
          `,
          [businessId],
        );
        if (result.rows[0]) {
          return rowToBusiness(result.rows[0] as Record<string, unknown>);
        }
        const again = await this.getByBusinessId(businessId);
        if (!again) throw new Error("Failed to create business row");
        return again;
      },

      async getByBusinessId(businessId) {
        const result = await pool.query(`SELECT * FROM businesses WHERE business_id = $1`, [businessId]);
        if (!result.rows[0]) return null;
        return rowToBusiness(result.rows[0] as Record<string, unknown>);
      },

      async getByStripeAccountId(stripeAccountId) {
        const result = await pool.query(`SELECT * FROM businesses WHERE stripe_account_id = $1`, [
          stripeAccountId,
        ]);
        if (!result.rows[0]) return null;
        return rowToBusiness(result.rows[0] as Record<string, unknown>);
      },

      async update(businessId, patch) {
        const result = await pool.query(
          `
          UPDATE businesses SET
            stripe_account_id = COALESCE($2, stripe_account_id),
            connect_state = COALESCE($3, connect_state),
            charges_enabled = COALESCE($4, charges_enabled),
            payouts_enabled = COALESCE($5, payouts_enabled),
            dashboard_url = COALESCE($6, dashboard_url),
            updated_at = NOW()
          WHERE business_id = $1
          RETURNING *
          `,
          [
            businessId,
            patch.stripeAccountId ?? null,
            patch.connectState ?? null,
            patch.chargesEnabled ?? null,
            patch.payoutsEnabled ?? null,
            patch.dashboardUrl ?? null,
          ],
        );
        if (!result.rows[0]) throw new Error(`Business not found: ${businessId}`);
        return rowToBusiness(result.rows[0] as Record<string, unknown>);
      },
    },

    invoicePayments: {
      async getByIdempotencyKey(key) {
        const result = await pool.query(`SELECT * FROM invoice_payments WHERE idempotency_key = $1`, [key]);
        if (!result.rows[0]) return null;
        return rowToInvoicePayment(result.rows[0] as Record<string, unknown>);
      },

      async get(businessId, invoiceId) {
        const result = await pool.query(`SELECT * FROM invoice_payments WHERE business_id = $1 AND invoice_id = $2`, [
          businessId,
          invoiceId,
        ]);
        if (!result.rows[0]) return null;
        return rowToInvoicePayment(result.rows[0] as Record<string, unknown>);
      },

      async upsert(record) {
        const result = await pool.query(
          `
          INSERT INTO invoice_payments (
            business_id, invoice_id, idempotency_key, amount_cents, currency,
            invoice_number, customer_email, checkout_session_id, payment_url,
            status, paid_at, expires_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
          ON CONFLICT (business_id, invoice_id) DO UPDATE SET
            idempotency_key = EXCLUDED.idempotency_key,
            amount_cents = EXCLUDED.amount_cents,
            currency = EXCLUDED.currency,
            invoice_number = EXCLUDED.invoice_number,
            customer_email = EXCLUDED.customer_email,
            checkout_session_id = EXCLUDED.checkout_session_id,
            payment_url = EXCLUDED.payment_url,
            status = EXCLUDED.status,
            paid_at = EXCLUDED.paid_at,
            expires_at = EXCLUDED.expires_at,
            updated_at = NOW()
          RETURNING *
          `,
          [
            record.businessId,
            record.invoiceId,
            record.idempotencyKey,
            record.amountCents,
            record.currency,
            record.invoiceNumber,
            record.customerEmail,
            record.checkoutSessionId,
            record.paymentUrl,
            record.status,
            record.paidAt,
            record.expiresAt,
          ],
        );
        return rowToInvoicePayment(result.rows[0] as Record<string, unknown>);
      },

      async markPaid({ businessId, invoiceId, paidAt, sessionId, amountCents }) {
        const result = await pool.query(
          `
          UPDATE invoice_payments SET
            status = 'paid',
            paid_at = $3,
            checkout_session_id = COALESCE($4, checkout_session_id),
            amount_cents = COALESCE($5, amount_cents),
            updated_at = NOW()
          WHERE business_id = $1 AND invoice_id = $2
          RETURNING *
          `,
          [businessId, invoiceId, paidAt, sessionId ?? null, amountCents ?? null],
        );
        if (!result.rows[0]) return null;
        return rowToInvoicePayment(result.rows[0] as Record<string, unknown>);
      },

      async markPaidBySessionId(sessionId, paidAt) {
        const result = await pool.query(
          `
          UPDATE invoice_payments SET
            status = 'paid',
            paid_at = $2,
            updated_at = NOW()
          WHERE checkout_session_id = $1
          RETURNING *
          `,
          [sessionId, paidAt],
        );
        if (!result.rows[0]) return null;
        return rowToInvoicePayment(result.rows[0] as Record<string, unknown>);
      },
    },

    stripeEvents: {
      async tryInsert(eventId, type) {
        const result = await pool.query(
          `
          INSERT INTO stripe_events (event_id, type)
          VALUES ($1, $2)
          ON CONFLICT (event_id) DO NOTHING
          RETURNING event_id
          `,
          [eventId, type],
        );
        return (result.rowCount ?? 0) > 0;
      },
    },

    simplilistDeviceEntitlements: {
      async get(deviceId) {
        const result = await pool.query(
          `SELECT device_id, pro, original_transaction_id, updated_at
           FROM simplilist_device_entitlements WHERE device_id = $1`,
          [deviceId],
        );
        const row = result.rows[0] as Record<string, unknown> | undefined;
        if (!row) return null;
        return {
          deviceId: row.device_id as string,
          pro: Boolean(row.pro),
          originalTransactionId: (row.original_transaction_id as string) ?? undefined,
          updatedAt: new Date(row.updated_at as string).toISOString(),
        };
      },

      async upsert({ deviceId, pro, originalTransactionId }) {
        const updatedAt = new Date().toISOString();
        const result = await pool.query(
          `
          INSERT INTO simplilist_device_entitlements (device_id, pro, original_transaction_id, updated_at)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (device_id)
          DO UPDATE SET
            pro = EXCLUDED.pro,
            original_transaction_id = EXCLUDED.original_transaction_id,
            updated_at = EXCLUDED.updated_at
          RETURNING device_id, pro, original_transaction_id, updated_at
          `,
          [deviceId, pro, originalTransactionId ?? null, updatedAt],
        );
        const row = result.rows[0] as Record<string, unknown>;
        return {
          deviceId: row.device_id as string,
          pro: Boolean(row.pro),
          originalTransactionId: (row.original_transaction_id as string) ?? undefined,
          updatedAt: new Date(row.updated_at as string).toISOString(),
        };
      },
    },
  };
}
