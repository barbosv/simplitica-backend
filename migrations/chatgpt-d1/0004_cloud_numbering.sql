-- Source-only numbering; verified import must seed state before readiness.
CREATE TABLE cloud_number_state (
 owner_id TEXT PRIMARY KEY REFERENCES cloud_owners(owner_id),
 next_index INTEGER NOT NULL CHECK(typeof(next_index)='integer' AND next_index BETWEEN 1 AND 9007199254740991),
 generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation BETWEEN 1 AND 9007199254740991),
 prefix TEXT NOT NULL CHECK(length(CAST(prefix AS BLOB))<=64),
 pad_length INTEGER NOT NULL CHECK(typeof(pad_length)='integer' AND pad_length BETWEEN 1 AND 12),
 initialized INTEGER NOT NULL CHECK(initialized IN (0,1))
);
CREATE TABLE cloud_number_reservations (
 owner_id TEXT NOT NULL REFERENCES cloud_owners(owner_id), id TEXT NOT NULL, device_key_id TEXT NOT NULL,
 start_index INTEGER NOT NULL CHECK(typeof(start_index)='integer' AND start_index BETWEEN 1 AND 9007199254740972),
 end_index INTEGER NOT NULL CHECK(typeof(end_index)='integer' AND end_index=start_index+19),
 prefix TEXT NOT NULL CHECK(length(CAST(prefix AS BLOB))<=64), pad_length INTEGER NOT NULL CHECK(typeof(pad_length)='integer' AND pad_length BETWEEN 1 AND 12),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),
 PRIMARY KEY(owner_id,id), UNIQUE(owner_id,start_index),
 FOREIGN KEY(device_key_id,owner_id) REFERENCES cloud_devices(device_key_id,owner_id)
);
CREATE INDEX cloud_number_reservations_device ON cloud_number_reservations(owner_id,device_key_id);
CREATE TABLE cloud_issued_numbers (
 owner_id TEXT NOT NULL REFERENCES cloud_owners(owner_id), formatted_number TEXT NOT NULL CHECK(length(CAST(formatted_number AS BLOB)) BETWEEN 1 AND 128),
 document_id TEXT NOT NULL, numeric_index INTEGER CHECK(numeric_index IS NULL OR (typeof(numeric_index)='integer' AND numeric_index BETWEEN 1 AND 9007199254740991)),
 reservation_id TEXT, issued_at INTEGER NOT NULL CHECK(typeof(issued_at)='integer' AND issued_at BETWEEN 0 AND 9007199254740991),
 PRIMARY KEY(owner_id,formatted_number), UNIQUE(owner_id,document_id), FOREIGN KEY(owner_id,reservation_id) REFERENCES cloud_number_reservations(owner_id,id)
);
