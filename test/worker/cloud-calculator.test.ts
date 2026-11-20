import { describe, expect, it } from "vitest";
import fixtures from "../fixtures/cloud-calculator-v1.json";
import {
  CalculationError,
  calculateDocumentV1,
} from "../../src/chatgpt/documents/calculator";

function freezeDeep(value: unknown): void {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
}

function expectError(input: unknown, code = "invalid_input"): void {
  let caught: unknown;
  try {
    calculateDocumentV1(input);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CalculationError);
  expect(caught).toMatchObject({ code, message: code });
}

const sample = () => ({
  currency: "USD",
  lines: [{ quantity: "1", unitPrice: "1" }],
  discountAmount: "0",
  taxRatePercent: "0",
});

describe("versioned USD calculator in workerd", () => {
  for (const fixture of fixtures.valid) {
    it(fixture.name, () => {
      const before = JSON.stringify(fixture.input);
      freezeDeep(fixture.input);
      const result = calculateDocumentV1(fixture.input);
      expect(result).toEqual(fixture.expected);
      expect(calculateDocumentV1(fixture.input)).toEqual(fixture.expected);
      expect(JSON.parse(JSON.stringify(result))).toEqual(fixture.expected);
      expect(JSON.stringify(fixture.input)).toBe(before);
    });
  }

  for (const fixture of fixtures.invalid) {
    it(fixture.name, () => {
      freezeDeep(fixture.input);
      expectError(fixture.input, fixture.error);
    });
  }

  it("accepts null-prototype records and normalizes without mutating them", () => {
    const input = Object.assign(Object.create(null), sample());
    input.lines = [Object.assign(Object.create(null), input.lines[0])];
    freezeDeep(input);
    expect(calculateDocumentV1(input)).toEqual({
      calculationVersion: "usd-line-cents-v1", currency: "USD",
      lines: [{ quantity: "1", unitPrice: "1.00", lineTotal: "1.00" }],
      subtotal: "1.00", discountRequested: "0.00", discountApplied: "0.00",
      taxRatePercent: "0", taxableAmount: "1.00", taxAmount: "0.00", total: "1.00",
    });
  });

  it("normalizes equivalent inputs to identical results", () => {
    expect(calculateDocumentV1(fixtures.valid[0].input)).toEqual(
      calculateDocumentV1(fixtures.valid[5].input),
    );
  });

  it("returns independent objects so caller edits cannot contaminate later calls", () => {
    const first = calculateDocumentV1(sample());
    first.lines[0].lineTotal = "99.00";
    first.lines.push({ quantity: "5", unitPrice: "5.00", lineTotal: "25.00" });
    expect(calculateDocumentV1(sample()).lines).toEqual([
      { quantity: "1", unitPrice: "1.00", lineTotal: "1.00" },
    ]);
  });

  it("rejects non-plain roots and lines, including inherited input fields", () => {
    class Input {
      currency = "USD";
      lines = [{ quantity: "1", unitPrice: "1" }];
      discountAmount = "0";
      taxRatePercent = "0";
    }
    class Line { quantity = "1"; unitPrice = "1"; }
    for (const input of [undefined, 1n, new Date(), new Input(),
      Object.create(sample()), Object.create({ unexpected: true }),
      { ...sample(), lines: [new Line()] },
      { ...sample(), lines: [Object.create({ quantity: "1", unitPrice: "1" })] },
      { ...sample(), lines: new Array(1) },
      { ...sample(), lines: [{ quantity: undefined, unitPrice: "1" }] },
    ]) expectError(input);
  });

  it("rejects unknown symbol and non-enumerable fields", () => {
    expectError({ ...sample(), [Symbol("extra")]: true });
    expectError(Object.defineProperty(sample(), "extra", { value: true }));
    expectError({ ...sample(), lines: [{ quantity: "1", unitPrice: "1", [Symbol("extra")]: true }] });
    expectError({ ...sample(), lines: [Object.defineProperty({ quantity: "1", unitPrice: "1" }, "extra", { value: true })] });
  });

  it("does not execute custom array iteration hooks", () => {
    const input = sample();
    input.lines[Symbol.iterator] = () => { throw new Error("caller iterator executed"); };
    expect(calculateDocumentV1(input).subtotal).toBe("1.00");
  });

  it("rejects line-array accessors without executing them", () => {
    let reads = 0;
    const input = sample();
    Object.defineProperty(input.lines, "0", {
      get() { reads++; return { quantity: "1", unitPrice: "1" }; },
    });
    expectError(input);
    expect(reads).toBe(0);
  });

  it("rejects accessor fields without invoking caller code", () => {
    let reads = 0;
    const input = Object.defineProperty(sample(), "discountAmount", {
      get() { reads++; return "0"; },
    });
    expectError(input);
    const line = Object.defineProperty({ quantity: "1", unitPrice: "1" }, "unitPrice", {
      get() { reads++; return "1"; },
    });
    expectError({ ...sample(), lines: [line] });
    expect(reads).toBe(0);
  });
});
