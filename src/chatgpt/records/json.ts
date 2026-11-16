import { RecordError } from "./types.js";
const encoder = new TextEncoder();
export const maxPayloadBytes = 1_048_576;
export const utf8Bytes = (value: string): number => encoder.encode(value).byteLength;
export const isLabel = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(value);
// Only validated JSON scalars/arrays/plain objects. In particular, do not invoke
// toJSON or accessors and do not silently omit undefined or coerce unsafe numbers.
export function encodeRecordJSON(value: unknown): string {
  const ancestors = new Set<object>();
  let nodes = 0;
  function visit(input: unknown, depth: number): string {
    if (++nodes > 100_000 || depth > 32) throw new RecordError("invalid_input");
    if (input === null || typeof input === "boolean") return JSON.stringify(input);
    if (typeof input === "number" && Number.isSafeInteger(input)) return JSON.stringify(input);
    if (typeof input === "string") {
      if (input.length > maxPayloadBytes || /[\uD800-\uDFFF]/u.test(input)) throw new RecordError("invalid_input");
      return JSON.stringify(input);
    }
    if (typeof input !== "object" || !input || ancestors.has(input)) throw new RecordError("invalid_input");
    const array = Array.isArray(input);
    if (!array && Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) throw new RecordError("invalid_input");
    if (Object.getOwnPropertySymbols(input).length) throw new RecordError("invalid_input");
    ancestors.add(input);
    let parts: string[];
    if (array) {
      if (input.length > 100_000 || Object.keys(input).length !== input.length) throw new RecordError("invalid_input");
      parts = Array.from({ length: input.length }, (_, i) => {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(i));
        if (!descriptor || !("value" in descriptor)) throw new RecordError("invalid_input");
        return visit(descriptor.value, depth + 1);
      });
    } else {
      parts = Object.keys(input).sort().map(key => {
        if (/[\uD800-\uDFFF]/u.test(key)) throw new RecordError("invalid_input");
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor || !("value" in descriptor)) throw new RecordError("invalid_input");
        return `${JSON.stringify(key)}:${visit(descriptor.value, depth + 1)}`;
      });
    }
    ancestors.delete(input);
    const result = array ? `[${parts.join(",")}]` : `{${parts.join(",")}}`;
    if (utf8Bytes(result) > maxPayloadBytes) throw new RecordError("invalid_input");
    return result;
  }
  try {
    const result = visit(value, 0);
    if (utf8Bytes(result) > maxPayloadBytes) throw new RecordError("invalid_input");
    return result;
  } catch { throw new RecordError("invalid_input"); }
}
