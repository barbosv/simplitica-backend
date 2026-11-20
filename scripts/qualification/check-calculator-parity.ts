import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CALCULATION_VERSION, CalculationError, calculateDocumentV1, calculateDocumentJSONV1, type CalculationResult } from "../../src/chatgpt/documents/calculator.js";
import { parseStrictJSON } from "../../src/chatgpt/json.js";

type Fixture = { version: string; valid: { name: string; input: unknown; expected: CalculationResult }[]; invalid: { name: string; input: unknown; error: string }[] };
type RawFixture = { version: string; valid: { name: string; raw: string; expected: CalculationResult }[]; invalid: { name: string; raw: string; error: string }[]; preflightValid: { name: string; raw: string }[]; preflightInvalid: { name: string; raw: string }[] };
const backendRoot = fileURLToPath(new URL("../../", import.meta.url));
const nativeRoot = resolve(process.argv[2] ?? resolve(backendRoot, "../voice-invoice"));
assert.ok(process.argv.length <= 3, "Usage: npm run qualify:calculator-parity -- /path/to/voice-invoice");
const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const pins = {
  "cloud-calculator-v1.json": "44b4d20b001071404bbaa12c28a0810695f2b0c2a3bf37250e0b333c281197e9",
  "cloud-calculator-raw-v1.json": "f185d6a91e872c26008e2d0b8fee143451576673dc88bffb7d8c786d5d785497",
};
function fixture<T>(name: keyof typeof pins): T {
  const backend = readFileSync(resolve(backendRoot, "test/fixtures", name));
  const native = readFileSync(resolve(nativeRoot, "Shared/CloudInvoiceCore/Tests/CloudInvoiceCoreTests/Resources", name));
  assert.ok(backend.equals(native), `Fixture byte mismatch: ${name}`);
  assert.equal(sha256(backend), pins[name], `Fixture digest drift: ${name}`);
  return JSON.parse(backend.toString("utf8")) as T;
}
function errorCode(run: () => unknown, expected: string, name: string) {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof CalculationError, `Unexpected error type: ${name}`);
    assert.equal(error.code, expected, `Error code mismatch: ${name}`);
    assert.equal(error.message, expected, `Error message mismatch: ${name}`);
    return true;
  });
}
const typed = fixture<Fixture>("cloud-calculator-v1.json");
const raw = fixture<RawFixture>("cloud-calculator-raw-v1.json");
assert.equal(typed.version, CALCULATION_VERSION);
assert.equal(raw.version, CALCULATION_VERSION);
assert.deepEqual([typed.valid.length, typed.invalid.length, raw.valid.length, raw.invalid.length, raw.preflightValid.length, raw.preflightInvalid.length], [23, 110, 3, 13, 7, 18]);
const bytes = (text: string) => new TextEncoder().encode(text);
for (const entry of typed.valid) {
  const before = JSON.stringify(entry.input);
  assert.deepEqual(calculateDocumentV1(entry.input), entry.expected, entry.name);
  assert.deepEqual(calculateDocumentJSONV1(bytes(JSON.stringify(entry.input))), entry.expected, entry.name);
  assert.equal(JSON.stringify(entry.input), before, `Input mutation: ${entry.name}`);
}
for (const entry of typed.invalid) errorCode(() => calculateDocumentV1(entry.input), entry.error, entry.name);
for (const entry of raw.valid) assert.deepEqual(calculateDocumentJSONV1(bytes(entry.raw)), entry.expected, entry.name);
for (const entry of raw.invalid) errorCode(() => calculateDocumentJSONV1(bytes(entry.raw)), entry.error, entry.name);
for (const entry of raw.preflightValid) assert.doesNotThrow(() => parseStrictJSON(bytes(entry.raw)), entry.name);
for (const entry of raw.preflightInvalid) assert.throws(() => parseStrictJSON(bytes(entry.raw)), entry.name);
console.log(JSON.stringify({
  calculationVersion: CALCULATION_VERSION,
  nodeVersion: process.version,
  byteIdenticalFixtures: true,
  fixtures: pins,
  sourceSHA256: {
    runner: sha256(readFileSync(fileURLToPath(import.meta.url))),
    calculator: sha256(readFileSync(resolve(backendRoot, "src/chatgpt/documents/calculator.ts"))),
    strictJSON: sha256(readFileSync(resolve(backendRoot, "src/chatgpt/json.ts"))),
  },
  passed: { valid: typed.valid.length, invalid: typed.invalid.length, rawValid: raw.valid.length, rawInvalid: raw.invalid.length, preflightValid: raw.preflightValid.length, preflightInvalid: raw.preflightInvalid.length },
}, null, 2));
