# Production deployment (Cloud Run + Cloud SQL)

Simplitica backend serves:

- **Apple subscriptions**: client sync + App Store Server Notifications v2
- **Stripe Connect**: Express onboarding, invoice Checkout links, webhooks

Entitlements remain **StoreKit-authoritative** on the device. Stripe payment status is **server-authoritative** for online invoice collection.

## Prerequisites

1. **GCP project** with billing enabled
2. APIs: Cloud Run, Cloud SQL Admin, Secret Manager, Artifact Registry
3. **Apple root certificates** in `certs/` (same as local dev)
4. **Stripe** Connect platform (test + live keys and webhook secrets)
5. **Node 20+** for local builds; production runs the Docker image

## Architecture

```
iOS App  -->  Cloud Run (simplitica-backend)  -->  Cloud SQL (PostgreSQL)
                    |                                    ^
Stripe webhooks ----+                                    |
App Store ASSN -----+                                    |
```

## 1. Cloud SQL (PostgreSQL)

```bash
gcloud sql instances create simplitica-db \
  --database-version=POSTGRES_16 \
  --tier=db-f1-micro \
  --region=us-central1

gcloud sql databases create simplitica --instance=simplitica-db
gcloud sql users create simplitica --instance=simplitica-db --password=CHANGE_ME
```

**Connection string for Cloud Run** (Unix socket):

```
postgresql://simplitica:PASSWORD@/simplitica?host=/cloudsql/PROJECT_ID:us-central1:simplitica-db
```

Store as Secret Manager secret `DATABASE_URL`.

## 2. Secret Manager

Create secrets (never commit values):

| Secret | Description |
|--------|-------------|
| `DATABASE_URL` | Postgres URL (socket form above) |
| `STRIPE_SECRET_KEY` | **Platform** test secret `sk_test_...` (not per-customer) |
| `STRIPE_WEBHOOK_SECRET` | **Platform** test webhook `whsec_...` |
| `STRIPE_SECRET_KEY_LIVE` | Platform live secret (when going live) |
| `STRIPE_WEBHOOK_SECRET_LIVE` | Platform live webhook secret |
| `HOME_DEPOT_DATA_API_KEY` | OpenWeb Ninja direct key (`ak_...`) for live material pricing |
| `SIMPLITICA_CLIENT_API_KEY` | Shared secret for iOS app (`X-API-Key` on `/v1/pricing/*`). Create before deploy: `./scripts/set-client-api-key-secret.sh` |

Optional Apple / app secrets if not using plain env vars.

With Terraform, `DATABASE_URL` and platform Stripe secrets are created automatically; add `home_depot_data_api_key` to `terraform.tfvars` to provision `HOME_DEPOT_DATA_API_KEY`. Cloud Run deploy (`.github/workflows/deploy-cloud-run.yml`) mounts it via `--set-secrets`.

**After adding the secret**, redeploy Cloud Run so `/v1/pricing/materials` is available (route ships with simplitica-backend main).

### Pricing route protection (client API key)

When `SIMPLITICA_CLIENT_API_KEY` is set on the server:

- `POST /v1/pricing/wages` and `POST /v1/pricing/materials` require header `X-API-Key: <same value>`
- Rate limit: **30 requests/minute** per key (or per IP if the header is missing)
- `GET /health` stays public; `/health/ready` reports `pricing.client_api_key_required: true`

If the env var is **unset**, pricing routes stay open (local dev / gradual rollout).

**Rollout**

```bash
# 1. Generate + store in GCP (prints key for iOS)
./scripts/set-client-api-key-secret.sh

# 2. voice-invoice Config/Subscription.xcconfig (and Xcode Cloud env)
#    SIMPLITICA_CLIENT_API_KEY = <same hex key>

# 3. Push backend + redeploy Cloud Run (workflow mounts the secret)

# 4. Rebuild/reinstall iOS app
```

Smoke test with auth:

```bash
SIMPLITICA_CLIENT_API_KEY=your-key ./scripts/smoke-pricing.sh
```

## Stripe Connect model (platform vs customer)

Contractors connect **their own** Stripe so clients can pay invoices online (Invoice Simple–style). The app uses **Stripe Connect Express**:

1. Contractor taps **Settings → Get Paid Online → Connect With Stripe** in the iOS app.
2. Backend creates a Stripe **connected account** and returns an onboarding URL.
3. Contractor completes identity/bank setup on Stripe’s site.
4. Invoice payment links charge the **connected account**; funds go to the contractor’s Stripe balance.

| Role | Stripe account | API keys in app? |
|------|----------------|------------------|
| **Simplitica (platform)** | Your company’s Connect platform account | No — keys live only on the server (Secret Manager) |
| **Each contractor** | Express connected account | No — onboarded via hosted Connect flow |

The backend maps `X-Business-Id` → `stripeAccountId` in Postgres. Platform secrets (`STRIPE_SECRET_KEY`, webhooks) let the server create connected accounts and Checkout sessions on behalf of contractors; they are **not** the contractor’s keys.

API contract: `voice-invoice/docs/STRIPE_CONNECT_API.md`.

## Platform Stripe setup checklist

Complete these steps **once** for Simplitica’s platform account (not per customer).

### 1. Create and configure the platform account

- [ ] Sign up at [Stripe Dashboard](https://dashboard.stripe.com) for **Simplitica** (your business).
- [ ] **Settings → Connect** → enable Connect; choose **Express** accounts.
- [ ] Set platform country to match `STRIPE_PLATFORM_COUNTRY` (default `US`).

### 2. Test-mode keys (development / TestFlight)

- [ ] **Developers → API keys** → copy **Secret key** (`sk_test_...`) → `terraform.tfvars` → `stripe_secret_key`, or GSM `STRIPE_SECRET_KEY`.
- [ ] Deploy backend (or run locally) so you have a public webhook URL for test mode.

### 3. Test-mode webhook

- [ ] **Developers → Webhooks → Add endpoint**
- [ ] URL: `https://<cloud-run-url>/v1/webhooks/stripe` (local: use [Stripe CLI](https://stripe.com/docs/stripe-cli) `stripe listen --forward-to localhost:3000/v1/webhooks/stripe`)
- [ ] Events: `account.updated`, `checkout.session.completed`, `payment_intent.succeeded`
- [ ] Copy **Signing secret** (`whsec_...`) → `stripe_webhook_secret` / GSM `STRIPE_WEBHOOK_SECRET`

### 4. Onboarding return URLs (platform-wide)

Set on Cloud Run / GitHub Actions (HTTPS; may redirect to the app):

- [ ] `STRIPE_CONNECT_RETURN_URL` — e.g. `https://simplitica.co/stripe/return`
- [ ] `STRIPE_CONNECT_REFRESH_URL` — e.g. `https://simplitica.co/stripe/refresh`

### 5. Live mode (App Store production)

- [ ] Toggle Dashboard to **Live**; repeat API key + webhook for live mode.
- [ ] Store `sk_live_...` and live `whsec_...` in GSM (`STRIPE_SECRET_KEY_LIVE`, `STRIPE_WEBHOOK_SECRET_LIVE`) or add to `terraform.tfvars` and re-apply.
- [ ] Set GitHub variable / Cloud Run `STRIPE_MODE=live`.

### 6. Validate contractor flow (not platform setup)

- [ ] In TestFlight: **Connect With Stripe** → complete onboarding.
- [ ] Create invoice payment link → pay with test card `4242 4242 4242 4242`.
- [ ] Confirm `GET .../payment-status` returns `"status": "paid"`.

Customers do **not** need to create Stripe apps, paste `sk_live_...`, or configure webhooks themselves.

## 3. Stripe Dashboard (quick reference)

Same as the checklist above:

1. **Connect**: Express accounts for `STRIPE_PLATFORM_COUNTRY`.
2. **Webhooks**: `https://<cloud-run-url>/v1/webhooks/stripe` with events `account.updated`, `checkout.session.completed`, `payment_intent.succeeded`.
3. **Onboarding URLs**: `STRIPE_CONNECT_RETURN_URL`, `STRIPE_CONNECT_REFRESH_URL`.

Set `STRIPE_MODE=test` or `live` on Cloud Run to select the key pair.

## 3b. Custom domain and TLS (`simpli-invoice.simplitica.co`)

Terraform creates a **Cloud Run domain mapping** with a **Google-managed certificate** (no separate load balancer in this repo). See [`terraform/cloud_run_domain.tf`](terraform/cloud_run_domain.tf).

**Order matters:**

1. `terraform apply` with `enable_api_domain_mapping = false` (default).
2. Deploy Cloud Run once (GitHub Actions push to `main`, or manual `gcloud run deploy`).
3. Set `enable_api_domain_mapping = true` in `terraform.tfvars` and `terraform apply` again.
4. If apply failed earlier with *Route simplitica-backend does not exist*: `terraform state rm 'google_cloud_run_domain_mapping.api[0]'` then re-apply.
5. Add DNS records from `terraform output -json api_domain_dns_records` at your DNS host (`simplitica.co`).
6. Wait for certificate provisioning (often 15–60 minutes after DNS propagates).

```bash
terraform output -raw api_base_url
terraform output -json api_domain_dns_records
curl -fsS "$(terraform output -raw api_base_url)/health"
```

Stripe webhooks: `https://simpli-invoice.simplitica.co/v1/webhooks/stripe`  
iOS: `SIMPLITICA_BACKEND_BASE_URL = https://simpli-invoice.simplitica.co`

To disable custom domain in Terraform, set `api_custom_domain = ""` in `terraform.tfvars`.

## 4. Build and deploy Cloud Run

```bash
export PROJECT_ID=your-project
export REGION=us-central1
export IMAGE=$REGION-docker.pkg.dev/$PROJECT_ID/simplitica/simplitica-backend:latest

gcloud auth configure-docker $REGION-docker.pkg.dev

docker build -t $IMAGE .
docker push $IMAGE

gcloud run deploy simplitica-backend \
  --image=$IMAGE \
  --region=$REGION \
  --platform=managed \
  --allow-unauthenticated \
  --port=8080 \
  --cpu=1 \
  --memory=512Mi \
  --min-instances=1 \
  --timeout=60 \
  --add-cloudsql-instances=$PROJECT_ID:$REGION:simplitica-db \
  --set-secrets=DATABASE_URL=DATABASE_URL:latest,STRIPE_SECRET_KEY=STRIPE_SECRET_KEY:latest,STRIPE_WEBHOOK_SECRET=STRIPE_WEBHOOK_SECRET:latest \
  --set-env-vars=NODE_ENV=production,STORAGE_BACKEND=postgres,RUN_MIGRATIONS=true,APPLE_ENVIRONMENT=Production,STRIPE_MODE=test,STRIPE_CONNECT_RETURN_URL=https://your-domain.com/stripe/return,STRIPE_CONNECT_REFRESH_URL=https://your-domain.com/stripe/refresh,STRIPE_PLATFORM_COUNTRY=US,SIMPLI_INVOICE_BUNDLE_ID=co.simplitica.simpli-invoice,SIMPLI_INVOICE_APP_APPLE_ID=YOUR_APPLE_ID
```

Use `cloudbuild.yaml` for Cloud Build–triggered deploys (adjust substitutions).

### Public access (org policy)

CI uses `--allow-unauthenticated`, but some GCP organizations **block** `allUsers` on Cloud Run (`FAILED_PRECONDITION: ... organization policy`). Symptoms:

- Deploy warning: *Setting IAM policy failed*
- `gcloud run services add-iam-policy-binding ... allUsers` fails
- Unauthenticated `curl` to the service returns **403**

The GitHub smoke check uses an **authenticated** identity token instead. For **Stripe webhooks** and the **iOS app**, the API must be reachable without auth — ask your org admin to allow public Cloud Run invoker, or front the service with a load balancer / DNS setup that matches your policy.

## 4b. GitHub Actions (CI/CD)

Pushes to `main` run tests, build a Docker image, push to Artifact Registry, and deploy to Cloud Run via [`.github/workflows/deploy-cloud-run.yml`](.github/workflows/deploy-cloud-run.yml). Pull requests run tests only.

### One-time GCP setup (Terraform — preferred)

Terraform in [`terraform/`](terraform/) provisions APIs, Artifact Registry, service accounts, Workload Identity Federation, Cloud SQL, and Secret Manager in one apply. See [`terraform/README.md`](terraform/README.md) for remote state setup.

```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars: project_id, stripe_secret_key, stripe_webhook_secret

terraform init
terraform plan
terraform apply
```

Map `terraform output` values to GitHub (see table below). Sections **1** and **2** above are handled by Terraform (`DATABASE_URL` is written to Secret Manager automatically).

Set GitHub variable `GCP_RUNTIME_SERVICE_ACCOUNT` to `terraform output -raw runtime_service_account_email` (the deploy workflow passes it as `--service-account`). Set `PUBLIC_API_URL` to `terraform output -raw api_base_url` (e.g. `https://simpli-invoice.simplitica.co`) for smoke checks and documentation.

<details>
<summary>Manual gcloud setup (fallback)</summary>

```bash
export PROJECT_ID=your-project
export PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')

gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  sqladmin.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  --project="$PROJECT_ID"

gcloud artifacts repositories create simplitica \
  --repository-format=docker \
  --location=us-central1 \
  --project="$PROJECT_ID"

gcloud iam service-accounts create github-deployer \
  --display-name="GitHub Actions deployer" \
  --project="$PROJECT_ID"

for ROLE in roles/run.admin roles/artifactregistry.writer roles/iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:github-deployer@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role="$ROLE"
done

gcloud iam service-accounts create simplitica-backend \
  --display-name="Simplitica backend runtime" \
  --project="$PROJECT_ID"

for ROLE in roles/cloudsql.client roles/secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:simplitica-backend@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role="$ROLE"
done

gcloud iam workload-identity-pools create github-pool \
  --location=global \
  --project="$PROJECT_ID"

gcloud iam workload-identity-pools providers create-oidc github-provider \
  --location=global \
  --workload-identity-pool=github-pool \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --project="$PROJECT_ID"

gcloud iam service-accounts add-iam-policy-binding \
  "github-deployer@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-pool/attribute.repository/barbosv/simplitica-backend" \
  --project="$PROJECT_ID"
```

WIF provider resource name (GitHub secret `GCP_WORKLOAD_IDENTITY_PROVIDER`):

```
projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github-pool/providers/github-provider
```

</details>

### GitHub repository configuration

**Secrets** (Settings → Secrets and variables → Actions → Secrets)

| Secret | Value |
|--------|-------|
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `terraform output -raw workload_identity_provider` |
| `GCP_SERVICE_ACCOUNT` | `terraform output -raw github_deployer_service_account_email` |

**Variables** (Settings → Secrets and variables → Actions → Variables)

| Variable | Example / Terraform output | Purpose |
|----------|---------------------------|---------|
| `GCP_PROJECT_ID` | `terraform output -raw project_id` | GCP project ID |
| `GCP_REGION` | `terraform output -raw region` | Deploy region |
| `GCP_ARTIFACT_REPO` | `terraform output -raw artifact_registry_repository` | Artifact Registry repo name |
| `GCP_CLOUD_SQL_INSTANCE` | `terraform output -raw cloud_sql_instance_connection_name` | Cloud SQL instance connection |
| `GCP_RUNTIME_SERVICE_ACCOUNT` | `terraform output -raw runtime_service_account_email` | Cloud Run runtime SA (`--service-account` on deploy) |
| `PUBLIC_API_URL` | `terraform output -raw api_base_url` | Public API base for smoke check (no trailing slash) |
| `CLOUD_RUN_SERVICE` | `simplitica-backend` | Cloud Run service name |
| `STRIPE_MODE` | `test` | Stripe key selection |
| `APPLE_ENVIRONMENT` | `Production` | App Store environment |
| `STRIPE_CONNECT_RETURN_URL` | `https://your-domain.com/stripe/return` | Required in production |
| `STRIPE_CONNECT_REFRESH_URL` | `https://your-domain.com/stripe/refresh` | Required in production |
| `SIMPLI_INVOICE_BUNDLE_ID` | `co.simplitica.simpli-invoice` | iOS bundle ID |
| `SIMPLI_INVOICE_APP_APPLE_ID` | `1234567890` | App Store Connect App Apple ID |
| `STRIPE_PLATFORM_COUNTRY` | `US` | Stripe Connect country |

After the first successful deploy, set the iOS app **`SIMPLITICA_BACKEND_BASE_URL`** to the Cloud Run URL:

```bash
gcloud run services describe simplitica-backend \
  --region=us-central1 \
  --format='value(status.url)'
```

## 5. Environment variables

| Variable | Required (prod) | Notes |
|----------|-----------------|--------|
| `NODE_ENV` | Yes | `production` |
| `PORT` | No | Cloud Run sets `8080` |
| `STORAGE_BACKEND` | Yes | `postgres` |
| `DATABASE_URL` | Yes | From Secret Manager |
| `RUN_MIGRATIONS` | Recommended | `true` applies `migrations/*.sql` on boot |
| `APPLE_ENVIRONMENT` | Yes | `Production` for App Store |
| `SIMPLI_INVOICE_APP_APPLE_ID` | Yes | App Store Connect App Apple ID |
| `STRIPE_MODE` | Yes | `test` or `live` |
| `STRIPE_SECRET_KEY` | Yes (test) | Or live key when `STRIPE_MODE=live` |
| `STRIPE_WEBHOOK_SECRET` | Yes | Matching webhook endpoint |
| `STRIPE_CONNECT_RETURN_URL` | Yes | HTTPS return after onboarding |
| `STRIPE_CONNECT_REFRESH_URL` | Yes | HTTPS refresh link |
| `STRIPE_PLATFORM_COUNTRY` | No | Default `US` |

Local dev without Postgres: `STORAGE_BACKEND=file` and `DATA_DIR=./data` (subscriptions only; Stripe uses in-memory stores for businesses/payments).

## 6. Health checks

| Path | Use |
|------|-----|
| `GET /health` | Liveness — `{ "ok": true }` |
| `GET /health/ready` | Readiness — DB `SELECT 1` when using Postgres |

## 7. iOS app

Set **`SIMPLITICA_BACKEND_BASE_URL`** (Info.plist / xcconfig) to the Cloud Run URL (no trailing slash required).

API contract: `voice-invoice/docs/STRIPE_CONNECT_API.md`

## 8. Validation checklist

### Automated

```bash
npm ci && npm run build && npm test
```

### Local stack (Postgres + API)

```bash
cp .env.example .env   # fill Stripe keys
docker compose up --build
```

### Stripe CLI (webhooks)

```bash
stripe listen --forward-to localhost:3000/v1/webhooks/stripe
```

### curl (Stripe Connect)

```bash
BUSINESS_ID="550e8400-e29b-41d4-a716-446655440000"
INVOICE_ID="660e8400-e29b-41d4-a716-446655440001"
BASE="http://localhost:3000"

curl -sS -X POST "$BASE/v1/stripe/connect/onboard" -H "X-Business-Id: $BUSINESS_ID"
curl -sS "$BASE/v1/stripe/connect/status" -H "X-Business-Id: $BUSINESS_ID"
```

See `docs/STRIPE_CONNECT_API.md` in the iOS repo for full examples.

### TestFlight

1. Deploy backend with test Stripe keys.
2. Complete Connect onboarding in Settings.
3. Create payment link on an invoice; pay with test card `4242...`.
4. Return via `simpli-invoice://payment/success?invoiceId=...`
5. Confirm `GET .../payment-status` returns `"status": "paid"`.

## 9. App Store Server Notifications

Production URL:

`https://<cloud-run-url>/v1/webhooks/app-store`

Use ASC “Send Test Notification” after deploy.

## Deploy order

1. Cloud SQL + secrets + migrations (`RUN_MIGRATIONS=true` on first deploy).
2. Cloud Run service + Stripe webhooks.
3. iOS `SIMPLITICA_BACKEND_BASE_URL` → Cloud Run URL.
4. TestFlight validation.
