resource "random_password" "db" {
  length  = 32
  special = false
}

resource "google_sql_database_instance" "simplitica" {
  name             = var.cloud_sql_instance_name
  database_version = "POSTGRES_16"
  region           = var.region

  deletion_protection = var.cloud_sql_deletion_protection

  settings {
    tier    = var.cloud_sql_tier
    edition = var.cloud_sql_edition
  }

  depends_on = [google_project_service.required]
}

resource "google_sql_database" "simplitica" {
  name     = var.cloud_sql_database_name
  instance = google_sql_database_instance.simplitica.name
}

resource "google_sql_user" "simplitica" {
  name     = var.cloud_sql_user_name
  instance = google_sql_database_instance.simplitica.name
  password = random_password.db.result
}
