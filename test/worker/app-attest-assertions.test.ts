import { describe, expect, it } from "vitest";
import { createHash, createVerify, generateKeyPairSync, sign } from "node:crypto";
import { decode, encode } from "cbor2";
import { verifyAssertion as verifyUpstreamAssertion } from "node-app-attest";
import { verifyAssertionFacts } from "../../src/chatgpt/attestation/assertions";
import fixture from "./fixtures/app-attest/assertion-upstream.json";
import golden from "./fixtures/app-attest/payload-golden.json";
import { syntheticContext as context, syntheticExtensions, syntheticSigner } from "./fixtures/app-attest/synthetic-assertions";

const input = () => ({ assertion: Buffer.from(fixture.assertion, "base64"), payload: Buffer.from(fixture.payload) });
const device = { publicKeyPem: fixture.publicKeyPem, counter: 0 };
const verify = (assertion: Uint8Array, payload = input().payload, stored = device) =>
  verifyAssertionFacts({ assertion, payload }, stored, context);

describe("exact-byte assertion facts, no enrollment or action authority", () => {
  it("verifies the unpaired public upstream signature with its exact algorithm in workerd", async () => {
    expect(await verify(input().assertion)).toEqual({ counter: 1, extensions: new Map() });
    // Independent fixture characterization: direct-concatenation verification fails.
    const decoded = decode<{ signature: Uint8Array; authenticatorData: Uint8Array }>(input().assertion);
    const verifier = createVerify("sha256");
    verifier.update(Buffer.concat([decoded.authenticatorData, createHash("sha256").update(input().payload).digest()]));
    expect(verifier.verify(fixture.publicKeyPem, decoded.signature)).toBe(false);
  });
  it.each([
    ["changed payload", Buffer.from("changed")],
    ["different JSON whitespace", Buffer.from(JSON.stringify(JSON.parse(fixture.payload), null, 2))],
    ["prehashed payload", createHash("sha256").update(fixture.payload).digest()],
  ])("denies %s", async (_name, payload) => {
    expect(await verify(input().assertion, payload)).toBeNull();
  });
  it("denies a different trusted RP context", async () => {
    expect(await verifyAssertionFacts(input(), device, { ...context, bundleId: "other.app" })).toBeNull();
    expect(await verifyAssertionFacts(input(), device, { ...context, teamId: "AAAAAAAAAA" })).toBeNull();
  });
  it("denies a different stored key and malformed PEM without exposing crypto errors", async () => {
    expect(await verify(input().assertion, input().payload, syntheticSigner().device)).toBeNull();
    expect(await verify(input().assertion, input().payload, { ...device, publicKeyPem: "invalid" })).toBeNull();
  });
  it("denies signed synthetic RSA and non-P256 EC stored keys", async () => {
    for (const options of [{ type: "rsa" as const, options: { modulusLength: 2048 } },
      { type: "ec" as const, options: { namedCurve: "secp384r1" } }]) {
      const pair = options.type === "rsa" ? generateKeyPairSync("rsa", options.options as { modulusLength: number }) :
        generateKeyPairSync("ec", options.options as { namedCurve: string });
      const auth = new Uint8Array(decode<{ authenticatorData: Uint8Array }>(input().assertion).authenticatorData);
      const nonce = createHash("sha256").update(Buffer.concat([auth, createHash("sha256").update(input().payload).digest()])).digest();
      const assertion = encode({ signature: new Uint8Array(sign("sha256", nonce, pair.privateKey)), authenticatorData: auth });
      expect(await verify(assertion, input().payload, { publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(), counter: 0 })).toBeNull();
    }
  });
  it("denies altered signature and authenticator bytes", async () => {
    for (const field of ["signature", "authenticatorData"]) {
      const outer = decode<Record<string, Uint8Array>>(input().assertion);
      outer[field][field === "signature" ? outer[field].length - 1 : 0] ^= 1;
      expect(await verify(encode({ signature: new Uint8Array(outer.signature), authenticatorData: new Uint8Array(outer.authenticatorData) }))).toBeNull();
    }
  });
  it.each([1, 2, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2147483647, 2147483648, 4294967296])(
    "denies replay/invalid/exhausted stored counter %s", async counter => {
      expect(await verify(input().assertion, input().payload, { ...device, counter })).toBeNull();
    });
  it("accepts the last supported unsigned counter and denies reset/wrap/high-bit counters with valid synthetic signatures", async () => {
    const signer = syntheticSigner();
    const payload = Buffer.from("synthetic-counter-control");
    expect(await verify(signer.assertion(payload, 2147483647), payload, { ...signer.device, counter: 2147483646 }))
      .toEqual({ counter: 2147483647, extensions: new Map() });
    for (const counter of [0, 2147483648, 4294967295]) {
      expect(await verify(signer.assertion(payload, counter), payload, signer.device)).toBeNull();
    }
    expect(await verify(signer.assertion(payload, 1), payload, { ...signer.device, counter: 2147483647 })).toBeNull();
  });
  it("accepts synthetic documented-name extensions but rejects alternate direct signing", async () => {
    const signer = syntheticSigner();
    const payload = Buffer.from("synthetic-policy-control");
    expect(await verify(signer.assertion(payload, 1, syntheticExtensions()), payload, signer.device))
      .toEqual({ counter: 1, extensions: new Map<string, unknown>([["validationCategory", 3], ["bundleVersion", "42"]]) });
    expect(await verify(signer.assertion(payload, 1, syntheticExtensions(), 0x80, "direct"), payload, signer.device)).toBeNull();
  });
  it.each([
    ["unknown extension", encode(new Map([["unknown", 3]]))],
    ["attestation aliases", encode(new Map<string, unknown>([["apple_validation_category_01", 3], ["apple_bundle_version_01", "42"]]))],
    ["non-map", encode([3, "42"])],
    ["empty map", encode(new Map())],
    ["category bytes alias", syntheticExtensions(new Uint8Array([0, 0, 0, 3]))],
    ["negative category", syntheticExtensions(-1)],
    ["category overflow", syntheticExtensions(4294967296)],
    ["empty version", syntheticExtensions(3, "")],
    ["oversized UTF8 version", syntheticExtensions(3, "é".repeat(65))],
    ["wrong version type", syntheticExtensions(3, 42)],
    ["duplicate embedded known key", Buffer.concat([Buffer.from([0xa3]), encode("validationCategory"), encode(3), encode("bundleVersion"), encode("42"), encode("validationCategory"), encode(3)])],
    ["indefinite known map", Buffer.concat([Buffer.from([0xbf]), encode("validationCategory"), encode(3), encode("bundleVersion"), encode("42"), Buffer.from([0xff])])],
    ["embedded trailing object", Buffer.concat([syntheticExtensions(), encode(0)])],
    ["embedded depth 17", Buffer.from("81".repeat(17) + "00", "hex")],
    ["embedded invalid UTF8", Buffer.from("a1617861ff", "hex")],
    ["embedded tag", Buffer.from("c0a0", "hex")],
    ["embedded float", Buffer.from("a16178f93c00", "hex")],
    ["oversized embedded bytes", new Uint8Array(8193)],
  ])("denies correctly signed synthetic malformed %s", async (_name, extensions) => {
    const signer = syntheticSigner();
    const payload = Buffer.from("synthetic-invalid-extension");
    const assertion = signer.assertion(payload, 1, extensions);
    // The intact signature passes maintained upstream; only adapter parsing/policy denies.
    expect(verifyUpstreamAssertion({ assertion, payload, publicKey: signer.device.publicKeyPem, signCount: 0,
      teamIdentifier: context.teamId, bundleIdentifier: context.bundleId })).toEqual({ signCount: 1 });
    expect(await verify(assertion, payload, signer.device)).toBeNull();
  });
  it("requires extension flags and excludes reserved flags", async () => {
    const signer = syntheticSigner();
    const payload = Buffer.from("synthetic-flags");
    for (const flags of [0, 0x40, 0x82, 0x84, 0x90]) {
      expect(await verify(signer.assertion(payload, 1, syntheticExtensions(), flags), payload, signer.device)).toBeNull();
    }
    expect(await verify(signer.assertion(payload, 1, undefined, 0x80), payload, signer.device)).toBeNull();
  });
  it("rejects malformed outer shapes, duplicates, trailing bytes and oversized proofs", async () => {
    const decoded = decode<Record<string, Uint8Array>>(input().assertion);
    for (const assertion of [
      encode({ ...decoded, extra: 1 }), encode({ signature: decoded.signature }),
      encode({ ...decoded, signature: "string" }), encode({ ...decoded, authenticatorData: new Uint8Array(36) }),
      encode([decoded.signature, decoded.authenticatorData]), Buffer.concat([input().assertion, encode(0)]),
      Buffer.from("a2617801617802", "hex"), new Uint8Array(8193), new Uint8Array(),
    ]) expect(await verify(assertion)).toBeNull();
  });
  it("bounds exact payloads at 8192 bytes and denies empty bytes", async () => {
    const signer = syntheticSigner();
    const payload = Buffer.alloc(8192, 65);
    expect(await verify(signer.assertion(payload), payload, signer.device)).toEqual({ counter: 1, extensions: new Map() });
    const oversized = Buffer.alloc(8193, 65);
    expect(await verify(signer.assertion(oversized), oversized, signer.device)).toBeNull();
    expect(await verify(signer.assertion(Buffer.alloc(0)), Buffer.alloc(0), signer.device)).toBeNull();
  });
  it("pins a synthetic Swift interoperability vector and rejects reserialized or changed signed intent", async () => {
    const payload = Buffer.from(golden.utf8);
    expect(payload.length).toBe(golden.byteLength);
    expect(payload.toString("hex")).toBe(golden.hex);
    expect(payload.toString("base64")).toBe(golden.base64);
    expect(createHash("sha256").update(payload).digest("hex")).toBe(golden.sha256);
    const signer = syntheticSigner();
    const assertion = signer.assertion(payload);
    expect((await verify(assertion, payload, signer.device))?.counter).toBe(1);
    expect(await verify(assertion, Buffer.from(JSON.stringify(JSON.parse(golden.utf8), null, 2)), signer.device)).toBeNull();
    for (const field of ["action", "version", "namespace", "challenge", "owner", "session", "keyId", "appEnvironment", "storeEnvironment", "expectedRevision", "purchaseProofSha256"]) {
      const changed = JSON.parse(golden.utf8);
      changed[field] = typeof changed[field] === "number" ? changed[field] + 1 : changed[field] + "x";
      expect(await verify(assertion, Buffer.from(JSON.stringify(changed)), signer.device)).toBeNull();
    }
  });
  it.each([
    { ...context, teamId: "bad" }, { ...context, bundleId: "bad" },
    { ...context, environment: "unknown" },
  ])("rejects malformed trusted configuration with a fixed error", async bad => {
    await expect(verifyAssertionFacts(input(), device, bad as typeof context)).rejects.toThrow(/^invalid_configuration$/);
  });
});
