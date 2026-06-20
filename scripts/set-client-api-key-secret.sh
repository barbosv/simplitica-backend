#!/usr/bin/env bash
# Provision or update SIMPLITICA_CLIENT_API_KEY in GCP Secret Manager for Cloud Run.
# iOS builds must use the same value in Config/Subscription.xcconfig (SIMPLITICA_CLIENT_API_KEY).
#
# Usage:
#   ./scripts/set-client-api-key-secret.sh
#   ./scripts/set-client-api-key-secret.sh <hex-key>
#   SIMPLITICA_CLIENT_API_KEY=... ./scripts/set-client-api-key-secret.sh
set -euo pipefail

KEY="${1:-${SIMPLITICA_CLIENT_API_KEY:-}}"
if [[ -z "$KEY" ]]; then
  if command -v openssl >/dev/null; then
    KEY="$(openssl rand -hex 32)"
    echo "Generated new client API key (save for iOS Subscription.xcconfig):"
    echo "$KEY"
  else
    echo "Usage: $0 <client_api_key>" >&2
    echo "Or set SIMPLITICA_CLIENT_API_KEY in the environment." >&2
    exit 1
  fi
fi

if ! command -v gcloud >/dev/null; then
  echo "gcloud CLI is required." >&2
  exit 1
fi

SECRET_ID="SIMPLITICA_CLIENT_API_KEY"
if gcloud secrets describe "$SECRET_ID" >/dev/null 2>&1; then
  printf '%s' "$KEY" | gcloud secrets versions add "$SECRET_ID" --data-file=-
  echo "Updated secret $SECRET_ID"
else
  printf '%s' "$KEY" | gcloud secrets create "$SECRET_ID" --data-file=-
  echo "Created secret $SECRET_ID"
fi

echo "Redeploy simplitica-backend so Cloud Run mounts SIMPLITICA_CLIENT_API_KEY."
echo "Add to voice-invoice Config/Subscription.xcconfig:"
echo "  SIMPLITICA_CLIENT_API_KEY = $KEY"
