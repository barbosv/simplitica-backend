# Development cloud invoice tools

This source-only component implements twelve owned-account MCP tools through `src/chatgpt/tools/transport.ts`. It is not mounted in the qualification probe or the production Worker. Verified native enrollment, durable native synchronization, production rollout and live end-to-end qualification remain unfinished.

The tools read business/customer/rate context; preview, create and edit numbered drafts; convert one estimate to one invoice; and return an owned native-review link. They do not finalize invoices, generate server PDFs, send messages, collect payment, delete records or save rates automatically. The native app must review and finalize new or edited drafts. Links carry no access token and do not themselves authorize or open an app.

Pricing guidance prefers exact normalized-title matches in saved rates with the same explicit unit and kind, then reviewed invoice history. It reports its bounded search windows (100 rates, 50 invoices, 200 compatible history lines), never claims complete account coverage, and requests a price or unit when needed. No external market-price provider is enabled. Historical and reported draft provenance is not authorization or proof of market pricing.

The future request entry must validate its token and construct `createCloudToolHandler` per request with the branded authority; do not expose the bare SDK server. The internal facade enforces strict raw JSON before SDK decoding, a 1 MiB request bound, upload timeout/abort, finite bounded responses, and fixed protocol errors. The calculator's separate 64 KiB raw-input default remains unchanged. All tool schemas are strict, every tool advertises `cloud:access`, and revoked authority produces the OAuth challenge metadata. Repository writes atomically guard current ownership, device/connection state, paid eligibility, source revisions, numbering, records, receipts and feed. Matching receipt replay still checks current authorization.

## Local verification

Run `npm run test:worker`, `npm test`, `npm run lint`, `npm run build` and `npm run build:worker`. The latter checks Worker types and performs a dry run; it does not deploy this component.

On Nov16, source through `2840680` passed 1,010 Worker tests across30files and167 Node tests across20files, plus lint, Node build and Worker typecheck/drybuild. The Worker tests use real local D1, signed test JWTs and the installed MCP SDK, including exact receipts, source/number races, owned draft operations, malformed protocol/duplicate-key requests, legacy protocol negotiation and a successful near-1 MiB persisted receipt. Controlled regressions failed before the authorization-recovery, authoritative-number and protocol-boundary fixes. Independent agent review approved documents/numbering and tools/pricing internal integration after those fixes. The initial pricing RED was a missing-module failure, not a behavioral test failure; later real-D1 pricing assertions passed. Raw logs remain local under `/tmp/cloud-tools-final-*` and the task workspaces, rather than being evidence of a live deployment.

Existing Vite JSON-import, Stripe sourcemap and vendor/CLI warnings remain. These results do not establish physical App Attest/StoreKit, Auth0 access-only reconnection, native synchronization or delivery qualification.
