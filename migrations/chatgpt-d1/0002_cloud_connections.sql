-- Internal lifecycle only; opt-in and separate from production migrations.
CREATE TABLE cloud_connections (
  owner_id TEXT NOT NULL REFERENCES cloud_owners(owner_id),
  client_id TEXT NOT NULL CHECK(length(CAST(client_id AS BLOB)) > 0),
  approving_device_key_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
  revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision BETWEEN 1 AND 9007199254740991),
  token_not_before INTEGER NOT NULL CHECK(typeof(token_not_before) = 'integer' AND token_not_before BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (owner_id, client_id),
  FOREIGN KEY (approving_device_key_id, owner_id) REFERENCES cloud_devices(device_key_id, owner_id)
);
