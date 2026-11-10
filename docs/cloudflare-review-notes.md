# Implementation review and remaining checks

Local verification on 2026-11-09: lint, Node build, Worker typecheck/bundle, local D1 migration, 70 Node tests and 38 actual workerd tests pass. The compiled Worker is approximately 391 KiB gzip. Stripe's package emits warnings about missing published source-map sources; verification remains enabled.

A fresh independent whole-branch review identified three important findings. All three were reproduced with failing regression tests, fixed in one pass, and verified with the full suites:

- D1 now preserves a paid invoice and its financial/session fields when a late same-key or regenerated checkout save arrives. The payment-link route rejects paid invoices, including a webhook racing with checkout creation.
- Material prices are cached individually: successful live prices retain their 24-hour lifetime; fallback prices retry after five minutes even in mixed quotes. Wages and deals retain their separate response caches.
- The GitHub deployment workflow exports all supported non-secret overrides. A test evaluates its variable mapping and runs the real generator with non-default country, quota, cache lifetime, fixture mode and provider endpoints.

## Decisions recorded during execution

- Manual execution tracking replaced skill helper scripts unavailable in the cloud filesystem. This affects bookkeeping rather than product behavior.
- Apple's SDK uses a CommonJS native-fetch adapter to supply `response.buffer()` and a bounded timeout. Both Wrangler and Worker-test aliases must retain this adapter; otherwise production OCSP checks fail.
- Bundle validation ran after the Worker entry point existed, following earlier actual-runtime verifier tests. The final bundle and full tests passed.
- Framework-neutral route interfaces share existing business handlers between Node and Hono. Both runtime suites guard this adapter boundary; a divergence could affect API compatibility.
- Route guards and persistent quotas were integrated in one commit to avoid an incompletely guarded Worker revision. The tradeoff is a larger review unit.
- Production Stripe mode is selected explicitly rather than automatically switched to live. Deployment needs the operator's intended mode and matching secrets.

## Deferred minor compatibility difference

Framework-generated errors are not byte-for-byte Fastify equivalents: oversized bodies still return 413 but use a simpler error object; malformed JSON returns 400 instead of the legacy custom parser's 500. Application-handler error responses remain shared. Check released clients' handling of these errors before cutover; clients depending on Fastify-specific error fields need adjustment or a compatibility response adapter.

## Review boundaries and pending account work

- Free-plan eligibility remains unproven until deployed cold/warm CPU measurements, especially Apple verification. The free allowance is 10 ms CPU per request; exceeding it would make the zero-cost target unsuitable without further changes.
- Provider reachability, legitimate Apple notifications, Stripe account/payment flows, actual app URLs, DNS switching and GCP retirement require account access. Local controlled upstreams are not evidence that external integrations work from Cloudflare.
- Authentication retains the existing application contract; an identity/authentication redesign is outside this migration. Existing identity-model risks remain.
- No exhaustive dependency/lockfile security audit was performed. Runtime dependencies and integration choices were reviewed; that is not a comprehensive supply-chain assessment.
- Released-client compatibility cannot be established from repository tests alone. Inventory and test actual client configuration before retiring any old endpoint.

No production service, domain, database, or billing plan was changed. Paid GCP resources still incur their existing charges until targeted retirement is performed after successful cutover.

## Staging validation (2026-11-10)

Initial deploy on personal account `434e924379669c6e66093b84b0f91902` (`vpb8447@gmail.com`) proved Workers/D1/secrets, but that account has **no** `simplitica.co` zone. Staging was recreated on the zone-owning account `ce1ed6e62f9f888ccd0582591e17e520` (`vitor.barbosa@simplitica.co`):

- Worker: `https://simplitica-backend-staging.vitor-barbosa-ce1.workers.dev` (also resolves via `*.simplitica.workers.dev`)
- D1: `simplitica-staging` id `2e7006b2-b267-47a8-ad49-603816cf1577`
- Route attached: `simpli-invoice-staging.simplitica.co/*` (DNS CNAME still required; Wrangler OAuth is zone-read-only)
- Secrets: Stripe test, client API, SimpliList (from GCP), pricing keys
- jsrsasign Workers RNG patch is required for upload (`npm run patch:jsrsasign`)

Verified against staging:

- `/health` and `/health/ready` return 200 with D1 connected and provider/key flags set.
- Apple `/v1/subscriptions/sync` and `/v1/webhooks/app-store` reject forged JWS with the shared handler errors (`Invalid signedTransactionInfo` / `Invalid signedPayload`), confirming the verifier path loads under Workers.
- Stripe webhook rejects missing/invalid signatures; Connect onboard creates a live test Express onboarding URL from the Worker; payment-link correctly refuses an account that is not charges-ready.
- Cloudflare analytics (`workersInvocationsAdaptive`) reported wall-time p50 ≈ 113 ms and p99 ≈ 271 ms over sampled staging traffic. The GraphQL schema available to this account did not expose `cpuTime`, so free-plan 10 ms CPU eligibility is still not proven. Deploy reported Worker startup ≈ 48–79 ms.
- Python/`urllib` clients can receive Cloudflare error 1010 against `workers.dev`; use a normal browser User-Agent for smoke checks.

### Blockers before production DNS cutover

1. **Staging hostname DNS:** Worker route `simpli-invoice-staging.simplitica.co/*` is configured on the zone-owning account, but Wrangler OAuth only has zone **read** (no DNS write). Create a proxied CNAME in the Cloudflare dashboard: `simpli-invoice-staging` → `simplitica-backend-staging.vitor-barbosa-ce1.workers.dev`.
2. **Current production API hostname:** `simpli-invoice.simplitica.co` is a CNAME to `ghs.googlehosted.com` (Cloud Run domain mapping). Leave it alone until staging on this account passes Apple/Stripe sandbox checks and CPU/plan decisions.
3. **Plan decision:** zone plan is Free Website; do not cut over on Workers Free until CPU for Apple OCSP/online verification is measured with paid analytics (or paid Workers is accepted). Deploy startup remains ~50–96 ms.
4. **Still needed on staging:** a completed Stripe Connect test onboarding + checkout (onboard URL creation already works), and a legitimate App Store sandbox signed transaction/notification against the Worker URL.

Safe next steps: add the staging CNAME above, verify `https://simpli-invoice-staging.simplitica.co/health`, finish sandbox payment/subscription proofs, then only replace the Google-hosted production record.
