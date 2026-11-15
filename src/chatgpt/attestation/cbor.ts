import { decodeSequence, SequenceEvents } from "cbor2/decoder";
import { encode } from "cbor2/encoder";
import type { DecodeOptions } from "cbor2";

const MAX_DEPTH = 16;

// The maintained decoder owns tokenization, UTF8 and container parsing. No global
// tag handlers are consulted. Canonical key encodings also detect equivalent
// non-preferred encodings before Map construction could overwrite a key.
const options: DecodeOptions = {
  // cbor2 increments array recursion twice; the structural check below sets
  // the uniform 16-container limit for arrays and maps.
  maxDepth: MAX_DEPTH * 2,
  preferMap: true,
  ignoreGlobalTags: true,
  tags: new Map(),
  rejectDuplicateKeys: true,
  rejectStreaming: true,
  rejectFloats: true,
  rejectBigInts: true,
  rejectUndefined: true,
  rejectSimple: true,
  createObject(pairs) {
    const keys = new Set<string>();
    for (const [key] of pairs) {
      const encoded = Buffer.from(encode(key, { cde: true, ignoreOriginalEncoding: true })).toString("hex");
      if (keys.has(encoded)) throw new Error("invalid_cbor");
      keys.add(encoded);
    }
    return new Map(pairs.map(([key, value]) => [key, value]));
  },
};

function validateDepth(value: unknown, depth = 0): void {
  if (value instanceof Map || Array.isArray(value)) {
    if (++depth > MAX_DEPTH) throw new Error("invalid_cbor");
    if (value instanceof Map) {
      for (const [key, item] of value) {
        validateDepth(key, depth);
        validateDepth(item, depth);
      }
    } else {
      for (const item of value) validateDepth(item, depth);
    }
  }
}

/** Internal sequence form for the credential-key and optional extensions pair. */
export function decodeStrictCborItems(bytes: Uint8Array, maxBytes: number, maxItems: number): unknown[] {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || bytes.length > maxBytes) {
    throw new Error("invalid_cbor");
  }
  // Reject tags before they could invoke a decoder, and unsafe integers before
  // conversion. The same bounded event parser is used for outer and embedded CBOR.
  for (const [major, , value] of new SequenceEvents(bytes, options)) {
    if (major === 6 || ((major === 0 || major === 1) &&
        (typeof value === "bigint" || !Number.isSafeInteger(value)))) {
      throw new Error("invalid_cbor");
    }
  }
  const result: unknown[] = [];
  for (const value of decodeSequence(bytes, options)) {
    if (result.length >= maxItems) throw new Error("invalid_cbor");
    validateDepth(value);
    result.push(value);
  }
  if (!result.length) throw new Error("invalid_cbor");
  return result;
}

/** Decode exactly one complete, bounded CBOR item; trailing items are invalid. */
export function decodeStrictCbor(bytes: Uint8Array, maxBytes: number): unknown {
  return decodeStrictCborItems(bytes, maxBytes, 1)[0];
}
