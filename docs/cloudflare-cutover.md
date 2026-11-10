# Simplitica Cloudflare cutover

The implementation can be built and tested without cloud credentials. Creating remote resources, deploying, switching DNS, and retiring GCP require access to the owning accounts. Nothing in the local test/build commands changes production.

## Local development and checks

Use Node 24 (CI uses Node 24). Run `npm ci`, copy `.dev.vars.example` to `.dev.vars`, then:

```sh
npm run db:migrate:local
npm run dev:worker
```

Validation:

```sh
npm run lint
npm run build
npm test
npm run test:worker
npm run build:worker
```

The legacy Node server and PostgreSQL migrations remain available for comparison and rollback preparation. The Worker never loads PostgreSQL or filesystem persistence. Shared route contracts in `src/http.ts` let both runtimes run the same business handlers. Worker readiness checks D1.

Apple's unmodified verification library runs with bundled committed Apple trust roots. A CommonJS alias for `node-fetch` supplies the SDK's `.buffer()` response method and a 30-second deadline using native fetch. Both Wrangler and the Worker tests declare that alias. Do not remove it or disable online checks. The Worker test chain and private leaf key are synthetic test assets, not Apple/customer/production keys. Tests fix the verification date to the fixture date for recorded OCSP responses; regenerate with `python test/worker/fixtures/generate-apple-chain.py` when changing the fixtures (requires OpenSSL).

## Free-plan envelope

Official limits checked 2026-11-09:

| Resource | Free allowance |
| --- | --- |
| Worker requests | 100,000/day per account |
| CPU | 10 ms per HTTP request or Cron invocation |
| D1 rows read | 5 million/day |
| D1 rows written | 100,000/day |
| D1 storage | 5 GB total per account |

Sources: [Worker limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).

These are account-wide allowances and may be shared with other projects. Free limits can stop requests/queries instead of generating paid-tier overage charges; a paid account follows its paid-plan pricing. Do not upgrade or change the account's plan automatically. RetailerAPI/OpenWeb/payment fees and domain registration are separate.

The local bundle is approximately 390 KiB gzip. That establishes bundle size, not production CPU eligibility. Staging must measure cold and warm CPU, particularly Apple chain/OCSP verification and Stripe checkout. Do not cut over on a free plan if the 10 ms CPU allowance prevents those flows from working. Report the measurements and agree on an alternative first.

Every guarded request writes a global quota counter; pricing/Stripe/deal routes also write a scoped counter. Cache misses, indexed writes, and cleanup add writes too, so the D1 write quota can be reached before 100,000 HTTP requests. Inspect D1 rows read/written and Worker CPU/error metrics during staging and after cutover. Every five minutes the scheduled handler deletes up to 1,000 expired quota rows and 1,000 expired cache rows using indexed expiration queries; it never deletes payment/subscription/event records.

## Account setup and staging

1. Confirm the Cloudflare account owns `simplitica.co`. Public nameservers were `curt.ns.cloudflare.com` and `simone.ns.cloudflare.com` on 2026-11-09, which confirms DNS hosting only. The Worker must be deployed in **that same account** (or one that can see the zone). A Wrangler login that can deploy Workers but lists zero zones cannot attach `simpli-invoice.simplitica.co` or a staging hostname.
2. Use Wrangler's login flow locally or configure `CLOUDFLARE_API_TOKEN` securely. Limit the token to the owning account's Workers Scripts and D1 permissions needed for deployments and migrations. Do not paste tokens, Stripe keys, or database passwords into chat. Before staging, run `npx wrangler whoami` and confirm the account can list the `simplitica.co` zone.
3. Create separate empty databases in the dashboard or using `npx wrangler d1 create simplitica-staging` and, later, `npx wrangler d1 create simplitica-production`. Record their real IDs. No PostgreSQL import is needed because the user confirmed no records need preservation.
4. Create GitHub environments `cloudflare-staging` and `cloudflare-production`. Set required reviewers on production and restrict its deployment branches to `main`. A named environment alone does not enable required reviewers. CI also rejects production dispatches from another branch.
5. Set environment variables `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_DATABASE_ID`, and `WORKER_SMOKE_URL` (the corresponding `https://simplitica-backend-staging.<account-subdomain>.workers.dev` or `https://simplitica-backend.<account-subdomain>.workers.dev`). Set the API token as an environment **secret** `CLOUDFLARE_API_TOKEN`.
6. Set `STRIPE_MODE` explicitly to `test` or `live` for production. Staging always uses test mode. Set production `SIMPLI_INVOICE_APP_APPLE_ID` to its actual App Store app ID. Optional configuration includes bundle ID, country, CORS origin, and onboarding return/refresh URLs. Set matching environment variables locally when preparing configuration outside CI.
7. Generate a temporary account-specific config:

```sh
node scripts/prepare-worker-config.mjs staging .wrangler/deploy-staging.json
```

The script refuses missing/invalid account/database IDs. It writes only allowlisted non-secret settings into ignored `.wrangler/` files. Do not add real secret values to Wrangler `vars`.

8. Provision runtime secrets using the Cloudflare dashboard or interactive commands, for example:

```sh
npx wrangler secret put STRIPE_SECRET_KEY --config .wrangler/deploy-staging.json
npx wrangler secret put STRIPE_WEBHOOK_SECRET --config .wrangler/deploy-staging.json
npx wrangler secret put SIMPLITICA_CLIENT_API_KEY --config .wrangler/deploy-staging.json
npx wrangler secret put SIMPLILIST_BACKEND_API_KEY --config .wrangler/deploy-staging.json
```

For a new Worker, Wrangler may offer to create the named Worker to store secrets; this is a staging bootstrap, with no custom domain attached. If needed, create an empty named Worker in the dashboard first. Preserve the API keys already embedded in released apps. Secrets stored in GitHub cannot be read back; obtain existing values securely from their current owning secret store.

Optional secrets: `RETAILERAPI_KEY`, `HOME_DEPOT_DATA_API_KEY`, `BLS_API_KEY`. Without live pricing keys the existing catalog/template fallback behavior remains. Production live mode requires `STRIPE_SECRET_KEY_LIVE` and `STRIPE_WEBHOOK_SECRET_LIVE`; test mode requires the unsuffixed test pair. Select keys matching the mode and webhook endpoint. Keep `PUBLIX_DEALS_FIXTURE=false` for live deal checks.

9. Dispatch **Deploy Cloudflare Worker → staging**. It validates configuration and required secret names, applies D1 migrations explicitly, deploys, and checks `/health` and `/health/ready`. Migrations do not run during requests. The workflow does not attach a custom hostname.
10. Test subscription sync and App Store notifications with legitimate sandbox signed data. Test Stripe Connect onboarding, checkout, payment status reconciliation, exact-byte signature rejection, and duplicate webhook delivery using the Stripe sandbox and its matching endpoint secret.
11. Test live Publix/Flipp, RetailerAPI/OpenWeb, and BLS from the deployed Worker. Controlled local upstream responses do not prove those providers allow Cloudflare egress. Confirm fallback responses retain their source labels. Measure CPU and D1 usage; verify CORS, API keys, device limits, and body limits.

The readiness route reports whether provider keys are configured; it does not disclose keys and does not prove upstream health. The original invoice API uses `X-Business-Id` as its existing identity contract; this migration does not redesign that contract.

## Production cutover

1. Inventory the actual iOS base URLs for Simpli Invoice and SimpliList, including released versions and Xcode Cloud configuration. The repo documents `https://simpli-invoice.simplitica.co`. A published app using a `run.app` address does not follow a DNS switch; update that client or retain a temporary forwarding service until it transitions. Do not retire the old address while it is still needed.
2. Inventory Apple notification URLs, Stripe test/live webhook endpoints (including connected-account event delivery), onboarding return/refresh URLs, checkout return URLs, and CORS origins. Record the existing DNS record, Cloud Run domain mapping, TTL, and target for rollback.
3. Prepare the production database/config/secrets and deploy to its `workers.dev` URL. Verify production Apple app ID/environment and selected Stripe mode. Match the target mode to current intended operation; migration is not authorization to switch test payments to live automatically.
4. Complete the staging validation checklist on production configuration. Leave current GCP DNS in place until it succeeds.
5. In Cloudflare Worker settings, attach the custom domain `simpli-invoice.simplitica.co` to the production Worker. If an existing DNS record conflicts, replace only that recorded backend record as part of this cutover. Leave the apex website and other subdomains alone. Wait for TLS/domain activation.
6. Check health/readiness through the hostname and verify the apps' subscription/deal/pricing flows and Stripe sandbox/live mode as intended. Verify notifications and payments reach D1. A site health response alone is insufficient evidence for payment readiness.
7. Avoid independent writes to two backends. Route webhooks and clients to the same authoritative backend. New records can be created immediately after switching traffic.

## Rollback and targeted GCP retirement

If validation fails before new writes, restore the captured DNS/domain configuration and original notification endpoints. After any new payment/subscription writes, reconcile/export the D1 records and Stripe state before restoring a PostgreSQL backend. Starting with an empty database does not make later rollback data-free. Do not blindly reset either database.

Only after hostname/app/payment verification succeeds:

- Disable any GCP Cloud Build repository triggers and other external auto-deploy triggers. The repo's Cloud Run GitHub workflow is now manual and requires its explicit legacy-deploy checkbox; pushes run validation only.
- List the exact backend-owned Cloud Run service, Cloud SQL instance/databases, domain mapping, Artifact Registry images, retained SQL backups and associated storage from the owning GCP project and Terraform state. Check whether anything else uses them.
- Prepare a targeted Terraform plan or equivalent exact-resource deletion commands for that inventory. Review it before applying destructive operations. Never run an unreviewed `terraform destroy` or delete the entire project.
- Remove the unused backend service and SQL instance after recording required configuration and verifying nothing needs the old `run.app` endpoint. Remove unneeded billable backups/images separately; preserve unrelated website/services.
- Recheck GCP resource inventory and billing after deletion. Routing to Cloudflare alone does not stop Google charges. Confirm Cloudflare remains on the intended plan and monitor usage there.

Deployment, CPU/upstream staging verification, DNS cutover, and retirement remain pending until account access is available. No cost saving is claimed until the paid resources have actually been retired.
