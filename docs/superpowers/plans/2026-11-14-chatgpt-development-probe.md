# ChatGPT Development MCP Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking. Preserve the owner's task-by-task independent review workflow.

**Goal:** Connect ChatGPT to an authenticated, synthetic development MCP probe without touching production.

**Architecture:** Continue the current Hono/Workers architecture. Recover the previous OAuth qualification contract selectively and adapt its transport; use a dedicated development Worker with no production database binding, or a supported tunnel to an isolated local probe. D1 persistence tasks follow only after full live qualification.

**Tech Stack:** TypeScript, Cloudflare Workers/workerd, existing Vitest Worker harness, maintained MCP TypeScript SDK, managed OAuth candidate Auth0.

**Spec:** `docs/superpowers/specs/2026-11-14-chatgpt-workers-continuation.md`

## Global Constraints

- Baseline: `34a0c8b4b9590326403c96383459cf3c33ab968a`.
- No production deployments, migrations, auth changes, or bindings.
- No real customer data; no send/payment tools; no production owner provisioning.
- Recover missing prior work rather than silently recreating it.
- Provider secrets/private Apple keys belong in secure settings, never chat or committed files.

## Review Focus

- Missing/wrong audience, issuer, signature, expiry or scope must deny tool access.
- Unsupported HTTP methods and streaming lifecycle must terminate correctly.
- OAuth metadata must match actual client-requested scopes and token audience.
- Development configuration must contain no production binding or fallback.
- Authentication success must not be reported as full Apple identity/revocation qualification.

### Task 1: Recover evidence and prepare development tenant

**Files:** Recover `scripts/qualify-cloud-auth.ts`, `test/auth-provider-contract.test.ts`, and `docs/chatgpt-managed-oauth-qualification.md` into a temporary comparison checkout first. Keep evidence under ignored `.superpowers/sdd/chatgpt-integration/`.

- [ ] Obtain the historical archive/path; inspect the complete task diff and accepted reviews before selecting files.
- [ ] Create a dedicated Auth0 development tenant and record its nonsecret issuer domain. Owner confirmed it does not yet exist.
- [ ] Follow current official Auth0/OpenAI docs to create separate native/ChatGPT clients, register the exact actual callback, configure Apple securely, and establish the development resource and explicit API scope.
- [ ] Record the task base, selected files, adaptation changes and missing live gates. Review before code adaptation.

### Task 2: Adapt the isolated probe and verify it locally

**Files:** Exact recovered interfaces and resulting file list must be recorded after Task 1; they are unavailable now. Expected Worker boundaries: a dedicated probe entry point/config, recovered JWT contract module, and `test/worker/` transport/authorization regressions. Do not wire the probe into `src/worker.ts` production routes.

- [ ] Pin the recovered contracts and SDK version against current official MCP and OpenAI documentation before implementation.
- [ ] Write/run failing workerd tests for accepted/rejected JWTs, protected-resource challenge, scope enforcement, method rejection and request lifecycle. Record RED output.
- [ ] Implement the smallest Worker transport adaptation with synthetic read-only tool output and isolated configuration. No D1 binding is needed for this stateless milestone.
- [ ] Run focused tests, existing Node and Worker suites, lint, Node build, Worker bundle and `git diff --check`; record actual results.
- [ ] Commit the scoped adaptation, obtain independent spec/quality review, fix blockers and record re-review.

### Task 3: Reach ChatGPT and capture actual linking evidence

**Files:** `docs/chatgpt-managed-oauth-qualification.md`; ignored sanitized evidence ledger.

- [ ] Establish an authorized development HTTPS endpoint via separate staging Worker or supported tunnel; inspect its target/config before publication.
- [ ] Link the actual ChatGPT development app using the portal's exact callback and configured development client.
- [ ] Run a protected synthetic tool from ChatGPT and confirm unauthenticated/wrong-scope denial. Capture sanitized request/resource/scope evidence without bearer tokens or personal identity payloads.
- [ ] Record first milestone separately from pending full P1T1b Apple continuity, rotation/reuse, and revocation gates.
- [ ] Complete full live qualification before starting owner enrollment or dependent production integration work.

## Later plan adaptation gate

Recover Parts 1–4 before rewriting their exact interfaces. Replace PostgreSQL transaction and migration assumptions task-by-task with D1 constraints/batches, conditional mutation gates, tested numbering and commit-safe feed ordering. Retain approved product behavior and native atomic outbox/number consumption requirements. Do not claim this milestone plan replaces the missing detailed plans.

## Current external inputs

Auth0 development tenant creation and historical archive transfer are pending. Neither local synthetic tests nor a plan can substitute for real provider/ChatGPT account access.
