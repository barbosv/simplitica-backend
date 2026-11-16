-- Internal authoring schema; issued numbers must already belong to this document.
CREATE UNIQUE INDEX cloud_issued_numbers_document_number ON cloud_issued_numbers(owner_id,document_id,formatted_number);
CREATE TABLE cloud_documents (
 owner_id TEXT NOT NULL REFERENCES cloud_owners(owner_id),
 id TEXT NOT NULL,
 number TEXT NOT NULL CHECK(length(CAST(number AS BLOB)) BETWEEN 1 AND 128),
 document_type TEXT NOT NULL CHECK(document_type IN ('invoice','estimate')),
 state TEXT NOT NULL CHECK(state IN ('draft','finalized','sent','paid')),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),
 updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at BETWEEN created_at AND 9007199254740991),
 deleted_at INTEGER CHECK(deleted_at IS NULL OR (typeof(deleted_at)='integer' AND deleted_at BETWEEN created_at AND 9007199254740991)),
 payload TEXT NOT NULL CHECK(json_valid(payload) AND length(CAST(payload AS BLOB))<=1048576),
 PRIMARY KEY(owner_id,id),
 FOREIGN KEY(owner_id,id,number) REFERENCES cloud_issued_numbers(owner_id,document_id,formatted_number)
);
CREATE TABLE cloud_estimate_conversions (
 owner_id TEXT NOT NULL REFERENCES cloud_owners(owner_id),
 estimate_id TEXT NOT NULL,
 invoice_id TEXT NOT NULL,
 estimate_revision INTEGER NOT NULL CHECK(typeof(estimate_revision)='integer' AND estimate_revision BETWEEN 1 AND 9007199254740991),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),
 PRIMARY KEY(owner_id,estimate_id), UNIQUE(owner_id,invoice_id),
 FOREIGN KEY(owner_id,estimate_id) REFERENCES cloud_documents(owner_id,id),
 FOREIGN KEY(owner_id,invoice_id) REFERENCES cloud_documents(owner_id,id)
);
