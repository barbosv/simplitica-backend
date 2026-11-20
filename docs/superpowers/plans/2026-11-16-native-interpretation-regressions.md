# Native Interpretation Regressions Implementation Plan

> **For agentic workers:** Execute task by task with a fresh implementation worker/independent review when available, root inline fallback otherwise. Continue the full integration without milestone approval.

**Goal:** Resolve four interpretation/prompt regressions and one USD-formatting regression from the executed main suite.

**Architecture:** Narrow existing heuristic/fallback/copy/prompt branches; keep shared match-only normalization and the versioned cloud calculator untouched. Separate the presentation task from interpretation.

**Tech Stack:** Existing Swift/Foundation/XCTest, Xcode26.6, signed iOS26.5 dedicated simulator.

**Spec:** `docs/superpowers/specs/2026-11-16-native-interpretation-regressions.md`.

## Global Constraints

- Only isolated native worktree /Users/vitorbarbosa/.codex/worktrees/chatgpt-mcp-probe/voice-invoice branchcodex/chatgpt-native-qualification; original user schemes untouched.
- No auth/provider/subscription/persistence/payment/PDF/UI changes, no new calculator/rounding, no real sign-in/purchase/send/production.
- Preserve tests/expectations; fix source causes. Keep unrelated failures explicitly visible, no skips or native-health green claim before full suite passes.

## Review Focus

1. Already priced or separately described tasks must not merge into a total-only tail.
2. Placeholder normalization must not turn invalid fallback data into a billable line.
3. Copy cleanup must preserve price, quantity and intended repair scope.
4. Matching-only normalization must not regress emoji/bidi preservation or stated-price validation.
5. USD grouping changes must not alter Decimal values/non-USD symbols or negative signs.

## Task 1 — Correct total-tail binding and fallback/copy validity

**Files:** native `SimpliInvoice/Core/Services/InvoiceAIService.swift`, `AIInvoicePrompts.swift`; existing `InvoiceHeuristicMoneyParsingTests.swift`, `InvoicePolishedCopyMergerTests.swift`, `VoiceStructuredInterpretationEngineTests.swift` regression additions only.

**Interfaces:** retain all current public types/signatures. Existing `mergeTrailingPriceOnlyClauses` may recognize a strict price-only total tail as well as the existing for-price tail when previous clause has no price. Use actual shared amount extraction and mapped price stripping; require stripped tail exactly total/in total, reject arbitrary described prose. Keep the original for-tail path and no-merge-on-priced behavior. Before fallback normalization, call existing `firstInvalidReason` on raw fallback just as primary does. In conservative `normalizeWorkVerbTense`, reorder only explicitly stated kitchen sink/sink leaking phrasing, then preserve existing estimate Repair/invoice Repaired voice and all money. Reword prompt placeholder prohibition without reproducing forbidden placeholder labels; preserve explicit task/JSON/unstated-price requirements.

- [ ] Observe existing four failures RED on current reviewed source: divides-total-by-quantity, fallback-empty, fallback-copy, prompt-copy. Add/observe controls for5hammers/$15total with marked currency, separate priced tasks/price+tip, unpriced prose with total/street number, empty/blank raw fallback, positive valid fallback and unchanged125 copy price/quantity.
- [ ] Implement one source cause at a time and run covering regressions; no unrelated financial logic, wholesale regex changes or test weakening. Audit shared mapped title stripping/marked-price integration tests remain green.
- [ ] Run full main XCTest once after final source edits using dedicated3F7A339C-FD65-4548-B53F-ADA6AC46A13F, existing recovered workspace/scheme/DerivedData, parallel-testing-enabled NO, unique result/log. Count actual passed/failed/skipped methods, list any remaining failures. Baseline224methods213pass11fail0skip; addedtestschange count.
- [ ] Self-review, diffcheck, source-only native commit, independent task review then feature push. Continue Task2/cloud work; no milestone prompt.

## Task 2 — Deterministic USD unit-price spacing

**Files:** native `SimpliInvoice/Core/Utilities/InvoiceCurrencyFormatting.swift`, corresponding existing formatter tests in `InvoiceHeuristicMoneyParsingTests.swift`. No change to calculator or stored unit prices.

**Interfaces:** retain `currencyUnitPriceString(_:currencyCode:)` and parse methods. Configure USD en_US_POSIX positive/negative currency prefix formatting explicitly if confirmed by actual Foundation probe; avoid globally removing Unicode spaces from arbitrary user text. Keep existing two-decimal display intent, grouping and other currencies. Do not round and persist display text automatically; future connected editor owns raw six-decimal fidelity.

- [ ] Observe existing USD-spacing failure and add positive/zero/negative grouped display + parse round trips using Decimal literals, non-USD currency control. Verify underlying NumberFormatter behavior with installed Foundation before choosing exact configuration.
- [ ] Implement minimal presentation fix, targeted GREEN, full main signed XCTest once final, record actual counts and remaining failures. No skips/assertion weakening.
- [ ] Self-review/diffcheck/native commit/independent review/push, continue pricing/PDF/test-contract/UI fixes and full cloud/native integration.
