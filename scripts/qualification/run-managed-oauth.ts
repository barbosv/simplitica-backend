import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createRemoteJWKSet } from "jose";
import { authorizationURL, callbackReceiver, checkRotation, checkRevocation, developmentOAuth,
  tokenClient, verifyAccessToken } from "./managed-oauth.js";
import { verifyNativeAccessToken } from "./managed-oauth.js";
import { nativeProofReceiver } from "./native-proof.js";

// This one-use file is deliberately fixed inside the Git-ignored coordination directory.
const secretPath = ".superpowers/sdd/chatgpt-integration/auth0-client-secret";

async function main() {
  const handle = await open(secretPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let secret: string;
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.() || info.size > 4096) {
      throw new Error("secret_file_permissions");
    }
    secret = (await handle.readFile("utf8")).trim();
    if (!secret) throw new Error("secret_file_empty");
  } finally { await handle.close(); }
  // The owner supplies this disposable input solely for the runner; remove it once consumed.
  await unlink(secretPath);
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
  const reasons = new Set(["secret_file_permissions", "secret_file_empty", "provider_invalid_grant", "provider_request_failed",
    "invalid_token_response", "access_token_verification_failed", "rotation_not_observed", "refresh_identity_changed",
    "refresh_denial_unproven", "invalidated_refresh_accepted", "callback_timeout", "callback_closed", "callback_listen_failed",
    "hosted_identity_changed", "hosted_identity_missing", "native_proof_timeout", "native_proof_closed", "native_proof_listen_failed"]);
  const reason = error instanceof Error && reasons.has(error.message) ? error.message : "qualification_failed";
  console.error(JSON.stringify({ status: "failed", reason }));
  process.exitCode = 1;
});
