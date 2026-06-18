#!/usr/bin/env bash
# Smoke test for /v1/pricing/materials (loads .env if present).
set -eu

cd "$(dirname "$0")/.."
PORT="${PORT:-3099}"
BASE_URL="${BASE_URL:-http://localhost:${PORT}}"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

echo "POST ${BASE_URL}/v1/pricing/materials"
curl -s -X POST "${BASE_URL}/v1/pricing/materials" \
  -H 'Content-Type: application/json' \
  -d '{"materials":["faucet","supply_lines"],"zip_code":"30075","quantity":1}' | python3 -m json.tool
