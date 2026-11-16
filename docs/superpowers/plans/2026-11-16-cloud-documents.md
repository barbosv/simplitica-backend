# Cloud Documents Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development task by task when workers are available; root inline fallback with independent review otherwise. Continue all integration work without milestone handoff.

**Goal:** Preview and author owned numbered invoice/estimate drafts with exact calculations, revisions, receipts and conversion.

**Architecture:** Strict typed JSON document payload plus indexed owner/revision/type/state columns, one guarded record-kernel batch for each mutation, composed numbering plans. Freeze snapshots on creation and intentional customer change only.

**Tech Stack:** Existing Workers/D1, shared BigInt calculator, real workerd D1 signed-JWT fixtures.

**Spec:** `docs/superpowers/specs/2026-11-16-cloud-documents.md`; existing cloud-records/numbering/calculation specs remain binding.

## Global Constraints

- Internal source only, opt-in migrations/chatgpt-d1; no public routes/tools/prod config/binding/deploy/migrate/ready toggle/native proof substitute.
- Derive owner/business from branded CloudRecordAuthority; every read owner-scoped plus current snapshot guard. Writes/replays fresh-paid current authority, importing denies.
- usd-line-cents-v1/USD decimal strings only; disabled configured tax yields effective0 but preserves snapshot rate. Final/sent/paid immutable, no PDF/send/pay/rate autosave.
- Preserve historical/native local data; this v1 authoring layer is not legacy import or purchase proof. All source text/provenance untrusted; native review fixed true.

## Review Focus

1. A retry after later edits/deletion must return its exact receipt while checking current authority.
2. Concurrent number-generation or source-revision changes must roll all dependent writes back, never silently change expected customer/business.
3. Disabled tax configuration must not accidentally charge the retained nonzero configured rate.
4. Mutable profile/customer records must not rewrite earlier document snapshots.
5. A conversion retry or second operation must not create another invoice from one estimate; original estimate stays unchanged.

## Task 1 — Strict document values, schema and pure preview

**Files:** create `migrations/chatgpt-d1/0005_cloud_documents.sql`, `src/chatgpt/documents/types.ts`, `validation.ts`, `preview.ts`, `test/worker/cloud-document-preview.test.ts`; narrowly extend record fixture cleanup. Check migration tree before selecting0005. Reuse existing field/UUID validators; export small existing scalar helper if needed without numeric behavior change.

**Schema:** cloud_documents PK(owner_id,id), owner_id/id NOT NULL and ownerFK, number NOT NULL/nonempty<=128UTF8, document_type invoice|estimate, state draft|finalized|sent|paid, revision/created/updated/deleted bounded as records, payload validJSON<=1MiB. Add unique superkey `(owner_id,document_id,formatted_number)` on cloud_issued_numbers and same-owner triple FK from document owner/id/number. cloud_estimate_conversions PK(owner_id,estimate_id), invoice_id unique within owner, estimate_revision, created_at, same-owner source/target FKs. No automatic backfill/production run. Document feed kind document. No SQL column per line.

**Input:** `DocumentInput={documentType,issueDate,serviceDate:string|null,dueDate:string|null,title,notes:string|null,paymentTermsSummary:string|null,jobSiteId:string|null,lines,discountAmount}`. All named fields required for deterministic source intent; line `{id?:UUID,title,detail:string|null,quantity:string,unitPrice:string,unit:existingUnit|null,kind:existingKind,reportedProvenance?:{kind:"explicit"|"saved_rate"|"history"|"guidance"|"estimate"|"unspecified",reference:string|null,asOf:number|null}}`. Strict unknown rejection; bounds title256, detail/notes/terms2048, provenance reference2048 (plain inert text, no fetching), positive safe asOf;1..200lines, distinct canonical optional IDs; decimal normalization through actual calculator. Missing provenance defaults unspecified/reference null/asOf null and output always reported:true. No input state/number/calculation/owner/tax/review flags. Date validator pure Gregorian YYYY-MM-DD year0001..9999, due>=issue. Postal jobSiteId must be in frozen customer.savedJobSites or null.

**Output:** `DocumentValue` has documentType/state:"draft"/number:string/null for preview, original businessRevision/businessSnapshot and customerId/customerRevision/customerSnapshot, selected jobSite snapshot/null, input dates/title/notes/terms, normalized lines with id string/null in preview and lineTotal, discountAmount normalized requested, calculationVersion/currency/subtotal/discountApplied/taxRatePercent/taxAmount/total, requiresNativeReview:true, createdBy:"chatgpt", convertedFrom:null|{id,revision}. Snapshots are decoded owned public BusinessProfile/Customer shapes, no owner IDs. Preview line IDs remain null if absent (no random identity/number side effect).

**Interfaces:** `normalizeDocumentInput(input:unknown)` -> canonical strict source input, `buildDocumentPreview(input,business:VersionedRecord<BusinessProfile>,customer:VersionedRecord<Customer>)` -> bounded DocumentValue. `createDocumentPreviewService(db,{authorizationNamespace,now?}).previewDocument(authority,{businessRevision,customerId,customerRevision,input})` uses kernel.readAuthoring with one static joined owned business/customer SELECT in same primary snapshot, verifies expected revisions, then pure builder. Missing/deleted source not_found; stale source revision_conflict; invalid_input fixed; no raw SQL text/errors. Requests canonicalized before future receipt hashing, IDs normalize lowercase.

- [ ] Real-D1 signed-authority RED for golden200*4 less50 tax6 =>800/45/795; disabled stored10% =>tax0 while snapshot retains10; profile/customer isolation and stale revisions/current device/paid/ready denial.
- [ ] RED strict dates/leapday/invalid dates/locale strings, lines/units/kinds/unknown keys/duplicate IDs/malformed Unicode/decimal limits/payload cap/provenance trust flags and selected-site mismatch. Assert all entity/number/receipt/feed state unchanged by repeated previews, including invalid/failed previews.
- [ ] Implement minimal schema/validators/preview, targeted GREEN/full appropriate checks, self-review/independent review/commit. Continue Task2.

## Task 2 — Atomic numbered drafts, edits and conversion

**Files:** create `src/chatgpt/documents/repository.ts`, `test/worker/cloud-documents.test.ts`; use Task1 schema/DTO, existing record kernel and numbering planner. No new transport/native proof or public finalization.

**Interfaces:** `createCloudDocumentRepository(db,{authorizationNamespace,now?})` exposes getDocument(a,id), createDocument(a,{operationKey,businessRevision,customerId,customerRevision,input}), updateDocument(a,{operationKey,id,expectedRevision,patch}), convertEstimateToInvoice(a,{operationKey,id,expectedRevision,issueDate,dueDate:string|null}). Get returns VersionedRecord<DocumentValue>; missing/deleted not_found. Input create normalizes before receipt; server document/absent line UUIDs generated only after eligible receipt lookup, then source reads/number planning. Commit number+entity+receipt+full document feed in same kernel batch, source revision predicates in final guard. Retry only number-choice/revision_conflict at most3 with unchanged canonical expected revisions (fail immediately when actual user source revision differs). Aggregate caller+number binds remain<=100 and kernel predicate<=86; no per-line SQL.

**Updates:** strict nonempty patch limited to title/issueDate/serviceDate/dueDate/notes/paymentTermsSummary/lines/discountAmount/jobSiteId/customerSelection:{id,expectedRevision}. Preserve number/type/business snapshot/calculation version/state/native-review flag. Missing fields retain previous values, null clears only nullable fields. Explicit customerSelection replaces snapshot under guarded expected revision; otherwise frozen customer stays. Changing customer resets jobSite unless explicitly selected in new snapshot; no other-customer address retained. Recalculate using frozen business snapshot/effective enabled flag and actual v1 calculator. Guard current document draft/revision; no model finalization or financial edits to final/sent/paid. Exact operation retries return historical response even after later edits. Later verified native import is separate capability.

**Conversion:** load owned estimate in any nondeleted lifecycle state, expected revision, only v1 calculator body supported. Clone frozen source lines/snapshots/calculation to a new draft invoice, new document ID/number and issue/due dates, convertedFrom source id/revision, keep original row unchanged. Final guard same expected estimate/type plus NOT EXISTS conversion link. Insert link+new invoice+number+receipt/feed atomically. Same operation replays original; different operation for already converted estimate revision_conflict, no second invoice. No source snapshot mutation. Historical legacy conversion remains mandatory later verified-import extension, not silent recalc here.

- [ ] Real-D1 RED CRUD snapshots/stale revisions/current authority/read-after-lapse; exact retries after edits; equal/unequal operation races and source revision changes after async planning. Golden calculation parity and no accidental disabled tax.
- [ ] RED actual concurrent numbered creates, failing later statement full rollback (counter/issued/entity/link/receipt/feed/head/guards), number conflict bounded3 and unchanged user source intent. Verify both own and other owners.
- [ ] RED draft-only edits, explicit customer change/site reset, estimate conversion from draft/finalized/sent fixtures, exact source preservation and single link under equal/unequal concurrent retries; reject legacy unsupported marker explicitly. Fixtures do not prove native finalization.
- [ ] Targeted GREEN, full appropriate Worker/Node/lint/type/build/drybuild, self-review/task review and broad documents/numbering integration review once; commit/push feature. Continue restricted MCP tools/provenance pricing/native proof+durable sync immediately, no approval milestone.
