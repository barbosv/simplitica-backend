# Approved ChatGPT integration — Workers/D1 adaptation

This is a new adaptation of the approved historical product scope, not a recovered copy of the missing earlier plan. The baseline remains `34a0c8b`; do not import the former PostgreSQL migrations or Cloud Run runtime. Provider qualification remains a hard execution gate for dependent owner/enrollment/persistence code. Planning can proceed while owner-assisted live tests are pending.

## Runtime and isolation

Extend the existing Hono Worker and D1 repository patterns after qualification. Use a dedicated development Worker configuration and separate D1 database for integration testing. The existing stateless probe remains isolated and synthetic. Do not bind integration development code to the production D1 database. No automatic production deploy/migrate/merge.

Existing billing/Stripe tables are legacy data, not authenticated cloud owners. No caller-supplied business UUID, appAccountToken, email or Apple relay address can claim them. New cloud ownership derives only from qualified signed identity plus the reviewed attested native enrollment/purchase proof. Keep existing routes working until a separately reviewed cutover; do not grant their unauthenticated token lookup the authority to authorize cloud tools.

## D1 atomicity contract

Use parameterized prepared SQL and `D1Database.batch`. Do not add PoolClient, PostgreSQL types, row locks, sequences or explicit BEGIN/COMMIT. D1 batches roll back on statement failure; a conditional update affecting zero rows is **not** a failed statement.

For operations with dependent writes, use an assertion row inside the same batch: `cloud_batch_guards(operation_id PRIMARY KEY, permitted INTEGER NOT NULL CHECK(permitted = 1))`. Insert exactly one assertion row unconditionally with VALUES and a CASE/COALESCE expression over ownership, expected revision, lifecycle and required-row predicates. Never use INSERT SELECT that can silently produce zero assertion rows. A false/missing precondition must cause a constraint failure. All entity, numbering, idempotency and feed statements follow that assertion, and the final statement deletes the guard. The entire batch either commits or rolls back, including the temporary guard. Re-read sanitized state on failure to distinguish replay, conflict and revoked capability; never expose SQL errors. Prove behavior with the actual D1 binding under workerd before adopting this algorithm.

Idempotency is scoped to authenticated owner plus caller operation key, with a canonical normalized request hash and exact response snapshot. Enforce a unique key in SQL. Concurrent equal requests must replay the same committed response; unequal payloads return conflict. Pre-reading a ledger is only an optimization: the unique constraint and atomic batch determine the winner. An idempotency collision must roll back number allocation, entity writes and feed rows.

Feed sequence values are allocated in the same SQLite write transaction as the mutation, using INTEGER PRIMARY KEY AUTOINCREMENT (or an equivalently proved persistent transactional counter), never a reusable implicit ROWID. Do not port PostgreSQL nontransactional sequence reasoning. Test concurrent writers and rollback against D1 to establish commit-visible ordering. Paginated feeds return tombstones and stable cursors; no cursor advancement for incomplete local application. Pruning requires an explicit retention floor and sync epoch: an older/reset cursor forces a resumable full resync, never silently jumps past missing changes. Never reset the sequence counter or reuse committed cursor values. Start with primary reads for authorization and feeds. If replicas are later used, implement and persist D1 session bookmarks separately from domain cursors; session consistency never replaces a transactional batch.

## Accounts, subscriptions and lifecycle

- Separate cloud owner, owner identity, one business, native devices, purchase lineage, entitlement facts, enrollment challenges and connection lifecycle records.
- Unique verified `(issuer, opaque_apple_identity)` ownership and unique `(app_slug, store_environment, original_transaction_id)` purchase lineage. One business and one eligible subscription relationship per owner. Ownership transfer/recovery is explicit, never a silent last-write-wins reassignment.
- Native enrollment binds fresh expiring server challenge, verified native token, current-app attestation and verified StoreKit transaction/renewal facts. App Attest proves the current app request, not historical ownership by itself. Verify the current entitlement through the reviewed Apple proof path and reject replay/another owner's lineage; historical appAccountToken values and business UUIDs remain independent identifiers.
- Use signed transaction/renewal fields with app/bundle/environment/product checks; preserve grace expiry, refund/revocation, signed-date ordering and notification deduplication. Verify current state when cached facts become stale. A body-supplied appAccountToken cannot override the verified signed field.
- Capabilities: verified active/trial/grace permits ChatGPT authoring and paid pricing; expired/revoked/unknown billing retry without verified grace denies those capabilities. Prior records and native synchronization remain readable as approved. Denial is enforced again in the mutation batch, not only before it.
- Local lifecycle state provides prompt denial of disconnected/revoked cloud connections despite an otherwise valid unexpired JWT. Managed refresh revocation is a separate provider operation. A disconnect must not erase native documents or purchase history.

## Shared records, money and numbers

Store owned business profile, customer, explicit reusable rate, document header/lines/snapshots, mutation ledger, feed, import checkpoint, device state and number reservations. Every data access includes the derived owner scope. Revisions apply to all mutable records. Finalized/sent/paid documents are immutable to ChatGPT; preserve their historic amounts, number and customer snapshots.

New money inputs and wire values are decimal strings. Use a versioned deterministic decimal calculator, never authoritative SQLite REAL/JavaScript floating-point arithmetic: round line extensions to cents, sum, subtract capped discount, compute/round configured tax, then total. Golden fixture: 200 × $4 minus $50, tax6% => subtotal800.00, tax45.00, total795.00. Native and server share literal golden fixtures and rounding edge cases.

Number allocation is an owned series counter updated atomically with an immutable reservation ledger. Native connected devices reserve blocks of20. A unique issued-number constraint prevents duplicate issuance, but does not protect a reserved-yet-unissued value by itself. Every server allocation and historical import must also exclude all occupied reservation ranges. Native issuance must prove its authenticated device owns the containing reservation; then the unique issued-number constraint prevents reuse across documents/retries. Never reclaim unused ranges from a disconnected device. Seed counters above preserved historical values before creating reservations, and surface an import/reservation collision explicitly rather than renumbering or stealing the reservation. Never reuse issued values; gaps are allowed. Exhausted offline devices retain unnumbered work but cannot produce a numbered PDF/send until reconnection. Historic numbers must be imported and preserved with explicit collision handling, never renumbered silently.

## Native synchronization

Owner connection/enrollment starts in iPhone settings, with secure SDK credentials and current StoreKit backfill. Production `AppDependencies` currently uses `NoopSubscriptionBackend`; configuration URLs alone do not activate this integration. Wire a real connected service only after enrollment and entitlement checks, keeping disconnected existing app behavior available.

Persist entities, local revisions, outbox, applied server cursor/bookmark and consumed number reservations atomically in the native state store. Recover safely after a crash at every write boundary. Dirty local edits survive downloads; concurrent revisions become visible conflicts rather than silent overwrites. Imports resume with stable IDs/checkpoints and retain finalized amounts/customer snapshots. Include both app_state.json and the separate historical UserDefaults number sequence in the migration/backup compatibility plan. Keep recordings, transcripts and local assets local by default.

Document links authenticate owner access, open the correct native record and never imply sending. Native final review/finalization/PDF/Mail/Messages remain the delivery path. No server PDF/email/SMS, attachment uploads, online checkout or payment tools.

## MCP and pricing boundary

Approved tools: `get_business_context`, `search_customers`, `get_customer`, `create_customer`, `search_saved_rates`, `get_pricing_guidance`, `preview_document`, `create_document`, `get_document`, `update_document`, `convert_estimate_to_invoice`, `open_in_app`.

No generic SQL/executor/send/payment tool. Derive owner from verified token and lifecycle records, never model parameters. Previews have no durable side effects. Creates require idempotency keys; updates/conversion require expected revisions and preserve source snapshots. Distinguish estimates from invoices and draft links from finalization/sending. Retrieved descriptions/customer notes are untrusted data.

Price preference is explicit saved rates, relevant accepted history, sourced/unit-compatible guidance, then labeled estimates or clarification. Preserve source/time/unit/provenance and differentiate whole-job vs unit prices. Save reusable rates only on explicit instruction. Use owner tax settings, USD and US units; do not promise nationwide tax calculation.

## Execution sequence and evidence

1. Finish managed issuer qualification: real native/hosted exact identity continuity; rotation/reuse/family rejection; provider revocation and local unexpired-JWT limitation. Capture sanitized evidence only.
2. Write focused accounts/enrollment/lifecycle task brief against the actual D1 schema, then meaningful RED/GREEN workerd/D1 tests, implement and independently review before pushing.
3. Add records/decimal authoring, idempotency/revisions/feed and numbering in separate reviewed tasks. Each must include actual D1 concurrency/rollback tests. Select new D1 migration numbers from the current tree at execution time (currently only0001 exists); historical PostgreSQL004–010 are not applicable.
4. Implement native durable sync/conflicts/numbering and backup compatibility against the same protocol; actual executed Xcode tests and native integration evidence required. The current main-app MLKit simulator baseline has an inherited architecture blocker; the separate native auth qualifier does not establish full-app tests.
5. Expose the constrained MCP toolset, provenance pricing and exact metadata, test owner isolation/entitlement revocation from ChatGPT, and validate create/edit/open with app closed and native review/send flows.
6. Produce staged release/rollback evidence and reviewable migrations. Reconfirm live payment-link adoption before any eventual legacy-data migration. Production action requires a separate owner decision.

References checked November14,2026: [D1 batch API](https://developers.cloudflare.com/d1/worker-api/d1-database/), [D1 sessions and replication](https://developers.cloudflare.com/d1/best-practices/read-replication/). The guard-row algorithm above is an implementation proposal to be proved in real D1 tests, not a guarantee inferred from the documentation.
