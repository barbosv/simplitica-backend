# Simplitica: Cloudflare Workers and D1 migration

Status: approved by the user on 2026-11-09. Implementation planning follows.

## Intent and confirmed facts

Remove the fixed cost of running the shared Simplitica backend. The user requested Workers and D1 and confirmed there are no production customer or payment records to preserve. Start with an empty D1 database; no PostgreSQL data import is required.

Source: `barbosv/simplitica-backend`, main commit `cdf3274513c8a72f554e552f3aed8f410d7c2997`. It currently runs Fastify on Node with PostgreSQL repositories. Deployment targets Cloud Run and Cloud SQL. The website is a separate repository and is outside this migration.

Public DNS verified on 2026-11-09: simplitica.co nameservers are curt.ns.cloudflare.com and simone.ns.cloudflare.com. This establishes Cloudflare DNS hosting, but does not establish access to the owning account. No Cloudflare or GCP credentials are configured in this execution environment.

## Goals and boundaries

- Run all existing API features on one Worker with D1 persistence.
- Preserve existing paths, methods, response bodies, validation, authentication, CORS, body-size protection, and Stripe/Apple verification.
- Retain the documented production address https://simpli-invoice.simplitica.co where possible. Verify actual client configuration before cutover: clients using a run.app address will need a configuration update or temporary forwarding service.
- Support subscriptions and entitlements, Stripe Connect and invoice payment links/status, Stripe and App Store webhooks, pricing lookups, Publix deals, health endpoints, and payment/onboarding landing pages.
- Preserve existing behavior rather than adding product features or redesigning authentication.
- Target Cloudflare's free plans. No guarantee of zero charges: request/CPU/database quotas and third-party API/payment fees still apply. Do not select a paid plan or paid auxiliary service automatically.
- Never weaken certificate validation, webhook signature verification, or persistent payment/idempotency state to make the runtime work.

## Approaches

1. Full Workers + D1 migration (recommended): removes both the always-running server and PostgreSQL instance. Requires a Worker-compatible request layer and SQLite repository implementation.
2. Worker API with PostgreSQL retained: less SQL conversion, but leaves the database's ongoing charges, so it does not meet the stated cost goal.
3. Keep GCP and scale Cloud Run to zero: smaller application change, but Cloud SQL still costs money. Suitable only as temporary cost mitigation, not the target.

The user specified Workers and D1; option 1 is the proposed implementation. Router, bundling, and internal module choices below are builder recommendations rather than explicit user choices.

## Runtime and request handling

Use Wrangler and a module Worker entry point with typed runtime bindings. Prefer a small fetch-native router (Hono is a reasonable builder choice) rather than adapting Fastify's Node HTTP server. Share business logic and input schemas with existing code wherever practical. Use request-scoped context for bindings, environment configuration, repository access, and request identity; never mutate process.env per request.

Inventory every route before porting and map its success and error behavior. Keep headers, auth checks, status codes, JSON shapes, landing links, and the 256 KiB body limit compatible. Enforce limits for streamed bodies as well as declared Content-Length. Preserve production security headers. Replace Fastify rate limiting using facilities available on the free plan after checking current platform support; a D1 atomic counter with a fixed expiration window is the fallback. Document any edge-local rather than global enforcement explicitly. Do not rely on isolate memory for authoritative limits.

Bundle fixture JSON and Apple root certificate bytes at build time. Audit the full import graph for node:fs, process.cwd, file paths, synchronous crypto, and Node HTTP assumptions. Node compatibility flags are acceptable only when the required APIs actually run in workerd.

## D1 persistence

Implement the existing repository contracts for subscriptions, businesses, invoice payments, and Stripe events. Preserve primary/unique keys, lookups, foreign keys, and Stripe event deduplication. Convert PostgreSQL placeholders/types/defaults to SQLite-compatible SQL. Store timestamps consistently as UTC ISO strings, booleans as integers, and amounts as integer cents. Preserve nullable-field and conflict/update behavior.

Use parameter binding for all values. Use D1 batch transactions and atomic SQL where operations require atomicity; no read-modify-write counters. Run migrations explicitly with Wrangler before enabling the matching Worker, never at request startup. Keep PostgreSQL migrations separate for rollback reference.

Review webhook claim/processing behavior so failed handling is retryable, duplicate successful events do not apply twice, and simultaneous deliveries cannot corrupt payment state. Do not carry an existing failure mode into a new repository implementation if it breaks those guarantees.

## Apple verification and Stripe

First validate @apple/app-store-server-library in workerd with bundled root certificates, including its X.509 crypto and production online-check path. Keep bundle ID, Apple app ID, environment, certificate chain, signed transaction, signed renewal, and notification validation intact. If it cannot run, stop and document the exact missing primitive and a verified compatible approach before expanding scope. Do not replace validation with JWT decoding or silently disable production checks.

Configure Stripe's fetch HTTP client and asynchronous webhook verification using its compatible crypto provider as needed. Verify signatures against the exact request bytes. Retain test/live key selection, Connect account scoping, checkout idempotency, payment records, event handling, and onboarding/checkout return URLs.

## Caching and upstream services

Preserve RetailerAPI/OpenWeb/catalog fallback, BLS wages, and Publix/Flipp behavior. Use bounded HTTP timeouts compatible with Worker limits. Store reusable pricing/deal payloads with expiration in D1 if needed to keep upstream requests low; in-memory maps can be an optimization only. Do not cache customer payment, subscription, or authenticated responses publicly. Fixture fallback must retain its source marker. Validate upstreams from the deployed Worker because local reachability does not establish edge reachability.

## Deployment and cost control

Prepare Worker/D1 configuration, local development commands, a production deployment workflow, and a documented inventory of required variables/secrets. Secrets must use Cloudflare secret bindings or the environment's secure settings; never put values in code, documentation, logs, or chat. Existing API keys should be retained through the switch so published app builds remain compatible. GitHub secrets cannot be read back: provision credentials securely through the owning accounts as necessary.

Disable automatic Cloud Run redeployment when the Cloudflare workflow is activated, so a later push cannot recreate retired infrastructure. Protect production deployment with a deliberate workflow/environment gate. Verify current free-plan quotas against expected request volume and measured Worker CPU, particularly cold Apple verification; report limits before cutover if incompatible.

## Validation and cutover

1. Run the existing tests as a baseline, then port meaningful API contract tests to the Worker.
2. Run integration tests in workerd with local D1: migrations, persistence across requests, conflicts, nullable fields, monetary values, deduplication, retry on webhook processing failure, and limits.
3. Exercise valid/invalid signatures for Apple and Stripe in the actual runtime. Check Stripe test-mode onboarding/checkout/webhook flow in staging with account access.
4. Deploy to a staging Worker and empty staging D1. Verify health/readiness, auth/validation, pricing, live upstream behavior, webhook configuration, and measured CPU/storage/request usage.
5. With production credentials ready, create production D1, apply migrations, deploy the Worker, verify it, then attach the existing API hostname. Capture existing DNS/domain configuration before changing it. Verify Apple/Stripe webhook URLs and return links.
6. Validate production through the hostname and the apps. During transition, avoid allowing independent writes to two different databases. Roll back routing only after reconciling any records created since cutover; an empty starting database is not a guarantee that rollback remains data-free.
7. Once cutover is confirmed, identify exact backend-owned Cloud Run, Cloud SQL, container images, backups, and related resources, then retire them through a reviewed targeted infrastructure change. Do not destroy the whole GCP project or unrelated website/services. Confirm billable leftovers in billing/resource inventory; DNS switching alone does not stop charges.

## Deliverable and access boundary

Deliver a reviewable implementation branch/PR, passing automated checks, staging/production deployment instructions, and a targeted retirement checklist. Deployment and GCP retirement require secure Cloudflare/GCP account access, which is currently unavailable. Do all preparatory work that does not depend on those credentials before asking for account configuration.

## Left to the builder

Choose the router and bundling details, test harness, cache implementation, rate-limit implementation within current free-plan support, and CI mechanics. Record significant deviations, especially any verified Apple-runtime incompatibility or free-tier limit that prevents the desired behavior. No new product behavior is authorized by these implementation choices.
