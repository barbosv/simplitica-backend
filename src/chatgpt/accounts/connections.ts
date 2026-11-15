import type { CloudIdentity, CloudOwner } from "./types.js";
import { isNonnegativeSafeInteger, isOpaqueIdentifier } from "./validation.js";

export type CloudConnectionErrorCode = "invalid_input" | "device_denied" | "storage_unavailable";
export class CloudConnectionError extends Error {
  constructor(public readonly code: CloudConnectionErrorCode) {
    super(code);
    this.name = "CloudConnectionError";
  }
}

// Internal inputs only: a future native command verifier supplies the device
// context, and a managed-token verifier supplies identity/client/iat claims.
// These methods neither verify proofs nor fabricate token issuance timestamps.
type Command = { identity: CloudIdentity; deviceKeyId: string; clientId: string; now: number };
type Claims = { identity: CloudIdentity; clientId: string; tokenIssuedAt: number; now: number };
function validContext(input: Command | Claims): boolean {
  return isOpaqueIdentifier(input?.identity?.issuer) &&
    isOpaqueIdentifier(input?.identity?.appleIdentity) &&
    isOpaqueIdentifier(input?.clientId) && isNonnegativeSafeInteger(input?.now);
}

export function createCloudConnectionRepository(db: D1Database) {
  const statement = (sql: string, ...values: (string | number)[]) => db.prepare(sql).bind(...values);
  const authority = `SELECT i.owner_id FROM cloud_identities i
    JOIN cloud_devices d ON d.owner_id = i.owner_id
    WHERE i.issuer = ? AND i.apple_identity = ? AND d.device_key_id = ? AND d.status = 'active'`;

  async function change(input: Command, status: "active" | "revoked"): Promise<void> {
    if (!validContext(input) || !isOpaqueIdentifier(input?.deviceKeyId)) {
      throw new CloudConnectionError("invalid_input");
    }
    // Copy scalars before the first await, including identity fields.
    const { issuer, appleIdentity } = input.identity;
    const { deviceKeyId, clientId, now } = input;
    const tokenNotBefore = Math.floor(now / 1000) + 1;
    const operationId = crypto.randomUUID();
    try {
      // The assertion is unconditional, so a missing owner or inactive device
      // aborts the batch instead of succeeding with a zero-row mutation.
      const mutation = status === "active"
        ? statement(
          `INSERT INTO cloud_connections (owner_id, client_id, approving_device_key_id, status, token_not_before)
           SELECT owner_id, ?, ?, 'active', ? FROM cloud_identities WHERE issuer = ? AND apple_identity = ?
           ON CONFLICT (owner_id, client_id) DO UPDATE SET
             approving_device_key_id = excluded.approving_device_key_id,
             status = 'active', token_not_before = MAX(cloud_connections.token_not_before, excluded.token_not_before)`,
          clientId, deviceKeyId, tokenNotBefore, issuer, appleIdentity,
        )
        : statement(
          `UPDATE cloud_connections SET status = 'revoked', token_not_before = MAX(token_not_before, ?)
           WHERE owner_id = (SELECT owner_id FROM cloud_identities WHERE issuer = ? AND apple_identity = ?)
             AND client_id = ?`,
          tokenNotBefore, issuer, appleIdentity, clientId,
        );
      await db.batch([
        statement(
          `INSERT INTO cloud_batch_guards (operation_id, permitted)
           VALUES (?, CASE WHEN EXISTS (${authority}) THEN 1 ELSE 0 END)`,
          operationId, issuer, appleIdentity, deviceKeyId,
        ),
        mutation,
        statement("DELETE FROM cloud_batch_guards WHERE operation_id = ?", operationId),
      ]);
    } catch {
      // Re-read primary authority after rollback. Never parse, log or retain D1
      // errors: they can contain SQL and private identifiers.
      let device;
      try {
        device = await statement(authority, issuer, appleIdentity, deviceKeyId).first();
      } catch {
        throw new CloudConnectionError("storage_unavailable");
      }
      throw new CloudConnectionError(device ? "storage_unavailable" : "device_denied");
    }
  }

  return {
    approve: (input: Command): Promise<void> => change(input, "active"),
    revoke: (input: Command): Promise<void> => change(input, "revoked"),
    async authorize(input: Claims): Promise<CloudOwner | null> {
      if (!validContext(input) || !isNonnegativeSafeInteger(input?.tokenIssuedAt) ||
          input.tokenIssuedAt > Math.floor(input.now / 1000)) return null;
      const { issuer, appleIdentity } = input.identity;
      const { clientId, tokenIssuedAt } = input;
      try {
        // One primary read checks both the connection and its approving device;
        // authorization is read-only and can never reactivate revoked state.
        return await statement(
          `SELECT i.owner_id AS ownerId, b.business_id AS businessId FROM cloud_identities i
           JOIN cloud_businesses b ON b.owner_id = i.owner_id
           JOIN cloud_connections c ON c.owner_id = i.owner_id
           JOIN cloud_devices d ON d.owner_id = c.owner_id AND d.device_key_id = c.approving_device_key_id
           WHERE i.issuer = ? AND i.apple_identity = ? AND c.client_id = ?
             AND c.status = 'active' AND d.status = 'active' AND c.token_not_before <= ?`,
          issuer, appleIdentity, clientId, tokenIssuedAt,
        ).first<CloudOwner>();
      } catch {
        throw new CloudConnectionError("storage_unavailable");
      }
    },
  };
}
