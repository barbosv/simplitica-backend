export type AttestationContext = {
  teamId: string;
  bundleId: string;
  environment: "development" | "production";
};

/** Internal cryptographic evidence only; insufficient for enrollment/admission. */
export type AttestationFacts = {
  keyId: string;
  publicKey: string;
  environment: AttestationContext["environment"];
  /** Exact 16-byte authenticator AAGUID, hex encoded. */
  aaguid: string;
  counter: number;
  extensions: { validationCategory?: number; bundleVersion?: string };
};
