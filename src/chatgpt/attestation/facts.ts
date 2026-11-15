import { verifyAttestation } from "node-app-attest";
import { decodeStrictCbor, decodeStrictCborItems } from "./cbor";
import { assertCredentialPublicKey, validateAttestationCertificates } from "./certificates";
import type { AttestationContext, AttestationFacts } from "./types";

const MAX_ATTESTATION_BYTES = 65536;
const MAX_CLIENT_PAYLOAD_BYTES = 8192;
const AAGUIDS = {
  development: "617070617474657374646576656c6f70",
  production: "61707061747465737400000000000000",
} as const;
const EXTENSIONS = new Set(["apple_validation_category_01", "apple_bundle_version_01"]);

function invalid(): never { throw new Error("invalid_attestation"); }

/**
 * Internal cryptographic facts only. This deliberately accepts historical
 * attestations without current admission extensions, and must never authorize
 * enrollment. Trusted application configuration cannot be overridden by proofs.
 */
export async function verifyAttestationFacts(
  input: { attestation: Uint8Array; keyId: string; clientPayload: Uint8Array },
  context: AttestationContext,
  dependencies: { now: () => number } = { now: Date.now },
): Promise<AttestationFacts | null> {
  if (!context || typeof context.teamId !== "string" || !/^[A-Z0-9]{10}$/.test(context.teamId) ||
      typeof context.bundleId !== "string" || context.bundleId.length > 255 ||
      !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(context.bundleId) ||
      (context.environment !== "development" && context.environment !== "production")) {
    throw new Error("invalid_configuration");
  }
  try {
    if (!input || !(input.attestation instanceof Uint8Array) ||
        !(input.clientPayload instanceof Uint8Array) || input.clientPayload.length === 0 ||
        input.clientPayload.length > MAX_CLIENT_PAYLOAD_BYTES ||
        typeof input.keyId !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(input.keyId) ||
        Buffer.from(input.keyId, "base64").toString("base64") !== input.keyId) invalid();
    const outer = decodeStrictCbor(input.attestation, MAX_ATTESTATION_BYTES);
    if (!(outer instanceof Map) || outer.size !== 3 || outer.get("fmt") !== "apple-appattest") invalid();
    const statement = outer.get("attStmt");
    const auth = outer.get("authData");
    if (!(statement instanceof Map) || statement.size !== 2 ||
        !(statement.get("receipt") instanceof Uint8Array) || !statement.get("receipt").length ||
        !(auth instanceof Uint8Array) || auth.length < 88) invalid();
    const chain = statement.get("x5c");
    if (!Array.isArray(chain) || chain.length !== 2 || !chain.every(v => v instanceof Uint8Array)) invalid();
    const leaf = validateAttestationCertificates(chain, dependencies.now());
    const data = Buffer.from(auth);
    // AT is required. Apple's documented extension sample omits ED even when
    // extensions follow the credential key, so inspect the exact CBOR sequence.
    if ((data[32] & 0x40) === 0 || (data[32] & ~0xc1) !== 0 || data.readUInt32BE(33) !== 0 ||
        data.subarray(37, 53).toString("hex") !== AAGUIDS[context.environment] ||
        data.readUInt16BE(53) !== 32 || data.subarray(55, 87).toString("base64") !== input.keyId) invalid();
    const embedded = decodeStrictCborItems(auth.subarray(87), MAX_ATTESTATION_BYTES, 2);
    const cose = embedded[0];
    if (!(cose instanceof Map)) invalid();
    assertCredentialPublicKey(leaf, cose);
    if (embedded.length === 2) {
      const extensions = embedded[1];
      if (!(extensions instanceof Map) || !extensions.size) invalid();
      for (const [key, value] of extensions) {
        if (typeof key !== "string" || !EXTENSIONS.has(key)) invalid();
        if (key === "apple_validation_category_01" ?
          !(value instanceof Uint8Array) || value.length !== 4 :
          typeof value !== "string" || value.length === 0 || value.length > 255) invalid();
      }
    } else if (data[32] & 0x80) invalid();
    // Pass exact payload bytes. Upstream computes SHA256(payload), then
    // SHA256(authData || clientDataHash); prehashing here would hash twice.
    const verified = verifyAttestation({
      attestation: input.attestation, keyId: input.keyId, challenge: input.clientPayload,
      teamIdentifier: context.teamId, bundleIdentifier: context.bundleId,
      allowDevelopmentEnvironment: context.environment === "development",
    });
    if (verified.environment !== context.environment) invalid();
    const extensions: AttestationFacts["extensions"] = {};
    if (verified.validationCategory !== undefined) extensions.validationCategory = verified.validationCategory;
    if (verified.bundleVersion !== undefined) extensions.bundleVersion = verified.bundleVersion;
    return { keyId: verified.keyId, publicKey: verified.publicKey, environment: verified.environment,
      aaguid: AAGUIDS[context.environment], counter: data.readUInt32BE(33), extensions };
  } catch {
    // Never expose proof bytes, identity, or parser/provider error text.
    return null;
  }
}
