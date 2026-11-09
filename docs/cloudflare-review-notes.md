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
