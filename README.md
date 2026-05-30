# simplitica-backend

Shared backend for Simpli Invoice and future iOS apps: **Apple subscription sync** and **Stripe Connect** invoice payments.

## Features

- `GET /health`, `GET /health/ready`
- `POST /v1/subscriptions/sync`, `GET /v1/entitlements`, `POST /v1/webhooks/app-store`
- `POST /v1/stripe/connect/onboard`, `GET /v1/stripe/connect/status`
- `POST /v1/invoices/:invoiceId/payment-link`, `GET /v1/invoices/:invoiceId/payment-status`
- `POST /v1/webhooks/stripe`

Persistence: **PostgreSQL** (production) or **file** (`STORAGE_BACKEND=file` for local subscription-only dev).

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
