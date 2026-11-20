import { X509Certificate } from "node:crypto";
import * as asn1js from "asn1js";
import { BasicConstraints, Certificate, ExtKeyUsage } from "pkijs";

// Apple App Attestation root, independently pinned from the StoreKit roots.
// https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem
const APPLE_APP_ATTESTATION_ROOT = `-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV
oyFraWVIyd/dganmrduC1bmTBGwD
-----END CERTIFICATE-----`;
const NONCE_OID = "1.2.840.113635.100.8.2";
const BASIC_CONSTRAINTS = "2.5.29.19";
const KEY_USAGE = "2.5.29.15";
const EXTENDED_KEY_USAGE = "2.5.29.37";
const P256 = "1.2.840.10045.3.1.7";
const P384 = "1.3.132.0.34";
const SIGNATURES = new Set(["1.2.840.10045.4.3.2", "1.2.840.10045.4.3.3", "1.2.840.10045.4.3.4"]);
const KNOWN_CRITICAL = new Set([BASIC_CONSTRAINTS, KEY_USAGE, EXTENDED_KEY_USAGE, NONCE_OID]);

function invalid(): never { throw new Error("invalid_certificate"); }

function parseAsn1(bytes: Uint8Array): asn1js.AsnType {
  if (!bytes.length || bytes.length > 16384) invalid();
  const parsed = asn1js.fromBER(bytes, { maxDepth: 32, maxNodes: 2048,
    maxContentLength: 16384, parseEmbedded: false });
  if (parsed.offset !== bytes.length || parsed.result.error || parsed.result.warnings.length) invalid();
  return parsed.result;
}

function requireNonceShape(value: asn1js.AsnType): void {
  if (!(value instanceof asn1js.Sequence) || value.valueBlock.value.length !== 1) invalid();
  const tagged = value.valueBlock.value[0];
  if (!(tagged instanceof asn1js.Constructed) || tagged.idBlock.tagClass !== 3 ||
      tagged.idBlock.tagNumber !== 1 || tagged.valueBlock.value.length !== 1) invalid();
  const nonce = tagged.valueBlock.value[0];
  if (!(nonce instanceof asn1js.OctetString) || nonce.idBlock.isConstructed ||
      nonce.valueBlock.valueHexView.length !== 32) invalid();
}

/** Validates certificate constraints only; it does not establish Apple trust. */
export function validateCertificateProfile(
  bytes: Uint8Array, role: "leaf" | "intermediate" | "root", now: number,
): Certificate {
  if (!(bytes instanceof Uint8Array) || !Number.isFinite(now)) invalid();
  const certificate = new Certificate({ schema: parseAsn1(bytes) });
  if (certificate.version !== 2 || !certificate.signature.isEqual(certificate.signatureAlgorithm) ||
      !SIGNATURES.has(certificate.signatureAlgorithm.algorithmId) ||
      certificate.signatureAlgorithm.algorithmParams !== undefined ||
      certificate.signatureValue.valueBlock.unusedBits !== 0) invalid();
  const before = certificate.notBefore.value.getTime();
  const after = certificate.notAfter.value.getTime();
  if (!Number.isFinite(before) || !Number.isFinite(after) || before > now || after < now || before > after) invalid();
  const key = certificate.subjectPublicKeyInfo;
  const curve = key.algorithm.algorithmParams;
  if (key.algorithm.algorithmId !== "1.2.840.10045.2.1" ||
      !(curve instanceof asn1js.ObjectIdentifier) ||
      !(role === "leaf" ? curve.valueBlock.toString() === P256 :
        [P256, P384].includes(curve.valueBlock.toString())) ||
      key.subjectPublicKey.valueBlock.unusedBits !== 0) invalid();

  const extensions = new Map<string, asn1js.AsnType>();
  for (const extension of certificate.extensions ?? []) {
    if (extensions.has(extension.extnID) || (extension.critical && !KNOWN_CRITICAL.has(extension.extnID))) invalid();
    // Bound even opaque, noncritical extension structures before upstream parsing.
    const value = parseAsn1(extension.extnValue.valueBlock.valueHexView);
    extensions.set(extension.extnID, value);
  }
  const constraints = extensions.get(BASIC_CONSTRAINTS);
  const usage = extensions.get(KEY_USAGE);
  if (!constraints || !(usage instanceof asn1js.BitString) || usage.idBlock.isConstructed) invalid();
  const basic = new BasicConstraints({ schema: constraints });
  const bits = usage.valueBlock.valueHexView;
  if (!bits.length) invalid();
  const isCA = role !== "leaf";
  if (basic.cA !== isCA || (isCA ? !(bits[0] & 0x04) :
      !(bits[0] & 0x80) || Boolean(bits[0] & 0x06))) invalid();
  if (!isCA && basic.pathLenConstraint !== undefined) invalid();
  if (basic.pathLenConstraint !== undefined &&
      (typeof basic.pathLenConstraint !== "number" || basic.pathLenConstraint < 0 ||
        !Number.isSafeInteger(basic.pathLenConstraint) || (role === "root" && basic.pathLenConstraint < 1))) invalid();

  const extendedUsage = extensions.get(EXTENDED_KEY_USAGE);
  if (extendedUsage) {
    const purposes = new ExtKeyUsage({ schema: extendedUsage }).keyPurposes;
    // Apple's attestation leaf purpose. Do not allow a TLS or unrelated purpose.
    if (role !== "leaf" || purposes.length !== 1 || purposes[0] !== "1.2.840.113635.100.4.24") invalid();
  }
  const nonce = extensions.get(NONCE_OID);
  if (role === "leaf") {
    if (!nonce) invalid();
    requireNonceShape(nonce);
  } else if (nonce) invalid();
  return certificate;
}

/** Checks ordered names and constraints; the reviewed upstream verifies signatures. */
export function validateAttestationCertificates(chain: Uint8Array[], now: number): Certificate {
  if (chain.length !== 2) invalid();
  const leaf = validateCertificateProfile(chain[0], "leaf", now);
  const intermediate = validateCertificateProfile(chain[1], "intermediate", now);
  const rootBytes = new X509Certificate(APPLE_APP_ATTESTATION_ROOT).raw;
  const root = validateCertificateProfile(rootBytes, "root", now);
  if (!leaf.issuer.isEqual(intermediate.subject) || !intermediate.issuer.isEqual(root.subject)) invalid();
  // Upstream's embedded root is the same published Apple root (pinned package
  // version/provenance). It verifies both signatures with their declared digest.
  return leaf;
}

export function assertCredentialPublicKey(certificate: Certificate, cose: Map<unknown, unknown>): void {
  const x = cose.get(-2);
  const y = cose.get(-3);
  if (cose.size !== 5 || cose.get(1) !== 2 || cose.get(3) !== -7 || cose.get(-1) !== 1 ||
      !(x instanceof Uint8Array) || x.length !== 32 || !(y instanceof Uint8Array) || y.length !== 32) invalid();
  const point = new Uint8Array([4, ...x, ...y]);
  if (!Buffer.from(point).equals(Buffer.from(certificate.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView))) invalid();
}
