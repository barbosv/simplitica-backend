import { importPKCS8, SignJWT } from "jose";
import type { Env } from "../env.js";
import { simplilistProProductIDs } from "./config.js";

type TransactionPayload = {
  productId?: string;
  productID?: string;
  expiresDate?: number | string;
  originalTransactionId?: string;
  originalTransactionID?: string;
};

export function decodeJWSPayload(jws: string): TransactionPayload | null {
  const parts = String(jws).split(".");
  if (parts.length < 2) return null;
  const json = Buffer.from(parts[1], "base64url").toString("utf8");
  try {
    return JSON.parse(json) as TransactionPayload;
  } catch {
    return null;
  }
}

export function transactionIndicatesPro(env: Env, payload: TransactionPayload | null): boolean {
  if (!payload) return false;
  const productIds = simplilistProProductIDs(env);
  const pid = payload.productId || payload.productID;
  if (!pid || !productIds.has(pid)) return false;
  const expRaw = payload.expiresDate;
  if (expRaw != null) {
    const exp = Number(expRaw);
    if (!Number.isNaN(exp) && exp < Date.now()) return false;
  }
  return true;
}

function applePrivateKeyPem(env: Env): string {
  return (env.APPLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");
}

export function isAppleIAPLookupConfigured(env: Env): boolean {
  return Boolean(
    env.APPLE_ISSUER_ID?.trim() &&
      env.APPLE_KEY_ID?.trim() &&
      applePrivateKeyPem(env).trim() &&
      env.SIMPLILIST_BUNDLE_ID?.trim(),
  );
}

async function appleJWT(env: Env): Promise<string> {
  if (!isAppleIAPLookupConfigured(env)) {
    throw new Error("apple_credentials_missing");
  }
  const privateKey = await importPKCS8(applePrivateKeyPem(env), "ES256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ bid: env.SIMPLILIST_BUNDLE_ID })
    .setProtectedHeader({ alg: "ES256", kid: env.APPLE_KEY_ID })
    .setIssuer(env.APPLE_ISSUER_ID!)
    .setIssuedAt(now)
    .setExpirationTime(now + 19 * 60)
    .setAudience("appstoreconnect-v1")
    .sign(privateKey);
}

export async function fetchAppleTransaction(env: Env, transactionId: string): Promise<TransactionPayload | null> {
  const base = env.SIMPLILIST_APPLE_SANDBOX
    ? "https://api.storekit-sandbox.itunes.apple.com"
    : "https://api.storekit.itunes.apple.com";
  const url = `${base}/inApps/v1/transactions/${transactionId}`;
  const appleToken = await appleJWT(env);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${appleToken}` },
  });
  const text = await response.text();
  if (!response.ok) return null;
  let body: { signedTransactionInfo?: string };
  try {
    body = JSON.parse(text) as { signedTransactionInfo?: string };
  } catch {
    return null;
  }
  if (!body.signedTransactionInfo) return null;
  return decodeJWSPayload(body.signedTransactionInfo);
}
