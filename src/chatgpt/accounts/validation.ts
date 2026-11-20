// D1 replaces unpaired surrogates with U+FFFD. Reject those lossy inputs,
// preserving exact well-formed Unicode, whitespace, NUL and provider prefixes.
// Unicode mode treats valid surrogate pairs as one supplementary code point;
// this range therefore matches only unpaired high or low surrogates.
export function isOpaqueIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 &&
    !/[\uD800-\uDFFF]/u.test(value);
}

export function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
