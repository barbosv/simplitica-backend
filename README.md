# simplitica-backend

Subscription/entitlement backend intended to be shared across your iOS apps.

## What’s implemented
- **Health**: `GET /health`
- **Client sync**: `POST /v1/subscriptions/sync` (verifies Apple `signedTransactionInfo`, stores entitlement snapshot)
- **Entitlements**: `GET /v1/entitlements` (returns latest entitlement for an `appAccountToken`)
- **Webhooks**: `POST /v1/webhooks/app-store` (verifies ASSN v2 `signedPayload`, updates entitlement snapshot)

Apple signature verification uses Apple’s official library (`@apple/app-store-server-library`) and the Apple root certs in `certs/`.

## Local development
Install dependencies:

```bash
npm i
```

Run the server:

```bash
npm run dev
```

Run tests:

```bash
npm test
```

## Environment variables
- **PORT**: server port (default `3000`)
- **NODE_ENV**: use `production` in production (affects verifier online checks)
- **APPLE_ENVIRONMENT**: `Sandbox` or `Production` (default `Sandbox`)
- **SIMPLI_INVOICE_BUNDLE_ID**: default `co.simplitica.simpli-invoice` (must match the shipping iOS bundle ID)
- **SIMPLI_INVOICE_APP_APPLE_ID**: required for production verification (App Store Connect “App Apple ID”)
- **DATA_DIR**: optional directory for entitlement JSON storage

See **`DEPLOYMENT.md`** for production TLS, certs, ASSN URL, and deploy order with the iOS app.

## Entitlements API usage
`GET /v1/entitlements` requires headers:
- `X-App-Account-Token`: UUID generated on-device and used as StoreKit `appAccountToken`
- `X-App-Slug` (optional): defaults to `simpli-invoice`
- `X-Bundle-Id` (optional): if set, resolves the app slug from the configured registry (useful for shared infra across apps)

## Client sync (`POST /v1/subscriptions/sync`)
JSON body:
- `appAccountToken` (UUID string)
- `signedTransactionInfo` (JWS string from StoreKit `VerificationResult.jwsRepresentation`)
- `signedRenewalInfo` (optional JWS string)
- `appSlug` (optional) and/or `bundleId` (optional) to select the app configuration (defaults to Simpli Invoice)

## App Store Server Notifications v2 (`POST /v1/webhooks/app-store`)
Apple posts JSON shaped like:

```json
{ "signedPayload": "..." }
```

The server tries verification against each configured app (bundle id) until one succeeds, then upserts the entitlement snapshot.

Optional JSON field:
- `appSlug`: if provided, must match the app inferred from the signed notification.

## iOS wiring
Set the **`SIMPLITICA_BACKEND_BASE_URL`** build setting (wired into `Info.plist` as `SimpliticaBackendBaseURL`) to your deployed base URL (example: `https://api.example.com`). When empty, the app skips server sync and relies on StoreKit locally. Client sync sends **`appSlug`: `simpli-invoice`** by default.

## App Store Connect
Create an auto-renewable subscription group, add product id `co.simplitica.simpli_invoice.subscription.monthly` at **$4.99/month**, and attach a **7-day free trial** introductory offer for eligible subscribers.

## Persistence
By default, entitlements are stored at `./data/store.json`. Tests can set `DATA_DIR` to redirect storage.

