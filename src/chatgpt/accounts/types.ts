export type CloudIdentity = { issuer: string; appleIdentity: string };

// Internal persistence input only. This interface does not verify native tokens,
// current StoreKit entitlement, device possession, or challenge-bound App Attest.
export type VerifiedEnrollmentEvidence = {
  identity: CloudIdentity;
  deviceKeyId: string;
  purchase: {
    appSlug: string;
    environment: "Sandbox" | "Production";
    originalTransactionId: string;
  };
};

export type EnrollmentReceipt = {
  ownerId: string;
  businessId: string;
  deviceKeyId: string;
};
export type CloudOwner = { ownerId: string; businessId: string };
export type CloudAccountErrorCode =
  | "invalid_input"
  | "challenge_invalid"
  | "enrollment_conflict"
  | "storage_unavailable";

export class CloudAccountError extends Error {
  constructor(public readonly code: CloudAccountErrorCode) {
    super(code);
    this.name = "CloudAccountError";
  }
}
