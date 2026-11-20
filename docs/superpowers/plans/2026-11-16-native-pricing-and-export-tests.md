# Native Pricing and Export Test Contracts Plan

> Execute inline with independent task/final review while implementation workers are quota-limited. Continue the full integration without milestone approval.

**Goal:** Correct logical CSV/rich-variant assertions and prefer one explicit strong saved rate over history.
**Architecture:** Test-only contract corrections followed by narrow local-candidate selection changes. Preserve stored data and math.
**Spec:** docs/superpowers/specs/2026-11-16-native-pricing-and-export-tests.md
**Stack:** Existing Swift/UIKit/Foundation/XCTest, dedicated synthetic simulator, signed recovered workspace.

## Global Constraints

- Only native isolated /Users/vitorbarbosa/.codex/worktrees/chatgpt-mcp-probe/voice-invoice, branchcodex/chatgpt-native-qualification. Original user schemes untouched.
- No auth/proof/provider/subscription/persistence/rounding/PDF/UI/delivery changes, no skips, no purchases/sign-in/send/production.
- Do not claim full native green until all remaining failures pass. Test contract changes require actual fixture/CSV format evidence, not hiding product failures.

## Review Focus

1. CSV logical counting must preserve escaped double quotes and embedded LF/CR, not flatten or omit fields.
2. Recommended variant assertion must use its ID while preserving first-item order.
3. One saved match must not weaken the minimum for unrelated or history-only evidence.
4. Strong saved match must not be crowded out by60 higher-scored history candidates or averaged with them.
5. Selected source/rationale/history count must match actual prices used; missing legacy unit remains explicit.

## Task 1 — Repair CSV logical-record and recommended-variant test contracts

**Files:** native SimpliInvoiceTests/Unit/DataExportServiceTests.swift and PriceSuggestionServiceTests.swift only. No product/fixture changes.

- Existing actual fullmain CSV and richvariant failures are RED evidence; retain exact summaries. CSV quote-aware local counter counts LF only outside quotes, ignores blank trailing record, asserts balanced quote state. Strengthen full quoted multiline memo and escaped item description checks; header +1logicalrow remains expected.
- Richfixture test asserts hasRichContent, first recurring id/typical215, recommended deep_clean lookup by actualID/typical375. No array reorder or forced recommendation.
- Run both full testclasses with real app export, record exact methods/counts and any unrelated saved-match failure (Task2). Diffcheck/source-limited commit and independent review. No assertion skips or broad snapshot rewrites.

## Task 2 — Prefer compatible strong saved prices with honest evidence

**Files:** native SimpliInvoice/Core/Services/Pricing/PriceSuggestionService.swift and existing Unit/PriceSuggestionServiceTests.swift.

- First add behavioral RED: one exact positive same-kind saved175 plus strong recent histories at otherprices still yields saved175 only; >60history candidates can't crowd out a strong saved match. Single exact saved existingfailure nowreturns nonnil175withsavedsource, localHistory count0/no localHistory source, limitedevidence + confirmunit warning. Cross-kind single saved and one history-only candidate remain nil; zero/negative savedexcluded. Keep existing3history percentile test.
- In source filter saved kind compatibility, choose positive strong saved candidates before combined cap, bounded maxCandidatesConsidered; otherwise retain old strong/all minimum2 fallback. Compute selectedStrong/selectedHistory for confidence/rationale/sources/count, avoid discarded history metadata. Keep same percentile/roundMoney math/config defaults and history collector scope; no guessedunit or model storage changes.
- Targeted price suite GREEN, full main once finalsource, exact result method counts and residual PDF/typography failures. Full no-skip evidence; self-review/commit/independent task then one final component review, push feature and continue PDF/typography/UI/native proof/sync. No milestone handoff.
