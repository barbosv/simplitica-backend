-- Simplitica backend: subscriptions + Stripe Connect

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id BIGSERIAL PRIMARY KEY,
  app_slug TEXT NOT NULL,
  app_account_token UUID NOT NULL,
  original_transaction_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  state TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  environment TEXT,
  latest_signed_transaction_info TEXT,
  latest_signed_renewal_info TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (app_slug, app_account_token, original_transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_entitlement
  ON subscriptions (app_slug, app_account_token, updated_at DESC);

CREATE TABLE IF NOT EXISTS businesses (
  business_id UUID PRIMARY KEY,
  stripe_account_id TEXT UNIQUE,
  connect_state TEXT NOT NULL DEFAULT 'not_started',
  charges_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  payouts_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  dashboard_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_businesses_stripe_account
  ON businesses (stripe_account_id);

CREATE TABLE IF NOT EXISTS invoice_payments (
  business_id UUID NOT NULL REFERENCES businesses (business_id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  invoice_number TEXT NOT NULL,
  customer_email TEXT,
  checkout_session_id TEXT,
  payment_url TEXT,
  status TEXT NOT NULL DEFAULT 'unpaid',
  paid_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (business_id, invoice_id)
);

CREATE INDEX IF NOT EXISTS idx_invoice_payments_session
  ON invoice_payments (checkout_session_id);

CREATE INDEX IF NOT EXISTS idx_invoice_payments_status
  ON invoice_payments (business_id, status);

CREATE TABLE IF NOT EXISTS stripe_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Simplitica backend: subscriptions + Stripe Connect

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id BIGSERIAL PRIMARY KEY,
  app_slug TEXT NOT NULL,
  app_account_token UUID NOT NULL,
  original_transaction_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  state TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  environment TEXT,
  latest_signed_transaction_info TEXT,
  latest_signed_renewal_info TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (app_slug, app_account_token, original_transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_entitlement
  ON subscriptions (app_slug, app_account_token, updated_at DESC);

CREATE TABLE IF NOT EXISTS businesses (
  business_id UUID PRIMARY KEY,
  stripe_account_id TEXT UNIQUE,
  connect_state TEXT NOT NULL DEFAULT 'not_started',
  charges_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  payouts_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  dashboard_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_businesses_stripe_account
  ON businesses (stripe_account_id);

CREATE TABLE IF NOT EXISTS invoice_payments (
  business_id UUID NOT NULL REFERENCES businesses (business_id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  invoice_number TEXT NOT NULL,
  customer_email TEXT,
  checkout_session_id TEXT,
  payment_url TEXT,
  status TEXT NOT NULL DEFAULT 'unpaid',
  paid_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (business_id, invoice_id)
);

CREATE INDEX IF NOT EXISTS idx_invoice_payments_session
  ON invoice_payments (checkout_session_id);

CREATE INDEX IF NOT EXISTS idx_invoice_payments_status
  ON invoice_payments (business_id, status);

CREATE TABLE IF NOT EXISTS stripe_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
