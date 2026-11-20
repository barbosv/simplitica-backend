# Main iOS Build Recovery Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for this focused task with independent review. Continue the overall integration immediately afterward; no milestone handoff.

**Goal:** Run actual main-app tests on arm64 simulator while retaining existing runtime translation and ZIP behavior.

**Architecture:** Remove the unused Google binary dependency and its architecture workarounds through the existing CocoaPods workflow. Keep Apple Translation and direct SSZipArchive; existing application behavior is unchanged.

**Tech Stack:** Existing Xcode26.6/Swift6.3.3, CocoaPods, fresh iOS26.5 simulator, native XCTest.

**Spec:** `docs/superpowers/specs/2026-11-15-native-build-recovery.md`; source evidence `.superpowers/sdd/full-integration/native-build-sync-recon.md`.

## Global Constraints

- Edit only isolated `/Users/vitorbarbosa/.codex/worktrees/chatgpt-mcp-probe/voice-invoice` branch codex/chatgpt-native-qualification. Never touch original checkout or its staged schemes.
- Keep AppleNativeTranslationService compiled/injected and SSZipArchive2.6; no app/persistence/calculator/sync/payment behavior change. No unrelated package upgrade/signing disablement.
- Fresh dedicated simulator; no physical-device/user-data overwrite, credentials, purchase, outward communication or production action.
- Zero executed tests is not success. Preserve expectations and diagnose failures; report exact executed/skipped/failing counts and result bundles.

## Review Focus

1. Podfile hooks can reinstate exclusions after generated configuration cleanup; remove all source writers and prove regenerated settings.
2. The historical MLKit-named file is actual Apple runtime translation and must remain compiled.
3. ZIP import/export depends on direct SSZipArchive, which must remain linked and tested.
4. Existing simulator/user data and original staged scheme edits must survive test setup.
5. Tests can be silently absent, skipped or fail after build recovery; inspect actual xcresult counts.

## Task 1 — Remove unused dependency and qualify the real app

**Repository:** Native isolated checkout above; record NATIVE BASE immediately before dispatch.

**Files:** modify native `Podfile`, regenerate tracked `Podfile.lock` and necessary CocoaPods project/workspace artifacts, remove the six explicit EXCLUDED_ARCHS entries from `SimpliInvoice.xcodeproj/project.pbxproj`, plus UI-target-only empty OTHER_LDFLAGS overrides in Debug/Release for the confirmed inherited app-Pod loader failure. Keep historical Swift file compiled and schemes/source unchanged unless a specific newly revealed failure requires a documented scope decision. Generated ignored Pods artifacts stay ignored.

- [ ] Reconfirm source references and capture main test/build RED using the existing workspace/scheme and an isolated fresh arm64 simulator. Discover available runtime/device identifiers through installed developer tooling rather than guessing. Preserve normal simulator ad-hoc signing, as Keychain requires it.
- [ ] Remove GoogleMLKit/Translate and obsolete comments; remove Podfile's Pods-target, user-target and generated-xcconfig arm64 exclusion writers. Retain unrelated hooks and direct SSZipArchive version constraint. Remove app/unit/UI target Debug/Release exclusions. Run existing CocoaPods install workflow without blanket dependency updates; inspect lock/generated changes for removal of unused Google dependencies and retention of ZIP.
- [ ] Run `xcodebuild test -workspace SimpliInvoice.xcworkspace -scheme SimpliInvoice -destination 'platform=iOS Simulator,id=<fresh-id>' -only-testing:SimpliInvoiceTests` with a separate derived-data/result path. Verify nonzero XCTest execution and inspect xcresult summary. Diagnose any remaining compile/test failure; do not skip failing tests, weaken assertions or declare the inherited blocker fixed from package tests.
- [ ] Run existing relevant UI tests on that fresh simulator if configured for synthetic isolated data; do not drive real sign-in/purchase/send flows. Record actual scope/counts/timeouts and any independent blocker. Run CloudInvoiceCore package checks and the signed native qualifier suite only if project/dependency changes affect them; avoid redundant repeats otherwise.
- [ ] Self-review source/lock/target diffs, verify original user schemes untouched, report command exits/counts/xcresults/diagnostics and narrow remaining risks to the backend ignored workspace task-1-report.md. Commit only native task files, independently review native diff range, then push reviewed native feature branch and continue backend/native integration without a milestone prompt.
