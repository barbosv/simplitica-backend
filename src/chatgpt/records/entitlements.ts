import type { CloudOwner } from "../accounts/types.js";
import { isNonnegativeSafeInteger, isOpaqueIdentifier } from "../accounts/validation.js";
import { RecordError } from "./types.js";
export type VerifiedEntitlementFact = { appSlug: "simpli-invoice"; environment: "Sandbox" | "Production"; originalTransactionId: string; state: "active" | "trial" | "grace" | "billing_retry" | "lapsed" | "revoked" | "unknown"; expiresAt: number | null; graceExpiresAt: number | null; signedAt: number; checkedAt: number };
function validOwner(owner: CloudOwner): boolean { return isOpaqueIdentifier(owner?.ownerId) && isOpaqueIdentifier(owner?.businessId); }
// These inputs must come from the future verified native/Apple service. They do
// not verify purchase evidence and are never mounted on a public endpoint.
export async function initializeVerifiedOwnerRecords(db: D1Database, owner: CloudOwner, deviceKeyId: string): Promise<void> {
  if (!validOwner(owner) || !isOpaqueIdentifier(deviceKeyId)) throw new RecordError("invalid_input");
  const { ownerId, businessId } = owner;
  const guard = crypto.randomUUID();
  const predicate = `EXISTS (SELECT 1 FROM cloud_businesses b JOIN cloud_devices d ON d.owner_id = b.owner_id WHERE b.owner_id = ? AND b.business_id = ? AND d.device_key_id = ? AND d.status = 'active')`;
  const values = [ownerId, businessId, deviceKeyId];
  try {
    await db.batch([
      db.prepare(`INSERT INTO cloud_batch_guards VALUES (?, CASE WHEN ${predicate} THEN 1 ELSE 0 END)`).bind(guard, ...values),
      db.prepare("INSERT INTO cloud_record_state(owner_id,business_id,phase,sync_epoch,head_sequence,floor_sequence) VALUES (?,?,'importing',?,0,0) ON CONFLICT(owner_id) DO NOTHING").bind(ownerId, businessId, crypto.randomUUID()),
      db.prepare("DELETE FROM cloud_batch_guards WHERE operation_id = ?").bind(guard),
    ]);
  } catch {
    let permitted;
    try { permitted = await db.prepare(`SELECT ${predicate} AS permitted`).bind(...values).first<number>("permitted"); } catch { throw new RecordError("storage_unavailable"); }
    throw new RecordError(permitted ? "storage_unavailable" : "not_authorized");
  }
}
export async function applyVerifiedEntitlement(db: D1Database, owner: CloudOwner, fact: VerifiedEntitlementFact, now: number): Promise<void> {
  if (!validOwner(owner) || !fact || fact.appSlug !== "simpli-invoice" || !["Sandbox", "Production"].includes(fact.environment) || !isOpaqueIdentifier(fact.originalTransactionId) ||
      !["active", "trial", "grace", "billing_retry", "lapsed", "revoked", "unknown"].includes(fact.state) ||
      !isNonnegativeSafeInteger(now) || !isNonnegativeSafeInteger(fact.signedAt) || !isNonnegativeSafeInteger(fact.checkedAt) || fact.checkedAt > now ||
      !(fact.expiresAt === null || isNonnegativeSafeInteger(fact.expiresAt)) || !(fact.graceExpiresAt === null || isNonnegativeSafeInteger(fact.graceExpiresAt))) throw new RecordError("invalid_input");
  const { ownerId, businessId } = owner;
  const { appSlug, environment, originalTransactionId, state, expiresAt, graceExpiresAt, signedAt, checkedAt } = fact;
  const guard = crypto.randomUUID();
  const lineage = `EXISTS (SELECT 1 FROM cloud_purchase_lineages p JOIN cloud_businesses b ON b.owner_id = p.owner_id WHERE p.owner_id = ? AND b.business_id = ? AND p.app_slug = ? AND p.store_environment = ? AND p.original_transaction_id = ?)`;
  const lineageValues = [ownerId, businessId, appSlug, environment, originalTransactionId];
  // An older server check or signed fact is ignored. For a non-stale equal
  // signed fact, inconsistent signed fields abort, including concurrent writers.
  const conflict = `EXISTS (SELECT 1 FROM cloud_entitlements WHERE owner_id = ? AND signed_at = ? AND checked_at <= ? AND (state IS NOT ? OR expires_at IS NOT ? OR grace_expires_at IS NOT ?))`;
  const conflictValues = [ownerId, signedAt, checkedAt, state, expiresAt, graceExpiresAt];
  try {
    await db.batch([
      db.prepare(`INSERT INTO cloud_batch_guards VALUES (?, CASE WHEN ${lineage} AND NOT (${conflict}) THEN 1 ELSE 0 END)`).bind(guard, ...lineageValues, ...conflictValues),
      db.prepare(`INSERT INTO cloud_entitlements(owner_id,app_slug,store_environment,original_transaction_id,state,expires_at,grace_expires_at,signed_at,checked_at) VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(owner_id) DO UPDATE SET state = excluded.state, expires_at = excluded.expires_at, grace_expires_at = excluded.grace_expires_at, signed_at = excluded.signed_at, checked_at = excluded.checked_at
        WHERE excluded.signed_at >= cloud_entitlements.signed_at AND excluded.checked_at >= cloud_entitlements.checked_at`).bind(ownerId, appSlug, environment, originalTransactionId, state, expiresAt, graceExpiresAt, signedAt, checkedAt),
      db.prepare("DELETE FROM cloud_batch_guards WHERE operation_id = ?").bind(guard),
    ]);
  } catch {
    try {
      const row = await db.prepare(`SELECT ${lineage} AS permitted, ${conflict} AS conflicting`).bind(...lineageValues, ...conflictValues).first<{ permitted: number; conflicting: number }>();
      if (!row?.permitted) throw new RecordError("not_authorized");
      if (row.conflicting) throw new RecordError("operation_conflict");
    } catch (error) { if (error instanceof RecordError) throw error; }
    throw new RecordError("storage_unavailable");
  }
}
