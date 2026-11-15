import { validateAttestationContext } from "./context";
import { createPublicKey } from "node:crypto";
import { verifyAssertion } from "node-app-attest";
import { decodeStrictCbor } from "./cbor";
import type { AssertionFacts, AssertionInput, AttestationContext, AttestedDevice } from "./types";

const MAX_BYTES = 8192;
const MAX_COUNTER = 2147483647;

function invalid(): never { throw new Error("invalid_assertion"); }

/**
 * Internal exact-byte cryptographic evidence only. The device must come from a
 * previously verified database record selected for this context's environment;
 * assertions have no AAGUID/environment marker. No freshness, action authority,
 * challenge consumption, or counter/database mutation is performed here.
 *
 * Extension encoding is a single provisional candidate pending paired physical
 * capture: CBOR UInt32 validationCategory and text bundleVersion, without aliases.
 */
export async function verifyAssertionFacts(
  input: AssertionInput,
  device: AttestedDevice,
  context: AttestationContext,
): Promise<AssertionFacts | null> {
  validateAttestationContext(context);
  try {
    if (!input || !(input.payload instanceof Uint8Array) || !input.payload.length || input.payload.length > MAX_BYTES ||
        !device || !Number.isInteger(device.counter) || device.counter < 0 || device.counter >= MAX_COUNTER ||
        typeof device.publicKeyPem !== "string" || device.publicKeyPem.length > 4096) invalid();
    const outer = decodeStrictCbor(input.assertion, MAX_BYTES);
    if (!(outer instanceof Map) || outer.size !== 2) invalid();
    const auth = outer.get("authenticatorData");
    const signature = outer.get("signature");
    if (!(auth instanceof Uint8Array) || auth.length < 37 ||
        !(signature instanceof Uint8Array) || signature.length < 8 || signature.length > 72) invalid();
    const data = Buffer.from(auth);
    // The historical upstream assertion sets 0x40 without credential fields.
    // Treat it as an opaque App Attest flag, never as credential/UP evidence.
    // Exclude reserved bits; ED must agree with the exact extension bytes.
    if ((data[32] & ~0xc1) !== 0 || Boolean(data[32] & 0x80) !== (auth.length > 37)) invalid();
    const counter = data.readUInt32BE(33);
    // Upstream reads signed int32; rotate the key before that range is exhausted.
    if (counter <= device.counter || counter > MAX_COUNTER) invalid();
    let extensions = new Map<string, unknown>();
    if (auth.length > 37) {
      const embedded = decodeStrictCbor(auth.subarray(37), MAX_BYTES);
      if (!(embedded instanceof Map) || !embedded.size) invalid();
      for (const [name, value] of embedded) {
        if (name === "validationCategory") {
          if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) invalid();
        } else if (name === "bundleVersion") {
          if (typeof value !== "string" || !value.length || Buffer.byteLength(value, "utf8") > 128 ||
              Buffer.from(value, "utf8").toString("utf8") !== value) invalid();
        } else invalid();
      }
      extensions = embedded;
    }
    const key = createPublicKey(device.publicKeyPem);
    if (key.type !== "public" || key.asymmetricKeyType !== "ec" ||
        key.asymmetricKeyDetails?.namedCurve !== "prime256v1") invalid();
    // Maintained upstream computes SHA256(payload), then nonce = SHA256(auth ||
    // clientDataHash), and verifies ECDSA/SHA256 over nonce. No alternate algorithm.
    const verified = verifyAssertion({ assertion: input.assertion, payload: input.payload,
      publicKey: device.publicKeyPem, signCount: device.counter,
      teamIdentifier: context.teamId, bundleIdentifier: context.bundleId });
    if (verified.signCount !== counter) invalid();
    return { counter, extensions };
  } catch {
    // Never expose proof bytes, device identity or parser/provider error text.
    return null;
  }
}
