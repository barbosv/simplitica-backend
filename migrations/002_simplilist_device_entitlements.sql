CREATE TABLE IF NOT EXISTS simplilist_device_entitlements (
  device_id TEXT PRIMARY KEY,
  pro BOOLEAN NOT NULL DEFAULT FALSE,
  original_transaction_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
