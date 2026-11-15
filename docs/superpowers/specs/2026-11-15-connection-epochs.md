# Issuer-bound connection epochs

The account foundation's revision compare-and-swap prevents stale native commands from undoing disconnects. Its timestamp fence alone cannot prove that an OAuth credential belongs to a new connection: a delayed time sample or backward clock can admit a JWT minted while disconnected. Public cloud authorization remains blocked until this design is implemented and qualified.

## Selected protocol

Use the connection's durable D1 revision as an issuer-signed epoch. Time checks remain auxiliary validation. An access token must carry numeric `https://simplitica.co/connection_epoch` equal to the currently active connection revision, with the approving device still active and owned. Missing, malformed or old epochs deny access even when the token otherwise validates and its iat is recent. The epoch comes only from the verified signed JWT, never model parameters, a request body or a lookup substituted by the resource server.

On an initial cloud OAuth authorization, the scoped Auth0 Action asks an authenticated, bounded development backend hook for the active epoch using its already trusted Apple identity. It writes that epoch to both the access-token claim and issuer-owned refresh-token metadata `simplitica_connection_epoch`. On refresh, it reads the original metadata, requires it to match the backend's current active epoch, and copies the same value onward. It must never upgrade an old grant to the latest epoch. Reconnect increments the D1 revision, so only a new authorization can obtain the new epoch. An Action result sampled before disconnect remains old and is denied after reconnect, even if token signing finishes later.

Auth0 documents refresh-token metadata setters and access during Actions. Tenant/client availability and persistence across rotation require live development qualification before enabling this protocol; the basic issuer qualification already recorded is a different completed milestone. No paid feature, unsupported custom authorization server or time-based fallback is authorized. [Auth0 API](https://auth0.com/docs/actions/reference/post-login/post-login-api-object#apirefreshtokensetmetadatakey-value), [metadata guidance](https://auth0.com/blog/auth0-session-refresh-token-metadata-guide/)

## Scope and isolation

Only the exact third-party development MCP client/audience and requests for `cloud:access` use the new grant path. The synthetic `probe:read` connection and native `qualification:read` login retain their existing behavior. Native tokens, superseded first-party clients, wrong resources and untrusted identity metadata cannot issue cloud epochs. An old refresh grant lacking metadata cannot acquire cloud access through refresh; it needs a fresh authorization.

The hook is an application-state lookup, not an OAuth server. It issues no tokens and grants no ownership. Its service credential is separate from the Auth0 client secret, scoped to this read-only development endpoint, stored only in development secrets, and never logged. The hook fixes issuer/client server-side; the bounded body contains only the trusted opaque Apple identity. It returns an active epoch or a fixed inactive result, without personal identifiers, tokens or database errors. No new public route or deployed binding is added during internal implementation.

## Admission and failure behavior

The resource server cryptographically verifies RS256, exact development issuer/MCP audience/third-party client, exp, nonempty subject, trusted Apple claim, safe iat and `cloud:access`, then passes the signed epoch to D1 authorization. Active status, exact epoch and active owned device are checked together. Future domain mutations recheck that same epoch/status and paid entitlement inside their atomic write batch; an earlier authorization read is not a durable permission.

Refresh metadata is a canonical positive decimal string within the safe integer range. The signed claim is its numeric value. Wrong/missing metadata, inactive or mismatched epoch, unavailable metadata APIs, missing hook credentials, redirect/oversize/timeout responses and hook failures deny cloud issuance. There is no profile-metadata fallback or automatic rebasing. Safe audit records contain only fixed labels and booleans.

The hook compares its fixed-format service credential without timing-sensitive string equality, limits body/read duration and returns no-store JSON. The Action uses a fixed HTTPS development URL, no redirects, a two-second total fetch/read deadline and a one-KiB response cap. Native approval still requires fresh proof binding expectedRevision into the canonical command; issuer epochs do not replace native purchase/device verification.

## Required evidence

Real workerd/D1 tests cover old/current signed epochs, wrong owner/client/device, delayed initial issuance, disconnect/reconnect and tokens minted during disconnection with misleading iat values. Real signed-JWT fixtures must prove the resource server cannot replace a missing/old epoch with a current database value. Tests execute the exact Action artifact with a bounded HTTP hook fixture and verify metadata continuity, downgrade/upgrade denial and redacted failures.

Before public cloud use, qualify metadata persistence on the development tenant through initial login, at least two rotations, old-epoch denial after reconnect and fresh-authorization success. The public native client can first test metadata capability without collecting another confidential client secret; actual third-party cloud grant behavior must also be observed before authoring is enabled. No public authorization, production resource, migration or release is implied by local fixture success.
