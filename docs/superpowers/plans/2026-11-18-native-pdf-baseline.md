# Native PDF Baseline Implementation Plan

> Use superpowers:subagent-driven-development. Prior owner direction opts out of repeated design/milestone approval. Serialize source editors and simulator runs.

**Goal:** Repair clipped invoice cards, Additional Information, and effective font invariance coverage.
**Architecture:** Narrow layout changes in existing renderer plus isolated test-only font control. Keep fixed production font roles.
**Tech Stack:** Swift/UIKit/PDFKit/XCTest, existing signed Xcode workspace and synthetic simulator.
**Spec:** docs/superpowers/specs/2026-11-18-native-pdf-baseline.md

## Global Constraints

- Only /Users/vitorbarbosa/.codex/worktrees/chatgpt-mcp-probe/voice-invoice, branch codex/chatgpt-native-qualification. Original native checkout untouched.
- One source editor/simulator runner at a time. No auth/persistence/provider/delivery changes, skips, real sends, production or merges.
- Preserve complete billing/destination separately, normalized additional information, fixed production font roles and meaningful strict assertions.

## Review Focus

- Wrapped Unicode billing/destination content remains complete and inside page/card bounds.
- Long notes continue with forward progress and without hiding rows/totals.
- Whitespace-only and attachment-only customer notes obey shared normalization.
- UIFont override restores even when body throws; no asynchronous/global leaked test state.
- Negative control fails through actual legacy selector; fixed-font renderer passes unchanged strict comparison.

### Task 1: Billing and Additional Information layout

Files: PDFExportService.swift, existing InvoicePDFClientAndOrderTests.swift and PDFExportIntegrityTests.swift (locate actual path), fixture helper if necessary.
- [ ] Add synthetic long-address/destination/no-destination and long-notes regressions with distinct sentinels, media bounds, normalized whitespace/attachment cases; run RED against baseline.
- [ ] Replace StudioAccent 100pt card clamps with measured padded card heights and page-aware line continuation. Preserve equal paired height and distinct content. Reuse existing measurement/drawing fonts and guarantee each iteration consumes text.
- [ ] Use shared CorporateSplit additionalInformationLabel/customerNotesText; fit full pill and measured body with notes continuation. Preserve existing row/totals rendering; track separate generic table defects explicitly.
- [ ] Run affected classes on dedicated simulator. Retain PDF/PNG artifacts for ordinary and long cases, all pages. Inspect visually at readable resolution. Self-review, diff check, commit, independent review.

### Task 2: Regression-sensitive font invariance

Files: InvoicePDFTypographyTests.swift only unless test-support project entry necessary.
- [ ] Add main-thread synchronous scoped class IMP replacement of exact one-argument preferredFont selector, redirecting to real compatibleWith-current-traits API. Prove variation through exact selector and restoration on normal/throwing scope exit. Keep strict existing PDF comparisons.
- [ ] Run controlled uncommitted renderer-font regression RED; record failing geometry/raster/control evidence and restore renderer immediately. No product hook or negative control committed.
- [ ] Run targeted typography GREEN and full SimpliInvoiceTests once final source; report actual counts and failures. Self-review/diff check/commit; independent task and final component review.
- [ ] Update verification evidence/PR scope, normal feature push only, then continue meaningful UI/proof/sync integration work. No milestone approval pause.
