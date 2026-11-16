-- Internal opt-in records only. No public import-completion or entitlement writer.
CREATE UNIQUE INDEX cloud_purchase_lineages_owner_key ON cloud_purchase_lineages(app_slug, store_environment, original_transaction_id, owner_id);
CREATE TABLE cloud_record_state (
 owner_id TEXT PRIMARY KEY NOT NULL REFERENCES cloud_owners(owner_id),
 business_id TEXT NOT NULL,
 phase TEXT NOT NULL CHECK(phase IN ('importing','ready')),
 sync_epoch TEXT NOT NULL CHECK(length(sync_epoch) = 36),
 head_sequence INTEGER NOT NULL DEFAULT 0 CHECK(typeof(head_sequence) = 'integer' AND head_sequence BETWEEN 0 AND 9007199254740991),
 floor_sequence INTEGER NOT NULL DEFAULT 0 CHECK(typeof(floor_sequence) = 'integer' AND floor_sequence BETWEEN 0 AND head_sequence),
 FOREIGN KEY(business_id,owner_id) REFERENCES cloud_businesses(business_id,owner_id)
);
CREATE TABLE cloud_entitlements (
 owner_id TEXT PRIMARY KEY NOT NULL REFERENCES cloud_owners(owner_id),
 app_slug TEXT NOT NULL CHECK(app_slug = 'simpli-invoice'),
 store_environment TEXT NOT NULL CHECK(store_environment IN ('Sandbox','Production')),
 original_transaction_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('active','trial','grace','billing_retry','lapsed','revoked','unknown')),
 expires_at INTEGER CHECK(expires_at IS NULL OR (typeof(expires_at) = 'integer' AND expires_at BETWEEN 0 AND 9007199254740991)),
 grace_expires_at INTEGER CHECK(grace_expires_at IS NULL OR (typeof(grace_expires_at) = 'integer' AND grace_expires_at BETWEEN 0 AND 9007199254740991)),
 signed_at INTEGER NOT NULL CHECK(typeof(signed_at) = 'integer' AND signed_at BETWEEN 0 AND 9007199254740991),
 checked_at INTEGER NOT NULL CHECK(typeof(checked_at) = 'integer' AND checked_at BETWEEN 0 AND 9007199254740991),
 FOREIGN KEY(app_slug,store_environment,original_transaction_id,owner_id) REFERENCES cloud_purchase_lineages(app_slug,store_environment,original_transaction_id,owner_id)
);
CREATE TABLE cloud_mutation_receipts (
 owner_id TEXT NOT NULL REFERENCES cloud_owners(owner_id),
 operation_key TEXT NOT NULL CHECK(length(operation_key) BETWEEN 1 AND 128 AND operation_key NOT GLOB '*[^A-Za-z0-9:_-]*'),
 kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 64),
 request_hash TEXT NOT NULL CHECK(length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
 response_snapshot TEXT NOT NULL CHECK(json_valid(response_snapshot) AND length(CAST(response_snapshot AS BLOB)) <= 1048576),
 committed_at INTEGER NOT NULL CHECK(typeof(committed_at) = 'integer' AND committed_at BETWEEN 0 AND 9007199254740991),
 PRIMARY KEY(owner_id,operation_key)
);
CREATE TABLE cloud_record_feed (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK(sequence BETWEEN 1 AND 9007199254740991),
 owner_id TEXT NOT NULL REFERENCES cloud_owners(owner_id),
 kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 64),
 id TEXT NOT NULL CHECK(length(CAST(id AS BLOB)) BETWEEN 1 AND 128),
 revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision BETWEEN 1 AND 9007199254740991),
 payload TEXT NOT NULL CHECK(json_valid(payload)),
 payload_bytes INTEGER NOT NULL CHECK(typeof(payload_bytes) = 'integer' AND payload_bytes BETWEEN 1 AND 1048576 AND payload_bytes = length(CAST(payload AS BLOB))),
 tombstone INTEGER NOT NULL CHECK(tombstone IN (0,1)),
 committed_at INTEGER NOT NULL CHECK(typeof(committed_at) = 'integer' AND committed_at BETWEEN 0 AND 9007199254740991)
);
CREATE INDEX cloud_record_feed_owner_sequence ON cloud_record_feed(owner_id,sequence);
CREATE TABLE cloud_business_profiles (
 owner_id TEXT PRIMARY KEY NOT NULL REFERENCES cloud_owners(owner_id),
 id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision BETWEEN 1 AND 9007199254740991),
 created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991),
 updated_at INTEGER NOT NULL CHECK(typeof(updated_at) = 'integer' AND updated_at BETWEEN created_at AND 9007199254740991),
 deleted_at INTEGER CHECK(deleted_at IS NULL OR (typeof(deleted_at) = 'integer' AND deleted_at BETWEEN created_at AND 9007199254740991)),
 payload TEXT NOT NULL CHECK(json_valid(payload) AND length(CAST(payload AS BLOB)) <= 1048576),
 search_text TEXT NOT NULL CHECK(length(CAST(search_text AS BLOB)) <= 1048576),
 FOREIGN KEY(id,owner_id) REFERENCES cloud_businesses(business_id,owner_id)
);
CREATE TABLE cloud_customers (
 owner_id TEXT NOT NULL REFERENCES cloud_owners(owner_id),
 id TEXT NOT NULL CHECK(length(id) = 36),
 revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision BETWEEN 1 AND 9007199254740991),
 created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991),
 updated_at INTEGER NOT NULL CHECK(typeof(updated_at) = 'integer' AND updated_at BETWEEN created_at AND 9007199254740991),
 deleted_at INTEGER CHECK(deleted_at IS NULL OR (typeof(deleted_at) = 'integer' AND deleted_at BETWEEN created_at AND 9007199254740991)),
 payload TEXT NOT NULL CHECK(json_valid(payload) AND length(CAST(payload AS BLOB)) <= 1048576),
 search_text TEXT NOT NULL CHECK(length(CAST(search_text AS BLOB)) <= 1048576),
 PRIMARY KEY(owner_id,id)
);
CREATE TABLE cloud_saved_rates (
 owner_id TEXT NOT NULL REFERENCES cloud_owners(owner_id),
 id TEXT NOT NULL CHECK(length(id) = 36),
 revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision BETWEEN 1 AND 9007199254740991),
 created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991),
 updated_at INTEGER NOT NULL CHECK(typeof(updated_at) = 'integer' AND updated_at BETWEEN created_at AND 9007199254740991),
 deleted_at INTEGER CHECK(deleted_at IS NULL OR (typeof(deleted_at) = 'integer' AND deleted_at BETWEEN created_at AND 9007199254740991)),
 payload TEXT NOT NULL CHECK(json_valid(payload) AND length(CAST(payload AS BLOB)) <= 1048576),
 search_text TEXT NOT NULL CHECK(length(CAST(search_text AS BLOB)) <= 1048576),
 PRIMARY KEY(owner_id,id)
);
