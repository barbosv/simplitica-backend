# ChatGPT Development MCP Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Preserve independent task review.

**Goal:** Build and push an isolated authenticated development MCP probe; subsequently connect it to ChatGPT and collect live provider qualification evidence.

**Architecture:** A standalone stateless Worker uses the maintained official MCP SDK and `jose` JWT verification. No database is needed. Existing Hono production routes and D1 configuration stay unchanged. The owner authorized a new replacement because the original local probe/archive is unavailable.

**Tech Stack:** TypeScript, Workers/workerd, Vitest Worker harness, maintained MCP TypeScript SDK, Auth0 development tenant.

**Spec:** `docs/superpowers/specs/2026-11-14-chatgpt-workers-continuation.md`

## Global Constraints

- Baseline: `34a0c8b4b9590326403c96383459cf3c33ab968a`; task base `97bf6a6`.
- No production deployments, migrations, auth changes, or bindings.
- Only synthetic read-only data; no sending, payment or document authoring tools.
- New replacement implementation is authorized; do not claim historical work was recovered.
- Secrets/private keys/tokens stay out of source, logs, tool output and chat.
- Push the reviewed `codex/chatgpt-mcp-probe` branch only, without merge or force push.

## Review Focus

- JWT negatives must have a valid positive control and correct issuer/audience/client/scope/expiry enforcement.
- Unsupported MCP GET/streaming methods must terminate promptly; POST response lifecycle must finish under workerd.
- Actual requested OAuth scopes and resource must be checked live, independently of advertised provider scopes.
- Probe configuration must never inherit production bindings or deployments.
- Synthetic success and public discovery are not evidence for native identity, refresh/reuse or revocation gates.

### Task 1: Replacement probe and local evidence

**Files:** `src/worker/qualification/`, `wrangler.qualify.jsonc`, `test/worker/qualification*.test.ts`, `package.json`, `package-lock.json`, isolated TypeScript/test config if required, and `docs/chatgpt-managed-oauth-qualification.md`.

**Interfaces:** dedicated Worker `fetch(request, env)`; one `qualification_probe` MCP tool; public protected-resource metadata; `QUALIFY_*` configuration for issuer/resource/client/scope/Apple claim and development-only operation.

- [x] Reconcile Git and record owner authorization; prepare focused brief and fresh implementer.
- [x] Write and execute failing tests for unsigned/wrong-signature, issuer/audience/client/scope/expiry/identity rejection, valid authenticated tool calls, method handling and request lifecycle.
- [x] Implement a standalone SDK Worker with no storage binding and bounded body/JWKS handling.
- [x] Verify the production app remains separate; run full Node/workerd suites, lint, builds, probe dry-run and diff checks.
- [x] Document exact local setup, identity claim requirement, nonsecret provider configuration, separate development deploy/tunnel procedure and remaining live gates.
- [x] Commit scoped work; obtain independent spec/quality review, fix blockers and obtain scoped re-review. Final code review passed at `93226f6`.
- [x] Push the feature branch; verify its remote commit matches local HEAD. Feature branch published after review; production remains unchanged.

### Task 2: Development HTTPS and ChatGPT linking (not completed by a push)

- [x] Establish a dedicated staging Worker or supported tunnel, with no production bindings. Verify the canonical domain and OAuth metadata routing.
- [x] Configure the development-tenant Action for the signed opaque Apple identity claim; verify exact third-party client ID copied from Auth0, not screenshot transcription.
- [ ] Obtain exact callback from the actual ChatGPT portal and register it with the predefined client; keep API-only OIDC settings and explicit scopes.
- [ ] Link using real Apple login and S256. Record sanitized actual resource/audience/token request evidence and a successful synthetic tool call from ChatGPT.

### Task 3: Complete full P1T1b qualification before dependent implementation

- [ ] Verify signed Apple identity continuity across native and hosted flows, with the approved App ID grouping; no email merging or prefix stripping.
- [ ] Verify refresh rotation and old-token reuse rejection, with the configured overlap accounted for.
- [ ] Verify revocation/disconnection denies subsequent refresh/access as appropriate. An unexpired JWT is not automatically revoked by this stateless probe.
- [ ] Record explicit pass/fail evidence for all gates. Evaluate another managed issuer if required; do not bypass failures with a custom authorization server.

## Later D1 adaptation gate

Rewrite remaining account/record/sync/numbering tasks against D1 before executing them. Preserve approved interfaces where available and mark unavailable historical details honestly. Replace PostgreSQL transactions, locks and sequence assumptions with tested atomic SQL/batches and conditional mutation gates. Prove ownership uniqueness, revision/idempotency, number allocation and commit-safe feed ordering in actual D1/workerd tests. No new PostgreSQL or Cloud Run dependency.
