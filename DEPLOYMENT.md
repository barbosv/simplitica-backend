# Production deployment (Simpli Invoice subscription sync)

Entitlements remain **StoreKit-authoritative** on the device. This service receives optional **client sync** payloads and **App Store Server Notifications v2** for analytics, support, and future server features.

## Prerequisites

1. **Node** 20+ (or current LTS you standardize on).
2. **Apple root certificates** in `certs/` (e.g. `AppleRootCA-G2.cer`, `AppleRootCA-G3.cer`) — ship the same files you use in development; the verifier loads them at runtime.
3. **Build**: `npm ci && npm run build` — run `node dist/server.js` (or your process manager).

## Environment variables

| Variable | Required | Notes |
|----------|----------|--------|
| `NODE_ENV` | Yes for prod | Set to `production` — enables online certificate checks in the Apple verifier. |
| `PORT` | No | Default `3000`. |
| `APPLE_ENVIRONMENT` | Yes | `Production` for App Store / ASC production; `Sandbox` for Xcode StoreKit / sandbox testers only. |
| `SIMPLI_INVOICE_BUNDLE_ID` | No | Default `co.simplitica.simpli-invoice` — must match the shipping app bundle ID. |
| `SIMPLI_INVOICE_APP_APPLE_ID` | **Yes in production** | Numeric **App Apple ID** from App Store Connect (used for verification). Omit only in local/dev if you accept weaker checks. |
| `DATA_DIR` | No | Directory for `store.json` entitlement persistence (default `./data` under cwd). |

## App registry

- Default client slug: **`simpli-invoice`** (`src/apps.ts`).
- iOS sends `appSlug: "simpli-invoice"` on sync (`StoreKitSubscriptionManager`).

## Endpoints to expose (HTTPS)

- `GET /health` — load balancer / uptime.
- `POST /v1/subscriptions/sync` — JSON from the app after purchases (JWS transaction).
- `GET /v1/entitlements` — headers `X-App-Account-Token` (UUID); optional `X-App-Slug` / `X-Bundle-Id`.
- `POST /v1/webhooks/app-store` — ASSN v2 `{ "signedPayload": "..." }`.

Configure **App Store Connect → App Store Server Notifications** production URL to:

`https://<your-host>/v1/webhooks/app-store`

Use ASC’s “Send Test Notification” after deploy.

## Deploy order (summary)

1. Deploy this service with production env + certs + `APPLE_ENVIRONMENT=Production`.
2. Point the iOS app’s `SIMPLITICA_BACKEND_BASE_URL` build setting at this base URL (no trailing slash required if your client normalizes).
3. Validate webhook + optional client sync from a sandbox / TestFlight build.

See the Simpli Invoice repo `docs/SUBSCRIPTION_GO_LIVE.md` for the full checklist.
