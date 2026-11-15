# Simpli Invoice ChatGPT continuation: Workers and D1

## Owner ruling — November 14, 2026

Continue from `34a0c8b4b9590326403c96383459cf3c33ab968a`. Cloudflare Workers and D1 replace Cloud Run and PostgreSQL for this integration. The earlier ChatGPT handoff is historical context; recover its documents and qualification probe selectively, without replacing current main or importing its old runtime architecture.

The first milestone is an authenticated development MCP probe reachable from ChatGPT through an isolated staging deployment or supported tunnel. Production deployment and migrations are not authorized. Preserve the previously approved product scope: existing US iOS subscribers, one owner/business, Apple owner login through a qualified managed issuer, ChatGPT draft authoring, and native final review/PDF/sending. Auth0 remains a candidate until real qualification succeeds.

## Observed baseline

- `src/worker.ts`: Hono application and D1 binding; existing shared route handlers remain in use.
- `src/db/repositories/d1.ts`: current persisted subscription/payment repository implementation.
- `migrations/d1/0001_initial.sql`: existing D1 migration. Old PostgreSQL migration numbers do not select new D1 numbers.
- `test/worker/` and `vitest.worker.config.ts`: actual workerd tests with local D1.
- `docs/cloudflare-cutover.md`: recorded production cutover, imported historical payment data, and remaining verification gaps. This continuation has not independently verified remote status.
- Old Node/PostgreSQL code remains in the repository as legacy material. New integration work must not add dependencies on it.

## Selective recovery

The saved commit `47d1a3c` and branch `feat/chatgpt-integration` are absent locally. Searches of available attachments, repositories, Downloads, Desktop and Documents did not locate the bundle or original coordination artifacts. P1T1a implementation and historical review/test results are reported by the handoff, not locally recovered or freshly verified. Do not label a replacement probe as recovered or reopen resolved findings without new evidence.

The owner subsequently confirmed the archive is unavailable and explicitly authorized creating a replacement development probe and pushing this feature branch. Recovery is no longer a prerequisite for that task. The new implementation must be identified as a replacement, with fresh tests and review.

If the archive later becomes available, inspect it in a separate temporary checkout. Recover design/research and the qualification contract; adapt the probe transport to Workers Request/Response where needed. Do not wholesale cherry-pick the earlier runtime/dependency lockfile. Preserve original review history alongside new adaptation evidence.

## Engineering adaptation requirements

- Use D1 bindings and parameterized SQLite SQL. Replace PoolClient/BEGIN/COMMIT guidance with atomic SQL and transactional D1 batches. A zero-row conditional update is not a SQL failure: dependent writes must be gated or constrained so revision/ownership failures cannot partially succeed.
- Prove ownership uniqueness, idempotency, revision conflicts, number allocations and change-feed ordering in real local D1/workerd tests before shipping those later tasks. Do not replace these guarantees with mocked repository tests.
- Preserve decimal-string API money and versioned decimal calculations; do not inherit SQLite floating-point arithmetic for authoritative money. Preserve finalized totals and snapshots.
- Do not port PostgreSQL sequences, row locks, types or cursor assumptions literally. Document the D1 algorithm and its atomicity proof per task. Session consistency is not a substitute for a multi-statement transaction.
- Use the existing Worker test harness and a separate development configuration. No production DB binding, credentials, hostname, or fixture/customer data in the probe.
- No production auth/owner enrollment/persistence work until live provider qualification succeeds. No custom authorization server fallback or paid purchase without separate authorization.

D1 API reference checked November 14, 2026: https://developers.cloudflare.com/d1/worker-api/d1-database/

## Development probe acceptance

Expose only synthetic, read-only qualification output. Public OAuth protected-resource metadata and an unauthenticated MCP request must guide account linking; protected tools must reject invalid JWT signature, issuer, audience, expiry, scope and required verified identity. Advertise the provider's actual metadata rather than rewriting it to conceal incompatibilities. Retain the historical unsupported-method/hanging-stream regression in the adapted transport where applicable.

Use a dedicated development Auth0 tenant, separate native and ChatGPT clients, an exact portal-supplied callback URI, S256, an explicit probe API scope, and a canonical resource/audience. Apple-only owner login and stable verified identity across native and hosted login remain full qualification requirements. Do not merge by email or strip provider subject prefixes.

A successful authenticated synthetic tool call from ChatGPT completes the first milestone, not all provider qualification. Full P1T1b also requires sanitized evidence for native/hosted Apple identity continuity, scope/resource mapping, refresh rotation/reuse rejection and disconnect/revocation denial. JWT validation alone cannot prove revocation handling.

## Replacement probe engineering decisions

- Build only a separate stateless Worker, with no D1, KV, service or production bindings. Keep existing `src/worker.ts` and production Wrangler configuration unchanged.
- Use the official maintained MCP TypeScript server SDK with its web-standard per-request handler and `jose` verification. No hand-written OAuth authorization server or Node HTTP bridge.
- Protect the entire `/mcp` endpoint. Public protected-resource metadata and HTTP Bearer challenges support account linking. Only one read-only synthetic `qualification_probe` tool exists; never return personal identity or token contents.
- Require an allowlisted OAuth client (`azp`) and a namespaced Apple identity claim in a signed API token. Configure that claim through a narrowly scoped development-tenant Action. Its value is an opaque Apple identity, not an email or a stripped Auth0 subject. This still does not prove native/hosted continuity.
- JWKS networking must use the configured HTTPS issuer with bounded timeout; do not accept caller-selected JWKS URLs. Do not change provider discovery to conceal advertised OIDC scopes or unsupported behavior.
- Planned canonical resource: `https://simpli-invoice-mcp-dev.simplitica.co/mcp`; scope `probe:read`. The isolated development hostname is provisioned; the first authenticated ChatGPT call and live S256/resource/scope audit passed. At this historical snapshot, full provider qualification remained pending; the later [completed managed-provider evidence](../../chatgpt-managed-oauth-qualification.md#signed-nativehosted-continuity-passed--november-14-2026) records hosted lifecycle checks and signed native/hosted identity continuity. That completion does not establish StoreKit/App Attest verification or full product readiness. Deployment/tunnel routing must preserve that resource or deliberately recreate/reconfigure the development API if it changes.
- Push authorization applies to the reviewed `codex/chatgpt-mcp-probe` feature branch. It does not authorize merging or production deployment.
