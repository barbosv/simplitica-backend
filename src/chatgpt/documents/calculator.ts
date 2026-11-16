export const CALCULATION_VERSION = "usd-line-cents-v1";

export class CalculationError extends Error {
  constructor(public readonly code: "invalid_input" | "amount_out_of_range") {
    super(code);
    this.name = "CalculationError";
  }
}

export interface CalculationResult {
  calculationVersion: typeof CALCULATION_VERSION;
  currency: "USD";
  lines: Array<{ quantity: string; unitPrice: string; lineTotal: string }>;
  subtotal: string;
  discountRequested: string;
  discountApplied: string;
  taxRatePercent: string;
  taxableAmount: string;
  taxAmount: string;
  total: string;
}

// Every authoritative amount is bounded in cents; scaled products remain BigInt.
const MAX_CENTS = 99_999_999_999_999n;
const LINE_SCALE = 6;
const TAX_SCALE = 4;

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    throw new CalculationError("invalid_input");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CalculationError("invalid_input");
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) =>
    typeof key !== "string" || !keys.includes(key))) {
    throw new CalculationError("invalid_input");
  }
  // Accessors are not decimal input data and must not execute during calculation.
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new CalculationError("invalid_input");
    }
  }
  return value as Record<string, unknown>;
}

function parseScaled(value: unknown, integerDigits: number, scale: number): bigint {
  if (typeof value !== "string" || value.length > 32) {
    throw new CalculationError("invalid_input");
  }
  const match = /^([0-9]+)(?:\.([0-9]+))?$/.exec(value);
  if (!match || match[0] !== value) throw new CalculationError("invalid_input");
  const integer = match[1].replace(/^0+/, "") || "0";
  const fraction = match[2] ?? "";
  if (integer.length > integerDigits || fraction.length > scale) {
    throw new CalculationError("invalid_input");
  }
  return BigInt(integer + fraction.padEnd(scale, "0"));
}

function formatScaled(value: bigint, scale: number, minimumFraction = 0): string {
  const digits = value.toString().padStart(scale + 1, "0");
  const integer = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/, "").padEnd(minimumFraction, "0");
  return fraction ? `${integer}.${fraction}` : integer;
}

function money(cents: bigint): string {
  return formatScaled(cents, 2, 2);
}

function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

function bounded(cents: bigint): bigint {
  if (cents > MAX_CENTS) throw new CalculationError("amount_out_of_range");
  return cents;
}

export function calculateDocumentV1(input: unknown): CalculationResult {
  const data = exactObject(input, ["currency", "lines", "discountAmount", "taxRatePercent"]);
  if (data.currency !== "USD" || !Array.isArray(data.lines) ||
    data.lines.length < 1 || data.lines.length > 200) {
    throw new CalculationError("invalid_input");
  }
  const discount = parseScaled(data.discountAmount, 12, 2);
  const taxRate = parseScaled(data.taxRatePercent, 3, TAX_SCALE);
  if (taxRate > 100n * 10n ** BigInt(TAX_SCALE)) {
    throw new CalculationError("invalid_input");
  }
  let subtotal = 0n;
  const lines: CalculationResult["lines"] = [];
  // Read bounded own data entries, avoiding holes, getters and custom iterators.
  for (let index = 0; index < data.lines.length; index++) {
    const entry = Object.getOwnPropertyDescriptor(data.lines, String(index));
    if (!entry || !("value" in entry)) throw new CalculationError("invalid_input");
    const line = exactObject(entry.value, ["quantity", "unitPrice"]);
    const quantity = parseScaled(line.quantity, 9, LINE_SCALE);
    const unitPrice = parseScaled(line.unitPrice, 9, LINE_SCALE);
    if (quantity === 0n) throw new CalculationError("invalid_input");
    const lineTotal = bounded(roundHalfUp(quantity * unitPrice, 10n ** 10n));
    subtotal = bounded(subtotal + lineTotal);
    lines.push({
      quantity: formatScaled(quantity, LINE_SCALE),
      unitPrice: formatScaled(unitPrice, LINE_SCALE, 2),
      lineTotal: money(lineTotal),
    });
  }
  const discountApplied = discount < subtotal ? discount : subtotal;
  const taxableAmount = bounded(subtotal - discountApplied);
  const taxAmount = bounded(roundHalfUp(taxableAmount * taxRate, 10n ** 6n));
  const total = bounded(taxableAmount + taxAmount);
  return {
    calculationVersion: CALCULATION_VERSION,
    currency: "USD",
    lines,
    subtotal: money(subtotal),
    discountRequested: money(discount),
    discountApplied: money(discountApplied),
    taxRatePercent: formatScaled(taxRate, TAX_SCALE),
    taxableAmount: money(taxableAmount),
    taxAmount: money(taxAmount),
    total: money(total),
  };
}
