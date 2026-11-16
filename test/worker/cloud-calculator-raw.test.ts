import { describe, expect, it } from "vitest";
import fixtures from "../fixtures/cloud-calculator-raw-v1.json";
import { calculateDocumentJSONV1, CalculationError } from "../../src/chatgpt/documents/calculator";

describe("raw JSON calculator parity", () => {
  for (const fixture of fixtures.valid) {
    it(fixture.name, () => {
      expect(calculateDocumentJSONV1(new TextEncoder().encode(fixture.raw))).toEqual(fixture.expected);
    });
  }
  for (const fixture of fixtures.invalid) {
    it(fixture.name, () => {
      let caught: unknown;
      try { calculateDocumentJSONV1(new TextEncoder().encode(fixture.raw)); }
      catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(CalculationError);
      expect(caught).toMatchObject({ code: fixture.error, message: fixture.error });
    });
  }
});
