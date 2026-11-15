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

/** Exact bytes only; canonical action construction belongs to the later service. */
export type AssertionInput = { assertion: Uint8Array; payload: Uint8Array };

/** Trusted stored record projection; never populate from request-supplied keys. */
export type AttestedDevice = { publicKeyPem: string; counter: number };

/** Internal cryptographic evidence only; no action or enrollment authority. */
export type AssertionFacts = { counter: number; extensions: ReadonlyMap<string, unknown> };

/** Trusted constructor configuration; no permissive defaults or request overrides. */
export type AttestationAdmissionPolicy = {
  validationCategories: readonly number[];
  bundleVersions: readonly string[];
};
