# Simplitica Workers and D1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the complete Simplitica API to Workers and fresh D1 storage so its GCP backend resources can be retired.

**Architecture:** A fetch-native Worker router calls the existing business services through request-scoped environment configuration and D1 repositories. Bundle static assets; use persistent SQL for payment state, event processing, quotas, and reusable upstream cache entries. Keep the Node implementation available for contract comparison and rollback preparation until cutover is validated.

**Tech Stack:** TypeScript, Hono, Wrangler/workerd, D1/SQLite, Vitest, Stripe SDK, Apple App Store Server library if runtime verification succeeds.

**Spec:** `docs/superpowers/specs/2026-11-09-simplitica-cloudflare-design.md`

## Global Constraints

- Start with an empty D1 database; no PostgreSQL data import is required.
- Preserve existing paths, methods, response bodies, validation, authentication, CORS, body-size protection, and Stripe/Apple verification.
- Preserve production security headers and the 256 KiB body limit, including streamed bodies.
- Never weaken certificate validation, webhook signature verification, or persistent payment/idempotency state to make the runtime work.
- No paid plan or paid auxiliary service is selected automatically.
- Preserve the documented hostname `https://simpli-invoice.simplitica.co`; verify actual client URLs before cutover.
- Secret values never belong in code, documentation, logs, or chat.
- Deployment and targeted GCP retirement need account access, currently unavailable; preparation continues independently.

## Review Focus

1. Interrupted and concurrent Stripe deliveries must remain retryable without losing or duplicating payment changes (Task 3).
2. Requests without Content-Length must not bypass the 262144-byte limit; raw signed bytes must survive parsing (Task 4).
3. Concurrent D1 writes must preserve uniqueness, zero/false values, timestamps, and integer cents (Task 2).
4. Cold Worker instances must enforce quotas and reuse cached upstream data while respecting expiration (Task 5).
5. Wrong-app/environment, untrusted, expired, and tampered Apple signatures must fail in the actual Worker runtime, including online-check failures (Task 1).

---

## File and dependency map

- `src/worker.ts`: fetch entry point; request-scoped bindings/configuration/context.
- `src/worker/{bindings,env,app,http,guards}.ts`: Worker types, env normalization, router assembly, bounded body reading and middleware.
- `src/worker/routes/{health,subscriptions,stripe-connect,stripe-webhook,pricing,simplilist,landing}.ts`: route adapters preserving the corresponding existing `src/routes/` contracts.
- `src/db/repositories/d1.ts`: existing `Repositories` implementation; `src/db/d1-events.ts`: atomic Stripe processing extension.
- `migrations/d1/0001_initial.sql`: business tables plus event-processing state, quotas, and upstream cache with expiration indexes.
- `src/worker/{rate-limit,cache}.ts`: persistent counters and cache.
- `src/apple/verifier.ts` and generated `src/apple/root-certificates.ts`: injectable/bundled trust roots shared with Node without filesystem imports in the Worker graph.
- `src/stripe/client.ts`: fetch transport; Worker webhook adapter uses async verification.
- `src/pricing/materials-service.ts`, `src/simplilist/publix-weekly-ad.ts`: bundled JSON and optional cache injection without changing service responses.
- `wrangler.jsonc`, `tsconfig.worker.json`, `vitest.worker.config.ts`, `test/worker/`: staging/production configuration, build types, actual-runtime tests.
- `scripts/worker-assets.mjs`: reproducible trust-root generation from committed DER files, if required by the chosen bundler.
- `.github/workflows/{ci,deploy-worker,deploy-cloud-run}.yml`: validation, deliberate Worker deployment, prevent old automatic deployments.
- `DEPLOYMENT.md`, `.dev.vars.example`, `.gitignore`, `README.md`, `docs/cloudflare-cutover.md`: secure setup and staged cutover/retirement instructions.

### Task 1: Prove Worker compatibility and establish runtime checks

**Interfaces:** `WorkerBindings` exposes `DB: D1Database` and optional string configuration. `buildSignedDataVerifier(opts)` retains its existing signature and semantics. `readWorkerEnv(bindings: WorkerBindings): Env` parses request-scoped strings with explicit booleans and supports D1 without requiring DATABASE_URL.

- [ ] Read applicable workflow skills, create an isolated implementation worktree, and inspect environment package-install instructions. Record Node/npm versions and baseline `npm ci`, `npm run lint`, `npm run build`, `npm test` results before edits.
- [ ] Add runtime tests in `test/worker/apple-verifier.test.ts` and `test/worker/env.test.ts`: missing required production configuration rejects; strings `"false"`/`"true"` parse correctly; app configuration does not leak across two bindings objects; verifier imports and constructs inside workerd without filesystem access.
- [ ] Add meaningful Apple signature fixtures using the library's official test approach: valid trusted signatures accepted only for matching app/environment; tampered signatures, wrong trust roots, wrong app/environment, expired chain, and failed online status checks rejected. Test nested transaction/renewal data as well as notification envelopes. Fixture-only trust roots stay test-only.
- [ ] Configure the Worker Vitest harness, test D1 binding and migration loading; bundle committed Apple root certificates. Test production-mode verifier code with online checks enabled, using controlled network responses rather than skipping validation.
- [ ] Run `npm run test:worker -- test/worker/apple-verifier.test.ts test/worker/env.test.ts` and `npm run build:worker`. Confirm actual runtime import/crypto/network failures explicitly, rather than accepting mocked verifier success.
- [ ] If the library cannot support the required X.509/online behavior, document the exact blocker and stop dependent implementation before choosing a replacement architecture. If compatible, pin required compatibility flags/date and commit `build: establish verified Workers runtime`.

### Task 2: Implement D1 repositories and schema

**Interfaces:** `createD1Repositories(db: D1Database): Repositories` implements `src/db/types.ts`. Add `readiness(): Promise<boolean>` to Worker context separately from the legacy PostgreSQL context.

- [ ] Add `test/worker/d1-repositories.test.ts` against real local D1 with failing cases for every repository method: missing records, subscription ordering/conflicts, business get-or-create races, false flags, nullable update semantics, invoice idempotency uniqueness, session lookups, and mark-paid persistence.
- [ ] Create `migrations/d1/0001_initial.sql`, translating UUIDs to text, booleans to constrained integers, cents to integers, and timestamps to UTC ISO text. Keep all current primary/unique keys, foreign keys and lookup indexes.
- [ ] Implement parameterized D1 repositories preserving `Repositories` return types and existing COALESCE/update behavior. Use atomic INSERT/UPDATE RETURNING and batches where needed; avoid read-modify-write races.
- [ ] Run repository tests including concurrent inserts and separate repository instances against one DB. Assert exact cents, `false`, absent fields, ISO timestamps, and uniqueness errors. Run Worker typecheck, then commit `feat: persist backend state in D1`.

### Task 3: Make Stripe transport and event processing reliable

**Interfaces:** `createWorkerStripe(env: Env): Stripe` uses fetch transport. `processD1StripeEvent(db: D1Database, event: Stripe.Event): Promise<'processed' | 'duplicate'>` applies each supported event's database mutation and completed-event marker atomically.

- [ ] Add failing `test/worker/stripe-webhook.test.ts`: a valid signature succeeds; changing one raw byte or signing secret fails; duplicate successful delivery returns `{ok:true,duplicate:true}`; injected SQL failure returns 500 and a retry applies payment once; concurrent deliveries persist one outcome.
- [ ] Use Stripe async signature verification and compatible crypto provider. Ensure event processing SQL and completion marker are in one D1 transaction, with duplicate checks inside the transaction. Existing event handling computes only database updates, so avoid a nontransactional permanent claim before applying them.
- [ ] Cover `account.updated`, paid/unpaid checkout completion, async checkout success, intent success, unknown events and missing mappings. Keep `handleStripeWebhookEvent` reusable for the legacy route; use shared pure mutation preparation if necessary rather than weakening its contract.
- [ ] Add `test/worker/stripe-connect.test.ts`: test/live key selection, connected-account scoping, stable payment-link idempotency, correct amount/currency/metadata, status and return URLs using a controlled Stripe fetch backend.
- [ ] Run both Worker Stripe tests and legacy `test/stripe-connect.test.ts`, typecheck, and commit `feat: support Stripe payments and retryable webhooks on Workers`.

### Task 4: Port the full API contract and request guards

**Interfaces:** `createWorkerApp(): Hono<{Bindings: WorkerBindings}>`; default entry `fetch(request: Request, env: WorkerBindings, ctx: ExecutionContext): Promise<Response>`; `readBoundedBody(request: Request, maxBytes = 262144): Promise<Uint8Array>`; per-request services never use mutable global configuration.

- [ ] Inventory exact routes, schemas, error shapes and landing HTML in existing `src/routes/` and authentication middleware; pin representative contract cases in `test/worker/api-contract.test.ts` before implementing adapters.
- [ ] Add failing `test/worker/http-guards.test.ts`: 262144 bytes permitted, 262145 rejected with 413, streamed/chunked over-limit rejected, malformed JSON rejected, raw-byte verification preserved, auth precedes expensive upstream work, allowed/disallowed CORS origins and production security headers match expected behavior.
- [ ] Implement router adapters for all existing health, subscriptions, App Store webhook, Stripe, pricing, Publix and landing routes. Share schemas/services when useful. Preserve existing error precedence, status codes, HTML and response bodies.
- [ ] Implement D1 health/readiness without PostgreSQL imports. Preserve pricing/SimpliList configuration indicators; readiness returns 503 on an unavailable DB.
- [ ] Assert every inventoried route is exercised, including absent configuration and invalid inputs. Run existing tests plus Worker contracts and build; commit `feat: serve the Simplitica API through Workers`.

### Task 5: Persist quotas/caches and bound upstream work

**Interfaces:** `consumeRateLimit(db: D1Database, key: string, limit: number, now?: number): Promise<{allowed:boolean;retryAfter:number}>`; `D1Cache.get<T>(key: string): Promise<T|null>`; `D1Cache.set<T>(key: string, value: T, ttlMs: number): Promise<void>`.

- [ ] Add failing `test/worker/rate-limit.test.ts`: concurrent requests, separate Worker contexts, counter expiration, and exact limits 120/min globally, 10/min for Stripe Connect/invoice routes, 30/min for pricing, configured SimpliList per-device limit defaulting to 60/min. Preserve existing key selection and JSON errors.
- [ ] Implement atomic fixed-window SQL quotas (no in-memory authority) with bounded expiration cleanup. Rate-limit storage outages fail closed for guarded routes rather than silently permitting unlimited calls; health remains available.
- [ ] Add `test/worker/cache.test.ts` and upstream tests: hits persist across separate contexts, expiry refetches, ZIP/store cache keys return the correct storeNumber, force refresh works, cache keys include all pricing inputs, fallback fixtures remain labeled, private API responses are never publicly cached.
- [ ] Inject D1 cache at service boundaries, bundle material and Publix fixture JSON, and add bounded abort signals to provider fetches. Preserve provider chain and response fields. Test timeouts and provider failures with controlled upstream responses.
- [ ] Run quota/cache/provider tests, full lint/build/tests, inspect the Worker bundle for filesystem and PostgreSQL dependencies, then commit `feat: persist Worker quotas and upstream caches`.

### Task 6: Prepare secure deployments, cutover and retirement

**Interfaces:** npm scripts `dev:worker`, `build:worker`, `test:worker`, `db:migrate:local`, `db:migrate:staging`, `db:migrate:production`. Deployment workflow accepts an explicit staging/production choice and validates configuration before mutations.

- [ ] Add separate staging/production D1 bindings and Worker names in `wrangler.jsonc`; default local operation must not alter DNS or deploy to production. Document how real database IDs are configured; never commit account secrets or invented resource IDs.
- [ ] Add `.dev.vars.example` covering each existing optional/required secret and variable; ignore `.dev.vars*` except that example and ignore Wrangler state. Explain preserving shipped app API keys and Stripe test/live separation.
- [ ] Add CI for lint, legacy build/tests, Worker typecheck/tests and dry-run bundling. Add manual Worker deployment which applies D1 migrations then deploys the matching Worker and checks health/readiness. Production uses a named GitHub environment and documented required-reviewer setup; fail deployment when IDs/secrets are missing.
- [ ] Make Cloud Run deployment manual and explicitly opt-in so merging the Worker implementation cannot redeploy GCP; retain rollback instructions. Document any Cloud Build triggers that must be disabled outside GitHub as well.
- [ ] Write `docs/cloudflare-cutover.md`: secure credential setup, current free quotas and measured CPU check, staging live-upstream and Stripe sandbox flow, signed Apple checks, actual app base-URL inventory, DNS capture/switch, webhook and return URL checks, and reconciliation before rollback after new writes.
- [ ] Include a targeted GCP resource retirement checklist using actual resource/state inventory after access is available. Require successful hostname/app checks before retiring backend-owned Cloud Run/Cloud SQL, images and chargeable backups. Never run a project-wide destroy.
- [ ] Run all documented local commands and final checks; inspect workflow syntax and deployment validation behavior. Review the whole branch independently, resolve findings, and deliver a PR. Staging/production/account retirement steps remain explicitly pending if credentials are unavailable; do not claim cost savings have already occurred.

## Execution and handoff

Recommendation: native execution in this session, with an independent whole-branch review. The six tasks depend closely on shared repository and request-context interfaces, so sequential implementation keeps coordination cost low. User review of this plan and execution-method selection are the next skill-required checkpoint.
