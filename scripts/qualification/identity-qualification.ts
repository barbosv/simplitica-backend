import { randomBytes } from "node:crypto";
import type { JWTVerifyGetKey } from "jose";
import { authorizationURL, callbackReceiver, verifyAccessToken, verifyNativeAccessToken, type TokenPair, type tokenClient } from "./managed-oauth.js";
import { nativeProofReceiver } from "./native-proof.js";

export type IdentityProgress =
  | { status: "awaiting_authorization"; mode: "identity-only"; authorizationURL: string }
  | { status: "awaiting_native_proof"; mode: "identity-only"; endpoint: string };
export interface IdentityReceivers {
  callback: typeof callbackReceiver;
  native: typeof nativeProofReceiver;
}

// Focused recovery proves identity only; it never refreshes or runs lifecycle qualification.
export async function qualifyIdentity(
  client: Pick<ReturnType<typeof tokenClient>, "exchange" | "revoke">,
  keys: JWTVerifyGetKey,
  report: (event: IdentityProgress) => void,
  receivers: IdentityReceivers = { callback: callbackReceiver, native: nativeProofReceiver },
) {
  const state = randomBytes(32).toString("base64url"), verifier = randomBytes(48).toString("base64url");
  const callback = await receivers.callback(state);
  let pair: TokenPair | undefined;
  try {
    report({ status: "awaiting_authorization", mode: "identity-only",
      authorizationURL: authorizationURL(callback.redirect, state, verifier).href });
    pair = await client.exchange(await callback.code, verifier, callback.redirect);
    const hostedIdentity = await verifyAccessToken(pair.accessToken, keys);
    const native = await receivers.native(hostedIdentity, token => verifyNativeAccessToken(token, keys));
    try {
      report({ status: "awaiting_native_proof", mode: "identity-only", endpoint: native.url });
      await native.qualified;
    } finally { await native.close(); }
  } finally {
    // Also revoke on invalid hosted/native proof, timeout, or receiver failure. A failed revoke fails the run.
    try { if (pair) await client.revoke(pair.refreshToken); }
    finally { await callback.close(); }
  }
  return { status: "passed", environment: "development", mode: "identity-only",
    checks: ["signed-token", "native-hosted-identity-continuity"], lifecycleChecks: "not-run" } as const;
}
