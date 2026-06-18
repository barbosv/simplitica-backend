locals {
  database_url = format(
    "postgresql://%s:%s@/%s?host=/cloudsql/%s",
    var.cloud_sql_user_name,
    urlencode(random_password.db.result),
    var.cloud_sql_database_name,
    google_sql_database_instance.simplitica.connection_name,
  )

  # Static secret IDs only — never put sensitive values in for_each keys.
  stripe_secret_ids = toset(concat(
    ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
    length(nonsensitive(var.stripe_secret_key_live)) > 0 ? ["STRIPE_SECRET_KEY_LIVE"] : [],
    length(nonsensitive(var.stripe_webhook_secret_live)) > 0 ? ["STRIPE_WEBHOOK_SECRET_LIVE"] : [],
  ))

  stripe_secret_values = {
    STRIPE_SECRET_KEY            = var.stripe_secret_key
    STRIPE_WEBHOOK_SECRET        = var.stripe_webhook_secret
    STRIPE_SECRET_KEY_LIVE       = var.stripe_secret_key_live
    STRIPE_WEBHOOK_SECRET_LIVE   = var.stripe_webhook_secret_live
  }

  pricing_secret_ids = toset(
    length(nonsensitive(var.home_depot_data_api_key)) > 0 ? ["HOME_DEPOT_DATA_API_KEY"] : []
  )

  pricing_secret_values = {
    HOME_DEPOT_DATA_API_KEY = var.home_depot_data_api_key
  }
}

resource "google_secret_manager_secret" "database_url" {
  secret_id = "DATABASE_URL"

  replication {
    auto {}
  }

  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret_version" "database_url" {
  secret      = google_secret_manager_secret.database_url.id
  secret_data = local.database_url
}

resource "google_secret_manager_secret" "stripe" {
  for_each = local.stripe_secret_ids

  secret_id = each.key

  replication {
    auto {}
  }

  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret_version" "stripe" {
  for_each = local.stripe_secret_ids

  secret      = google_secret_manager_secret.stripe[each.key].id
  secret_data = local.stripe_secret_values[each.key]
}

resource "google_secret_manager_secret" "pricing" {
  for_each = local.pricing_secret_ids

  secret_id = each.key

  replication {
    auto {}
  }

  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret_version" "pricing" {
  for_each = local.pricing_secret_ids

  secret      = google_secret_manager_secret.pricing[each.key].id
  secret_data = local.pricing_secret_values[each.key]
}

resource "google_secret_manager_secret_iam_member" "runtime" {
  for_each = merge(
    { DATABASE_URL = google_secret_manager_secret.database_url.id },
    { for name, secret in google_secret_manager_secret.stripe : name => secret.id },
    { for name, secret in google_secret_manager_secret.pricing : name => secret.id },
  )

  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}
