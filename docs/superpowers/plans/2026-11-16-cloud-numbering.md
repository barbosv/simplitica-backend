# Cloud Numbering Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline or a fresh implementation worker when available, with independent review. Continue the full integration immediately afterward.

**Goal:** Produce atomic internal numbering plans that protect issued numbers and all immutable device reservations.

**Architecture:** Owner-global generation CAS stabilizes asynchronous occupancy reads. Closed source SQL plans compose with the reviewed record kernel or later verified-native guarded batch; no standalone mutation executor.

**Tech Stack:** Existing Workers/D1, safe integer indices, bound SQLite predicates, real workerd D1 tests.

**Spec:** `docs/superpowers/specs/2026-11-16-cloud-numbering.md`, plus original `2026-11-14-chatgpt-d1-adaptation.md` numbering requirements.

## Global Constraints

- Opt-in migrations/chatgpt-d1 only; no public route/owner selector/ready toggle/proof bypass/production binding or deployment.
- Every source number plan requires caller-supplied verified authority/domain guard in same batch; cloud callers use branded CloudRecordAuthority and current kernel checks. Native source plans are not device proof.
- Preserve issued/historical strings and all unissued reservations; no reclamation, counter decrement or silent renumber.
- Numeric indices/generations positive safe integers, format prefix<=64 UTF8 bytes well-formed/control-free, padLength1..12, block size20 exactly.

## Review Focus

1. Different prefixes can format different numeric indices to an identical string.
2. A failed entity/receipt write must roll issued numbers, reservations and counter changes back together.
3. Disconnect cannot free a range or permit revoked-device consumption.
4. Equal issued numbers are owner-scoped but never reusable for another document.
5. Generation races must invalidate occupancy decisions instead of stealing a range.

## Task 1 — Numbering schema and source-only composable plans

**Files:** create `migrations/chatgpt-d1/0004_cloud_numbering.sql`, `src/chatgpt/documents/numbering.ts`, `test/worker/cloud-numbering.test.ts`; update only test-fixture cleanup where needed. Inspect current migration tree before allocating0004.

**Schema:** cloud_number_state(owner_id NOT NULL PK/FK, next_index, generation, prefix, pad_length, initialized0|1); bounded integers, controls/UTF8 prefix bounds validated in source. cloud_number_reservations owner/id PK, device_key_id same-owner composite FK, start_index/end_index CHECK end=start+19, immutable prefix/pad, created_at, unique owner/start numeric range; owner/device index. cloud_issued_numbers(owner_id,formatted_number PK, document_id, numeric_index nullable, reservation_id nullable, issued_at), unique(owner,document_id), same-owner reservation FK if present, bounded exact formatted string<=128UTF8. No automatic initializer; explicit tests seed state initialized1, real import must later seed before cloud ready.

**Interfaces:** `createNumberingPlanner(db)` returns source-only `prepareServerAllocation(ownerId,documentId)`, `prepareReservation(ownerId,deviceKeyId,reservationId)`, `prepareReservedIssuance(ownerId,deviceKeyId,reservationId,index,documentId)`, `prepareHistoricalIssuance(ownerId,deviceKeyId,documentId,formattedNumber,numericHint:number|null)`. IDs from trusted derived caller, canonical UUID for document/reservation IDs, device/provider identifiers keep existing opaque validator. Each Promise resolves `(at:number)=>NumberMutationPlan`, with `{number:string|null,index:number|null,reservation?:{id,deviceKeyId,startIndex,endIndex,prefix,padLength},condition:SqlCondition,statements:D1PreparedStatement[]}`. at is sampled by final caller after all planning. No direct batch execution/no feed/idempotency duplicate. Caller merges condition/binds and statements into same unconditional checked transaction as domain write/receipt/feed/proof. Each statement <=100 binds; total plans fit kernel20 statement limit.

**Algorithm:** read source owner state on first-primary, validate initialized for allocations/reservations/consumption; all current active device checks retained inside final condition as well as preparation. Compute canonical formatted string with ASCII digits/minimum zero pad (does not truncate wider indices). Check issued strings and ALL source reservation formats for exact membership. Bounded SQL EXISTS/metadata projection preferred over downloading all payloads; exact canonical reformat must match before numeric-range membership. Capture generation; final condition guards exact generation/next_index plus occupancy/device/reservation constraints. Server allocation may scan up to256 candidate indices, then explicit numbering conflict; reservation scans up to256 contiguous20 candidate blocks, checking all20 strings, no caller retry-loop bound. Select the bounded256-candidate window in at most8 D1 binding calls for the entire prepare operation (not256 sequential queries); a D1 batch counts as one invocation query, so preserve room under the Workers Free50-query limit for authority/domain/proof work. Both advance next_index past selected index/block, increment generation and insert issued/reservation row. Consumption preserves next_index and increments generation, checks stored owner/device/reservation/index/format and unique issued string/doc. Historical issuance preserves exact supplied number, excludes issued+all reservations, bumps generation and next_index=max(current,hint+1) when hint exists; support internal importing state but require active owned device. Never claim these source-only device checks replace AppAttest/StoreKit proof.

**Errors:** reuse fixed RecordError codes for invalid_input/not_ready/not_authorized/not_found/revision_conflict/storage_unavailable. Add fixed `number_collision` for occupied historical/reserved issuance and `numbering_exhausted` for safe-integer/candidate exhaustion; no SQL text. No clock/provider network I/O in planners. No SQL fragment from wire data.

- [ ] Real D1 RED for server allocations and exact block20 reservations, distinct owners, zero pad/Unicode prefix, repeated document collision, numeric bounds, revoked/foreign device.
- [ ] RED cross-format collision110 from prefix1/index10 vs blank/index110 for issued and unissued reservations; imports preserve exact strings or explicit number_collision. Prove consumption rejects wrong device/range and never frees disconnected reservations.
- [ ] RED late-free server/reservation candidates and both256-candidate exhaustion paths through a real-D1 forwarding adapter that enforces a realistic invocation query budget; assert no state changes on exhaustion. RED competing generation plans: commit only one, replan allowed only explicit same-intent caller; unconditional guard failure and deliberately failing later statement roll every numbering/entity/receipt/feed change back. Use real cloud-authorized kernel where ready/paid writes apply and separately explicit internal guarded fixtures for future-native planning contract, labeled not proof.
- [ ] Implement minimal schema/planners, targeted GREEN, full appropriate Worker/Node/lint/type/build/drybuild checks. Self-review, independent review, feature commit/push. Continue document preview/create/update/conversion using these plans immediately, no milestone prompt.
