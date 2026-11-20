# Cloud Account Foundation Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development task-by-task, with independent review before each feature-branch push. This implements the already approved Workers/D1 scope; production rollout remains excluded.

**Goal:** Establish atomic, owner-scoped cloud account persistence and connection denial before exposing enrollment or authoring routes.

**Architecture:** A separate D1 migration directory and internal repository isolate cloud ownership from legacy subscription/payment rows. Enrollment commits accept already verified native evidence from a future enrollment service, and enforce challenge, identity, device and purchase-lineage constraints in a single guarded D1 batch. No HTTP endpoint or deployed binding is added by this plan.

**Tech Stack:** Existing TypeScript, Web Crypto, D1 prepared statements/batch and actual workerd/D1 Vitest tests.

**Spec:** `docs/superpowers/specs/2026-11-14-chatgpt-d1-adaptation.md`; qualified managed identity evidence in `docs/chatgpt-managed-oauth-qualification.md`.

## Global Constraints

- Preserve Workers/D1 baseline `34a0c8b` and existing legacy routes/tables. No PostgreSQL/Cloud Run implementation.
- No production deployment, migration, automatic merge or legacy ownership backfill.
- Store no access/refresh tokens, raw StoreKit JWS, email or user-editable ownership claims in the new repository.
- Unique issuer/opaque Apple identity, one business per owner, one purchase lineage per owner; a lineage cannot move between owners.
- Use an unconditional one-row CHECK guard within D1 batch; zero-row conditional writes never establish authorization.
- Public enrollment remains gated by separately reviewed StoreKit device-possession/App Attest implementation. A TypeScript evidence interface is not a security boundary or a public proof verifier.

## Review Focus

1. Concurrent claims of one identity, lineage or device must leave one winner and no orphan owner/business/challenge consumption.
2. Lost enrollment responses must replay exactly; changed verified evidence on the same challenge must conflict without writes.
3. Expired, consumed, wrong-identity or wrong-device challenges must leave every dependent table unchanged.
4. Existing body-supplied appAccountToken/business UUID and legacy subscription rows must never confer cloud ownership.
5. Disconnected connections and revoked devices must deny access even with an unexpired managed JWT; reconnect must not revive earlier-issued tokens.

---

## Task 1 — Atomic enrollment storage

**Files:**
- Create `migrations/chatgpt-d1/0001_cloud_accounts.sql` (outside default production migration directory).
- Create `src/chatgpt/accounts/types.ts`, `src/chatgpt/accounts/d1.ts`.
- Create `test/worker/cloud-accounts.test.ts`.
- Modify `vitest.worker.config.ts` to supply separate `TEST_CLOUD_MIGRATIONS` from `./migrations/chatgpt-d1` alongside existing migrations.

**Interfaces:**
- `CloudIdentity = { issuer: string; appleIdentity: string }` — exact values, never normalize/strip provider prefixes.
- `VerifiedEnrollmentEvidence = { identity: CloudIdentity; deviceKeyId: string; purchase: { appSlug: string; environment: "Sandbox" | "Production"; originalTransactionId: string } }`. Internal persistence input only; future service must cryptographically verify native token, current device entitlement and challenge-bound App Attest before constructing it.
- `EnrollmentReceipt = { ownerId: string; businessId: string; deviceKeyId: string }`.
- `createCloudAccountRepository(db: D1Database)` returns:
  - `issueChallenge(input: { challengeHash: string; identity: CloudIdentity; deviceKeyId: string; now: number; expiresAt: number }): Promise<void>`.
  - `commitEnrollment(input: { challengeHash: string; evidence: VerifiedEnrollmentEvidence; now: number }): Promise<EnrollmentReceipt>`.
  - `findOwner(identity: CloudIdentity): Promise<CloudOwner | null>` with `CloudOwner = { ownerId: string; businessId: string }`.
- `CloudAccountError` exposes fixed codes `invalid_input`, `challenge_invalid`, `enrollment_conflict`, `storage_unavailable`; never SQL text, input values or provider payloads.

**Storage decisions:** `cloud_owners`, `cloud_identities`, `cloud_businesses`, `cloud_devices`, `cloud_purchase_lineages`, `cloud_enrollment_challenges`, `cloud_enrollment_commits`, `cloud_batch_guards`. Device key globally unique and bound to owner; device status constrained active/revoked. Purchase unique `(app_slug, store_environment, original_transaction_id)` and unique owner. Identity unique `(issuer, apple_identity)` and unique owner. Business owner unique. Challenge stores hash only, exact identity/device context, expiry and nullable consumed time; expiry uses safe integer epoch milliseconds. Commit ledger uses challenge hash as unique operation key, canonical SHA256 hash of all verified evidence (exclude generated receipt IDs/time), and exact response snapshot. Foreign keys and NOT NULL/CHECK constraints enforce required relationships.

- [x] Write real D1 RED tests: successful owner/identity/business/device/lineage commit; exact response replay after receiver loss; altered identity/device/lineage conflicts; expired/wrong identity/wrong device/unknown challenge rejects with every table unchanged; concurrent same challenge returns same receipt, concurrent different challenges claiming one identity or lineage/device leaves one winner and no orphan rows; legacy subscription rows confer no cloud owner; successful batches leave zero guard rows. Include arbitrary Unicode/SQL-looking opaque identifiers, exact case distinction, empty/malformed hashes and invalid numeric timestamps. Reject unpaired high/low UTF-16 surrogates before any D1 binding, with no writes, while preserving valid U+FFFD and supplementary-character surrogate pairs.
- [x] Run `npm run test:worker -- test/worker/cloud-accounts.test.ts` and observe behavioral RED before repository implementation.
- [x] Implement schema and repository with server-generated UUID owner/business IDs, fixed-order canonical evidence hash, nonempty well-formed Unicode opaque input strings of at most 1024 UTF-16 code units (no trimming or case normalization), 64 lowercase hex challenge hash and maximum challenge lifetime 5 minutes. Pre-read ledger is optimization only. Batch unconditionally inserts guard using VALUES/CASE, then owner/identity/business/device/lineage, ledger snapshot, challenge consumption and guard deletion. Check exact identity/device and `consumed_at IS NULL AND expires_at > now` in guard. SQL uniqueness chooses concurrent winner. On batch failure re-read ledger for an exact same-evidence replay; otherwise return fixed conflict/challenge/storage errors without logging SQL. No INSERT OR REPLACE, ownership reassignment or silent conflict-ignore chains. Existing owner enrollment does not attach a new device yet: fail closed for later explicitly reviewed device enrollment.
- [x] Run targeted real D1 tests GREEN, existing worker suite, Node suite, lint/typecheck/build appropriate to changed source. Independently review guard/rollback/concurrency behavior, then commit/push feature branch. Do not apply migration outside the ephemeral test database.

## Task 2 — Persisted connection lifecycle

**Historical contract, superseded in part:** the original timestamp-fence instructions below record the foundation implementation. The [later epoch design](../specs/2026-11-15-connection-epochs.md) now requires a verified signed `connectionEpoch` and external namespace, removes the approval-time iat cutoff from admission, and denies every MCP refresh. The legacy timestamp remains only for schema compatibility; safe-integer/nonnegative/not-future iat and normal exp/nbf validation still apply.

**Files:** create `migrations/chatgpt-d1/0002_cloud_connections.sql`, `src/chatgpt/accounts/connections.ts`, `test/worker/cloud-connections.test.ts`. Create `src/chatgpt/accounts/validation.ts` exporting `isOpaqueIdentifier(value: unknown): value is string` and `isNonnegativeSafeInteger(value: unknown): value is number`, and adapt the account repository to share those existing predicates with connections. Preserve the account repository error types/behavior; the shared predicates return booleans and throw nothing.

**Interfaces:** Consume Task 1 `CloudIdentity`, `CloudOwner`, device ownership/status. Produce `createCloudConnectionRepository(db)` with `approve({identity,deviceKeyId,clientId,expectedRevision,now}): Promise<void>`, `revoke({identity,deviceKeyId,clientId,expectedRevision,now}): Promise<void>`, and `authorize({identity,clientId,tokenIssuedAt,now}): Promise<CloudOwner | null>`. Add `getState({identity,clientId}): Promise<CloudConnectionState | null>` with `CloudConnectionState = {revision:number;status:"unapproved"|"active"|"revoked"}`. Identity is `CloudIdentity`; identifiers are strings; expectedRevision is a nonnegative safe integer; now is safe integer epoch milliseconds; tokenIssuedAt is safe integer epoch seconds. Export `CloudConnectionError` with fixed codes `invalid_input`, `device_denied`, `connection_conflict`, `storage_unavailable`; approve/revoke unknown or inactive device throws device_denied. Authorization returns null for malformed input (including opaque identity/client identifiers and invalid/missing/future iat) or unknown/inactive authority, and maps database failure to storage_unavailable without SQL details. Inputs are internal verified-native command context or verified managed-token claims; no HTTP route in this task.

- [x] Write real D1 RED tests: unknown owner/connection denied; only active owned device can approve/revoke; wrong owner/client cannot affect rows; revoke immediately denies a previously valid token; idempotent revoke; reconnect requires the current expected revision, preserves/increases token not-before and rejects pre-disconnect tokens; malformed/missing/future iat denied; invalid/ill-formed Unicode identity/device/client inputs fail closed before D1 binding while valid supplementary characters and literal U+FFFD remain exact; approving-device revocation denies its existing connection; concurrent revoke/authorize never silently reactivates a connection. Verify legacy data cannot approve and unrelated owner's connection remains unchanged.
- [x] Run targeted test RED, then implement one record per `(owner_id, client_id)` with approving device key, positive safe-integer lifecycle revision, active/revoked status and monotonic token-not-before epoch seconds. Guard state-changing commands by exact expectedRevision, treating no row as revision0. Revocation before first approval creates a tombstone; stale approval cannot reactivate it. Already-revoked repeats are no-ops after device validation; future revisions or stale commands targeting an active row conflict. Approval requires subsequent token issuance (`floor(now/1000)+1`) and never lowers a prior not-before value. Authorization also requires the approving device still belongs to this owner and is active; a revoked device cannot leave an active authorized connection. Authorization requires safe integer iat at least not-before and no later than `floor(now/1000)`; no token claims are fabricated. Guard approval/revocation batches against owned active device inside SQL. Revocation does not delete native documents, identities, devices, purchase lineage or business. Provider refresh revocation remains separate.
- [x] Run GREEN, full relevant checks and independent review; commit/push. Keep lifecycle method calls out of deployed probe until real native enrollment and connection approval UX/proof are implemented.

## Next plan boundary

Public authenticated enrollment, attestation counters/challenges, device-bound StoreKit proof, entitlement facts/notifications, device attachment/recovery and native enrollment UI require their own reviewed plan against current Apple SDK/runtime support. No claim that these internal repositories establish purchase ownership or production readiness. Records/money/feed/numbering/sync/MCP authoring remain subsequent approved work.

Primary reference verified November 14, 2026: [D1 batch API](https://developers.cloudflare.com/d1/worker-api/d1-database/). Rollback and races above must be demonstrated in workerd/D1, not inferred from documentation.

## Whole-branch review correction — command ordering

The final review found that timestamp fences did not prevent an older in-flight approval from undoing a disconnect. The lifecycle contract now additionally requires `expectedRevision` on approve/revoke and a durable positive safe-integer revision per connection. No existing row means revision0/unapproved. Revoke-before-first-approval creates a revoked tombstone. Approval must atomically match the current revision and increment it; stale commands return fixed `connection_conflict` without automatic rebasing. Repeated revoke of an already revoked connection is an owned-device-validated no-op, preserving all fields; a stale revoke cannot undo a newer approval. `getState` supplies an owner-scoped internal revision/status snapshot. Public native canonical commands must bind this revision into their fresh challenge/assertion proof. This correction is required before accepting the foundation milestone; it does not add public endpoints or production actions.

The scoped final review confirmed this command-ordering correction, but identified a residual token-time limitation under an older clock or delayed time sampling. The internal iat fence is not proof of a newly authorized OAuth grant. Public cloud authorization stays blocked pending `2026-11-15-connection-epochs.md`: issuer-signed connection revisions compared in the same active/device D1 read. **Superseded protocol decision:** retaining revisions across MCP refresh was rejected by the later [access-only epoch design](../specs/2026-11-15-connection-epochs.md); every MCP refresh is denied and a new authorization-code flow is required. That design also supersedes the historical approval-time iat fence: exact signed epoch/namespace and active owned-device state establish generation authority, while normal JWT time validation remains. No merge, production release or complete public authorization claim is made by this foundation alone.
