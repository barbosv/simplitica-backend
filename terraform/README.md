# Terraform — GCP foundation

Provisions one-time infrastructure for simplitica-backend:

- GCP APIs
- Artifact Registry (`simplitica`)
- Service accounts (`github-deployer`, `simplitica-backend`) and IAM
- GitHub Workload Identity Federation
- Cloud SQL (PostgreSQL 16)
- Secret Manager (`DATABASE_URL`, Stripe keys)

Cloud Run is **not** managed here; `[.github/workflows/deploy-cloud-run.yml](../.github/workflows/deploy-cloud-run.yml)` deploys on push to `main`.



## Prerequisites

- [Terraform](https://developer.hashicorp.com/terraform/install) >= 1.5
- [gcloud CLI](https://cloud.google.com/sdk/docs/install) with permission to create resources in the target project
- Billing enabled on the GCP project

### Install gcloud (macOS)

Use Homebrew — do **not** unpack the SDK inside this directory:

```bash
brew install --cask google-cloud-sdk
```

Restart your shell, then verify:

```bash
gcloud --version
```

If you already downloaded `google-cloud-sdk/` here by mistake, remove it:

```bash
rm -rf google-cloud-sdk
```

### Authenticate (required for Terraform)

Terraform uses **Application Default Credentials**. Both steps are needed:

```bash
gcloud auth login
gcloud auth application-default login
gcloud config set project YOUR_GCP_PROJECT_ID
```

The first command signs you into the CLI; the second writes credentials Terraform reads. Without `application-default login`, `terraform plan` fails with *"could not find default credentials"*.

## Quick start

```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars: project_id, stripe_secret_key, stripe_webhook_secret

terraform init -migrate-state   # first time only, after creating gs://simplitica-terraform
terraform plan
terraform apply
```

Copy outputs into GitHub repository settings (see [DEPLOYMENT.md](../DEPLOYMENT.md) section 4b).

## Stripe Connect model (platform vs customer)

Invoice payments use **Stripe Connect Express** (same pattern as Invoice Simple). Two different Stripe accounts are involved:


| Who                  | Account type                  | Stored where                                                                           | Who configures it                                            |
| -------------------- | ----------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **Simplitica (you)** | Connect **platform** account  | Secret Manager: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (from `terraform.tfvars`) | You once in [Stripe Dashboard](https://dashboard.stripe.com) |
| **Each contractor**  | **Connected** Express account | Postgres `stripeAccountId` per `X-Business-Id`                                         | Customer in the app (**Settings → Connect With Stripe**)     |


`stripe_secret_key` and `stripe_webhook_secret` in `terraform.tfvars` are **your platform keys only**. Customers never paste API keys into the app; they complete Stripe-hosted onboarding and receive payments into **their** Stripe account.

Terraform does **not** store per-customer Stripe secrets. See [DEPLOYMENT.md § Stripe Connect model](../DEPLOYMENT.md#stripe-connect-model-platform-vs-customer) and [Platform Stripe setup checklist](../DEPLOYMENT.md#platform-stripe-setup-checklist).

## Remote state (GCS)

State is stored in `**gs://simplitica-terraform`** (prefix `simplitica-backend`). The backend is configured in `[versions.tf](versions.tf)`.

### First-time setup

1. Create the bucket (one-time; bucket names are globally unique):

```bash
export PROJECT_ID=your-gcp-project-id
gcloud config set project "$PROJECT_ID"
gsutil mb -l us-central1 -p "$PROJECT_ID" gs://simplitica-terraform
gsutil versioning set on gs://simplitica-terraform
```

If the name is taken, use e.g. `simplitica-terraform-${PROJECT_ID}` and update the `backend "gcs"` block in `versions.tf`.

1. Initialize and migrate local state (if you previously used local state):

```bash
cd terraform
terraform init -migrate-state
```

Confirm when prompted to copy state to GCS.

### Fresh clone

```bash
terraform init
```

## Apply after code changes

If `terraform apply` failed partway (e.g. Cloud SQL edition or WIF provider), fix and re-run:

```bash
terraform plan
terraform apply
```

Common fixes already in this repo: `cloud_sql_edition = "ENTERPRISE"` (for `db-f1-micro`), and `attribute_condition` on the GitHub WIF provider.

## Custom API domain (TLS)

Default hostname: `simpli-invoice.simplitica.co` (`api_custom_domain`). Mapping is **off by default** (`enable_api_domain_mapping = false`) because the Cloud Run service is created by CI, not Terraform.

**Order:**

1. `terraform apply` (foundation only; domain mapping skipped).
2. Deploy Cloud Run once (push to `main` or `gcloud run deploy simplitica-backend ...`).
3. If a previous apply failed with *Route simplitica-backend does not exist*, remove the broken mapping from state:
  ```bash
   terraform state rm 'google_cloud_run_domain_mapping.api[0]' 2>/dev/null || true
  ```
4. Set `enable_api_domain_mapping = true` in `terraform.tfvars`, then `terraform apply`.
5. Configure DNS from `terraform output -json api_domain_dns_records`.
6. Set GitHub variable `PUBLIC_API_URL` to `terraform output -raw api_base_url`.

There is no separate HTTPS load balancer; Cloud Run domain mapping provisions the certificate.

## Files


| File                   | Resources                                        |
| ---------------------- | ------------------------------------------------ |
| `apis.tf`              | Required GCP APIs                                |
| `artifact_registry.tf` | Docker repository                                |
| `service_accounts.tf`  | Deploy + runtime SAs, project IAM                |
| `workload_identity.tf` | WIF pool, OIDC provider, GitHub binding          |
| `cloud_sql.tf`         | Postgres instance, database, user, password      |
| `cloud_run_domain.tf`  | Custom domain + Google-managed TLS for Cloud Run |
| `secrets.tf`           | GSM secrets and runtime SA access                |


## Updating Stripe live secrets

Add live keys to `terraform.tfvars` and re-apply, or create versions manually:

```bash
echo -n "sk_live_..." | gcloud secrets versions add STRIPE_SECRET_KEY_LIVE --data-file=-
```

## Destroy

```bash
terraform destroy
```

Set `cloud_sql_deletion_protection = false` in `terraform.tfvars` before destroying the SQL instance.