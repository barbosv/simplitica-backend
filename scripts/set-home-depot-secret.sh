#!/usr/bin/env bash
# Provision or update HOME_DEPOT_DATA_API_KEY in GCP Secret Manager for Cloud Run.
# Usage:
#   ./scripts/set-home-depot-secret.sh ak_your_openwebninja_key
#   HOME_DEPOT_DATA_API_KEY=ak_... ./scripts/set-home-depot-secret.sh
set -euo pipefail

KEY="${1:-${HOME_DEPOT_DATA_API_KEY:-}}"
if [[ -z "$KEY" ]]; then
  echo "Usage: $0 <ak_openwebninja_key>" >&2
  echo "Or set HOME_DEPOT_DATA_API_KEY in the environment." >&2
  exit 1
fi

if ! command -v gcloud >/dev/null; then
  echo "gcloud CLI is required." >&2
  exit 1
fi

SECRET_ID="HOME_DEPOT_DATA_API_KEY"
if gcloud secrets describe "$SECRET_ID" >/dev/null 2>&1; then
  printf '%s' "$KEY" | gcloud secrets versions add "$SECRET_ID" --data-file=-
  echo "Updated secret $SECRET_ID"
else
  printf '%s' "$KEY" | gcloud secrets create "$SECRET_ID" --data-file=-
  echo "Created secret $SECRET_ID"
fi

echo "Redeploy simplitica-backend (push to main or workflow_dispatch) so Cloud Run picks up the secret."
echo "Verify: curl https://simpli-invoice.simplitica.co/health/ready"
echo "Expect: \"home_depot_key_configured\": true"
