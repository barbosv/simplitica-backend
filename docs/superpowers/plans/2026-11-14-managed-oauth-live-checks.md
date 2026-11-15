# Managed OAuth Live Checks Implementation Plan

> **For agentic workers:** Use executing-plans inline with independent review of each qualification artifact. This extends the already authorized provider qualification task; do not reopen approved product scope.

**Goal:** Prove controlled rotation/reuse/revocation and native identity continuity before dependent account/persistence work.

**Architecture:** Development-only Node callback receiver is an OAuth client, never an authorization server. It uses the existing confidential third-party client, PKCE S256, fixed development issuer/resource and a separately allowlisted loopback callback. Secrets and token pairs stay in process memory; only sanitized verdicts are retained. Native qualification uses the official Auth0 Swift SDK in an isolated iOS checkout.

**Spec:** `docs/superpowers/specs/2026-11-14-chatgpt-workers-continuation.md` and original approved handoff product scope.

## Constraints and review focus

- No production bindings, deployments, migrations, owner registry or shared record writes until qualification passes.
- No raw tokens, client secret, authorization code, Apple identity or relay email in output/evidence.
- Callback must enforce state, one-time code, loopback binding, exact path and timeout. Reject malformed/duplicate query inputs.
- Validate every successful access token cryptographically with development issuer/audience/client/scope/Apple claim; decoded payloads alone never qualify.
- Provider error strings/bodies and transport errors are not safe log messages.
- Refresh identity/resource and invalidated-token-family behavior must be verified, not inferred from token string differences.

## Task 1 — Controlled confidential-client runner

Files: `scripts/qualification/managed-oauth.ts`, `test/managed-oauth-live-runner.test.ts`, runbook and package script.

- [x] Write RED tests for fixed S256 authorization/resource/scopes and strict callback state/path/duplicate/replay handling, using real loopback HTTP.
- [x] Implement loopback client callback and test it GREEN.
- [x] Write RED tests for refresh rotation, unchanged refresh rejection, replay/family denial, revoke denial and redacted failures using an actual disposable HTTP issuer fixture.
- [x] Implement in-memory token lifecycle checks; verify real JWTs through `jose` and fixed development config.
- [x] Run full Node suite, lint/build, independent review, commit and push feature branch.
- [x] Register exact temporary development loopback callback; owner enters secret directly into a protected ignored local file. Run two owner-authenticated stages (reuse detection invalidates the first token family; revocation needs a fresh login).
- [x] Record sanitized live provider verdicts; remove temporary callback/config after testing without changing ChatGPT's existing callback.

## Task 2 — Native qualification

Workspace: isolated `voice-invoice`, branch `codex/chatgpt-native-qualification`; preserve original staged scheme changes.

- [ ] Build and execute baseline tests on a selected available simulator/device; record actual test counts, not the permissive helper-script exit.
- [x] Add development-only official Auth0 Swift SDK login and secure credential storage with tests;20 simulator tests passed, independently reviewed. No production enrollment.
- [ ] Issue a separately authorized native-audience token and compare its verified opaque Apple identity privately with the hosted flow. No email matching or prefix stripping.
- [ ] Verify actual native login on selected runtime, then independently review and document evidence.

## Later implementation

After provider gates pass, write concrete D1 account/subscription, records/sync/numbering, native outbox and MCP authoring plans against current code. Preserve one owner/business/subscription, StoreKit lineage uniqueness, entitlement rules, decimal-string USD calculations, revision/idempotency and atomic D1 batch gates. Every D1 concurrency guarantee requires real workerd/D1 tests. Keep finalization/PDF/email/text native; no payment or send tools. User authorizes full implementation, feature-branch pushes and development testing; production rollout remains excluded.

Prepared native provider config and independently reviewed SDK artifact are complete; owner-assisted native login succeeded; private signed comparison remains pending. Native main-app baseline attempt failed before executing tests (inherited simulator architecture issue); the separate qualifier has20 actual passing tests.
