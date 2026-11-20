import { describe, expect, it } from "vitest";
import fixtures from "../fixtures/cloud-calculator-raw-v1.json";
import { parseStrictJSON } from "../../src/chatgpt/json";
import { calculateDocumentJSONV1, CalculationError } from "../../src/chatgpt/documents/calculator";

const bytes = (raw: string) => new TextEncoder().encode(raw);

describe("bounded strict JSON byte parser", () => {
  for (const fixture of fixtures.preflightValid) {
    it(fixture.name, () => { expect(() => parseStrictJSON(bytes(fixture.raw))).not.toThrow(); });
  }
  for (const fixture of fixtures.preflightInvalid) {
    it(fixture.name, () => {
      expect(() => parseStrictJSON(bytes(fixture.raw))).toThrowError(new Error("invalid_json"));
    });
  }
  it("preserves exact decoded scalar keys without Unicode normalization", () => {
    expect(Object.keys(parseStrictJSON(bytes('{"é":1,"é":2}')) as object)).toEqual(["é", "é"]);
  });
  it("accepts depth 16 and rejects depth 17 before platform value parsing", () => {
    for (const open of ["[", '{"a":']) {
      const close = open === "[" ? "]" : "}";
      expect(() => parseStrictJSON(bytes(open.repeat(16) + "0" + close.repeat(16)))).not.toThrow();
      expect(() => parseStrictJSON(bytes(open.repeat(17) + "0" + close.repeat(17)))).toThrowError(new Error("invalid_json"));
    }
  });
  it("enforces 64 KiB including whitespace at both raw boundaries", () => {
    const raw = fixtures.valid[0].raw;
    const atLimit = bytes(raw + " ".repeat(65_536 - bytes(raw).length));
    expect(calculateDocumentJSONV1(atLimit).total).toBe("1.00");
    expect(() => parseStrictJSON(bytes("0" + " ".repeat(65_535)))).not.toThrow();
    const unicodeAtLimit = bytes('"' + "é".repeat(32_767) + '"');
    expect(unicodeAtLimit.byteLength).toBe(65_536);
    expect(() => parseStrictJSON(unicodeAtLimit)).not.toThrow();
    expect(() => parseStrictJSON(bytes('"' + "é".repeat(32_767) + '" '))).toThrowError(new Error("invalid_json"));
    const over = bytes("0" + " ".repeat(65_536));
    expect(() => parseStrictJSON(over)).toThrowError(new Error("invalid_json"));
    expect(() => calculateDocumentJSONV1(over)).toThrowError(new CalculationError("invalid_input"));
  });
  it("rejects malformed UTF8 without replacement decoding and sanitizes errors", () => {
    for (const raw of [new Uint8Array([0x22, 0xff, 0x22]),
      new Uint8Array([0x22, 0xc0, 0xaf, 0x22]), new Uint8Array([0x22, 0xed, 0xa0, 0x80, 0x22])]) {
      expect(() => parseStrictJSON(raw)).toThrowError(new Error("invalid_json"));
      expect(() => calculateDocumentJSONV1(raw)).toThrowError(new CalculationError("invalid_input"));
    }
  });
});
