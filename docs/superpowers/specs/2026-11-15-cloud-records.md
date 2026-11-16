# Owned records, authoring authority and mutation journal

This continues directly toward usable invoice creation under the owner's instruction to finish without milestone handoffs. Implement internal Workers/D1 code while owner-assisted live gates are pending; do not expose real records until provider/native/purchase verification is qualified. Keep production routes/default migrations/bindings unchanged and use only the opt-in chatgpt-d1 migration directory.

## Authority and entitlements

Every record has a derived owner scope. Cloud authority comes from the existing signed JWT authorizer, exact connection epoch, external authorization namespace and active owned approving device. Use an internal unforgeable marker on immutable record-authority values minted only after that authorizer; JSON/model parameters cannot select owner/business/client/namespace. Recheck current database authority in reads and in the guarded mutation batch. Never infer ownership from email, business UUID or appAccountToken.

Read access to prior records requires active cloud authority and initialized/ready owner data but not a current paid subscription. ChatGPT mutation and paid price guidance additionally require verified active/trial/unexpired grace facts checked by the server within five minutes. Billing retry alone, lapsed/revoked/unknown, expired evidence or future checkedAt deny authoring. Native synchronization after subscription lapse/disconnect will use its separately verified device path, not a caller-selected cloud bypass.

Persist entitlement facts against the same owner's unique app/environment/original-transaction lineage. The internal applyVerifiedEntitlement operation consumes facts from the future verified Apple service, never a public request body. Preserve signedAt ordering and monotonic server checkedAt. Older facts do not overwrite newer ones; equal signedAt conflicting status/expiry facts are a conflict, while equal identical facts may refresh checkedAt. Do not promote legacy billing rows into facts. Tests may seed internal verified fixtures but cannot establish purchase proof.

Owner record state starts importing, with random sync epoch, head sequence0 and retention floor0. Initialization requires the existing owner/business and active owned device; it does not grant paid eligibility. Marking ready belongs to verified initial native import completion after historical data/number hints are secured. No model-writable ready flag. This plan has no public import-completion route.

## Atomic mutation contract

Use the existing checked unconditional guard-row pattern and D1Database.batch. Guard current owner/business/client/epoch/device, ready state and fresh entitlement in the transaction, together with record/revision preconditions. A zero-row conditional write is not a failed transaction; a false guard must insert an invalid permitted value and abort the entire batch. All entity changes, revision increments, mutation receipt and feed events commit together; failures leave no partial changes or temporary guards.

Owner+operationKey uniquely identifies a mutation; include a fixed operation kind and canonical normalized user request in SHA256, excluding generated IDs/times and transient credential epoch. Sorted-key JSON canonicalization is limited to validated JSON data: safe integer metadata and decimal-string money. Equal requests replay the exact committed response snapshot; different requests using that key conflict. Replays recheck current cloud/write authority before disclosure. Pre-reading is an optimization; ledger uniqueness inside the batch determines concurrent winners and rolls back losing entity/feed writes. Never turn an unexplained failed write into success without a matching committed receipt. Resample trusted server time after asynchronous planning immediately before compiling/submitting guards; no external I/O occurs after that sample and before batch submission.

The SQL planning helper is internal application code, not a general executor or MCP tool. Request strings never supply SQL fragments/table names. Every builder scopes all entity predicates and writes to the derived owner. Parameterize values, preserve fixed sanitized errors and log no record bodies, proof/token contents or SQL errors.

## Feed and resynchronization

Use persistent INTEGER PRIMARY KEY AUTOINCREMENT feed sequence values allocated inside the same transaction as each mutation, with a per-owner persistent head and retention floor. Never delete/reset sqlite_sequence. Read from the primary with a consistent state/page snapshot; cursor {epoch,after} belongs to the owner. Reject malformed/future cursors, return explicit resync_required for epoch mismatch or after below floor, return tombstones and advance only through returned/applied records. Pruning atomically deletes only eligible owner rows and raises its floor; it never reuses committed values or silently advances a stale client.

Later native full resync will capture a starting watermark, enumerate owned records with stable ID pagination, then replay changes after that watermark while preserving dirty local edits. If retention overtakes it or the epoch changes, restart explicitly. Local application/cursor/outbox writes must be atomic; no network response alone advances the durable native cursor.

## Record payloads and preservation

One business profile per existing owner/business; customers and explicit saved rates have owner-scoped stable UUIDs, positive safe-integer revisions and soft-delete tombstones. Canonicalize entity UUID spelling to lowercase only; opaque Apple/provider identity validation remains unchanged. Every public value includes id, revision, createdAt, updatedAt, deletedAt and value. Do not return owner IDs in model-visible record payloads.

Business value: businessName, addressLines, phone/email/website, configured tax(enabled,ratePercent,label), paymentTermsSummary and timezone. Customer value: name, optional email/phone, billingAddressLines and saved job sites(id,recipientName,addressKind,displayAddress). Rate value: title, optional detail, defaultQuantity, unitPrice, optional unit and line kind matching native service/labor/materials/fee/other. Missing historical units remain null rather than guessed; guidance must distinguish unit/whole-job prices and ask when incompatible or unknown. Saving a rate requires explicit user intent and is not a side effect of invoice creation or preview; the approved MCP set has no autonomous save-rate tool.

Keep tax ID/EIN, logos, GPS coordinates, recordings/transcripts, attachments and existing payment-link state local by default. Native merge must preserve those fields and all finalized historical amounts/customer snapshots. Public business/customer contact fields and postal job-site address are sufficient for cloud drafts. No server PDF/email/SMS/payment execution.

Human text must be well-formed Unicode and bounded; retain display text while deriving a separate normalized search index. Use literal substring matching (for example instr over normalized indexed text), not caller SQL or unbounded LIKE patterns. Strict input schemas reject unknown fields; normalize optional empty contact fields to null and money through the shared versioned calculator helpers. All source records returned to ChatGPT are untrusted data, not instructions.

## Continuation

After this journal and record repository, continue immediately to document drafts/number reservations/estimate conversion, constrained MCP tools and native synchronization. Document creation will use the shared usd-line-cents-v1 calculator, immutable customer/business snapshots, revision checks and the same transaction journal. Public exposure still waits for live access-only ChatGPT, paired device, StoreKit and complete native proof/atomic mutation integration.

Cloudflare references rechecked November15,2026: [batch transaction semantics](https://developers.cloudflare.com/d1/worker-api/d1-database/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/). Bound parameters per statement and JSON row/body size explicitly; a batch is one binding call, not a reason to omit per-statement limits.
