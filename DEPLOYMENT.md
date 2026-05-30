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
| `STRIPE_SECRET_KEY` | Test secret `sk_test_...` |
| `STRIPE_WEBHOOK_SECRET` | Test webhook `whsec_...` |
| `STRIPE_SECRET_KEY_LIVE` | Live secret (when going live) |
| `STRIPE_WEBHOOK_SECRET_LIVE` | Live webhook secret |

Optional Apple / app secrets if not using plain env vars.

## 3. Stripe Dashboard

1. **Connect**: enable Express accounts for your platform country (`STRIPE_PLATFORM_COUNTRY`, default `US`).
2. **Webhooks**: endpoint `https://<cloud-run-url>/v1/webhooks/stripe`
   - Events: `account.updated`, `checkout.session.completed`, `payment_intent.succeeded`
   - Create **separate** test and live endpoints (or one URL with mode-specific secrets on the same service).
3. **Onboarding URLs** (HTTPS; can redirect to the app):
   - `STRIPE_CONNECT_RETURN_URL` — e.g. `https://simplitica.co/stripe/return`
   - `STRIPE_CONNECT_REFRESH_URL` — e.g. `https://simplitica.co/stripe/refresh`

Set `STRIPE_MODE=test` or `live` on Cloud Run to select key pair.

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

## 4b. GitHub Actions (CI/CD)

Pushes to `main` run tests, build a Docker image, push to Artifact Registry, and deploy to Cloud Run via [`.github/workflows/deploy-cloud-run.yml`](.github/workflows/deploy-cloud-run.yml). Pull requests run tests only.

### One-time GCP setup (Workload Identity Federation)

```bash
export PROJECT_ID=your-project
export PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')

# Enable APIs
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  sqladmin.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  --project="$PROJECT_ID"

# Artifact Registry
gcloud artifacts repositories create simplitica \
  --repository-format=docker \
  --location=us-central1 \
  --project="$PROJECT_ID"

# Deploy service account
gcloud iam service-accounts create github-deployer \
  --display-name="GitHub Actions deployer" \
  --project="$PROJECT_ID"

for ROLE in roles/run.admin roles/artifactregistry.writer roles/iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:github-deployer@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role="$ROLE"
done

# Runtime service account (Cloud Run execution)
gcloud iam service-accounts create simplitica-backend \
  --display-name="Simplitica backend runtime" \
  --project="$PROJECT_ID"

for ROLE in roles/cloudsql.client roles/secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:simplitica-backend@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role="$ROLE"
done

# Workload Identity Pool + OIDC provider
gcloud iam workload-identity-pools create github-pool \
  --location=global \
  --project="$PROJECT_ID"

gcloud iam workload-identity-pools providers create-oidc github-provider \
  --location=global \
  --workload-identity-pool=github-pool \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --project="$PROJECT_ID"

# Allow only barbosv/simplitica-backend to impersonate the deploy SA
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

### GitHub repository configuration

**Secrets** (Settings → Secrets and variables → Actions → Secrets)

| Secret | Value |
|--------|-------|
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | Full WIF provider resource name (see above) |
| `GCP_SERVICE_ACCOUNT` | `github-deployer@PROJECT_ID.iam.gserviceaccount.com` |

**Variables** (Settings → Secrets and variables → Actions → Variables)

| Variable | Example | Purpose |
|----------|---------|---------|
| `GCP_PROJECT_ID` | `your-project` | GCP project ID |
| `GCP_REGION` | `us-central1` | Deploy region |
| `GCP_ARTIFACT_REPO` | `simplitica` | Artifact Registry repo name |
| `GCP_CLOUD_SQL_INSTANCE` | `your-project:us-central1:simplitica-db` | Cloud SQL instance connection |
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
