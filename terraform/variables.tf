variable "project_id" {
  type        = string
  description = "GCP project ID."
}

variable "region" {
  type        = string
  description = "Primary GCP region for regional resources."
  default     = "us-central1"
}

variable "github_repository" {
  type        = string
  description = "GitHub repository allowed to impersonate the deploy service account (owner/name)."
  default     = "barbosv/simplitica-backend"
}

variable "workload_identity_pool_id" {
  type        = string
  description = "Workload Identity Federation pool ID."
  default     = "github-pool"
}

variable "workload_identity_provider_id" {
  type        = string
  description = "OIDC provider ID within the WIF pool."
  default     = "github-provider"
}

variable "artifact_registry_repository_id" {
  type        = string
  description = "Artifact Registry Docker repository ID."
  default     = "simplitica"
}

variable "github_deployer_service_account_id" {
  type        = string
  description = "Service account ID for GitHub Actions deploys."
  default     = "github-deployer"
}

variable "runtime_service_account_id" {
  type        = string
  description = "Service account ID for Cloud Run runtime."
  default     = "simplitica-backend"
}

variable "cloud_sql_instance_name" {
  type        = string
  description = "Cloud SQL instance name."
  default     = "simplitica-db"
}

variable "cloud_sql_tier" {
  type        = string
  description = "Cloud SQL machine tier."
  default     = "db-f1-micro"
}

variable "cloud_sql_edition" {
  type        = string
  description = "Cloud SQL edition. ENTERPRISE allows db-f1-micro; ENTERPRISE_PLUS requires db-perf-optimized-* tiers."
  default     = "ENTERPRISE"
}

variable "cloud_sql_database_name" {
  type        = string
  description = "PostgreSQL database name."
  default     = "simplitica"
}

variable "cloud_sql_user_name" {
  type        = string
  description = "PostgreSQL user name."
  default     = "simplitica"
}

variable "cloud_sql_deletion_protection" {
  type        = bool
  description = "Prevent accidental Cloud SQL instance deletion."
  default     = true
}

variable "cloud_run_service_name" {
  type        = string
  description = "Cloud Run service name (must match CLOUD_RUN_SERVICE in GitHub Actions)."
  default     = "simplitica-backend"
}

variable "api_custom_domain" {
  type        = string
  description = "Custom API hostname (e.g. simpli-invoice.simplitica.co). Leave empty to skip domain mapping."
  default     = "simpli-invoice.simplitica.co"
}

variable "enable_api_domain_mapping" {
  type        = bool
  description = "Create Cloud Run domain mapping. Set true only after the Cloud Run service exists (first deploy via CI or gcloud)."
  default     = false
}

variable "stripe_secret_key" {
  type        = string
  sensitive   = true
  description = "Stripe test secret key (sk_test_...)."
}

variable "stripe_webhook_secret" {
  type        = string
  sensitive   = true
  description = "Stripe test webhook signing secret (whsec_...)."
}

variable "stripe_secret_key_live" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Optional Stripe live secret key (sk_live_...)."
}

variable "stripe_webhook_secret_live" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Optional Stripe live webhook signing secret."
}
