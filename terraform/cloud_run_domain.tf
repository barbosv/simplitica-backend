# Maps a custom domain to the Cloud Run service (Google-managed TLS certificate).
# Prerequisite: Cloud Run service must exist — set enable_api_domain_mapping = true after first deploy.
resource "google_cloud_run_domain_mapping" "api" {
  count    = var.enable_api_domain_mapping && var.api_custom_domain != "" ? 1 : 0
  location = var.region
  name     = var.api_custom_domain

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = var.cloud_run_service_name
  }

  depends_on = [google_project_service.required]
}
