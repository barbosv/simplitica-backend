import { afterEach, describe, expect, it, vi } from "vitest";
import { encode } from "cbor2";
import { createAttestationAdmission } from "../../src/chatgpt/attestation/admission";
import * as facts from "../../src/chatgpt/attestation/facts";
import type { AttestationAdmissionPolicy, AttestationContext, AttestationFacts } from "../../src/chatgpt/attestation/types";
import development from "./fixtures/app-attest/attestation-development.json";
import production from "./fixtures/app-attest/attestation-production.json";
import upstream from "./fixtures/app-attest/assertion-upstream.json";
import { syntheticContext as context, syntheticExtensions, syntheticSigner } from "./fixtures/app-attest/synthetic-assertions";

const policy = (): AttestationAdmissionPolicy => ({ validationCategories: [3], bundleVersions: ["42"] });
const payload = Buffer.from("synthetic-admission-policy-only");
const input = () => ({ attestation: Buffer.from(development.attestation, "base64"), keyId: development.keyId,
  clientPayload: Buffer.from(development.challenge, "base64") });
const syntheticFacts = (): AttestationFacts => ({ keyId: "synthetic-policy-key", publicKey: "synthetic-policy-public-key",
  environment: "development", aaguid: "617070617474657374646576656c6f70", counter: 0,
  extensions: { validationCategory: 3, bundleVersion: "42" } });

afterEach(() => vi.restoreAllMocks());

describe("strict internal admission, paired physical qualification still required", () => {
  it.each([
    undefined, null, {}, { validationCategories: [], bundleVersions: ["42"] },
    { validationCategories: [3], bundleVersions: [] },
    ...[0, 1, 5, -1, 3.5, 4294967296, Number.NaN, "3", null].map(v => ({ validationCategories: [v], bundleVersions: ["42"] })),
    { validationCategories: [3, 3], bundleVersions: ["42"] },
    ...["", "é".repeat(65), "\ud800", 42, null].map(v => ({ validationCategories: [3], bundleVersions: [v] })),
    { validationCategories: [3], bundleVersions: ["42", "42"] },
    { validationCategories: "3", bundleVersions: ["42"] },
    { validationCategories: [3], bundleVersions: "42" },
  ])("requires explicit well-formed nonempty unique trusted allowlists: %j", malformed => {
    expect(() => createAttestationAdmission(context, malformed as AttestationAdmissionPolicy)).toThrow(/^invalid_configuration$/);
  });
  it.each([
    null, { ...context, teamId: "bad" }, { ...context, bundleId: "bad" },
    { ...context, environment: "any" },
  ])("rejects malformed trusted context immediately: %j", malformed => {
    expect(() => createAttestationAdmission(malformed as AttestationContext, policy())).toThrow(/^invalid_configuration$/);
  });
  it("uses immutable copies of context and both policy allowlists", async () => {
    const trustedContext = { ...context };
    const trustedPolicy = { validationCategories: [3], bundleVersions: ["42"] };
    const admission = createAttestationAdmission(trustedContext, trustedPolicy);
    trustedContext.teamId = "AAAAAAAAAA";
    trustedContext.bundleId = "other.app";
    trustedPolicy.validationCategories[0] = 4;
    trustedPolicy.bundleVersions[0] = "99";
    const signer = syntheticSigner();
    const assertion = signer.assertion(payload, 1, syntheticExtensions());
    expect((await admission.verifyAssertion({ assertion, payload }, signer.device))?.counter).toBe(1);
    expect(await admission.verifyAssertion({ assertion: signer.assertion(payload, 1, syntheticExtensions(4, "99")), payload }, signer.device)).toBeNull();
  });
  it.each([2, 3, 4])("admits signed synthetic candidate category %i only with the explicit version", async category => {
    const admission = createAttestationAdmission(context, { validationCategories: [category], bundleVersions: ["42"] });
    const signer = syntheticSigner();
    const assertion = signer.assertion(payload, 1, syntheticExtensions(category));
    expect(await admission.verifyAssertion({ assertion, payload }, signer.device)).toEqual({ counter: 1,
      extensions: new Map<string, unknown>([["validationCategory", category], ["bundleVersion", "42"]]) });
  });
  it("matches version UTF8 bytes exactly without normalization, at the 128-byte boundary", async () => {
    const signer = syntheticSigner();
    const version = "é".repeat(64);
    const admission = createAttestationAdmission(context, { validationCategories: [3], bundleVersions: [version] });
    expect((await admission.verifyAssertion({ assertion: signer.assertion(payload, 1, syntheticExtensions(3, version)), payload }, signer.device))?.counter).toBe(1);
    expect(await admission.verifyAssertion({ assertion: signer.assertion(payload, 1, syntheticExtensions(3, version.normalize("NFD"))), payload }, signer.device)).toBeNull();
  });
  it.each([
    ["missing both", undefined], ["missing version", encode(new Map([["validationCategory", 3]]))],
    ["missing category", encode(new Map([["bundleVersion", "42"]]))],
    ["unapproved category", syntheticExtensions(4)], ["unapproved build", syntheticExtensions(3, "43")],
    ["unknown evidence", encode({ validationCategory: 3, bundleVersion: "42", unknown: true })],
    ["attestation aliases", encode({ apple_validation_category_01: new Uint8Array([0, 0, 0, 3]), apple_bundle_version_01: "42" })],
  ])("denies signed synthetic assertion %s", async (_name, extensions) => {
    const signer = syntheticSigner();
    expect(await createAttestationAdmission(context, policy()).verifyAssertion({ assertion: signer.assertion(payload, 1, extensions), payload }, signer.device)).toBeNull();
  });
  it("denies altered signature/payload/RP and replay after policy evidence is present", async () => {
    const signer = syntheticSigner();
    const assertion = signer.assertion(payload, 1, syntheticExtensions());
    const admission = createAttestationAdmission(context, policy());
    expect(await admission.verifyAssertion({ assertion, payload: Buffer.from("changed") }, signer.device)).toBeNull();
    expect(await admission.verifyAssertion({ assertion, payload }, { ...signer.device, counter: 1 })).toBeNull();
    expect(await createAttestationAdmission({ ...context, bundleId: "other.app" }, policy()).verifyAssertion({ assertion, payload }, signer.device)).toBeNull();
    const changed = new Uint8Array(assertion);
    changed[20] ^= 1;
    expect(await admission.verifyAssertion({ assertion: changed, payload }, signer.device)).toBeNull();
  });
  it("denies the unpaired historical assertion despite a valid cryptographic signature", async () => {
    expect(await createAttestationAdmission(context, policy()).verifyAssertion({ assertion: Buffer.from(upstream.assertion, "base64"),
      payload: Buffer.from(upstream.payload) }, { publicKeyPem: upstream.publicKeyPem, counter: 0 })).toBeNull();
  });
  it("denies genuine historical extension-free attestation even at its valid certificate time", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2024-03-01T00:00:00Z"));
    expect(await facts.verifyAttestationFacts(input(), context)).toMatchObject({ counter: 0, extensions: {} });
    expect(await createAttestationAdmission(context, policy()).verifyAttestation(input())).toBeNull();
    const prod = { attestation: Buffer.from(production.attestation, "base64"), keyId: production.keyId,
      clientPayload: Buffer.from(production.challenge, "base64") };
    expect(await createAttestationAdmission(context, policy()).verifyAttestation(prod)).toBeNull();
    expect(await createAttestationAdmission({ ...context, environment: "production" }, policy()).verifyAttestation(input())).toBeNull();
  });
  it("denies expired historical attestation at server time", async () => {
    expect(await createAttestationAdmission(context, policy()).verifyAttestation(input())).toBeNull();
  });
  // No genuine paired current-extension attestation exists in this suite. These
  // tests replace ONLY crypto facts to exercise real admission policy branches;
  // they cannot establish Apple trust, extension encoding or paired-device proof.
  it("admits synthetic attestation policy evidence only after facts verification", async () => {
    vi.spyOn(facts, "verifyAttestationFacts").mockResolvedValue(syntheticFacts());
    expect(await createAttestationAdmission(context, policy()).verifyAttestation(input())).toEqual(syntheticFacts());
  });
  it.each([
    {}, { validationCategory: 3 }, { bundleVersion: "42" },
    { validationCategory: 4, bundleVersion: "42" }, { validationCategory: 3, bundleVersion: "43" },
    { validationCategory: 0, bundleVersion: "42" }, { validationCategory: 3, bundleVersion: "" },
  ])("denies synthetic attestation facts with missing/unapproved policy evidence %j", async extensions => {
    vi.spyOn(facts, "verifyAttestationFacts").mockResolvedValue({ ...syntheticFacts(), extensions });
    expect(await createAttestationAdmission(context, policy()).verifyAttestation(input())).toBeNull();
  });
});
