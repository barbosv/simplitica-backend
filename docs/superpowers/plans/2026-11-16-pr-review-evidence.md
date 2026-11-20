# PR Review Evidence Implementation Plan

> **For agentic workers:** Execute inline with independent review, then continue the full implementation.

**Goal:** Make PR10 evidence reproducible/reviewable and close the narrow redirect-test/doc hygiene gaps.

**Architecture:** Qualification-only test visibility plus deterministic offline/backend parity CLI and sanitized documentation artifacts; PR metadata updated last. No main-app behavior change.

**Tech Stack:** Existing XCTest/URLSession/SwiftPM, Node/tsx, GitHub connector.

**Spec:** `docs/superpowers/specs/2026-11-16-pr-review-evidence.md`.

## Global Constraints

- Isolated backend/native feature branches only; no original user scheme edits, merge/history rewrite, real auth/purchase/send/prod deployment/migration.
- No secrets/identity claims in committed artifacts. Synthetic test summaries distinguish local evidence from CI/live qualification.
- Preserve current calculator raw-byte/key equality/rounding contract and historical app calculations; no main-app package wiring yet.

## Review Focus

1. Stale9918a71 review must not imply current170afb1 has no executed main tests.
2. Method counts differ from assertion-failure counts; report224/213/11, not16failedmethods.
3. A302stub does not prove the redirect delegate declines a redirect.
4. Cross-repository calculator parity must execute actual server entrypoints, not just compare fixture digests.
5. Raw live auth artifacts must remain private; only sanitized local summaries and explicit limits are published.

## Task 1 — Reproducible tests, evidence and PR metadata

**Native files:** existing LocalProofVerifier.swift/Tests, Auth0NativeSessionTests.swift, qualifier README/VERIFICATION/plan, package README, new docs/verification/chatgpt-native-2026-11-16.md and sanitized JSON summaries. No main app source/project changes.
**Backend files:** scripts/qualification/check-calculator-parity.ts, package.json command and a short reproducible-run/result doc if needed. No deployment/config/migration change.

- [ ] Reconfirm current PRhead/body with connected GitHub; review all feedback against actual source. Configure repo-local verified19333405+barbosv@users.noreply.github.com identity for new commits; no rewrite. Record two repo BASEs.
- [ ] Add direct redirect-delegate test with suspended URLSession task/synthetic302, callback must receive nil, no resumed network. Verify controlled return-request mutation makes it fail, restore implementation. Make delegate internal only for@testable, match Keychain test synchronizable:false. Run signed qualifier full suite on dedicated simulator; exact actual count expected21 if one new method.
- [ ] Add CLI `npm run qualify:calculator-parity -- /path/to/voice-invoice` reading native Resources and backend fixtures, pin both known SHA256s, assertbyteequality, 23valid110invalid cases plus3rawvalid13rawinvalid/7preflightvalid18invalid against actual calculator/strictJSON helpers. Fail nonzero on drift and print only counts/digests. Run it and SwiftPM debug/release suites; lint/type/build as appropriate.
- [ ] Generate sanitized summaries from actual retained xcresult/Swift command outputs with source hashes, source commits and failed-method names. Commit documentary review ranges/verdicts/AI reviewer roles, honest local/live/remaining gates, supported rerun commands and links. Correct stale qualifier live checkbox and MLKit baseline wording. Document first-binder caveat. No token/raw live evidence.
- [ ] Self-review/independent review, source/docs feature commits and push; update PR10 title/body through GitHub connector only after artifacts are concrete, then read back metadata. No conversation comments/reviewer notifications/merge. Continue full draft/MCP/native work without a milestone handoff.
