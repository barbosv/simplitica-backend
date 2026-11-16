# Task 1 — authority, entitlement, atomic journal and feed kernel

## Outcome and scope

Implemented Task 1 only. Added opt-in migration 0003, private immutable cloud-record authority wrapping the existing JOSE/D1 authorizer, internal verified initialization/entitlement fact operations, unconditional checked D1 mutation kernel, exact receipts, bounded feed and owner-scoped retention. Added signed-RS256/real-D1 fixtures and 38 behavioral tests. Existing main-worker routes, authorization, migrations, bindings, dependencies and deployment are unchanged. No public ready flag, entitlement writer, native bypass or generic wire SQL executor was introduced.

## TDD evidence

- First attempted targeted command reported missing modules (not accepted as behavioral RED).
- Added thin importable interfaces/scaffolds and migration; targeted run failed behaviorally at unimplemented verified initialization (10 failed; kernel suite initially also had a test-title BigInt formatting error, corrected before relying on it).
- After initialization/fact implementation and correcting the test title, `npm run test:worker -- test/worker/cloud-record-kernel.test.ts test/worker/cloud-entitlements.test.ts` produced **28 failed / 2 passed**, with real owner/device/connection setup and actual signed JWT admissions. Kernel failures included `not_authorized` instead of successful commit/feed results or expected invalid-input/revision/rollback classifications. Log: `/tmp/cloud-record-red-kernel.log`.
- Implemented kernel: same targeted command **30 passed**. Added transaction-boundary race and exact 1MiB/page/pruning coverage: **38 passed**. Logs: `/tmp/cloud-record-green.log`, `/tmp/cloud-record-red-config.log` (the latter contains a GREEN 38-test run; filename denotes the added-check stage, not its outcome).

## Verification executed

| Command | Result |
| --- | --- |
| `npm run test:worker -- test/worker/cloud-record-kernel.test.ts test/worker/cloud-entitlements.test.ts` | 38 passed, 2 files |
| `npm run test:worker` | 852 passed, 23 files |
| `npm test` | 167 passed, 20 files |
| `npm run lint` | exit 0 |
| `npm run typecheck:worker` | exit 0 |
| `npm run build` | exit 0 |
| `npm run build:worker` | exit 0; Wrangler dry-run only |
| `git diff --check` | exit 0 |

Full logs: `/tmp/cloud-record-worker-full.log`, `/tmp/cloud-record-node-full.log`, `/tmp/cloud-record-lint.log`, `/tmp/cloud-record-build.log`, `/tmp/cloud-record-worker-build.log`.

Existing warnings: Vite JSON import lacking import attributes in `vitest.worker.config.ts`; installed Stripe package missing sourcemap sources; Wrangler update notice; vendored jsrsasign suspicious boolean-not/instanceof and NaN comparison warnings. No test failures or new-source lint/type failures were suppressed.

## Task 2 consumption contract

- `authority.ts`: `createCloudRecordAuthorizer(db,{authorizationNamespace,keys?,now?})(token)` delegates signature/claim/connection checks to the existing authorizer and freezes the resulting `CloudRecordAuthority`. A module-private WeakSet supplies the unforgeable runtime brand. Spreading/JSON/casting cannot mint authority. Owner/business/connectionEpoch/namespace are read-only scalars. No caller-selected client; the kernel uses existing `CLOUD_CLIENT_ID`.
- `kernel.ts`: `createCloudRecordKernel(db,{authorizationNamespace,now?})` exposes `authorizeRead`, `authorizeAuthoring`, `commit`, `readFeed`. Both authorization methods return `{syncEpoch:string,head:number,floor:number}`. Read permits paid lapse; all mutations and receipt replays require fresh authoring authority.
- `types.ts`: `JsonValue` permits JSON primitives/arrays/plain objects; runtime encoding rejects unsupported values, cycles, malformed Unicode, non-safe-integer numbers, excessive depth/nodes and payloads over 1MiB. Normalize decimal money/quantity through existing calculator before calling the kernel. Canonical request hashing sorts object keys and hashes `[kind,normalizedRequest]`, excluding transient epoch/IDs/timestamps.
- `MutationCommand={operationKey,kind,request}`. Operation key ASCII `[A-Za-z0-9:_-]{1,128}`; source-fixed kind label `[A-Za-z][A-Za-z0-9_.:-]{0,63}`. Include expected revision, canonical stable caller ID where supplied, normalized value and explicit saved-rate intent in the request. Generate server IDs **inside `build`**, after hashing/receipt lookup, so historical replay does not generate a new ID.
- `MutationPlan={condition:{sql:string,values:(string|number|null)[]},statements:D1PreparedStatement[],events:FeedEvent[],response:JsonValue}`. This is source-only, never decoded from a wire payload. Repositories must use static owner-scoped SQL and parameterized values. Additional condition is evaluated inside the same transaction as all writes. Max condition binds 86 (kernel itself adds 12), max condition SQL 10KB, max entity statements 20, feed events 1–10. Each prepared statement must separately respect D1's 100-parameter/statement limit.
- `build(at)` is synchronous, following asynchronous entity planning. It receives a freshly sampled trusted time immediately before compiling/submitting the batch. No external I/O occurs in the kernel between that sample and `db.batch`. Return exact public record snapshot as `response`; it is canonical JSON-persisted and returned on equal retries even after later entity revisions. Kernel returns `Promise<JsonValue>`.
- Feed event: `{kind:string,id:string,revision:number,payload:JsonValue,tombstone:boolean}`. Kind uses the source label bound; id <=128 UTF8 bytes; revision positive safe integer; payload <=1MiB. Kernel supplies owner and committed timestamp. Task 2 should use `business`, `customer`, `saved_rate` consistently (the kernel intentionally allows future source labels). Delete payload should contain only the public tombstone metadata required by the specification.
- Feed page: `{changes:({sequence,kind,id,revision,payload,tombstone,committedAt})[],nextCursor:{epoch,after},head,hasMore}`. Cursor advances through returned changes only. A single primary SQL snapshot includes state, metadata/window byte selection and final payload projection. Materialized metadata budget includes 2048 bytes/event and caps the page at 1,500,000 bytes; exactly 1MiB payload fits. No parameterized IN list. Invalid future cursors/limits yield `invalid_input`; epoch/floor mismatch yields `resync_required`.
- `RecordError` exposes only a fixed code/message. SQL/provider text, bodies and credentials are never logged or propagated. Source builder failures sanitize to `storage_unavailable`; unsupported plan/input values to `invalid_input`. Post-rollback read may conservatively report authority/revision/storage conditions; only an actual matching committed receipt can establish replay success.

## Schema contract

All names are in `migrations/chatgpt-d1/0003_cloud_records.sql` (opt-in only):

- `cloud_record_state`: PK `owner_id`; `business_id` same-owner composite FK; `phase` importing/ready; `sync_epoch`; `head_sequence`, `floor_sequence`. Init creates random epoch/head0/floor0, preserves existing state on retry. No public ready method. Task 2 assumes verified ready initialization; tests may explicitly set phase ready as future verified import-completion fixtures.
- `cloud_entitlements`: PK `owner_id`; `app_slug`, `store_environment`, `original_transaction_id` same-owner composite FK to existing lineage via the one added unique superkey index; `state`, `expires_at`, `grace_expires_at`, `signed_at`, `checked_at`. No legacy billing promotion.
- `cloud_mutation_receipts`: PK `(owner_id,operation_key)`; `kind`, `request_hash`, `response_snapshot`, `committed_at`.
- `cloud_record_feed`: `sequence INTEGER PRIMARY KEY AUTOINCREMENT`; `owner_id`, `kind`, `id`, `revision`, `payload`, `payload_bytes`, `tombstone`, `committed_at`; index `(owner_id,sequence)`. SQL checks exact UTF8 payload length against persisted `payload_bytes`. Never reset `sqlite_sequence`.
- `cloud_business_profiles`: PK `owner_id`; `id` is existing `business_id` with same-owner composite FK, so exactly one per existing owner/business.
- `cloud_customers`, `cloud_saved_rates`: PK `(owner_id,id)`; stable canonical UUID validation belongs to Task 2.
- Every entity table shares `revision` (positive safe integer), `created_at`, `updated_at`, nullable `deleted_at`, JSON-valid `payload` (<=1MiB), `search_text` (<=1MiB). JSON payload contains only the typed public **value**; the row columns are the revision/timestamp envelope. Owner IDs are never included in model-visible output. Use `instr(search_text,?)` for normalized literal searches and `id > ? ORDER BY id LIMIT ?` for stable pagination. Keep actual combined row size below D1's 2MB limit; Task 2's prescribed field bounds are far below it.
- SQL bounds enforce safe nonnegative times/head/floor, positive revisions/feed sequence, floor<=head, updated/deleted timestamps>=created_at and valid JSON. JSON scalar semantic validation remains in typed repository/calculator code.

## Internal verified service inputs

`initializeVerifiedOwnerRecords(db,owner,deviceKeyId)` guards existing owner/business/active owned device. It grants no subscription or ready status. `applyVerifiedEntitlement(db,owner,fact,now)` validates same-owner lineage and bounded timestamps, rejects future checkedAt, ignores older signed/check times, rejects equal-signed inconsistent state/expiry, permits identical checkedAt refresh. Active/trial require expiry>now; grace requires grace expiry>now; checkedAt must be <=now and >=now-300000. Billing retry/lapsed/revoked/unknown deny.

`pruneOwnerFeed(db,ownerId,expectedEpoch,through)` is internal only; atomically raises floor and deletes eligible owner rows, preserves other owners/head/AUTOINCREMENT, rejects wrong epochs/future pruning. No automatic job or public tool.

## Self-review and remaining gates

Reviewed brand/copy rejection, namespace isolation, current device/connection epoch, importing state, entitlement freshness/expiry and same-owner FK; unconditional checked guard, zero-row distinction, stale revision predicates, exact historical replays, concurrent equal/unequal operation keys, full entity/receipt/feed/head/guard rollback; metadata-before-payload pagination, max event, tombstones, empty/future/epoch/floor cursors, other-owner pruning and retained sequence allocation. Tests use real D1 and actual locally signed issuer test keys; one narrow Proxy injects a real D1 state mutation immediately before forwarding the real batch to exercise transaction-boundary revocation races.

These fixture entitlement facts are **not purchase proof**. External gates remain live access-only ChatGPT/provider qualification, verified Apple/StoreKit service, paired device and complete native proof/atomic import/sync integration. No deployment/migration/push was performed. Task 2 and document/native/domain routes remain out of this implementation scope. Root performs the independent review.
