# simplitica-backend

Shared backend for **Simpli Invoice**, **SimpliList**, and future iOS apps: **Apple subscription sync**, **Stripe Connect** invoice payments, and **SimpliList Publix BOGO deals proxy**.

## Features

- `GET /health`, `GET /health/ready`
- `POST /v1/subscriptions/sync`, `GET /v1/entitlements`, `POST /v1/webhooks/app-store`
- `POST /v1/stripe/connect/onboard`, `GET /v1/stripe/connect/status`
- `POST /v1/invoices/:invoiceId/payment-link`, `GET /v1/invoices/:invoiceId/payment-status`
- `POST /v1/webhooks/stripe`
- `POST /v1/pricing/materials` — Home Depot material pricing for estimate suggestions (iOS client)
- `POST /v1/pricing/wages` — Cached BLS OEWS wage lookups for estimate suggestions (iOS client)
- **SimpliList** (when `SIMPLILIST_BACKEND_API_KEY` is set):
  - `GET /v1/deals/publix/stores`, `GET /v1/deals/publix/bogo`

Persistence: **PostgreSQL** (production) or **file** (`STORAGE_BACKEND=file` for local subscription-only dev).

### Pricing environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `RETAILERAPI_KEY` | No | RetailerAPI key (`rk_live_...`) for live Home Depot product lookups (tried first) |
| `RETAILERAPI_BASE_URL` | No | Default: `https://api.retailerapi.com/v1` |
| `HOME_DEPOT_DATA_API_KEY` | No | OpenWeb Ninja direct key (`ak_...`) or RapidAPI key (fallback after RetailerAPI) |
| `BLS_API_KEY` | No | BLS Public API registration key for cached OEWS wage lookups |
| `SIMPLITICA_CLIENT_API_KEY` | No | When set, `/v1/pricing/*` requires matching `X-API-Key` header (shared with iOS `Subscription.xcconfig`) |
| `HOME_DEPOT_DATA_API_BASE_URL` | No | Default: `https://api.openwebninja.com/realtime-homedepot-data` (direct). Set RapidAPI URL if using RapidAPI. |
| `HOME_DEPOT_DATA_API_HOST` | No | **RapidAPI only** — sets `X-RapidAPI-Host`. Leave unset for OpenWeb direct (`x-api-key` auth). |

Live materials pricing uses a provider chain: **RetailerAPI → OpenWeb Ninja → catalog fallback** (`src/pricing/material_catalog.json`). Configure at least one live key for `source: "home_depot"` responses.

OpenWeb Ninja direct API uses `items_per_page`, `zipcode`, and `store_id` query params (not `limit` / `zip`). When `/search` is unavailable, the client falls back to `/item-lookup`.

Keys starting with `ak_` auto-select OpenWeb direct mode. Without any live provider key, `/v1/pricing/materials` returns catalog fallback prices only.

## Quick start

```bash
npm ci
cp .env.example .env   # optional: Stripe + DATABASE_URL
npm run dev
```

With Postgres:

```bash
docker compose up --build
```

Run migrations manually:

```bash
DATABASE_URL=postgres://... npm run migrate
```

## Tests

```bash
npm test
```

## Deployment

See **[DEPLOYMENT.md](./DEPLOYMENT.md)** for Cloud Run, Cloud SQL, Secret Manager, and Stripe setup.

iOS API contract: `voice-invoice/docs/STRIPE_CONNECT_API.md`
