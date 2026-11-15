import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { createCloudConnectionRepository } from "../accounts/connections.js";
import type { CloudOwner } from "../accounts/types.js";
import { isNonnegativeSafeInteger, isOpaqueIdentifier } from "../accounts/validation.js";

import { CLOUD_ISSUER, CLOUD_AUDIENCE, CLOUD_CLIENT_ID, CloudTokenConfigurationError, isCanonicalBase64url32 } from "./configuration.js";
export { CLOUD_ISSUER, CLOUD_AUDIENCE, CLOUD_CLIENT_ID, CloudTokenConfigurationError } from "./configuration.js";
const appleIdentityClaim = "https://simplitica.co/apple_identity";
const connectionEpochClaim = "https://simplitica.co/connection_epoch";
const authorizationNamespaceClaim = "https://simplitica.co/authorization_namespace";

// Internal dependencies only: callers cannot supply issuer/audience/JWKS URLs.
// This isolated admission gate is not mounted on a public route.
export function createCloudTokenAuthorizer(db: D1Database, dependencies: { authorizationNamespace: string; keys?: JWTVerifyGetKey; now?: () => number }) {
  // Trusted external configuration (future CLOUD_AUTHORIZATION_NAMESPACE),
  // outside D1 so a restored/cloned revision cannot resurrect old credentials.
  // Capture it once; never infer it from a token or persisted application state.
  const authorizationNamespace = dependencies?.authorizationNamespace;
  if (!isCanonicalBase64url32(authorizationNamespace)) throw new CloudTokenConfigurationError();
  const connections = createCloudConnectionRepository(db);
  return async (token: string): Promise<(CloudOwner & { connectionEpoch: number; authorizationNamespace: string }) | null> => {
    if (typeof token !== "string" || token.length === 0 || token.length > 12000) return null;
    const now = (dependencies?.now ?? Date.now)();
    if (!isNonnegativeSafeInteger(now)) return null;
    const currentDate = new Date(now);
    if (!Number.isFinite(currentDate.getTime())) return null;
    let payload;
    try {
      // A fresh resolver per admission observes issuer key rotation immediately.
      // JOSE ignores untrusted jku/x5u headers and resolves only this fixed URL.
      const keys = dependencies?.keys ?? createRemoteJWKSet(new URL(".well-known/jwks.json", CLOUD_ISSUER), { timeoutDuration: 2000 });
      ({ payload } = await jwtVerify(token, keys, {
        algorithms: ["RS256"], issuer: CLOUD_ISSUER, audience: CLOUD_AUDIENCE,
        requiredClaims: ["exp", "sub", "iat"], currentDate,
      }));
    } catch {
      // Provider errors and token contents must never escape the verifier.
      return null;
    }
    const appleIdentity = payload[appleIdentityClaim];
    const connectionEpoch = payload[connectionEpochClaim];
    if (payload[authorizationNamespaceClaim] !== authorizationNamespace ||
        !isOpaqueIdentifier(payload.sub) || !isOpaqueIdentifier(appleIdentity) ||
        payload.azp !== CLOUD_CLIENT_ID || typeof payload.scope !== "string" || !payload.scope.split(" ").includes("cloud:access") ||
        !isNonnegativeSafeInteger(payload.iat) || payload.iat > Math.floor(now / 1000) ||
        !isNonnegativeSafeInteger(connectionEpoch) || connectionEpoch === 0) return null;
    // Only the verified signed claim supplies the epoch. An issuer lookup may
    // never rebase a token onto the current connection generation.
    // D1 errors are sanitized by the repository and intentionally propagate.
    const owner = await connections.authorize({
      identity: { issuer: CLOUD_ISSUER, appleIdentity }, clientId: CLOUD_CLIENT_ID,
      tokenIssuedAt: payload.iat, connectionEpoch, now,
    });
    return owner ? { ...owner, connectionEpoch, authorizationNamespace } : null;
  };
}
