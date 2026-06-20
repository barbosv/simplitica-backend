#!/usr/bin/env bash
# Provision or update RETAILERAPI_KEY in GCP Secret Manager for Cloud Run.
# Usage:
#   ./scripts/set-retailerapi-secret.sh rk_live_your_key
#   RETAILERAPI_KEY=rk_live_... ./scripts/set-retailerapi-secret.sh
set -euo pipefail

KEY="${1:-${RETAILERAPI_KEY:-}}"
if [[ -z "$KEY" ]]; then
  echo "Usage: $0 <rk_live_retailerapi_key>" >&2
  echo "Or set RETAILERAPI_KEY in the environment." >&2
  exit 1
fi

if ! command -v gcloud >/dev/null; then
  echo "gcloud CLI is required." >&2
  exit 1
fi

SECRET_ID="RETAILERAPI_KEY"
if gcloud secrets describe "$SECRET_ID" >/dev/null 2>&1; then
  printf '%s' "$KEY" | gcloud secrets versions add "$SECRET_ID" --data-file=-
  echo "Updated secret $SECRET_ID"
else
  printf '%s' "$KEY" | gcloud secrets create "$SECRET_ID" --data-file=-
  echo "Created secret $SECRET_ID"
fi

echo "Redeploy simplitica-backend (push to main or workflow_dispatch) so Cloud Run picks up the secret."
echo "Verify: curl https://simpli-invoice.simplitica.co/health/ready"
echo 'Expect: "retailerapi_key_configured": true'
