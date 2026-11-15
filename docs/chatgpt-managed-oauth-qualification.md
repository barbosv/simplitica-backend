# Development OAuth/MCP qualification

This is a newly built replacement for the missing earlier local probe. It is not production authentication or a document-authoring integration. Building/pushing it does not deploy it or complete provider qualification.

## Isolation and current state

The production application stays at `src/worker.ts` with its existing D1 binding. The probe has a separate Worker entry point and `wrangler.qualify.jsonc`, no database, and only a synthetic read-only `qualification_probe` tool. Never add a production binding, route, credential, customer record, or subscription database to this config. Do not use the production deployment workflow for it.

Owner-driven development setup on November 14, 2026:

| Setting | Development value/status |
| --- | --- |
| Issuer | `https://dev-i8usug5fp48kepvr.us.auth0.com/` |
| Native client | Separate first-party development app; isolated official SDK qualifier passed20 simulator tests; live login/identity proof pending |
| ChatGPT client | Dedicated Regular Web third-party client `tpc_5RjUULWf1V9koMnfWj1Xg3` (confirmed against the signed-in development dashboard) |
| Client authentication | Client Secret (Post); secret stays in Auth0/ChatGPT secure configuration |
| Canonical resource/API identifier | `https://simpli-invoice-mcp-dev.simplitica.co/mcp` (deployed isolated development custom domain) |
| API permission | `probe:read`; explicit user-delegated client grant only |
| Authoring/payment access | None |
| Apple | Connection test succeeded in hosted flow; domain-level promotion reported |
| Resource compatibility | Tenant profile enabled, owner confirmed |
| Refresh | Grant enabled, rotation enabled, overlap 0 shown in screenshot; live behavior untested |
| Apple identity claim | Scoped development Action deployed and applied; not yet confirmed in signed API tokens |
| Actual ChatGPT callback | `https://chatgpt.com/connector_platform_oauth_redirect`; copied from the current portal and saved to the development client |

An earlier standard first-party ChatGPT development client was superseded during setup. Do not use it for strict third-party qualification. Do not modify the native client into a third-party client. Neither deletion nor broader system-API access is required.

Public metadata from both `/.well-known/oauth-authorization-server` and `/.well-known/openid-configuration` was read directly from the development tenant on November 14, 2026. It advertised S256 and plain, both client-secret methods, and global OIDC scopes including `offline_access`; it did not advertise `probe:read`. This verifies discovery reachability only. It does not establish the scopes the actual ChatGPT client will request or that any token flow succeeds. Never rewrite this discovery to hide a mismatch. Require actual S256 on the live authorization request.

## Local configuration and checks

Install dependencies with `npm ci`. Use the exact scripts in `package.json` for the dedicated probe:

```sh
npm run dev:qualify
npm run build:qualify
```

`dev:qualify` binds loopback and disables route-derived origin inference so the deployed custom domain does not break local Host validation. Its dedicated Wrangler config uses an explicit empty required-secret list to prevent unrelated root `.dev.vars` entries from becoming probe bindings; only its configured nonsecret variables are admitted. Do not remove that filter or copy the main application’s secrets into this probe. A real Wrangler regression verifies isolation with a harmless sentinel, without reading real credentials. The build is a dry run and must not upload a Worker. Keep authentication secrets out of the Worker: it validates access tokens with the issuer's public signing keys and needs no client secret.

Configure these nonsecret bindings in the dedicated probe config/local development settings:

- `QUALIFY_ENVIRONMENT`: `development`.
- `QUALIFY_ISSUER`: exact HTTPS issuer including trailing slash.
- `QUALIFY_MCP_AUDIENCE`: exact canonical HTTPS resource, including `/mcp` and without a trailing slash.
- `QUALIFY_CLIENT_ID`: exact allowlisted `tpc_` client ID; development value was confirmed against the signed-in Auth0 dashboard.
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

Configure a Post Login Action **in the development tenant only**, scoped to the exact ChatGPT development client/MCP audience or the separate native development client/native audience. Auth0's trusted `event.connection` and `event.user.identities` supply the Apple connection and opaque provider identity. Do not derive it by stripping `apple|` from the Auth0 subject, and do not copy a value from user-editable metadata.

The following Action was deployed as **Simpli Invoice Dev Apple Identity** and applied to the development Post Login flow on November 14, 2026. The dashboard confirmed all flow changes live. Built-in tests with synthetic events verified claim issuance for Apple, rejection of non-Apple login and wrong audience, and no-op behavior for another client. These are not real signed-token tests. The repository does not apply the Action automatically:

```js
/* global exports, console */
// Development tenant only. Never log request bodies, tokens, identities or query values.
exports.onExecutePostLogin = async (event, api) => {
  const native = event.client.client_id === 'WXTblf8z8B9kGNaX9QgR6dUzexXT5Ixa';
  if (!native && event.client.client_id !== 'tpc_5RjUULWf1V9koMnfWj1Xg3') return;
  const resource = native ? 'https://simpli-invoice-native-dev.simplitica.co/api'
    : 'https://simpli-invoice-mcp-dev.simplitica.co/mcp';
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
  const label = native ? 'development-native-qualification' : 'development-oauth-qualification';
  if (event.transaction?.protocol === 'oauth2-refresh-token') {
    console.log(JSON.stringify({ event: label, flow: 'refresh' }));
  } else {
    const query = event.request?.query ?? {};
    const scopes = typeof query.scope === 'string' ? query.scope.split(/\s+/).filter(Boolean) : [];
    const observation = {
      event: label, flow: 'authorization',
      pkceS256: query.code_challenge_method === 'S256'
        && typeof query.code_challenge === 'string' && query.code_challenge.length > 0,
    };
    if (native) {
      console.log(JSON.stringify({ ...observation, audienceMatches: query.audience === resource,
        qualificationScope: scopes.includes('qualification:read'), offlineAccess: scopes.includes('offline_access'),
        unexpectedScopes: scopes.some(scope => !['openid', 'profile', 'offline_access', 'qualification:read'].includes(scope)),
      }));
    } else {
      console.log(JSON.stringify({ ...observation, resourceMatches: query.resource === resource,
        probeScope: scopes.includes('probe:read'), offlineAccess: scopes.includes('offline_access'),
        unexpectedScopes: scopes.some(scope => scope !== 'probe:read' && scope !== 'offline_access'),
      }));
    }
  }
  api.accessToken.setCustomClaim(
    'https://simplitica.co/apple_identity', identities[0].user_id
  );
};
```

This is an issuer assertion, not independent proof that native and hosted flows identify the same Apple user. Validate the identity data shape in a real development login and refresh transaction; if the event lacks the required fields, deny and investigate rather than fall back to email or a guessed prefix. Review any future template change before publishing it to the development Login flow. For full continuity qualification, separately issue native-audience tokens with the equivalent trusted mapping and compare identifiers privately under the same approved Apple App ID/developer-team grouping. Do not expose those identities in MCP output.

## HTTPS staging or tunnel

On November 14, 2026, the isolated `simplitica-mcp-probe-development` Worker was deployed to the canonical development custom domain, version `6625cb89-d270-4f05-860a-74066c734051`. Cloudflare provisioned its DNS and TLS. No production deployment or migration was performed. External HTTPS checks passed: health 200, protected-resource metadata 200, anonymous and invalid-bearer MCP POST 401, and MCP GET 405 with `Allow: POST`. An authenticated ChatGPT call passed after owner-completed Apple login, as recorded below.

For future deployment or tunnel changes:

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
| Discovery | Canonical resource metadata and unmodified provider discovery | Development issuer and canonical probe metadata reachable over HTTPS; anonymous/invalid-token challenges verified |
| Scope/resource | S256 authorization and token exchange; signed API JWT with exact audience/client/scope/Apple claim | Live S256/resource/API-only scope audit passed; accepted signed-token checks inferred from probe; controlled token audit pending |
| First milestone | ChatGPT initializes, lists and invokes `qualification_probe` through authenticated development connection | Passed November 14, 2026: installed development plugin, execution trace “Checked Synthetic Development Access”, result `{"success":true,"probe":"synthetic-development"}` |
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

## Local implementation evidence — November 14, 2026

Final runtime code was independently accepted for specification and quality at `93226f6` after fixing four findings: local secret inheritance, upload/disconnect lifecycle, meaningful algorithm rejection fixtures, and canonical URL validation. The last disconnect fix has a real direct-workerd TCP regression that fails with the required flag removed. The original implementation agent reached a usage limit during that small final test change; the coordinator completed verification and obtained independent re-review.

Fresh local results: 72 Node tests in 14 files, 109 workerd tests in 11 files (68 probe cases), lint, Node build, Worker typecheck and isolated probe dry run passed. The existing production Worker dry run also passed during the implementation/fix wave. Existing dependency source-map and compatibility warnings were recorded; no production deployment was performed. These results establish local code behavior, not any pending live gate above.

## Live ChatGPT probe evidence — November 14, 2026

The owner entered the third-party development client secret directly in ChatGPT and completed Apple sign-in. ChatGPT returned to the Plugins page with the development plugin installed and a connection-success notice. Its Try in chat flow invoked the synthetic probe; the expanded execution trace showed **Checked Synthetic Development Access**, followed by the expected `success: true`, `probe: synthetic-development` result.

- Plugin: `plugin_asdk_app_6af882aa05848191914e4c94171532ec`.
- Evidence conversation: [Qualification Probe Result](https://chatgpt.com/c/6af885e3-2494-83e9-b016-203e56e9d167).
- Portal configuration: predefined third-party client, `client_secret_post`, default `probe:read`, base `offline_access`, OIDC disabled; discovered endpoints and resource left unchanged.
- No tokens, secrets or opaque personal Apple identifiers were collected. No customer or invoice bindings exist in this Worker.

Because the deployed verifier requires RS256 issuer/audience/client/scope/Apple-claim validation for MCP POST, the successful call is evidence that this request passed those checks. This is an inference from deployed code behavior and visible execution, not a captured JWT audit. The initial ChatGPT authorization redirect was not captured, so actual S256/resource/scope request details remain unverified. Refresh rotation/reuse, revocation behavior and native/hosted identity continuity remain pending.

## Additional provider evidence

Auth0 development tenant logs independently confirm Apple login at `2026-11-14T16:01:14.602Z` and successful code exchange (`seacft`) at `2026-11-14T16:01:17.017Z` for the configured third-party client and canonical MCP audience. The login consent context records exactly `offline_access probe:read`; the exchange summary scope is null, so it is not used as scope evidence. Standard logs do not expose the original PKCE parameters.

The versioned development Action source now lives at `scripts/auth0/development-apple-identity.cjs`; tests execute that exact artifact. Its additional audit emits fixed labels and booleans only after identity/audience guards: authorization S256 presence, exact resource match, API/offline scope presence and unexpected-scope status, or a refresh-flow marker. It never logs request bodies, raw query values, personal identity, client secrets or tokens. Logging records observations and does not turn provider configuration or synthetic events into live qualification evidence.

## Controlled live runner (ready; owner input pending)

`npm run qualify:oauth` is a development OAuth **client**, not an authorization server. It uses fixed development endpoints and a temporary exact `http://127.0.0.1:8792/callback` allowlist entry. The existing ChatGPT callback must be preserved. Only start after the owner supplies the secret directly in the disposable ignored local file `.superpowers/sdd/chatgpt-integration/auth0-client-secret` with mode 0600. The runner rejects symlinks, another owner, group/world access and oversize input; removes that one-use file after reading, and keeps tokens/identities in process memory. Never paste credentials into chat or command arguments.

The runner requests two fresh S256/Apple authorizations. First it verifies the signed API token, rotates a refresh token, attempts reuse and verifies family invalidation. Then a fresh login checks refresh before revoking the current token and proving subsequent refresh denial. Only a recognized provider `invalid_grant` counts as denial; network errors do not qualify. The final local native proof on port8793 requires a separately signed native-development token with matching opaque Apple identity. Native client/audience/scope are separate from the ChatGPT client: `WXTblf8z8B9kGNaX9QgR6dUzexXT5Ixa`, `https://simpli-invoice-native-dev.simplitica.co/api`, `qualification:read`. The separate native API/grant/callback/claim configuration is prepared; actual native login and signed identity proof remain pending. No unexpired access-JWT revocation is inferred.

Temporary loopback callback must be removed after testing. Authorization codes are single-use in the local callback; wrong/duplicate state, duplicate code, malformed HTTP targets, wrong Host/path/method and timeout are rejected. A real child-process TCP regression verifies malformed targets cannot crash or leak request text.

Live audit at `2026-11-14T19:49:32.861Z` recorded authorization with S256=true, resource match=true, probe scope=true, offline access=true, unexpected scopes=false. Its code exchange succeeded at `19:49:34.421Z`. These are real Auth0 Action-execution logs, unlike the earlier built-in synthetic Action test.

## Native qualifier and prepared development configuration

The isolated iOS artifact is on `codex/chatgpt-native-qualification` in `voice-invoice`, runtime commit `e3e101f`. Official Auth0.swift3.3.1, dedicated qualification bundle/callback and device-only Keychain namespace; no production app project/source changed. Fresh independent review passed and independently read the result bundle:20 XCTest tests passed, zero failed/skipped on arm64 iPhone17Pro/iOS26.5. Actual native Apple login is still pending; local SDK/Keychain tests are not identity-continuity evidence. Main-app baseline executed zero tests because the inherited MLKit simulator configuration excludes the available architecture.

Prepared native API `6af8c0b132b9f616a47057ac`: Auth0 profile/RS256; access lifetime300sec, explicit consent, offline access, per-app user-delegated authorization, no machine-to-machine client access. Only `qualification:read` is explicitly granted to the native development client, with no anonymous grant or MCP API permission. Native client keeps Authorization Code and Refresh Token grants, with Implicit disabled, rotation overlap0, idle3600sec and maximum86400sec. Existing native callbacks are preserved; the exact `co.simplitica.simpli-invoice.qualification://dev-i8usug5fp48kepvr.us.auth0.com/ios/co.simplitica.simpli-invoice.qualification/callback` was added with non-verifiable callback confirmation enabled. OIDC remains enabled for native login and disabled for ChatGPT.

The reviewed Action extension was deployed and built-in synthetic native event test returned the expected namespaced claim and safe boolean audit; it does not qualify real native tokens. The owner is currently on a phone without the confidential client secret available. The one-use local secret input file is still empty, and no controlled refresh/replay/revocation flow or temporary confidential loopback callback registration has run. Resume those owner-assisted tests when desktop access is available. Keep dependent owner/enrollment/shared-persistence implementation gated by complete live provider qualification.
