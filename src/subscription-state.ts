import { OfferType } from "@apple/app-store-server-library";
import type { JWSTransactionDecodedPayload } from "@apple/app-store-server-library";
import type { EntitlementState } from "./storage.js";

export function entitlementStateFromDecodedTransaction(decoded: JWSTransactionDecodedPayload): EntitlementState {
  const expiresAtMs = decoded.expiresDate;
  const now = Date.now();
  const active = typeof expiresAtMs === "number" && expiresAtMs > now;

  if (!active) return "inactive";
  if (decoded.offerType === OfferType.INTRODUCTORY_OFFER) return "trial";
  return "active";
}
