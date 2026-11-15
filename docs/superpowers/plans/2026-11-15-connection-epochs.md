# Connection Epoch Authorization Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development task-by-task with independent review. This is the load-bearing continuation of the foundation review's residual token-time finding, not a second patch wave for command ordering.

**Goal:** Bind cloud access to the issuer-signed connection generation and prepare a free-tier, authorization-code-only managed-provider issuance path.

**Architecture:** D1 compares a signed epoch to its active revision; an isolated token authorizer derives that epoch only after cryptographic JWT verification. A scoped Auth0 Action issues the epoch/namespace on initial code authorization using a private state hook; every MCP refresh is denied. Native refresh remains separate. Neither component adds a public route or production deployment in this plan.

**Tech Stack:** Existing TypeScript, jose, Hono, Workers/D1, real workerd tests and exact CJS Action tests.

**Spec:** `docs/superpowers/specs/2026-11-15-connection-epochs.md`; account foundation and Workers/D1 adaptation remain binding.

## Global Constraints

- No PostgreSQL/Cloud Run code, production bindings/deployment/migration/merge, or legacy ownership backfill.
- No tokens, secrets, opaque Apple identity or provider bodies in logs, MCP output or committed evidence.
- Native proof and purchase ownership are not established by internal TypeScript inputs.
- A current database epoch cannot substitute for a missing, old or unsigned token epoch. No iat-only authorization fallback.
- Keep the synthetic probe and native qualifier behavior unchanged; cloud admission is a separate future gate.
- User requires keeping Auth0 without Enterprise for a small family/friends audience. No refresh/session metadata APIs or paid dependency. Actual access-only ChatGPT expiry/reauthorization must pass before exposing cloud data/tools.

## Review Focus

1. An old access token stays denied after reconnect, independent of iat or delayed signing; every MCP refresh request must be rejected.
2. A legacy refresh grant must not obtain cloud authority even with missing scope or ambiguous protocol.
3. A current-epoch claim with the wrong signed owner/client/audience/device must not authorize.
4. Hook timeout, redirect, oversized/invalid body and secret failures must not leak inputs or fall back to a current epoch.
5. Exact Unicode identity behavior and native/probe isolation must survive shared Action changes.

## Task 1 — Signed epoch admission

**Files:** modify `src/chatgpt/accounts/connections.ts` and its Worker tests; create `src/chatgpt/auth/cloud-token.ts` and `test/worker/cloud-token.test.ts`.

**Interfaces:**
- Add required `connectionEpoch:number` to repository `authorize` input. Validate positive safe integer; reject missing/malformed values with null before D1. Require `cloud_connections.revision = connectionEpoch` in the same active-device query. Keep existing iat checks, status/ownership and fixed errors.
- Add `getActiveEpoch({identity,clientId}):Promise<number|null>`: one primary read requiring active connection and active owned approving device, exact identity/client; invalid context returns null, database failures remain sanitized. This read is for the future trusted issuer hook, never a replacement for token epoch verification.
- `createCloudTokenAuthorizer(db:D1Database, dependencies: { authorizationNamespace:string; keys?: JWTVerifyGetKey; now?:()=>number })` returns `(token:string)=>Promise<(CloudOwner & {connectionEpoch:number;authorizationNamespace:string})|null>`; the namespace is mandatory trusted external configuration, captured at construction; missing/malformed values throw fixed CloudTokenConfigurationError(invalid_configuration). Require canonical unpadded base64url 32 bytes via decode/re-encode. Key resolver and clock are trusted internal test dependencies. Default keys use per-request remote JWKS at the fixed development issuer with a two-second network timeout. No request-supplied config/URLs. Token bounded to 12000 characters.
- Fixed issuer `https://dev-i8usug5fp48kepvr.us.auth0.com/`, audience `https://simpli-invoice-mcp-dev.simplitica.co/mcp`, azp `tpc_5RjUULWf1V9koMnfWj1Xg3`, required scope `cloud:access`, algorithm RS256, claim `https://simplitica.co/apple_identity`, numeric epoch claim `https://simplitica.co/connection_epoch`, and exact configured namespace claim `https://simplitica.co/authorization_namespace`. Namespace must match before D1; never derive configuration from token or database. exp/subject/iat required; identity strings retain the shared well-formed Unicode restrictions. Signature/claim failures return null; operational D1 failure propagates only sanitized CloudConnectionError, not token/provider errors.

- [x] Write real D1 behavioral RED for missing/old epoch despite a recent iat, token minted while disconnected, reconnect with backward clock/current revision, and old delayed issuance. Update existing authorization tests with explicit immutable simulated token epochs; never fetch the latest epoch in a test helper to authorize an old token.
- [x] Implement the repository predicate and active-epoch lookup; observe targeted GREEN.
- [x] Write actual signed RS256/jose Worker RED tests: current epoch accepted; tampered epoch/signature, wrong algorithm/issuer/audience/client/owner, missing scope/subject/exp/iat, expired/future time and malformed epoch denied; old epoch remains denied after reconnect even with a new iat; device revocation denies both lookup and token admission. Literal U+FFFD/valid pairs and malformed Unicode preserve account constraints. No DB access for invalid token contexts; D1 failure sanitized. Simulate a restored/cloned database retaining its active revision: old namespace tokens must fail under a rotated external namespace; new namespace+correct epoch positive control must pass. Invalid namespace configuration rejects before DB.
- [x] Implement fixed-config authorizer, then run targeted tests GREEN and final relevant Worker/Node/lint/typecheck/build checks once. Independently review, commit and push feature branch; no public binding or provider change.

## Task 2 — Access-only issuer Action and authenticated lookup

**Files:** modify exact `scripts/auth0/development-apple-identity.cjs` and its tests/runbook mirror; share fixed development constants/canonical namespace validation in `src/chatgpt/auth/configuration.ts` (adapt cloud-token without changing its public contract) if needed to avoid copied predicates; create `src/chatgpt/auth/epoch-hook.ts`, `test/worker/cloud-epoch-hook.test.ts`, `test/development-cloud-epoch-action.test.ts`.

**Interfaces:**
- `createEpochHook(db:D1Database, secret:string, authorizationNamespace:string)` validates/captures the same canonical external namespace as Task1 and returns Hono app serving only `POST /api/internal/oauth/connection-epoch`. Future dev routing mounts it deliberately; this task adds no deployed route. Require canonical development native API host in Request URL. Hook credential is canonical base64url 32 bytes (43 characters), sent as Bearer, compared with timingSafeEqual after format/length checks. Invalid configured secret returns 503; unauthorized returns 401 before body read.
- Request strict JSON `{appleIdentity:string}` only, decoded body<=4096bytes and two-second acquisition limit. Fix issuer/client to Task1 constants server-side. Active lookup returns 200 `{"active":true,"epoch":N,"namespace":"configured-value"}`; inactive 200 `{"active":false}`. Unsupported method 405; wrong path 404; malformed body 400; timeout 408; operational failure 503. All JSON no-store; no personal data/errors in responses or logs.
- Action hook URL fixed to `https://simpli-invoice-native-dev.simplitica.co/api/internal/oauth/connection-epoch`; secret name `CLOUD_CONNECTION_LOOKUP_TOKEN`. Only exact MCP client's literal `oidc-basic-profile` initial protocol is accepted. Every `oauth2-refresh-token`, absent/unknown/other protocol is denied for this client regardless of scopes, with no lookup or new epoch; native first-party flow retains behavior. Initial code flow with `cloud:access` fetches active epoch+namespace, validates the coherent response, and sets both signed claims. No refresh/session/user metadata APIs. Secret/hook/shape failures deny with fixed reasons, no value/credential/body logs. Fetch/read shares two-second deadline, no redirects, max 1024 response bytes, strict response shape. Synthetic probe initial authorization remains usable without cloud lookup.

- [ ] Write real Worker D1 hook RED tests for active/inactive/revoked-device state, exact ownership, credential and URL/method/body/deadline limits, and fixed operational errors; implement GREEN.
- [ ] Execute exact Action artifact against a real disposable HTTP fixture, with mock Auth0 API call recording: initial coherent epoch/namespace issuance, unconditional refresh denial with omitted/scoped requests and missing/unknown protocol denial, wrong client/audience/identity, hook failure/timeout/redirect/oversize/invalid shapes, no metadata API dependency and safe logs. Retain existing identity/client/audience/native qualifier coverage; update MCP refresh expectations to the intentional access-only policy while preserving native refresh. Observe RED, implement, then GREEN.
- [ ] Update source mirror/runbook with pending access-only live qualification and secret-entry steps; run final relevant checks, independent review and feature-branch push. Do not deploy the Action, expose the hook or ask the owner to enter secrets before the concrete source/config is reviewed.

## Next live gate

Keep Auth0 without Enterprise. After source/config review, make only the development MCP client authorization-code-only, disable offline access on its separate MCP API, and remove offline_access from the ChatGPT connection configuration. Keep native API/client refresh settings unchanged. Qualify actual ChatGPT connection, expiry, OAuth challenge/new sign-in and disconnect/reapproval with a short temporary development token lifetime; restore the ordinary 24-hour target afterward. Every cloud request still checks D1 epoch/device/entitlement, so expiry length does not delay an explicit local disconnect. Live interop remains required before cloud authoring; never introduce an unsupported refresh fallback or pay for a feature.

App Attest/StoreKit and public enrollment are separate subsequent work; the owner has an iPhone available when the test build is ready. Cold restore requires maintenance, revoking restored authority, rotating external namespace, draining/updating all instances and fresh native/OAuth proofs as specified.
