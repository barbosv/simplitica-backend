#!/usr/bin/env bash
# Smoke-test pricing endpoints the same way the iOS app calls them.
# Usage: ./scripts/smoke-pricing.sh [base_url]
set -euo pipefail

BASE="${1:-https://simpli-invoice.simplitica.co}"
BASE="${BASE%/}"

echo "==> GET $BASE/health/ready"
curl -fsS "$BASE/health/ready" | python3 -m json.tool
echo

echo "==> POST $BASE/v1/pricing/wages"
curl -fsS -X POST "$BASE/v1/pricing/wages" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -d '{"soc_code":"47-2031","state_code":"GA","fallback":24}' | python3 -m json.tool
echo

echo "==> POST $BASE/v1/pricing/materials"
curl -fsS -X POST "$BASE/v1/pricing/materials" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -d '{"materials":["flooring","underlayment","supplies"],"quantity":1000,"zip_code":"30309","region_hint":"Atlanta, GA"}' | python3 -m json.tool
