import { type CloudRecordAuthority } from "./authority.js";
import { createCloudRecordKernel } from "./kernel.js";
import { encodeRecordJSON } from "./json.js";
import { RecordError, type JsonValue } from "./types.js";
import { businessValue, customerValue, rateValue, object, uuid, revision, searchInput, searchText, invalid, type BusinessProfile, type Customer, type SavedRate } from "./validation.js";

export type VersionedRecord<T> = { id: string; revision: number; createdAt: number; updatedAt: number; deletedAt: number | null; value: T };
type Value = BusinessProfile | Customer | SavedRate;
type Table = "cloud_business_profiles" | "cloud_customers" | "cloud_saved_rates";
type Row = { id: string; revision: number; created_at: number; updated_at: number; deleted_at: number | null; payload: string };
type WriteInput = { operationKey: string; expectedRevision: number; value: unknown; id?: string; explicitUserRequest?: boolean };
type DeleteInput = { operationKey: string; expectedRevision: number; id: string };
type SearchInput = { query: string; afterId?: string; limit: number };
const columns = "id,revision,created_at,updated_at,deleted_at,payload";
const json = (value: unknown): JsonValue => JSON.parse(encodeRecordJSON(value));
function record<T>(row: Row): VersionedRecord<T> {
  try { return { id: row.id, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at, value: JSON.parse(row.payload) as T }; }
  catch { throw new RecordError("storage_unavailable"); }
}
function indexValue(value: JsonValue): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return "";
  return Object.values(value).map(indexValue).join(" ");
}
const kind = (table: Table) => table === "cloud_business_profiles" ? "business" : table === "cloud_customers" ? "customer" : "saved_rate";
export function createCloudRecordRepository(db: D1Database, dependencies: { authorizationNamespace: string; now?: () => number }) {
  const kernel = createCloudRecordKernel(db, dependencies);
  async function get<T>(a: CloudRecordAuthority, table: Table, id: string): Promise<VersionedRecord<T>> {
    const rows = await kernel.readOwned<Row>(a, db.prepare(`SELECT ${columns} FROM ${table} WHERE owner_id=? AND id=? AND deleted_at IS NULL`).bind(a.ownerId, id));
    if (!rows[0]) throw new RecordError("not_found");
    return record<T>(rows[0]);
  }
  async function search<T>(a: CloudRecordAuthority, table: Table, input: SearchInput) {
    const { query, afterId, limit } = searchInput(input);
    const rows = await kernel.readOwned<Row>(a, db.prepare(`SELECT ${columns} FROM ${table} WHERE owner_id=? AND deleted_at IS NULL AND id>? AND instr(search_text,?)>0 ORDER BY id LIMIT ?`).bind(a.ownerId, afterId, query, limit + 1));
    const records = rows.slice(0, limit).map(row => record<T>(row));
    return { records, nextAfterId: rows.length > limit ? records.at(-1)!.id : null };
  }
  async function write<T extends Value>(a: CloudRecordAuthority, table: Table, input: WriteInput, normalize: (v: unknown) => T, mode: "create" | "update" | "upsert"): Promise<VersionedRecord<T>> {
    const required = ["operationKey", "expectedRevision", "value", ...(table === "cloud_saved_rates" ? ["id", "explicitUserRequest"] : mode === "update" ? ["id"] : [])];
    const v = object(input, required, table === "cloud_customers" && mode === "create" ? ["id"] : []);
    const expectedRevision = revision(v.expectedRevision, mode !== "update");
    if (mode === "create" && expectedRevision !== 0) return invalid();
    if (table === "cloud_saved_rates" && v.explicitUserRequest !== true) return invalid();
    const id = table === "cloud_business_profiles" ? a.businessId : v.id === undefined ? null : uuid(v.id);
    const value = normalize(v.value);
    const request = json({ id, expectedRevision, value, ...(table === "cloud_saved_rates" ? { explicitUserRequest: true } : {}) });
    const response = await kernel.prepareAndCommit(a, { operationKey: v.operationKey as string, kind: `${kind(table)}.${mode}`, request }, async () => {
      const rows = id ? await kernel.readAuthoring<Row>(a, db.prepare(`SELECT ${columns} FROM ${table} WHERE owner_id=? AND id=?`).bind(a.ownerId, id)) : [];
      const previous = rows[0];
      if ((previous && previous.deleted_at !== null) || (previous?.revision ?? 0) !== expectedRevision) throw new RecordError("revision_conflict");
      if (mode === "update" && !previous) throw new RecordError("not_found");
      return at => {
        const entityId = id ?? crypto.randomUUID();
        const next: VersionedRecord<T> = { id: entityId, revision: expectedRevision + 1, createdAt: previous?.created_at ?? at, updatedAt: at, deletedAt: null, value };
        const payload = encodeRecordJSON(value);
        // Only explicit source table names enter SQL; every value is bound.
        const statement = previous
          ? db.prepare(`UPDATE ${table} SET revision=?,updated_at=?,payload=?,search_text=? WHERE owner_id=? AND id=? AND revision=? AND deleted_at IS NULL`).bind(next.revision, at, payload, searchText(indexValue(json(value))), a.ownerId, entityId, expectedRevision)
          : db.prepare(`INSERT INTO ${table}(owner_id,id,revision,created_at,updated_at,deleted_at,payload,search_text) VALUES (?,?,?,?,?,NULL,?,?)`).bind(a.ownerId, entityId, 1, at, at, payload, searchText(indexValue(json(value))));
        const condition = previous
          ? { sql: `EXISTS(SELECT 1 FROM ${table} WHERE owner_id=? AND id=? AND revision=? AND deleted_at IS NULL)`, values: [a.ownerId, entityId, expectedRevision] }
          : { sql: `NOT EXISTS(SELECT 1 FROM ${table} WHERE owner_id=? AND id=?)`, values: [a.ownerId, entityId] };
        return { condition, statements: [statement], events: [{ kind: kind(table), id: entityId, revision: next.revision, payload: json(next), tombstone: false }], response: json(next) };
      };
    });
    return response as VersionedRecord<T>;
  }
  async function remove(a: CloudRecordAuthority, table: Table, input: DeleteInput) {
    const v = object(input, ["operationKey", "id", "expectedRevision"]);
    const id = uuid(v.id), expectedRevision = revision(v.expectedRevision);
    return kernel.prepareAndCommit(a, { operationKey: v.operationKey as string, kind: `${kind(table)}.delete`, request: { id, expectedRevision } }, async () => {
      const rows = await kernel.readAuthoring<Row>(a, db.prepare(`SELECT ${columns} FROM ${table} WHERE owner_id=? AND id=?`).bind(a.ownerId, id));
      if (!rows[0]) throw new RecordError("not_found");
      if (rows[0].revision !== expectedRevision || rows[0].deleted_at !== null) throw new RecordError("revision_conflict");
      return at => {
        const tombstone = { id, revision: expectedRevision + 1, createdAt: rows[0].created_at, updatedAt: at, deletedAt: at };
        return {
          condition: { sql: `EXISTS(SELECT 1 FROM ${table} WHERE owner_id=? AND id=? AND revision=? AND deleted_at IS NULL)`, values: [a.ownerId, id, expectedRevision] },
          statements: [db.prepare(`UPDATE ${table} SET revision=?,updated_at=?,deleted_at=? WHERE owner_id=? AND id=? AND revision=?`).bind(tombstone.revision, at, at, a.ownerId, id, expectedRevision)],
          events: [{ kind: kind(table), id, revision: tombstone.revision, payload: tombstone, tombstone: true }], response: tombstone,
        };
      };
    });
  }
  return {
    getBusinessContext: (a: CloudRecordAuthority) => get<BusinessProfile>(a, "cloud_business_profiles", a.businessId),
    putBusinessProfile: (a: CloudRecordAuthority, input: WriteInput) => write(a, "cloud_business_profiles", input, businessValue, "upsert"),
    searchCustomers: (a: CloudRecordAuthority, input: SearchInput) => search<Customer>(a, "cloud_customers", input),
    getCustomer: (a: CloudRecordAuthority, id: string) => get<Customer>(a, "cloud_customers", uuid(id)),
    createCustomer: (a: CloudRecordAuthority, input: WriteInput) => write(a, "cloud_customers", input, customerValue, "create"),
    updateCustomer: (a: CloudRecordAuthority, input: WriteInput) => write(a, "cloud_customers", input, customerValue, "update"),
    deleteCustomer: (a: CloudRecordAuthority, input: DeleteInput) => remove(a, "cloud_customers", input),
    searchSavedRates: (a: CloudRecordAuthority, input: SearchInput) => search<SavedRate>(a, "cloud_saved_rates", input),
    getSavedRate: (a: CloudRecordAuthority, id: string) => get<SavedRate>(a, "cloud_saved_rates", uuid(id)),
    putSavedRate: (a: CloudRecordAuthority, input: WriteInput) => write(a, "cloud_saved_rates", input, rateValue, "upsert"),
    deleteSavedRate: (a: CloudRecordAuthority, input: DeleteInput) => remove(a, "cloud_saved_rates", input),
  };
}
