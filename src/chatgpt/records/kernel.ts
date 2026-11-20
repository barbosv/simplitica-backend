import { isCanonicalBase64url32, CLOUD_CLIENT_ID } from "../auth/configuration.js";
import { isNonnegativeSafeInteger, isOpaqueIdentifier } from "../accounts/validation.js";
import { requireRecordAuthority, type CloudRecordAuthority } from "./authority.js";
import { encodeRecordJSON, isLabel, utf8Bytes } from "./json.js";
import { RecordError, type MutationCommand, type MutationPlan, type RecordState, type FeedCursor, type FeedPage, type JsonValue } from "./types.js";

// Reused inside the batch guard. Connection/device/epoch are always current;
// there is no alternate native channel or caller-selected authorization bypass.
const authorityPredicate = `EXISTS (SELECT 1 FROM cloud_businesses b
 JOIN cloud_connections c ON c.owner_id = b.owner_id
 JOIN cloud_devices d ON d.owner_id = c.owner_id AND d.device_key_id = c.approving_device_key_id
 WHERE b.owner_id = ? AND b.business_id = ? AND c.client_id = ? AND c.revision = ? AND c.status = 'active' AND d.status = 'active')`;
const readyPredicate = `EXISTS (SELECT 1 FROM cloud_record_state WHERE owner_id = ? AND business_id = ? AND phase = 'ready')`;
const entitlementPredicate = `EXISTS (SELECT 1 FROM cloud_entitlements WHERE owner_id = ? AND checked_at <= ? AND checked_at >= ? AND
 ((state IN ('active','trial') AND expires_at > ?) OR (state = 'grace' AND grace_expires_at > ?)))`;
type StateRow = { permitted: number; phase: string | null; syncEpoch: string | null; head: number | null; floor: number | null; entitled: number };
type Receipt = { kind: string; request_hash: string; response_snapshot: string };
const authorityValues = (a: CloudRecordAuthority) => [a.ownerId, a.businessId, CLOUD_CLIENT_ID, a.connectionEpoch];
const entitlementValues = (a: CloudRecordAuthority, at: number) => [a.ownerId, at, Math.max(0, at - 300_000), at, at];
function checkState(row: StateRow | null | undefined, authoring: boolean): RecordState {
  if (!row?.permitted) throw new RecordError("not_authorized");
  if (row.phase !== "ready" || row.syncEpoch === null || row.head === null || row.floor === null) throw new RecordError("not_ready");
  if (authoring && !row.entitled) throw new RecordError("entitlement_required");
  return { syncEpoch: row.syncEpoch, head: row.head, floor: row.floor };
}
export function createCloudRecordKernel(db: D1Database, dependencies: { authorizationNamespace: string; now?: () => number }) {
  const namespace = dependencies?.authorizationNamespace;
  if (!isCanonicalBase64url32(namespace)) throw new RecordError("invalid_configuration");
  const now = dependencies.now ?? Date.now;
  const sample = () => { const at = now(); if (!isNonnegativeSafeInteger(at)) throw new RecordError("invalid_configuration"); return at; };
  // Explicit primary sessions also remain correct if read replication is enabled.
  const primary = () => db.withSession("first-primary");
  const stateSQL = `SELECT ${authorityPredicate} AS permitted, s.phase, s.sync_epoch AS syncEpoch,
    s.head_sequence AS head, s.floor_sequence AS floor, ${entitlementPredicate} AS entitled
    FROM (SELECT 1) LEFT JOIN cloud_record_state s ON s.owner_id = ? AND s.business_id = ?`;
  const stateValues = (a: CloudRecordAuthority, at: number) => [...authorityValues(a), ...entitlementValues(a, at), a.ownerId, a.businessId];
  async function authorize(a: CloudRecordAuthority, authoring: boolean): Promise<RecordState> {
    requireRecordAuthority(a, namespace);
    const at = sample();
    let row;
    try { row = await primary().prepare(stateSQL).bind(...stateValues(a, at)).first<StateRow>(); } catch { throw new RecordError("storage_unavailable"); }
    return checkState(row, authoring);
  }
  async function receipt(a: CloudRecordAuthority, key: string): Promise<Receipt | null> {
    try { return await primary().prepare("SELECT kind,request_hash,response_snapshot FROM cloud_mutation_receipts WHERE owner_id = ? AND operation_key = ?").bind(a.ownerId, key).first<Receipt>(); } catch { throw new RecordError("storage_unavailable"); }
  }
  function replay(row: Receipt, kind: string, hash: string): JsonValue {
    if (row.kind !== kind || row.request_hash !== hash) throw new RecordError("operation_conflict");
    try { return JSON.parse(row.response_snapshot) as JsonValue; } catch { throw new RecordError("storage_unavailable"); }
  }
  async function commandHash(command: MutationCommand): Promise<string> {
    if (!command || typeof command.operationKey !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(command.operationKey) || !isLabel(command.kind)) throw new RecordError("invalid_input");
    const bytes = new TextEncoder().encode(`[${JSON.stringify(command.kind)},${encodeRecordJSON(command.request)}]`);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
  }
  async function read<T>(a: CloudRecordAuthority, statement: D1PreparedStatement, authoring: boolean): Promise<T[]> {
    requireRecordAuthority(a, namespace);
    const at = sample();
    let results;
    try { results = await primary().batch([db.prepare(stateSQL).bind(...stateValues(a, at)), statement]); }
    catch { throw new RecordError("storage_unavailable"); }
    checkState(results[0].results[0] as StateRow | undefined, authoring);
    return results[1].results as T[];
  }
  const kernel = {
    readOwned: <T>(a: CloudRecordAuthority, statement: D1PreparedStatement) => read<T>(a, statement, false),
    readAuthoring: <T>(a: CloudRecordAuthority, statement: D1PreparedStatement) => read<T>(a, statement, true),
    async prepareAndCommit(a: CloudRecordAuthority, command: MutationCommand, prepare: () => Promise<(at: number) => MutationPlan>): Promise<JsonValue> {
      requireRecordAuthority(a, namespace);
      const hash = await commandHash(command);
      const existing = await receipt(a, command.operationKey);
      await authorize(a, true);
      if (existing) return replay(existing, command.kind, hash);
      let build;
      try { build = await prepare(); }
      catch (error) {
        const winner = await receipt(a, command.operationKey);
        await authorize(a, true);
        if (winner) return replay(winner, command.kind, hash);
        if (error instanceof RecordError) throw error;
        throw new RecordError("storage_unavailable");
      }
      return kernel.commit(a, command, build);
    },
    authorizeRead: (a: CloudRecordAuthority) => authorize(a, false),
    authorizeAuthoring: (a: CloudRecordAuthority) => authorize(a, true),
    async commit(a: CloudRecordAuthority, command: MutationCommand, build: (at: number) => MutationPlan): Promise<JsonValue> {
      requireRecordAuthority(a, namespace);
      if (typeof build !== "function") throw new RecordError("invalid_input");
      const hash = await commandHash(command);
      const { operationKey, kind } = command;
      const existing = await receipt(a, operationKey);
      if (existing) { await authorize(a, true); return replay(existing, kind, hash); }
      // All asynchronous record planning and hashing precede this trusted sample.
      // Building/validation/preparation below are synchronous, then one batch.
      const at = sample();
      let plan: MutationPlan;
      try { plan = build(at); } catch (error) { if (error instanceof RecordError) throw error; throw new RecordError("storage_unavailable"); }
      if (!plan || !plan.condition || typeof plan.condition.sql !== "string" || plan.condition.sql.length === 0 || utf8Bytes(plan.condition.sql) > 10_000 || !Array.isArray(plan.condition.values) || plan.condition.values.length > 86 || !Array.isArray(plan.statements) || plan.statements.length > 20 || !Array.isArray(plan.events) || plan.events.length < 1 || plan.events.length > 10) throw new RecordError("invalid_input");
      if (plan.condition.values.some(v => v !== null && typeof v !== "string" && !(typeof v === "number" && Number.isSafeInteger(v)))) throw new RecordError("invalid_input");
      const response = encodeRecordJSON(plan.response);
      const events = plan.events.map(e => {
        if (!e || !isLabel(e.kind) || !isOpaqueIdentifier(e.id) || utf8Bytes(e.id) > 128 || !isNonnegativeSafeInteger(e.revision) || e.revision === 0 || typeof e.tombstone !== "boolean") throw new RecordError("invalid_input");
        return { ...e, serialized: encodeRecordJSON(e.payload) };
      });
      const guard = crypto.randomUUID();
      try {
        await db.batch([
          // An unconditional VALUES/CASE forces a CHECK failure when any
          // authority or record condition fails, even with zero matching rows.
          db.prepare(`INSERT INTO cloud_batch_guards VALUES (?, CASE WHEN ${authorityPredicate} AND ${readyPredicate} AND ${entitlementPredicate} AND (${plan.condition.sql}) THEN 1 ELSE 0 END)`).bind(guard, ...authorityValues(a), a.ownerId, a.businessId, ...entitlementValues(a, at), ...plan.condition.values),
          ...plan.statements,
          ...events.map(e => db.prepare("INSERT INTO cloud_record_feed(owner_id,kind,id,revision,payload,payload_bytes,tombstone,committed_at) VALUES (?,?,?,?,?,?,?,?)").bind(a.ownerId, e.kind, e.id, e.revision, e.serialized, utf8Bytes(e.serialized), e.tombstone ? 1 : 0, at)),
          db.prepare("INSERT INTO cloud_mutation_receipts(owner_id,operation_key,kind,request_hash,response_snapshot,committed_at) VALUES (?,?,?,?,?,?)").bind(a.ownerId, operationKey, kind, hash, response, at),
          db.prepare("UPDATE cloud_record_state SET head_sequence = (SELECT MAX(sequence) FROM cloud_record_feed WHERE owner_id = ?) WHERE owner_id = ?").bind(a.ownerId, a.ownerId),
          db.prepare("DELETE FROM cloud_batch_guards WHERE operation_id = ?").bind(guard),
        ]);
      } catch {
        // A failed SQL call is never success by itself. Only a committed matching
        // ledger row can establish the winning result after rollback/response loss.
        const winner = await receipt(a, operationKey);
        await authorize(a, true);
        if (winner) return replay(winner, kind, hash);
        let valid;
        try { valid = await primary().prepare(`SELECT CASE WHEN (${plan.condition.sql}) THEN 1 ELSE 0 END AS valid`).bind(...plan.condition.values).first<number>("valid"); } catch { throw new RecordError("storage_unavailable"); }
        throw new RecordError(valid ? "storage_unavailable" : "revision_conflict");
      }
      return JSON.parse(response) as JsonValue;
    },
    async readFeed(a: CloudRecordAuthority, cursor: FeedCursor, limit: number): Promise<FeedPage> {
      requireRecordAuthority(a, namespace);
      if (!cursor || typeof cursor.epoch !== "string" || cursor.epoch.length !== 36 || !isNonnegativeSafeInteger(cursor.after) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new RecordError("invalid_input");
      const { epoch, after } = cursor;
      const at = sample();
      type Row = StateRow & { sequence: number | null; kind: string; id: string; revision: number; payload: string; tombstone: number; committedAt: number; hasMore: number };
      let rows: Row[];
      try {
        // MATERIALIZED metadata/window selection precedes any payload projection.
        // 2048 bytes/event bounds serialized metadata overhead; a 1MiB event fits.
        // No IN-parameter list, and state+page come from this one primary snapshot.
        const result = await primary().prepare(`WITH state AS MATERIALIZED (${stateSQL}),
          limited AS MATERIALIZED (SELECT sequence,payload_bytes FROM cloud_record_feed WHERE owner_id = ? AND sequence > ? ORDER BY sequence LIMIT ?),
          budget AS MATERIALIZED (SELECT sequence,SUM(payload_bytes + 2048) OVER (ORDER BY sequence) AS bytes FROM limited),
          picked AS MATERIALIZED (SELECT sequence FROM budget,state WHERE bytes <= 1500000 AND state.permitted = 1 AND state.phase = 'ready' AND state.syncEpoch = ? AND ? >= state.floor AND ? <= state.head)
          SELECT state.*, f.sequence,f.kind,f.id,f.revision,f.payload,f.tombstone,f.committed_at AS committedAt,
            EXISTS(SELECT 1 FROM cloud_record_feed WHERE owner_id = ? AND sequence > COALESCE((SELECT MAX(sequence) FROM picked),?)) AS hasMore
          FROM state LEFT JOIN picked ON 1 LEFT JOIN cloud_record_feed f ON f.sequence = picked.sequence ORDER BY f.sequence`).bind(...stateValues(a, at), a.ownerId, after, limit, epoch, after, after, a.ownerId, after).all<Row>();
        rows = result.results;
      } catch { throw new RecordError("storage_unavailable"); }
      const state = checkState(rows[0], false);
      if (epoch !== state.syncEpoch || after < state.floor) throw new RecordError("resync_required");
      if (after > state.head) throw new RecordError("invalid_input");
      let changes;
      try { changes = rows.filter(r => r.sequence !== null).map(r => ({ sequence: r.sequence!, kind: r.kind, id: r.id, revision: r.revision, payload: JSON.parse(r.payload) as JsonValue, tombstone: r.tombstone === 1, committedAt: r.committedAt })); } catch { throw new RecordError("storage_unavailable"); }
      return { changes, nextCursor: { epoch, after: changes.at(-1)?.sequence ?? after }, head: state.head, hasMore: rows[0].hasMore === 1 };
    },
  };
  return kernel;
}
// Internal retention primitive only. Never reset AUTOINCREMENT or persisted head.
export async function pruneOwnerFeed(db: D1Database, ownerId: string, expectedEpoch: string, through: number): Promise<void> {
  if (!isOpaqueIdentifier(ownerId) || typeof expectedEpoch !== "string" || expectedEpoch.length !== 36 || !isNonnegativeSafeInteger(through)) throw new RecordError("invalid_input");
  const guard = crypto.randomUUID();
  try {
    await db.batch([
      db.prepare("INSERT INTO cloud_batch_guards VALUES (?,CASE WHEN EXISTS (SELECT 1 FROM cloud_record_state WHERE owner_id = ? AND sync_epoch = ? AND head_sequence >= ?) THEN 1 ELSE 0 END)").bind(guard, ownerId, expectedEpoch, through),
      db.prepare("UPDATE cloud_record_state SET floor_sequence = MAX(floor_sequence,?) WHERE owner_id = ?").bind(through, ownerId),
      db.prepare("DELETE FROM cloud_record_feed WHERE owner_id = ? AND sequence <= ?").bind(ownerId, through),
      db.prepare("DELETE FROM cloud_batch_guards WHERE operation_id = ?").bind(guard),
    ]);
  } catch {
    let row;
    try { row = await db.withSession("first-primary").prepare("SELECT sync_epoch,head_sequence FROM cloud_record_state WHERE owner_id = ?").bind(ownerId).first<{ sync_epoch: string; head_sequence: number }>(); } catch { throw new RecordError("storage_unavailable"); }
    if (!row || row.sync_epoch !== expectedEpoch) throw new RecordError("resync_required");
    if (through > row.head_sequence) throw new RecordError("invalid_input");
    throw new RecordError("storage_unavailable");
  }
}
