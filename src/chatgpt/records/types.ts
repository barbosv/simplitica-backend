export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type RecordErrorCode = "invalid_input" | "not_authorized" | "not_ready" | "entitlement_required" | "revision_conflict" | "operation_conflict" | "not_found" | "resync_required" | "storage_unavailable" | "invalid_configuration";
export class RecordError extends Error {
  constructor(public readonly code: RecordErrorCode) { super(code); this.name = "RecordError"; }
}
export type SqlCondition = { sql: string; values: (string | number | null)[] };
export type FeedEvent = { kind: string; id: string; revision: number; payload: JsonValue; tombstone: boolean };
// Source-internal plans only: never decode these structures from HTTP/MCP input.
export type MutationPlan = { condition: SqlCondition; statements: D1PreparedStatement[]; events: FeedEvent[]; response: JsonValue };
export type MutationCommand = { operationKey: string; kind: string; request: JsonValue };
export type RecordState = { syncEpoch: string; head: number; floor: number };
export type FeedCursor = { epoch: string; after: number };
export type FeedChange = FeedEvent & { sequence: number; committedAt: number };
export type FeedPage = { changes: FeedChange[]; nextCursor: FeedCursor; head: number; hasMore: boolean };
