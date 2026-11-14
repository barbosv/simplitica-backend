CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_slug TEXT NOT NULL,
  app_account_token TEXT NOT NULL,
  original_transaction_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  state TEXT NOT NULL,
  expires_at TEXT,
  environment TEXT,
  latest_signed_transaction_info TEXT,
  latest_signed_renewal_info TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (app_slug, app_account_token, original_transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_entitlement
  ON subscriptions (app_slug, app_account_token, updated_at DESC);

CREATE TABLE IF NOT EXISTS businesses (
  business_id TEXT PRIMARY KEY,
  stripe_account_id TEXT UNIQUE,
  connect_state TEXT NOT NULL DEFAULT 'not_started',
  charges_enabled INTEGER NOT NULL DEFAULT 0,
  payouts_enabled INTEGER NOT NULL DEFAULT 0,
  dashboard_url TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_businesses_stripe_account
  ON businesses (stripe_account_id);

CREATE TABLE IF NOT EXISTS invoice_payments (
  business_id TEXT NOT NULL REFERENCES businesses (business_id) ON DELETE CASCADE,
  invoice_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  invoice_number TEXT NOT NULL,
  customer_email TEXT,
  checkout_session_id TEXT,
  payment_url TEXT,
  status TEXT NOT NULL DEFAULT 'unpaid',
  paid_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (business_id, invoice_id)
);

CREATE INDEX IF NOT EXISTS idx_invoice_payments_session
  ON invoice_payments (checkout_session_id);

CREATE INDEX IF NOT EXISTS idx_invoice_payments_status
  ON invoice_payments (business_id, status);

CREATE TABLE IF NOT EXISTS stripe_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  processed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);


CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX idx_rate_limits_expiry ON rate_limits(expires_at);
CREATE TABLE upstream_cache (key TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX idx_upstream_cache_expiry ON upstream_cache(expires_at);
