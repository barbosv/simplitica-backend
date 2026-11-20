-- Opt-in cloud ownership schema. Not part of the production migration directory.
CREATE TABLE cloud_owners (
  owner_id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991)
);

CREATE TABLE cloud_identities (
  issuer TEXT NOT NULL CHECK(length(CAST(issuer AS BLOB)) > 0),
  apple_identity TEXT NOT NULL CHECK(length(CAST(apple_identity AS BLOB)) > 0),
  owner_id TEXT NOT NULL UNIQUE REFERENCES cloud_owners(owner_id),
  PRIMARY KEY (issuer, apple_identity)
);

CREATE TABLE cloud_businesses (
  business_id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL UNIQUE REFERENCES cloud_owners(owner_id),
  UNIQUE (business_id, owner_id)
);

CREATE TABLE cloud_devices (
  device_key_id TEXT PRIMARY KEY NOT NULL CHECK(length(CAST(device_key_id AS BLOB)) > 0),
  owner_id TEXT NOT NULL REFERENCES cloud_owners(owner_id),
  status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
  UNIQUE (device_key_id, owner_id)
);

CREATE TABLE cloud_purchase_lineages (
  app_slug TEXT NOT NULL CHECK(length(CAST(app_slug AS BLOB)) > 0),
  store_environment TEXT NOT NULL CHECK(store_environment IN ('Sandbox', 'Production')),
  original_transaction_id TEXT NOT NULL CHECK(length(CAST(original_transaction_id AS BLOB)) > 0),
  owner_id TEXT NOT NULL UNIQUE REFERENCES cloud_owners(owner_id),
  PRIMARY KEY (app_slug, store_environment, original_transaction_id)
);

CREATE TABLE cloud_enrollment_challenges (
  challenge_hash TEXT PRIMARY KEY NOT NULL CHECK(length(challenge_hash) = 64 AND challenge_hash NOT GLOB '*[^0-9a-f]*'),
  issuer TEXT NOT NULL CHECK(length(CAST(issuer AS BLOB)) > 0),
  apple_identity TEXT NOT NULL CHECK(length(CAST(apple_identity AS BLOB)) > 0),
  device_key_id TEXT NOT NULL CHECK(length(CAST(device_key_id AS BLOB)) > 0),
  issued_at INTEGER NOT NULL CHECK(typeof(issued_at) = 'integer' AND issued_at BETWEEN 0 AND 9007199254740991),
  expires_at INTEGER NOT NULL CHECK(typeof(expires_at) = 'integer' AND expires_at BETWEEN 0 AND 9007199254740991 AND expires_at > issued_at AND expires_at - issued_at <= 300000),
  consumed_at INTEGER CHECK(consumed_at IS NULL OR (typeof(consumed_at) = 'integer' AND consumed_at >= issued_at AND consumed_at < expires_at))
);

CREATE TABLE cloud_enrollment_commits (
  challenge_hash TEXT PRIMARY KEY NOT NULL REFERENCES cloud_enrollment_challenges(challenge_hash),
  evidence_hash TEXT NOT NULL CHECK(length(evidence_hash) = 64 AND evidence_hash NOT GLOB '*[^0-9a-f]*'),
  owner_id TEXT NOT NULL REFERENCES cloud_owners(owner_id),
  business_id TEXT NOT NULL,
  device_key_id TEXT NOT NULL,
  response_snapshot TEXT NOT NULL CHECK(json_valid(response_snapshot)
    AND json_extract(response_snapshot, '$.ownerId') IS owner_id
    AND json_extract(response_snapshot, '$.businessId') IS business_id
    AND json_extract(response_snapshot, '$.deviceKeyId') IS device_key_id),
  committed_at INTEGER NOT NULL CHECK(typeof(committed_at) = 'integer' AND committed_at BETWEEN 0 AND 9007199254740991),
  FOREIGN KEY (business_id, owner_id) REFERENCES cloud_businesses(business_id, owner_id),
  FOREIGN KEY (device_key_id, owner_id) REFERENCES cloud_devices(device_key_id, owner_id)
);

CREATE TABLE cloud_batch_guards (
  operation_id TEXT PRIMARY KEY NOT NULL,
  permitted INTEGER NOT NULL CHECK(permitted = 1)
);
