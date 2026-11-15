import type { CloudIdentity, CloudOwner } from "./types.js";
import { isNonnegativeSafeInteger, isOpaqueIdentifier } from "./validation.js";

export type CloudConnectionErrorCode = "invalid_input" | "device_denied" | "connection_conflict" | "storage_unavailable";
export class CloudConnectionError extends Error {
  constructor(public readonly code: CloudConnectionErrorCode) {
    super(code);
    this.name = "CloudConnectionError";
  }
}

// Internal inputs only: a future native command verifier supplies the device
// context, and a managed-token verifier supplies identity/client/iat/epoch claims.
// These methods neither verify proofs nor fabricate token issuance timestamps.
export type CloudConnectionState = { revision: number; status: "unapproved" | "active" | "revoked" };
type Context = { identity: CloudIdentity; clientId: string };
type Command = Context & { deviceKeyId: string; now: number; expectedRevision: number };
type Claims = { identity: CloudIdentity; clientId: string; tokenIssuedAt: number; connectionEpoch: number; now: number };
function validIdentity(input: Context): boolean {
  return isOpaqueIdentifier(input?.identity?.issuer) &&
    isOpaqueIdentifier(input?.identity?.appleIdentity) &&
    isOpaqueIdentifier(input?.clientId);
}
function validContext(input: Command | Claims): boolean {
  return validIdentity(input) && isNonnegativeSafeInteger(input?.now);
}

export function createCloudConnectionRepository(db: D1Database) {
  const statement = (sql: string, ...values: (string | number)[]) => db.prepare(sql).bind(...values);
  const authority = `SELECT i.owner_id FROM cloud_identities i
    JOIN cloud_devices d ON d.owner_id = i.owner_id
    WHERE i.issuer = ? AND i.apple_identity = ? AND d.device_key_id = ? AND d.status = 'active'`;

  const stateQuery = `SELECT COALESCE(c.revision, 0) AS revision,
    COALESCE(c.status, 'unapproved') AS status FROM cloud_identities i
    LEFT JOIN cloud_connections c ON c.owner_id = i.owner_id AND c.client_id = ?
    WHERE i.issuer = ? AND i.apple_identity = ?`;
  const maxRevision = Number.MAX_SAFE_INTEGER;

  async function change(input: Command, status: "active" | "revoked"): Promise<void> {
    if (!validContext(input) || !isOpaqueIdentifier(input?.deviceKeyId) ||
        !isNonnegativeSafeInteger(input?.expectedRevision)) {
      throw new CloudConnectionError("invalid_input");
    }
    // A future proof verifier must bind expectedRevision into its canonical
    // payload. Never read the latest revision and rebase a verified command.
    // Copy scalars before the first await, including identity fields.
    const { issuer, appleIdentity } = input.identity;
    const { deviceKeyId, clientId, now, expectedRevision } = input;
    const tokenNotBefore = Math.floor(now / 1000) + 1;
    const operationId = crypto.randomUUID();
    const revisionPredicate = status === "revoked"
      ? "(status = 'revoked' AND revision >= ?) OR (revision = ? AND revision < ?)"
      : "revision = ? AND revision < ?";
    const revisionValues = status === "revoked"
      ? [expectedRevision, expectedRevision, maxRevision]
      : [expectedRevision, maxRevision];
    try {
      await db.batch([
        // Both checks are unconditional and in the mutation batch. A missing
        // row is generation zero; revoked rows persist as lifecycle tombstones.
        statement(
          `INSERT INTO cloud_batch_guards (operation_id, permitted)
           VALUES (?, CASE WHEN EXISTS (${authority}) AND EXISTS (
             SELECT 1 FROM (${stateQuery}) WHERE ${revisionPredicate}
           ) THEN 1 ELSE 0 END)`,
          operationId, issuer, appleIdentity, deviceKeyId,
          clientId, issuer, appleIdentity, ...revisionValues,
        ),
        statement(
          `INSERT INTO cloud_connections
           (owner_id, client_id, approving_device_key_id, status, token_not_before, revision)
           SELECT owner_id, ?, ?, ?, ?, 1 FROM cloud_identities WHERE issuer = ? AND apple_identity = ?
           ON CONFLICT (owner_id, client_id) DO UPDATE SET
             approving_device_key_id = CASE WHEN excluded.status = 'active'
               THEN excluded.approving_device_key_id ELSE cloud_connections.approving_device_key_id END,
             status = excluded.status,
             token_not_before = MAX(cloud_connections.token_not_before, excluded.token_not_before),
             revision = cloud_connections.revision + 1
           WHERE excluded.status = 'active' OR cloud_connections.status = 'active'`,
          clientId, deviceKeyId, status, tokenNotBefore, issuer, appleIdentity,
        ),
        statement("DELETE FROM cloud_batch_guards WHERE operation_id = ?", operationId),
      ]);
    } catch {
      // Re-read sanitized primary state only to classify failure after rollback,
      // never to retry. D1 errors can contain SQL and private identifiers.
      let device;
      let state;
      try {
        device = await statement(authority, issuer, appleIdentity, deviceKeyId).first();
        if (device) state = await statement(stateQuery, clientId, issuer, appleIdentity).first<CloudConnectionState>();
      } catch {
        throw new CloudConnectionError("storage_unavailable");
      }
      if (!device) throw new CloudConnectionError("device_denied");
      const noOpRevoke = status === "revoked" && state?.status === "revoked" && expectedRevision <= state.revision;
      if (!state || (!noOpRevoke && (state.revision !== expectedRevision || state.revision === maxRevision))) {
        throw new CloudConnectionError("connection_conflict");
      }
      throw new CloudConnectionError("storage_unavailable");
    }
  }

  return {
    async getState(input: Context): Promise<CloudConnectionState | null> {
      if (!validIdentity(input)) return null;
      const { issuer, appleIdentity } = input.identity;
      const { clientId } = input;
      try {
        return await statement(stateQuery, clientId, issuer, appleIdentity).first<CloudConnectionState>();
      } catch {
        throw new CloudConnectionError("storage_unavailable");
      }
    },
    // Trusted issuer state lookup only. Resource admission must instead compare
    // the epoch already authenticated in the signed token via authorize().
    async getActiveEpoch(input: Context): Promise<number | null> {
      if (!validIdentity(input)) return null;
      const { issuer, appleIdentity } = input.identity;
      const { clientId } = input;
      try {
        const row = await statement(
          `SELECT c.revision FROM cloud_identities i
           JOIN cloud_connections c ON c.owner_id = i.owner_id
           JOIN cloud_devices d ON d.owner_id = c.owner_id AND d.device_key_id = c.approving_device_key_id
           WHERE i.issuer = ? AND i.apple_identity = ? AND c.client_id = ?
             AND c.status = 'active' AND d.status = 'active'`,
          issuer, appleIdentity, clientId,
        ).first<{ revision: number }>();
        return row?.revision ?? null;
      } catch {
        throw new CloudConnectionError("storage_unavailable");
      }
    },
    approve: (input: Command): Promise<void> => change(input, "active"),
    revoke: (input: Command): Promise<void> => change(input, "revoked"),
    async authorize(input: Claims): Promise<CloudOwner | null> {
      if (!validContext(input) || !isNonnegativeSafeInteger(input?.tokenIssuedAt) ||
          !isNonnegativeSafeInteger(input?.connectionEpoch) || input.connectionEpoch === 0 ||
          input.tokenIssuedAt > Math.floor(input.now / 1000)) return null;
      const { issuer, appleIdentity } = input.identity;
      const { clientId, tokenIssuedAt, connectionEpoch } = input;
      try {
        // One primary read checks both the connection and its approving device;
        // authorization is read-only and can never reactivate revoked state.
        return await statement(
          `SELECT i.owner_id AS ownerId, b.business_id AS businessId FROM cloud_identities i
           JOIN cloud_businesses b ON b.owner_id = i.owner_id
           JOIN cloud_connections c ON c.owner_id = i.owner_id
           JOIN cloud_devices d ON d.owner_id = c.owner_id AND d.device_key_id = c.approving_device_key_id
           WHERE i.issuer = ? AND i.apple_identity = ? AND c.client_id = ?
             AND c.status = 'active' AND d.status = 'active' AND c.revision = ? AND c.token_not_before <= ?`,
          issuer, appleIdentity, clientId, connectionEpoch, tokenIssuedAt,
        ).first<CloudOwner>();
      } catch {
        throw new CloudConnectionError("storage_unavailable");
      }
    },
  };
}
