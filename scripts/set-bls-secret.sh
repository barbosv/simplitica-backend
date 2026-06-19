#!/usr/bin/env bash
# Provision or update BLS_API_KEY in GCP Secret Manager for Cloud Run.
# Usage:
#   ./scripts/set-bls-secret.sh your_bls_registration_key
#   BLS_API_KEY=... ./scripts/set-bls-secret.sh
set -euo pipefail

KEY="${1:-${BLS_API_KEY:-}}"
if [[ -z "$KEY" ]]; then
  echo "Usage: $0 <bls_registration_key>" >&2
  echo "Or set BLS_API_KEY in the environment." >&2
  exit 1
fi

if ! command -v gcloud >/dev/null; then
  echo "gcloud CLI is required." >&2
  exit 1
fi

SECRET_ID="BLS_API_KEY"
if gcloud secrets describe "$SECRET_ID" >/dev/null 2>&1; then
  printf '%s' "$KEY" | gcloud secrets versions add "$SECRET_ID" --data-file=-
  echo "Updated secret $SECRET_ID"
else
  printf '%s' "$KEY" | gcloud secrets create "$SECRET_ID" --data-file=-
  echo "Created secret $SECRET_ID"
fi

echo "Redeploy simplitica-backend so Cloud Run mounts BLS_API_KEY."
echo "Verify: curl https://simpli-invoice.simplitica.co/health/ready"
