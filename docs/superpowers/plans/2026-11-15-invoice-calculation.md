# Shared Invoice Calculation Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development task-by-task with independent review. Continue directly into records, tools and native integration after this plan; do not stop for milestone approval. The owner explicitly requests finishing the full integration autonomously.

**Goal:** Produce identical versioned new-draft USD totals on Workers and iOS.

**Architecture:** Server scaled BigInt and native Foundation Decimal implement one bounded numeric contract with the same literal JSON fixtures. Neither calculator changes existing stored documents or authorizes invoice access.

**Tech Stack:** Existing TypeScript/workerd, native Swift 6.0 package/Foundation Decimal; no new third-party runtime dependency.

**Spec:** `docs/superpowers/specs/2026-11-15-invoice-calculation.md`; approved Workers/D1 adaptation remains binding.

## Global Constraints

- Keep Workers/D1, isolated feature branches and existing production routes/bindings/default migrations unchanged. No production deployment/migration/merge, real invoice/customer data or secrets.
- Authoritative numeric inputs/outputs are decimal strings. BigInt server/Decimal native only; no binary floating-point money. Version `usd-line-cents-v1`, USD only; half-up rounded line cents, subtotal, capped discount, rounded tax, total in that order.
- Historical native totals remain unchanged. This package is not main-app wiring or a substitute for main-app/physical-device/provider release evidence.
- User has opted out of milestone/design approval pauses. Record routine choices and continue the approved full workflow. Browser and physical actions still require the appropriate owner capability/interaction.

## Review Focus

1. Repeating small lines must sum individually rounded cents, not round an aggregate extension.
2. Scaled-input boundaries and intermediates can exceed JavaScript safe integers; they must stay exact and fail explicit output limits.
3. Normalization can cause idempotency mismatches if native/server canonical strings differ; compare all result fields from identical fixtures.
4. Parsers must reject numeric JSON, exponent/sign/Unicode/separator/malformed values and excess scale before conversion.
5. Native Decimal calculations must not silently lose precision or read a process locale; prove exact ASCII parsing/formatting and arithmetic errors under the bounded contract.

## Task 1 — Worker calculator and shared contract fixtures

**Files:** create `src/chatgpt/documents/calculator.ts`, `test/worker/cloud-calculator.test.ts`, `test/fixtures/cloud-calculator-v1.json`.

**Interfaces:**
- Export `CALCULATION_VERSION = "usd-line-cents-v1"`, `CalculationError` with fixed code/message `invalid_input` or `amount_out_of_range`, and `calculateDocumentV1(input:unknown):CalculationResult`.
- Strict input `{currency:"USD",lines:Array<{quantity:string;unitPrice:string}>,discountAmount:string,taxRatePercent:string}`. Apply exact limits/grammar from spec. Leading integer zeros do not count toward significant integer digits; total input string length still <=32. No request metadata, customer/owner identifiers or durable effects.
- `CalculationResult` has `calculationVersion`, `currency`, `lines:Array<{quantity:string;unitPrice:string;lineTotal:string}>`, `subtotal`, `discountRequested`, `discountApplied`, `taxRatePercent`, `taxableAmount`, `taxAmount`, `total`, all numeric fields strings. Normalize quantity/tax minimally, unitPrice at least2 fractional places, monetary values exactly2. Reject unknown input/line keys and non-plain input shapes.
- Fixture format `{version:"usd-line-cents-v1",valid:Array<{name:string;input:unknown;expected:CalculationResult}>,invalid:Array<{name:string;input:unknown;error:"invalid_input"|"amount_out_of_range"}>}`. Literal expected results are independent of implementation. Include significant-integer, scale, 32-character, 200-line and maximum-cent boundaries; valid JSON fixtures cannot represent undefined/prototype attacks, so cover those in Worker tests.

- [x] Write behavioral RED for the literal required examples, normalization-equivalent forms, fractional precision/ties, independent line rounding, discount capping, tax limits, input/output caps and malformed/extra fields. Assert input immutability and pure repeated output. Include values above Number.MAX_SAFE_INTEGER in scaled arithmetic with exact expected cents.
- [x] Implement bounded scaled BigInt parsing, multiplication, half-up division and string formatting; no SQLite or runtime dependency. Run `npm run test:worker -- test/worker/cloud-calculator.test.ts` GREEN.
- [x] Run relevant existing checks (full Worker/Node once, lint, Worker typecheck, build/dry build), capture actual results, independently review and commit. Record fixture SHA256 for Task2, then push reviewed feature branch while continuing.

## Task 2 — Native calculator parity package

**Repository:** isolated `/Users/vitorbarbosa/.codex/worktrees/chatgpt-mcp-probe/voice-invoice`, branch `codex/chatgpt-native-qualification`; record its own BASE before dispatch.

**Files:** create `Shared/CloudInvoiceCore/Package.swift`, `Sources/CloudInvoiceCore/InvoiceCalculator.swift`, `Tests/CloudInvoiceCoreTests/InvoiceCalculatorTests.swift`, `Tests/CloudInvoiceCoreTests/Resources/cloud-calculator-v1.json`, `README.md` inside that package.

**Interfaces:**
- Swift-tools6.0, platform iOS15/macOS13, Foundation only. Public Codable/Equatable/Sendable input/result/line DTOs matching Task1 JSON keys and public `InvoiceCalculatorV1.calculate(_ input:CalculationInput) throws -> CalculationResult`. Typed error maps exact wire codes. A strict Data-based decoding entrypoint `calculate(json:Data)` must reject missing/extra fields, wrong primitive/container types and unsupported currency; typed entrypoint enforces all numeric bounds and line counts too. No `Double`/`Float` bridge or environment-locale conversion for money; check Decimal operation errors.
- Copy Task1 fixture file byte-for-byte after its review/commit. Record source backend SHA and fixture SHA256 in package README; run all literal valid/invalid cases, comparing every result field. Keep fixtures bounded before loading and no private data.
- This reusable package is deliberately not added to production AppDependencies or InvoiceDraft yet; the ensuing native-sync work will integrate it with explicit versioning. Do not modify original checkout or its staged scheme edits, existing app/qualifier projects or production scheme. No package dependency downloads beyond standard Swift/Foundation.

- [x] Write/run `swift test --package-path Shared/CloudInvoiceCore` RED for missing behavior and independent line rounding/normalization contract. Tests must execute assertions, not skip for simulator limitations.
- [x] Implement strict DTO decoding and bounded Decimal calculator using explicit locale and rounding; verify malformed numeric/unknown fields, operation bounds, input immutability and stable output.
- [x] Run package tests GREEN with zero skipped tests, compiler diagnostics and identical fixture digest; independently review native commit range using its own repository. Commit/push the isolated native feature branch. Then continue into owned D1 record authoring and MCP tools without requesting milestone approval.

## Task 3 — Final duplicate-name fix wave (2026-11-15)

Scope for this wave overrides earlier continuation/push instructions: fix I1 only, no subagents, pushes, route/app wiring, provider actions, deployments or migrations. Backend BASE `9a4b19c0f407373894c846834aaee8f1e5f2ea62`; native BASE `52657929745d8c7d8afe6ae88e4bb8e087705aef`.

- Capture behavioral RED against both actual raw calculator calls with conflicting and identical duplicate names.
- Add reusable `parseStrictJSON(Uint8Array)` and `calculateDocumentJSONV1` on the server; preflight native Data before eager DTO decoding. Use bounded structural scans plus maintained platform parsers, 64 KiB/depth 16, exact decoded UTF-8 key equality, no Unicode normalization, explicit BOM rejection, fixed sanitized errors and preserved arithmetic overflow.
- Copy literal raw fixtures byte-for-byte; cover scopes, escapes, Unicode, malformed/trailing JSON/UTF-8 and exact byte/depth boundaries. Keep the original 133 fixtures unchanged.
- Verify affected/full Worker and Node suites, native debug/release, lint/type/build checks and fixture digests; record actual RED/GREEN, warnings and limitations in `.superpowers/sdd/2026-11-15-invoice-calculation/final-fix-report.md`.
- Self-review task-owned changes and commit separately in each repository for the root's dual-scoped review.

Future Worker/MCP ingress must call the strict raw helper before SDK/object decoding discards names. Direct DTO/object decoding alone does not satisfy the boundary contract or protect request hashes.

## Source verification

Server and native tasks passed independent review. Whole-branch review found raw duplicate-key parity; one reviewed fix now rejects ambiguous raw JSON before object/DTO decoding on both sides. Final evidence:814 Worker/167 Node,186 affected tests, Swift debug/release14 XCTest methods each with zero skips, unchanged133 numeric fixtures and shared raw fixtures. Existing historical calculations/main-app wiring remain unchanged; records and transport integration continue next.
