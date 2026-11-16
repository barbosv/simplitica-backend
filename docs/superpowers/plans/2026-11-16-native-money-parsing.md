# Native Money Parsing Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline while delegated implementers are unavailable; retain independent review when capacity allows. Continue remaining integration tasks immediately.

**Goal:** Correct duplicate price occurrence accounting, unsafe stripping alternation and invisible formatting normalization.

**Architecture:** Preserve existing extraction/strip public API, normalize documented marks before matching, group the shared numeric alternation, deduplicate overlapping extraction captures by source numeric range rather than Decimal value.

**Tech Stack:** Existing Swift/Foundation, iOS26.5 signed simulator XCTest, Xcode26.6.

**Spec:** `docs/superpowers/specs/2026-11-16-native-money-parsing.md`.

## Global Constraints

- Native isolated `/Users/vitorbarbosa/.codex/worktrees/chatgpt-mcp-probe/voice-invoice`, branch codex/chatgpt-native-qualification. Original checkout and staged schemes untouched.
- No versioned calculator/historical totals/persistence/auth/subscription/PDF/UI behavior changes; no real credentials/purchase/send/production.
- Preserve source price/quantity expectations; no skips/weakened assertions. Existing remaining failures stay explicitly red.

## Review Focus

1. Two equal prices at different source positions must not collapse into a single occurrence.
2. Several regex matches for one currency token must not create false ambiguity and split combined service intent.
3. Ordinary numeric description suffixes must survive money stripping.
4. Supported invisible marks must normalize without dropping legitimate currency/description characters.
5. Grouped/localized amounts and last-for-price preference must remain unchanged.

## Task 1 — Correct occurrence matching and phrase stripping

**Files:** native `SimpliInvoice/Core/Services/InvoiceHeuristicMoneyParsing.swift`, `SimpliInvoiceTests/InvoiceHeuristicMoneyParsingTests.swift`; no other runtime files.

**Interfaces:** existing `extractAmount(from:) -> Extraction`, `stripPricePhrasesFromLineDescription(_:) -> String`, currency/spoken normalization helpers retain signatures. `hadMultipleAmounts` reflects distinct captured numeric source ranges, not number of regexes or unique numeric values. Reuse the grouped numeric constant in ordered-for extraction without changing its accepted digit grammar.

- [ ] Run existing parser suite on recovered dedicated simulator3F7A339C-FD65-4548-B53F-ADA6AC46A13F, capture actual RED and method counts. Reuse existing derived data, unique result bundle. Existing broader failure matrix: backend `.superpowers/sdd/2026-11-15-native-build-recovery/native-main-failures.md`.
- [ ] Add regression cases: same token matched by overlapping patterns has hadMultipleAmounts=false; two distinct `$100` tokens have true; bare `Room 4`/`Polished 3` remain unchanged; `Replace door - $100` strips to `Replace door`; LRM/WORD JOINER/FE0E/FE0F around `$1000` parse1000; localized amounts/last-for selection remain. Observe failures before source fix.
- [ ] Group shared numeric alternation, track unique numeric match NSRanges and preserve transcript order, remove documented invisible scalars through a valid deterministic implementation. No set of Decimal values for deduplication. Keep parser debug diagnostics scoped as before.
- [ ] Run focused parser and dependent copy/draft/voice/order tests. Report remaining unrelated failures by name. Then run full main unit suite once after this component's final edits; zero skipped, count actual XCTest methods. Existing other failures need not be falsely claimed resolved.
- [ ] Self-review and commit only task source/tests in native feature branch. Independent review, then push reviewed branch. Record residual failures for next focused task and continue cloud authoring/native work; no milestone question.
