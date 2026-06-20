#!/usr/bin/env bash
# Provision or update SIMPLILIST_BACKEND_API_KEY in GCP Secret Manager for Cloud Run.
# SimpliList iOS builds must use the same value in Info.plist (SimpliListBackendAPIKey).
#
# Usage:
#   ./scripts/set-simplilist-backend-api-key-secret.sh
#   ./scripts/set-simplilist-backend-api-key-secret.sh <hex-key>
#   SIMPLILIST_BACKEND_API_KEY=... ./scripts/set-simplilist-backend-api-key-secret.sh
set -euo pipefail

KEY="${1:-${SIMPLILIST_BACKEND_API_KEY:-}}"
if [[ -z "$KEY" ]]; then
  if command -v openssl >/dev/null; then
    KEY="$(openssl rand -hex 32)"
    echo "Generated new SimpliList backend API key (save for Info.plist SimpliListBackendAPIKey):"
    echo "$KEY"
  else
    echo "Usage: $0 <backend_api_key>" >&2
    echo "Or set SIMPLILIST_BACKEND_API_KEY in the environment." >&2
    exit 1
  fi
fi

if ! command -v gcloud >/dev/null; then
  echo "gcloud CLI is required." >&2
  exit 1
fi

SECRET_ID="SIMPLILIST_BACKEND_API_KEY"
if gcloud secrets describe "$SECRET_ID" >/dev/null 2>&1; then
  printf '%s' "$KEY" | gcloud secrets versions add "$SECRET_ID" --data-file=-
  echo "Updated secret $SECRET_ID"
else
  printf '%s' "$KEY" | gcloud secrets create "$SECRET_ID" --data-file=-
  echo "Created secret $SECRET_ID"
fi

echo "Redeploy simplitica-backend so Cloud Run mounts SIMPLILIST_BACKEND_API_KEY."
echo "Set in SimpliList PantrySync/Info.plist:"
echo "  SimpliListBackendBaseURL = https://<your-cloud-run-or-custom-domain>"
echo "  SimpliListBackendAPIKey = $KEY"
