import { randomBytes } from "node:crypto";
import { createRemoteJWKSet } from "jose";
import { authorizationURL, callbackReceiver, checkRotation, checkRevocation, developmentOAuth,
  tokenClient, verifyAccessToken } from "./managed-oauth.js";
import { verifyNativeAccessToken } from "./managed-oauth.js";
import { nativeProofReceiver } from "./native-proof.js";
import { consumeClientSecret, qualificationFailureReason } from "./runner-support.js";

async function main() {
  const secret = await consumeClientSecret();
  const client = tokenClient(secret);
  const keys = createRemoteJWKSet(new URL(".well-known/jwks.json", developmentOAuth.issuer), { timeoutDuration: 2000 });
  let hostedIdentity: string | undefined;
  const verify = async (token: string) => {
    const identity = await verifyAccessToken(token, keys);
    if (hostedIdentity !== undefined && identity !== hostedIdentity) throw new Error("hosted_identity_changed");
    hostedIdentity = identity;
    return identity;
  };
  for (const stage of ["rotation-reuse", "revocation"] as const) {
    const state = randomBytes(32).toString("base64url"), verifier = randomBytes(48).toString("base64url");
    const receiver = await callbackReceiver(state);
    try {
      console.log(JSON.stringify({ status: "awaiting_authorization", stage,
        authorizationURL: authorizationURL(receiver.redirect, state, verifier).href }));
      const pair = await client.exchange(await receiver.code, verifier, receiver.redirect);
      if (stage === "rotation-reuse") await checkRotation(client, pair, verify);
      else await checkRevocation(client, pair, verify);
      console.log(JSON.stringify({ status: "passed", stage, signedIdentityContinuity: true }));
    } finally { await receiver.close(); }
  }
  if (!hostedIdentity) throw new Error("hosted_identity_missing");
  const native = await nativeProofReceiver(hostedIdentity, token => verifyNativeAccessToken(token, keys));
  try {
    console.log(JSON.stringify({ status: "awaiting_native_proof", endpoint: native.url }));
    await native.qualified;
    console.log(JSON.stringify({ status: "passed", stage: "native-hosted-identity-continuity" }));
  } finally { await native.close(); }
  console.log(JSON.stringify({ status: "passed", environment: "development",
    checks: ["signed-token", "refresh-rotation", "old-token-reuse-denial", "family-invalidation", "revocation-refresh-denial"],
    unexpiredAccessTokens: "stateless-probe-may-accept-until-expiry", nativeIdentityContinuity: "passed" }));
}

void main().catch(error => {
  const reason = qualificationFailureReason(error);
  console.error(JSON.stringify({ status: "failed", reason }));
  process.exitCode = 1;
});
