# Connection Epoch Authorization Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development task-by-task with independent review. This is the load-bearing continuation of the foundation review's residual token-time finding, not a second patch wave for command ordering.

**Goal:** Bind cloud access to the issuer-signed connection generation and prepare the scoped managed-provider issuance path.

**Architecture:** D1 compares a signed epoch to its active revision; an isolated token authorizer derives that epoch only after cryptographic JWT verification. A scoped Auth0 Action carries the same epoch through refresh metadata using a private authenticated state hook. Neither component adds a public route or production deployment in this plan.

**Tech Stack:** Existing TypeScript, jose, Hono, Workers/D1, real workerd tests and exact CJS Action tests.

**Spec:** `docs/superpowers/specs/2026-11-15-connection-epochs.md`; account foundation and Workers/D1 adaptation remain binding.

## Global Constraints

- No PostgreSQL/Cloud Run code, production bindings/deployment/migration/merge, or legacy ownership backfill.
- No tokens, secrets, opaque Apple identity or provider bodies in logs, MCP output or committed evidence.
- Native proof and purchase ownership are not established by internal TypeScript inputs.
- A current database epoch cannot substitute for a missing, old or unsigned token epoch. No iat-only authorization fallback.
- Keep the synthetic probe and native qualifier behavior unchanged; cloud admission is a separate future gate.
- Live Auth0 metadata availability/rotation and actual third-party cloud grant continuity must pass before exposing cloud data/tools.

## Review Focus

1. A freshly signed token from an old refresh grant must remain denied after reconnect, independent of iat or delayed signing.
2. An old refresh grant without metadata must not obtain cloud authority after scope/config changes.
3. A current-epoch claim with the wrong signed owner/client/audience/device must not authorize.
4. Hook timeout, redirect, oversized/invalid body and secret failures must not leak inputs or fall back to a current epoch.
5. Exact Unicode identity behavior and native/probe isolation must survive shared Action changes.

## Task 1 — Signed epoch admission

**Files:** modify `src/chatgpt/accounts/connections.ts` and its Worker tests; create `src/chatgpt/auth/cloud-token.ts` and `test/worker/cloud-token.test.ts`.

**Interfaces:**
- Add required `connectionEpoch:number` to repository `authorize` input. Validate positive safe integer; reject missing/malformed values with null before D1. Require `cloud_connections.revision = connectionEpoch` in the same active-device query. Keep existing iat checks, status/ownership and fixed errors.
- Add `getActiveEpoch({identity,clientId}):Promise<number|null>`: one primary read requiring active connection and active owned approving device, exact identity/client; invalid context returns null, database failures remain sanitized. This read is for the future trusted issuer hook, never a replacement for token epoch verification.
- `createCloudTokenAuthorizer(db:D1Database, dependencies?: { keys?: JWTVerifyGetKey; now?:()=>number })` returns `(token:string)=>Promise<(CloudOwner & {connectionEpoch:number})|null>`; key resolver and clock are trusted internal test dependencies. Default keys use per-request remote JWKS at the fixed development issuer with a two-second network timeout. No request-supplied config/URLs. Token bounded to 12000 characters.
- Fixed issuer `https://dev-i8usug5fp48kepvr.us.auth0.com/`, audience `https://simpli-invoice-mcp-dev.simplitica.co/mcp`, azp `tpc_5RjUULWf1V9koMnfWj1Xg3`, required scope `cloud:access`, algorithm RS256, claim `https://simplitica.co/apple_identity`, numeric epoch claim `https://simplitica.co/connection_epoch`. exp/subject/iat required; identity strings retain the shared well-formed Unicode restrictions. Signature/claim failures return null; operational D1 failure propagates only sanitized CloudConnectionError, not token/provider errors.

- [ ] Write real D1 behavioral RED for missing/old epoch despite a recent iat, token minted while disconnected, reconnect with backward clock/current revision, and old delayed issuance. Update existing authorization tests with explicit immutable simulated token epochs; never fetch the latest epoch in a test helper to authorize an old token.
- [ ] Implement the repository predicate and active-epoch lookup; observe targeted GREEN.
- [ ] Write actual signed RS256/jose Worker RED tests: current epoch accepted; tampered epoch/signature, wrong algorithm/issuer/audience/client/owner, missing scope/subject/exp/iat, expired/future time and malformed epoch denied; old epoch remains denied after reconnect even with a new iat; device revocation denies both lookup and token admission. Literal U+FFFD/valid pairs and malformed Unicode preserve account constraints. No DB access for invalid token contexts; D1 failure sanitized.
- [ ] Implement fixed-config authorizer, then run targeted tests GREEN and final relevant Worker/Node/lint/typecheck/build checks once. Independently review, commit and push feature branch; no public binding or provider change.

## Task 2 — Scoped issuer metadata and authenticated lookup

**Files:** modify exact `scripts/auth0/development-apple-identity.cjs` and its tests/runbook mirror; create `src/chatgpt/auth/epoch-hook.ts`, `test/worker/cloud-epoch-hook.test.ts`, `test/development-cloud-epoch-action.test.ts`.

**Interfaces:**
- `createEpochHook(db:D1Database, secret:string)` returns Hono app serving only `POST /api/internal/oauth/connection-epoch`. Future dev routing mounts it deliberately; this task adds no deployed route. Require canonical development native API host in Request URL. Hook credential is canonical base64url 32 bytes (43 characters), sent as Bearer, compared with timingSafeEqual after format/length checks. Invalid configured secret returns 503; unauthorized returns 401 before body read.
- Request strict JSON `{appleIdentity:string}` only, decoded body<=4096bytes and two-second acquisition limit. Fix issuer/client to Task1 constants server-side. Active lookup returns 200 `{"active":true,"epoch":N}`; inactive200 `{"active":false}`. Unsupported method405; wrong path404; malformed body400; timeout408; operational failure503. All JSON no-store; no personal data/errors in responses or logs.
- Action hook URL fixed to `https://simpli-invoice-native-dev.simplitica.co/api/internal/oauth/connection-epoch`; secret name `CLOUD_CONNECTION_LOOKUP_TOKEN`. The exact source artifact handles cloud scopes and issuer-owned refresh metadata key `simplitica_connection_epoch`. Initial code flow with `cloud:access` fetches active epoch, sets numeric signed custom claim and canonical string metadata. Refresh with metadata must preserve the same value and match active lookup; missing/old/malformed metadata cannot upgrade from a database lookup. API absence, hook/secret failure or mismatch denies cloud issuance with fixed reasons; native/probe-only paths retain behavior. No logs of values/credentials/bodies. Fetch/read shares a two-second deadline, no redirects, max1024 response bytes, strict response shape.

- [ ] Write real Worker D1 hook RED tests for active/inactive/revoked-device state, exact ownership, credential and URL/method/body/deadline limits, and fixed operational errors; implement GREEN.
- [ ] Execute exact Action artifact against a real disposable HTTP fixture, with mock Auth0 API call recording: initial epoch issuance, at least two rotations preserving metadata, old/missing metadata and explicit cloud refresh upgrade denial, wrong client/audience/identity, hook failure/timeout/redirect/oversize/invalid shapes, metadata API missing and safe logs. Preserve all existing Action tests. Observe RED, implement, then GREEN.
- [ ] Update source mirror/runbook with pending live qualification and secret-entry steps; run final relevant checks, independent review and feature-branch push. Do not deploy the Action, expose the hook or ask the owner to enter secrets before the concrete source/config is reviewed.

## Next live gate

Prepare a separate focused owner-assisted qualification against actual SDK/tenant behavior before public use. Prefer the public native client to establish refresh metadata capability without collecting the confidential secret; then observe actual third-party cloud authorization/rotation and old-grant rejection. Unknown/unavailable feature behavior fails closed. App Attest/StoreKit and public enrollment remain separate subsequent work; the owner has an iPhone available when the test build is ready.
