resource "google_service_account" "github_deployer" {
  account_id   = var.github_deployer_service_account_id
  display_name = "GitHub Actions deployer"

  depends_on = [google_project_service.required]
}

resource "google_service_account" "runtime" {
  account_id   = var.runtime_service_account_id
  display_name = "Simplitica backend runtime"

  depends_on = [google_project_service.required]
}

locals {
  github_deployer_roles = [
    "roles/run.admin",
    "roles/artifactregistry.writer",
    "roles/iam.serviceAccountUser",
  ]

  runtime_roles = [
    "roles/cloudsql.client",
    "roles/secretmanager.secretAccessor",
  ]
}

resource "google_project_iam_member" "github_deployer" {
  for_each = toset(local.github_deployer_roles)

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.github_deployer.email}"
}

resource "google_project_iam_member" "runtime" {
  for_each = toset(local.runtime_roles)

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.runtime.email}"
}
