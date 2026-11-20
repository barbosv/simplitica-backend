import { isNonnegativeSafeInteger, isOpaqueIdentifier } from "./validation.js";
import {
  CloudAccountError,
  type CloudIdentity,
  type CloudOwner,
  type EnrollmentReceipt,
  type VerifiedEnrollmentEvidence,
} from "./types.js";

export { CloudAccountError } from "./types.js";

type ChallengeInput = {
  challengeHash: string;
  identity: CloudIdentity;
  deviceKeyId: string;
  now: number;
  expiresAt: number;
};
type EnrollmentInput = {
  challengeHash: string;
  evidence: VerifiedEnrollmentEvidence;
  now: number;
};
type LedgerRow = { evidence_hash: string; response_snapshot: string };

function opaque(value: unknown): asserts value is string {
  if (!isOpaqueIdentifier(value)) {
    throw new CloudAccountError("invalid_input");
  }
}
function identityInput(identity: CloudIdentity) {
  opaque(identity?.issuer);
  opaque(identity?.appleIdentity);
}
function challengeInput(hash: string) {
  if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) {
    throw new CloudAccountError("invalid_input");
  }
}
function timestamp(value: number) {
  if (!isNonnegativeSafeInteger(value)) {
    throw new CloudAccountError("invalid_input");
  }
}
function sanitize(error: unknown): never {
  if (error instanceof CloudAccountError) throw error;
  // Never retain the D1 exception as a cause: it can contain SQL/input values.
  throw new CloudAccountError("storage_unavailable");
}

export function createCloudAccountRepository(db: D1Database) {
  const statement = (sql: string, ...values: (string | number)[]) =>
    db.prepare(sql).bind(...values);
  const ledger = (challengeHash: string) =>
    statement(
      "SELECT evidence_hash, response_snapshot FROM cloud_enrollment_commits WHERE challenge_hash = ?",
      challengeHash,
    ).first<LedgerRow>();
  const replay = (row: LedgerRow, evidenceHash: string): EnrollmentReceipt => {
    if (row.evidence_hash !== evidenceHash) {
      throw new CloudAccountError("enrollment_conflict");
    }
    return JSON.parse(row.response_snapshot) as EnrollmentReceipt;
  };

  return {
    async issueChallenge(input: ChallengeInput): Promise<void> {
      challengeInput(input?.challengeHash);
      identityInput(input?.identity);
      opaque(input?.deviceKeyId);
      timestamp(input.now);
      timestamp(input.expiresAt);
      if (input.expiresAt <= input.now || input.expiresAt - input.now > 300_000) {
        throw new CloudAccountError("invalid_input");
      }
      const { challengeHash, deviceKeyId, now, expiresAt } = input;
      const { issuer, appleIdentity } = input.identity;
      try {
        await statement(
          `INSERT INTO cloud_enrollment_challenges
           (challenge_hash, issuer, apple_identity, device_key_id, issued_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          challengeHash, issuer, appleIdentity, deviceKeyId, now, expiresAt,
        ).run();
      } catch {
        try {
          const existing = await statement(
            "SELECT challenge_hash FROM cloud_enrollment_challenges WHERE challenge_hash = ?",
            challengeHash,
          ).first();
          if (existing) throw new CloudAccountError("enrollment_conflict");
          throw new CloudAccountError("storage_unavailable");
        } catch (error) {
          sanitize(error);
        }
      }
    },

    async commitEnrollment(input: EnrollmentInput): Promise<EnrollmentReceipt> {
      challengeInput(input?.challengeHash);
      identityInput(input?.evidence?.identity);
      opaque(input?.evidence?.deviceKeyId);
      opaque(input?.evidence?.purchase?.appSlug);
      opaque(input?.evidence?.purchase?.originalTransactionId);
      if (input?.evidence?.purchase?.environment !== "Sandbox" && input?.evidence?.purchase?.environment !== "Production") {
        throw new CloudAccountError("invalid_input");
      }
      timestamp(input.now);
      // Snapshot every scalar before awaiting: caller mutation cannot change the
      // payload between hashing and persistence. JSON arrays preserve exact strings.
      const { challengeHash, now } = input;
      const { issuer, appleIdentity } = input.evidence.identity;
      const { deviceKeyId } = input.evidence;
      const { appSlug, environment, originalTransactionId } = input.evidence.purchase;
      try {
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(JSON.stringify([
            issuer, appleIdentity, deviceKeyId, appSlug, environment, originalTransactionId,
          ])),
        );
        const evidenceHash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
        // Optimization only. The batch guard, unique keys, and post-failure replay
        // establish correctness even when multiple requests all miss this read.
        const previous = await ledger(challengeHash);
        if (previous) return replay(previous, evidenceHash);
        const receipt: EnrollmentReceipt = {
          ownerId: crypto.randomUUID(),
          businessId: crypto.randomUUID(),
          deviceKeyId,
        };
        const operationId = crypto.randomUUID();
        try {
          await db.batch([
            statement(
              `INSERT INTO cloud_batch_guards (operation_id, permitted)
               VALUES (?, CASE WHEN EXISTS (
                 SELECT 1 FROM cloud_enrollment_challenges
                 WHERE challenge_hash = ? AND issuer = ? AND apple_identity = ?
                   AND device_key_id = ? AND consumed_at IS NULL
                   AND issued_at <= ? AND expires_at > ?
               ) THEN 1 ELSE 0 END)`,
              operationId, challengeHash, issuer, appleIdentity, deviceKeyId, now, now,
            ),
            statement("INSERT INTO cloud_owners (owner_id, created_at) VALUES (?, ?)", receipt.ownerId, now),
            statement("INSERT INTO cloud_identities (issuer, apple_identity, owner_id) VALUES (?, ?, ?)", issuer, appleIdentity, receipt.ownerId),
            statement("INSERT INTO cloud_businesses (business_id, owner_id) VALUES (?, ?)", receipt.businessId, receipt.ownerId),
            statement("INSERT INTO cloud_devices (device_key_id, owner_id, status) VALUES (?, ?, 'active')", deviceKeyId, receipt.ownerId),
            statement(
              `INSERT INTO cloud_purchase_lineages (app_slug, store_environment, original_transaction_id, owner_id)
               VALUES (?, ?, ?, ?)`,
              appSlug, environment, originalTransactionId, receipt.ownerId,
            ),
            statement(
              `INSERT INTO cloud_enrollment_commits
               (challenge_hash, evidence_hash, owner_id, business_id, device_key_id, response_snapshot, committed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
              challengeHash, evidenceHash, receipt.ownerId, receipt.businessId, deviceKeyId, JSON.stringify(receipt), now,
            ),
            statement("UPDATE cloud_enrollment_challenges SET consumed_at = ? WHERE challenge_hash = ?", now, challengeHash),
            statement("DELETE FROM cloud_batch_guards WHERE operation_id = ?", operationId),
          ]);
          return receipt;
        } catch {
          // Re-read sanitized primary state rather than parsing/logging SQL errors.
          // The winner may have committed after our optimistic ledger lookup.
          const committed = await ledger(challengeHash);
          if (committed) return replay(committed, evidenceHash);
          const validChallenge = await statement(
            `SELECT 1 AS valid FROM cloud_enrollment_challenges
             WHERE challenge_hash = ? AND issuer = ? AND apple_identity = ?
               AND device_key_id = ? AND consumed_at IS NULL
               AND issued_at <= ? AND expires_at > ?`,
            challengeHash, issuer, appleIdentity, deviceKeyId, now, now,
          ).first();
          if (!validChallenge) throw new CloudAccountError("challenge_invalid");
          const claimed = await statement(
            `SELECT 1 AS claimed WHERE
               EXISTS (SELECT 1 FROM cloud_identities WHERE issuer = ? AND apple_identity = ?)
               OR EXISTS (SELECT 1 FROM cloud_devices WHERE device_key_id = ?)
               OR EXISTS (SELECT 1 FROM cloud_purchase_lineages
                          WHERE app_slug = ? AND store_environment = ? AND original_transaction_id = ?)`,
            issuer, appleIdentity, deviceKeyId, appSlug, environment, originalTransactionId,
          ).first();
          if (claimed) throw new CloudAccountError("enrollment_conflict");
          throw new CloudAccountError("storage_unavailable");
        }
      } catch (error) {
        sanitize(error);
      }
    },

    async findOwner(identity: CloudIdentity): Promise<CloudOwner | null> {
      identityInput(identity);
      try {
        return await statement(
          `SELECT i.owner_id AS ownerId, b.business_id AS businessId
           FROM cloud_identities i JOIN cloud_businesses b ON b.owner_id = i.owner_id
           WHERE i.issuer = ? AND i.apple_identity = ?`,
          identity.issuer, identity.appleIdentity,
        ).first<CloudOwner>();
      } catch (error) {
        sanitize(error);
      }
    },
  };
}
