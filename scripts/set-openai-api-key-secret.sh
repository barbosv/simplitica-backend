#!/usr/bin/env bash
# Provision or update OPENAI_API_KEY in GCP Secret Manager for Cloud Run.
#
# Usage:
#   ./scripts/set-openai-api-key-secret.sh sk-...
#   OPENAI_API_KEY=sk-... ./scripts/set-openai-api-key-secret.sh
set -euo pipefail

KEY="${1:-${OPENAI_API_KEY:-}}"
if [[ -z "$KEY" ]]; then
  echo "Usage: $0 <openai_api_key>" >&2
  echo "Or set OPENAI_API_KEY in the environment." >&2
  exit 1
fi

if ! command -v gcloud >/dev/null; then
  echo "gcloud CLI is required." >&2
  exit 1
fi

SECRET_ID="OPENAI_API_KEY"
if gcloud secrets describe "$SECRET_ID" >/dev/null 2>&1; then
  printf '%s' "$KEY" | gcloud secrets versions add "$SECRET_ID" --data-file=-
  echo "Updated secret $SECRET_ID"
else
  printf '%s' "$KEY" | gcloud secrets create "$SECRET_ID" --data-file=-
  echo "Created secret $SECRET_ID"
fi

echo "Redeploy simplitica-backend so Cloud Run mounts OPENAI_API_KEY."
