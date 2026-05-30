output "project_id" {
  description = "GCP project ID."
  value       = var.project_id
}

output "region" {
  description = "GCP region."
  value       = var.region
}

output "workload_identity_provider" {
  description = "GitHub secret GCP_WORKLOAD_IDENTITY_PROVIDER."
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "github_deployer_service_account_email" {
  description = "GitHub secret GCP_SERVICE_ACCOUNT."
  value       = google_service_account.github_deployer.email
}

output "runtime_service_account_email" {
  description = "Cloud Run --service-account (GitHub variable GCP_RUNTIME_SERVICE_ACCOUNT)."
  value       = google_service_account.runtime.email
}

output "cloud_sql_instance_connection_name" {
  description = "GitHub variable GCP_CLOUD_SQL_INSTANCE."
  value       = google_sql_database_instance.simplitica.connection_name
}

output "artifact_registry_repository" {
  description = "GitHub variable GCP_ARTIFACT_REPO."
  value       = google_artifact_registry_repository.simplitica.repository_id
}

output "artifact_registry_url" {
  description = "Docker image registry host path prefix."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.simplitica.repository_id}"
}

output "cloud_run_service_name" {
  description = "GitHub variable CLOUD_RUN_SERVICE (deployed by CI, not Terraform)."
  value       = var.cloud_run_service_name
}

output "api_custom_domain" {
  description = "Custom API hostname when domain mapping is enabled."
  value       = var.api_custom_domain != "" ? var.api_custom_domain : null
}

output "api_base_url" {
  description = "GitHub variable PUBLIC_API_URL and iOS SIMPLITICA_BACKEND_BASE_URL."
  value       = var.api_custom_domain != "" ? "https://${var.api_custom_domain}" : null
}

output "api_domain_dns_records" {
  description = "DNS records to add at your DNS host for the custom domain (after enable_api_domain_mapping and apply)."
  value = var.enable_api_domain_mapping && var.api_custom_domain != "" ? [
    for record in google_cloud_run_domain_mapping.api[0].status[0].resource_records : {
      type   = record.type
      name   = record.name
      rrdata = record.rrdata
    }
  ] : []
}
