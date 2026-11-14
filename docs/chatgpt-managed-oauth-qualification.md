# Development OAuth/MCP qualification

This is a newly built replacement for the missing earlier local probe. It is not production authentication or a document-authoring integration. Building/pushing it does not deploy it or complete provider qualification.

## Isolation and current state

The production application stays at `src/worker.ts` with its existing D1 binding. The probe has a separate Worker entry point and `wrangler.qualify.jsonc`, no database, and only a synthetic read-only `qualification_probe` tool. Never add a production binding, route, credential, customer record, or subscription database to this config. Do not use the production deployment workflow for it.

Owner-driven development setup on November 14, 2026:

| Setting | Development value/status |
| --- | --- |
| Issuer | `https://dev-i8usug5fp48kepvr.us.auth0.com/` |
| Native client | Separate first-party native app; created, no SDK validation yet |
| ChatGPT client | Dedicated Regular Web third-party client `tpc_5RjUULWf1V9koMnfWj1Xg3` (from owner screenshot; confirm against dashboard before live use) |
| Client authentication | Client Secret (Post); secret stays in Auth0/ChatGPT secure configuration |
| Canonical resource/API identifier | `https://simpli-invoice-mcp-dev.simplitica.co/mcp` (planned hostname, not yet provisioned) |
| API permission | `probe:read`; explicit user-delegated client grant only |
| Authoring/payment access | None |
| Apple | Connection test succeeded in hosted flow; domain-level promotion reported |
| Resource compatibility | Tenant profile enabled, owner confirmed |
| Refresh | Grant enabled, rotation enabled, overlap 0 shown in screenshot; live behavior untested |
| Apple identity claim | Requires development Action configuration below; not yet confirmed in signed API tokens |
| Actual ChatGPT callback | Pending; use the exact portal value, no guessed/wildcard URL |

An earlier standard first-party ChatGPT development client was superseded during setup. Do not use it for strict third-party qualification. Do not modify the native client into a third-party client. Neither deletion nor broader system-API access is required.

Public metadata from both `/.well-known/oauth-authorization-server` and `/.well-known/openid-configuration` was read directly from the development tenant on November 14, 2026. It advertised S256 and plain, both client-secret methods, and global OIDC scopes including `offline_access`; it did not advertise `probe:read`. This verifies discovery reachability only. It does not establish the scopes the actual ChatGPT client will request or that any token flow succeeds. Never rewrite this discovery to hide a mismatch. Require actual S256 on the live authorization request.

## Local configuration and checks

Install dependencies with `npm ci`. Use the exact scripts in `package.json` for the dedicated probe:

```sh
npm run dev:qualify
npm run build:qualify
```

`dev:qualify` binds loopback. Its dedicated Wrangler config uses an explicit empty required-secret list to prevent unrelated root `.dev.vars` entries from becoming probe bindings; only its configured nonsecret variables are admitted. Do not remove that filter or copy the main application’s secrets into this probe. A real Wrangler regression verifies isolation with a harmless sentinel, without reading real credentials. The build is a dry run and must not upload a Worker. Keep authentication secrets out of the Worker: it validates access tokens with the issuer's public signing keys and needs no client secret.

Configure these nonsecret bindings in the dedicated probe config/local development settings:

- `QUALIFY_ENVIRONMENT`: `development`.
- `QUALIFY_ISSUER`: exact HTTPS issuer including trailing slash.
- `QUALIFY_MCP_AUDIENCE`: exact canonical HTTPS resource, including `/mcp` and without a trailing slash.
- `QUALIFY_CLIENT_ID`: exact allowlisted `tpc_` client ID; development value is configured from the owner’s screenshot, so confirm it against the dashboard before live use.
- `QUALIFY_PROBE_SCOPE`: `probe:read`.
- `QUALIFY_APPLE_IDENTITY_CLAIM`: `https://simplitica.co/apple_identity`.

A missing or invalid configuration fails closed. The worker must not accept a token from another client or resource even if its signature is valid. The claim namespace is an identifier, not a network endpoint.

Read-only local discovery/challenge checks:

```sh
curl -i http://127.0.0.1:8787/.well-known/oauth-protected-resource/mcp
curl -i -X POST http://127.0.0.1:8787/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The first should advertise the exact canonical resource and development issuer; the unauthenticated MCP request should return 401 with a Bearer `resource_metadata` challenge. Never use a production access token for local experiments. Do not paste bearer/refresh tokens into chat, commit them, or attach raw browser network exports containing them.

The probe uses a per-request JWKS resolver with a network timeout. It does not keep an indefinite startup-only JWKS snapshot. This favors straightforward key-rotation handling over minimizing development-tenant JWKS requests. The token algorithm is restricted to RS256. Unsupported MCP HTTP methods (including SSE GET) return 405 promptly. The dedicated probe config opts into `enable_request_signal` because its compatibility date precedes the default for incoming disconnect signals. A direct workerd network regression checks this behavior using the probe’s configured date and flags; changing synthetic Request objects alone is insufficient. Wrangler’s local proxy adds a separate transport boundary, so local proxy behavior is not evidence of edge disconnect propagation. Authenticated uploads are limited to 64 KiB and a two-second body-acquisition deadline. Timed-out uploads return 408; disconnected uploads return 499. Cancellation cannot hold the response open, and the original abort signal is preserved into SDK handling. SDK-managed per-request responses must be consumed to completion; no standalone long-lived SSE subscription is provided.

## Signed Apple identity claim

The Worker requires the configured namespaced string claim in the verified API token. A plain `sub`, email (including Apple relay), user-supplied business UUID, or decoded unsigned JWT is insufficient. No production owner is created and the claim is never echoed by the probe.

Configure a Post Login Action **in the development tenant only**, scoped to the exact third-party client and probe audience. Auth0's trusted `event.connection` and `event.user.identities` supply the Apple connection and opaque provider identity. Do not derive it by stripping `apple|` from the Auth0 subject, and do not copy a value from user-editable metadata.

Example Action template (confirm the development client ID before applying; this repository does not apply it automatically):

```js
exports.onExecutePostLogin = async (event, api) => {
  const clientId = 'tpc_5RjUULWf1V9koMnfWj1Xg3';
  const resource = 'https://simpli-invoice-mcp-dev.simplitica.co/mcp';
  if (event.client.client_id !== clientId) return;
  if (event.resource_server?.identifier !== resource) {
    api.access.deny('Development probe audience required');
    return;
  }
  const identities = (event.user.identities ?? []).filter(
    identity => identity.provider === 'apple'
      && typeof identity.user_id === 'string'
      && identity.user_id.trim().length > 0
  );
  if (event.connection.strategy !== 'apple' || identities.length !== 1) {
    api.access.deny('A single verified Apple identity is required');
    return;
  }
  api.accessToken.setCustomClaim(
    'https://simplitica.co/apple_identity', identities[0].user_id
  );
};
```

This is an issuer assertion, not independent proof that native and hosted flows identify the same Apple user. Validate the identity data shape in a real development login and refresh transaction; if the event lacks the required fields, deny and investigate rather than fall back to email or a guessed prefix. Review the template before publishing it to the development Login flow. For full continuity qualification, separately issue native-audience tokens with the equivalent trusted mapping and compare identifiers privately under the same approved Apple App ID/developer-team grouping. Do not expose those identities in MCP output.

## HTTPS staging or tunnel

No deployment, DNS mutation or tunnel was performed by creating/pushing this code. For the later live milestone:

1. Inspect `wrangler.qualify.jsonc`: entry point must be the probe and bindings must contain no production storage/service resources. Select the intended development Cloudflare account explicitly.
2. Use a dedicated development Worker, never `simplitica-backend`, or a supported tunnel to the loopback probe. The custom canonical hostname above needs separate DNS/routing setup. A workers.dev URL alone does not provision it.
3. Keep the Auth0 API identifier, OAuth `resource`, JWT audience and protected-resource metadata identical. Do not simply paste a random temporary tunnel URL into one setting. Prefer stable HTTPS; if the canonical URI must change, create a matching development Auth0 API/grant because its identifier cannot be edited.
4. The probe accepts the configured canonical origin and local HTTP loopback hosts only. A different workers.dev or tunnel hostname is rejected; route the canonical development hostname to the isolated probe, or deliberately update the development resource/API before testing that alternative. Do not broaden Host/Origin acceptance to `*` or trust forwarded headers as the canonical resource.
5. Confirm anonymous discovery and 401 challenges through the exact external URL before starting ChatGPT linking. Any tunnel metadata rewriting must be understood and tested against the canonical audience, not assumed compatible.

## Real ChatGPT linking and qualification gates

Register this server through the actual ChatGPT development app portal with OAuth and the predefined third-party Auth0 client. Copy the exact callback shown by that portal into the client's allowed callback list. Put the client secret only into the portal's secure OAuth field. Keep API-only identity settings off unless a separately reviewed qualification adjustment is required; native login can still use OIDC.

Request only the explicit API permission plus `offline_access` when supported. Inspect the actual authorization request: `response_type=code`, PKCE `code_challenge_method=S256`, the correct client, callback, resource/audience and scope set. A provider's advertised scopes are not the client's requested scopes. If ChatGPT requests incompatible OIDC scopes, investigate the portal/client configuration and record a failed gate rather than rewriting provider discovery or widening the client silently. Historical package-level OIDC overrides may not apply to the current portal.

| Gate | Required real evidence | Current status |
| --- | --- | --- |
| Discovery | Canonical resource metadata and unmodified provider discovery | Development issuer metadata reachable; probe endpoint pending |
| Scope/resource | S256 authorization and token exchange; signed API JWT with exact audience/client/scope/Apple claim | Pending |
| First milestone | ChatGPT initializes, lists and invokes `qualification_probe` through authenticated development connection | Pending |
| Native/hosted identity | Same verified opaque Apple identity in separately validated native and hosted flows | Pending; native SDK not integrated |
| Refresh | New refresh token after exchange; old-token reuse rejected outside overlap, with token-family behavior recorded | Pending |
| Disconnect/revocation | Revoked grant/refresh token cannot renew; local/probe access denial behavior documented | Pending |

Keep sanitized evidence: date, client type, endpoint, requested scope names, HTTP status, verifier outcome and token lifetime, without the tokens or personal identity values. A screenshot of hosted Apple connection success is useful but does not pass the signed-token/native-continuity gates.

An otherwise-valid unexpired JWT can remain accepted by this stateless verifier after provider revocation. It has no token-introspection, denylist, owner lifecycle or subscription subsystem. Record that limitation explicitly; full P1T1b must establish the eventual denial policy before production implementation proceeds. Do not add an unreviewed production auth subsystem to this probe.

## References

- [Official MCP web-standard serving](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/web-standard.md)
- [OpenAI authentication](https://developers.openai.com/plugins/build/auth)
- [Auth0 third-party application configuration](https://auth0.com/docs/get-started/applications/third-party-applications/configure-third-party-applications)
- [Auth0 third-party security controls](https://auth0.com/docs/get-started/applications/third-party-applications/security-controls)
- [Auth0 Action event object](https://auth0.com/docs/actions/reference/post-login/post-login-event-object)
- [Auth0 Action API object](https://auth0.com/docs/actions/reference/post-login/post-login-api-object)
- [Auth0 refresh rotation](https://auth0.com/docs/secure/tokens/refresh-tokens/configure-refresh-token-rotation)

- [Cloudflare incoming request-signal compatibility flag](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#enable-requestsignal-for-incoming-requests)
