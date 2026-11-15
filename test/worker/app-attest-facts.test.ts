import { describe, expect, it } from "vitest";
import { verifyAttestation } from "node-app-attest";
import { createHash } from "node:crypto";
import { encode, decode } from "cbor2";
import { decodeStrictCbor, decodeStrictCborItems } from "../../src/chatgpt/attestation/cbor";
import { verifyAttestationFacts } from "../../src/chatgpt/attestation/facts";
import { validateCertificateProfile, assertCredentialPublicKey } from "../../src/chatgpt/attestation/certificates";
import type { AttestationContext } from "../../src/chatgpt/attestation/types";
import production from "./fixtures/app-attest/attestation-production.json";
import extensions from "./fixtures/app-attest/attestation-extensions.json";
import synthetic from "./fixtures/app-attest/synthetic-certificates.json";
import development from "./fixtures/app-attest/attestation-development.json";

// Characterization gate: do not replace the reviewed upstream crypto on failure.
describe("reviewed upstream crypto in workerd", () => {
  it("verifies the public Apple-root historical P256/P384 fixture", () => {
    const result = verifyAttestation({
      attestation: Buffer.from(development.attestation, "base64"),
      challenge: Buffer.from(development.challenge, "base64"),
      keyId: development.keyId,
      bundleIdentifier: "io.uebelacker.AppAttestExample",
      teamIdentifier: "V8H6LQ9448",
      allowDevelopmentEnvironment: true,
    });
    expect(result.environment).toBe("development");
    expect(result.keyId).toBe(development.keyId);
    expect(result.publicKey).toContain("-----BEGIN PUBLIC KEY-----");
  });
});

// These cases catch parser relaxation before untrusted objects reach crypto.
describe("strict bounded CBOR", () => {
  const hex = (value: string) => new Uint8Array(Buffer.from(value, "hex"));
  it("preserves byte strings and arbitrary Map keys without object coercion", () => {
    const decoded = decodeStrictCbor(hex("a261784201020103"), 8);
    expect(decoded).toEqual(new Map<unknown, unknown>([["x", hex("0102")], [1, 3]]));
  });
  it("accepts depth 16 and rejects depth 17, including empty containers", () => {
    expect(() => decodeStrictCbor(hex("81".repeat(16) + "00"), 64)).not.toThrow();
    expect(() => decodeStrictCbor(hex("81".repeat(17) + "00"), 64)).toThrow();
    expect(() => decodeStrictCbor(hex("81".repeat(16) + "80"), 64)).toThrow();
  });
  it.each([
    ["duplicate outer key", "a2617801617802"],
    ["duplicate nested key", "a16178a201020103"],
    ["equivalent integer keys", "a20102180103"],
    ["equivalent compound keys", "a281010281180103"],
    ["indefinite array", "9f01ff"],
    ["indefinite map", "bf0102ff"],
    ["indefinite bytes", "5f4101ff"],
    ["invalid UTF8", "61ff"],
    ["invalid surrogate UTF8", "63eda080"],
    ["tag", "c001"],
    ["nested tag", "81c001"],
    ["unsafe positive integer", "1b0020000000000000"],
    ["unsafe negative integer", "3b0020000000000000"],
    ["float", "f93c00"],
    ["bignum", "c24101"],
    ["undefined", "f7"],
    ["simple", "e0"],
    ["trailing object", "a000"],
    ["truncated", "82a0"],
    ["empty", ""],
  ])("rejects %s", (_name, bytes) => {
    expect(() => decodeStrictCbor(hex(bytes), 1024)).toThrow();
  });
  it("bounds size before decoding, accepting the exact size", () => {
    const encoded = encode(new Uint8Array(64));
    expect(decodeStrictCbor(encoded, encoded.length)).toEqual(new Uint8Array(64));
    expect(() => decodeStrictCbor(encoded, encoded.length - 1)).toThrow();
  });
});

const context: AttestationContext = {
  teamId: "V8H6LQ9448", bundleId: "io.uebelacker.AppAttestExample", environment: "development",
};
const historical = { now: () => Date.parse("2024-03-01T00:00:00Z") };
const input = () => ({
  attestation: new Uint8Array(Buffer.from(development.attestation, "base64")),
  clientPayload: new Uint8Array(Buffer.from(development.challenge, "base64")),
  keyId: development.keyId,
});
const fromHex = (value: string) => new Uint8Array(Buffer.from(value, "hex"));
function mutated(change: (outer: Map<unknown, unknown>) => void): Uint8Array {
  const outer = decode<Map<unknown, unknown>>(input().attestation, { preferMap: true });
  change(outer);
  return encode(outer);
}
function changedAuth(change: (auth: Uint8Array) => Uint8Array | void): Uint8Array {
  return mutated(outer => {
    const auth = outer.get("authData") as Uint8Array;
    outer.set("authData", change(auth) ?? auth);
  });
}

describe("internal attestation facts, insufficient for enrollment", () => {
  it("accepts genuine historical development facts without current admission extensions", async () => {
    const facts = await verifyAttestationFacts(input(), context, historical);
    expect(facts).toMatchObject({ keyId: development.keyId, environment: "development", counter: 0,
      aaguid: "617070617474657374646576656c6f70", extensions: {} });
    expect(facts?.publicKey).toContain("-----BEGIN PUBLIC KEY-----");
  });
  it("accepts genuine historical production facts only in exact production context", async () => {
    const value = { attestation: new Uint8Array(Buffer.from(production.attestation, "base64")),
      clientPayload: new Uint8Array(Buffer.from(production.challenge, "base64")), keyId: production.keyId };
    expect(await verifyAttestationFacts(value, { ...context, environment: "production" }, historical))
      .toMatchObject({ environment: "production", aaguid: "61707061747465737400000000000000", counter: 0 });
    expect(await verifyAttestationFacts(value, context, historical)).toBeNull();
  });
  it("treats the public extension guide as parser evidence, denying its mismatched challenge", async () => {
    // Upstream uses this sample for parser tests only; its declared challenge
    // does not reproduce the leaf nonce. It is not paired cryptographic evidence.
    const outer = decodeStrictCbor(new Uint8Array(Buffer.from(extensions.attestation, "base64")), 65536) as Map<unknown, unknown>;
    const auth = outer.get("authData") as Uint8Array;
    const items = decodeStrictCborItems(auth.subarray(87), 65536, 2);
    expect(items[1]).toEqual(new Map<unknown, unknown>([
      ["apple_bundle_version_01", "1"],
      ["apple_validation_category_01", new Uint8Array([1, 0, 0, 0])],
    ]));
    expect(() => verifyAttestation({ attestation: new Uint8Array(Buffer.from(extensions.attestation, "base64")),
      challenge: new TextEncoder().encode(extensions.challenge), keyId: extensions.keyId,
      teamIdentifier: extensions.teamIdentifier, bundleIdentifier: extensions.bundleIdentifier }))
      .toThrow("nonce does not match");
    expect(await verifyAttestationFacts({ attestation: new Uint8Array(Buffer.from(extensions.attestation, "base64")),
      clientPayload: new TextEncoder().encode(extensions.challenge), keyId: extensions.keyId },
      { teamId: extensions.teamIdentifier, bundleId: extensions.bundleIdentifier, environment: "production" },
      { now: () => Date.parse("2026-04-21T00:00:00Z") })).toBeNull();
  });
  it("rejects expired genuine certificates using current server time", async () => {
    expect(await verifyAttestationFacts(input(), context)).toBeNull();
  });
  it("rejects genuine certificates before notBefore", async () => {
    expect(await verifyAttestationFacts(input(), context, { now: () => Date.parse("2024-01-01T00:00:00Z") })).toBeNull();
  });
  it("hashes exact payload bytes once, denying changed bytes and prehashed payloads", async () => {
    const value = input(); value.clientPayload[0] ^= 1;
    expect(await verifyAttestationFacts(value, context, historical)).toBeNull();
    expect(await verifyAttestationFacts({ ...input(), clientPayload: createHash("sha256").update(input().clientPayload).digest() }, context, historical)).toBeNull();
  });
  it("rejects altered RP/application context and environment", async () => {
    expect(await verifyAttestationFacts(input(), { ...context, bundleId: "io.example.Other" }, historical)).toBeNull();
    expect(await verifyAttestationFacts(input(), { ...context, teamId: "0123456789" }, historical)).toBeNull();
    expect(await verifyAttestationFacts(input(), { ...context, environment: "production" }, historical)).toBeNull();
    expect(await verifyAttestationFacts({ ...input(), attestation: changedAuth(a => { a[0] ^= 1; }) }, context, historical)).toBeNull();
  });
  it("rejects altered key/credential, counter and nonce-bound authenticator bytes", async () => {
    expect(await verifyAttestationFacts({ ...input(), keyId: Buffer.alloc(32).toString("base64") }, context, historical)).toBeNull();
    for (const offset of [33, 37, 55, 120]) {
      expect(await verifyAttestationFacts({ ...input(), attestation: changedAuth(a => { a[offset] ^= 1; }) }, context, historical)).toBeNull();
    }
  });
  it("rejects reversed, replaced, truncated or duplicate certificates", async () => {
    for (const change of [
      (c: Uint8Array[]) => c.reverse(),
      (c: Uint8Array[]) => [c[0], c[0]],
      (c: Uint8Array[]) => [c[0]],
      (c: Uint8Array[]) => [fromHex("3000"), c[1]],
      (c: Uint8Array[]) => [new Uint8Array(Buffer.from(synthetic.validLeaf, "base64")), c[1]],
      (c: Uint8Array[]) => [new Uint8Array([...c[0], 0]), c[1]],
    ]) {
      const attestation = mutated(o => { const stmt = o.get("attStmt") as Map<unknown, unknown>;
        stmt.set("x5c", change(stmt.get("x5c") as Uint8Array[])); });
      expect(await verifyAttestationFacts({ ...input(), attestation }, context, historical)).toBeNull();
    }
  });
  it("rejects a signature bit change in either otherwise valid certificate", async () => {
    for (const index of [0, 1]) {
      const attestation = mutated(o => {
        const chain = (o.get("attStmt") as Map<unknown, unknown>).get("x5c") as Uint8Array[];
        chain[index][chain[index].length - 1] ^= 1;
        // This mutation preserves the profile: rejection needs crypto, not parsing.
        expect(() => validateCertificateProfile(chain[index], index === 0 ? "leaf" : "intermediate", historical.now())).not.toThrow();
      });
      expect(await verifyAttestationFacts({ ...input(), attestation }, context, historical)).toBeNull();
    }
  });
  it.each(["fmt", "attStmt", "authData"])("rejects wrong outer shape for %s", async (field) => {
    const attestation = mutated(o => { o.set(field, 1); });
    expect(await verifyAttestationFacts({ ...input(), attestation }, context, historical)).toBeNull();
  });
  it("rejects missing/wrong attestation statement types", async () => {
    for (const [field, value] of [["receipt", "bytes"], ["x5c", "array"]]) {
      const attestation = mutated(o => { (o.get("attStmt") as Map<unknown, unknown>).set(field, value); });
      expect(await verifyAttestationFacts({ ...input(), attestation }, context, historical)).toBeNull();
    }
  });
  it("rejects outer duplicates and trailing CBOR objects", async () => {
    expect(await verifyAttestationFacts({ ...input(), attestation: new Uint8Array([...input().attestation, 0]) }, context, historical)).toBeNull();
    expect(await verifyAttestationFacts({ ...input(), attestation: fromHex("a2617801617802") }, context, historical)).toBeNull();
  });
  it.each([
    ["duplicate credential key", "a201020103"],
    ["duplicate extension key", "a0a2617801617802"],
    ["third embedded object", "a0a000"],
    ["deep credential", "81".repeat(17) + "00"],
    ["tagged credential", "c0a0"],
    ["indefinite credential", "bf0102ff"],
    ["wrong credential type", "01"],
    ["wrong extension type", "a001"],
  ])("rejects %s with shared strict embedded decoder", async (_name, encoded) => {
    const attestation = changedAuth(a => new Uint8Array([...a.subarray(0, 87), ...fromHex(encoded)]));
    expect(await verifyAttestationFacts({ ...input(), attestation }, context, historical)).toBeNull();
  });
  it("accepts a 64 KiB proof and rejects boundary plus one before library verification", async () => {
    // Receipt is opaque to this facts-only verifier. Keep the signed authData
    // and certificates intact while independently exercising the proof bound.
    const padded = (size: number) => {
      const outer = decode<Map<unknown, unknown>>(input().attestation, { preferMap: true });
      const statement = outer.get("attStmt") as Map<unknown, unknown>;
      statement.set("receipt", new Uint8Array(65500));
      const overhead = encode(outer).length - 65500;
      statement.set("receipt", new Uint8Array(size - overhead));
      const encoded = encode(outer);
      expect(encoded.length).toBe(size);
      return encoded;
    };
    expect(await verifyAttestationFacts({ ...input(), attestation: padded(65536) }, context, historical))
      .toMatchObject({ keyId: development.keyId });
    expect(await verifyAttestationFacts({ ...input(), attestation: padded(65537) }, context, historical)).toBeNull();
  });
  it("bounds proof and exact payload bytes before parser/crypto", async () => {
    expect(await verifyAttestationFacts({ ...input(), attestation: new Uint8Array(65537) }, context, historical)).toBeNull();
    expect(await verifyAttestationFacts({ ...input(), clientPayload: new Uint8Array(8193) }, context, historical)).toBeNull();
    expect(await verifyAttestationFacts({ ...input(), attestation: new Uint8Array() }, context, historical)).toBeNull();
    expect(await verifyAttestationFacts({ ...input(), keyId: "a".repeat(100000) }, context, historical)).toBeNull();
  });
  it("throws only fixed invalid_configuration for invalid trusted context", async () => {
    for (const bad of [{ ...context, teamId: "" }, { ...context, teamId: "team" },
      { ...context, bundleId: " bad.bundle " }, { ...context, environment: "sandbox" }]) {
      await expect(verifyAttestationFacts(input(), bad as AttestationContext, historical)).rejects.toThrow(/^invalid_configuration$/);
    }
  });
});

describe("synthetic certificate profile parsing in workerd (not Apple trust)", () => {
  const cert = (name: keyof typeof synthetic) => new Uint8Array(Buffer.from(synthetic[name], "base64"));
  it("accepts supported P256 leaf and P384 issuer profiles", () => {
    expect(() => validateCertificateProfile(cert("validLeaf"), "leaf", historical.now())).not.toThrow();
    expect(() => validateCertificateProfile(cert("validIssuer"), "intermediate", historical.now())).not.toThrow();
  });
  it.each([
    "leafAsCA", "missingDigitalSignature", "leafSigningCertificates", "unknownCriticalExtension",
    "nonceWrongTag", "nonceWrongLength", "nonceTrailing", "nonceMissing", "unsupportedPublicKey",
    "unsupportedCurve", "unsupportedSignature", "invalidExtendedUsage",
  ] as const)("rejects %s", name => {
    expect(() => validateCertificateProfile(cert(name), "leaf", historical.now())).toThrow();
  });
  it("rejects expired/not-yet-valid leaves and nonfinite server time", () => {
    for (const now of [Date.parse("2025-01-02T00:00:00Z"), Date.parse("2023-12-31T00:00:00Z"), NaN]) {
      expect(() => validateCertificateProfile(cert("validLeaf"), "leaf", now)).toThrow();
    }
  });
  it("rejects intermediate as leaf and CA without keyCertSign", () => {
    expect(() => validateCertificateProfile(cert("validIssuer"), "leaf", historical.now())).toThrow();
    expect(() => validateCertificateProfile(cert("caMissingKeyCertSign"), "intermediate", historical.now())).toThrow();
  });
  it("requires complete ASN.1 consumption", () => {
    expect(() => validateCertificateProfile(new Uint8Array([...cert("validLeaf"), 0]), "leaf", historical.now())).toThrow();
  });
  it("binds the COSE ES256 P256 point to the certificate public key", () => {
    const parsed = validateCertificateProfile(cert("validLeaf"), "leaf", historical.now());
    const cose = new Map<unknown, unknown>([[1, 2], [3, -7], [-1, 1], [-2, fromHex(synthetic.x)], [-3, fromHex(synthetic.y)]]);
    expect(() => assertCredentialPublicKey(parsed, cose)).not.toThrow();
    const mismatch = new Map(cose); mismatch.set(-2, new Uint8Array(32));
    expect(() => assertCredentialPublicKey(parsed, mismatch)).toThrow();
    for (const [key, value] of [[1, 3], [3, -35], [-1, 2], [-2, "bytes"], [-3, new Uint8Array(31)]]) {
      const wrong = new Map(cose); wrong.set(key, value);
      expect(() => assertCredentialPublicKey(parsed, wrong)).toThrow();
    }
  });
});
