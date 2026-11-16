// Raw ingress must run this before SDK/object decoding discards duplicate names.
// This scans structure and string tokens only; JSON.parse owns the JSON grammar.
export function parseStrictJSON(bytes: Uint8Array): unknown {
  return parseBoundedJSON(bytes, 65_536);
}
// Trusted source configuration only; never take this bound from request data.
export function createStrictJSONParser(configuration: { maximumBytes: number }) {
  const maximumBytes = configuration?.maximumBytes;
  if (!Number.isInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 1_048_576) throw new Error("invalid_configuration");
  return (bytes: Uint8Array): unknown => parseBoundedJSON(bytes, maximumBytes);
}
function parseBoundedJSON(bytes: Uint8Array, maximumBytes: number): unknown {
  try {
    if (bytes.byteLength > maximumBytes) throw new Error();
    // Preserve a BOM during decoding so the common policy can reject it explicitly.
    const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (source.charCodeAt(0) === 0xfeff) throw new Error();
    const scopes: Array<{ object: boolean; keys: Set<string>; key: boolean }> = [];
    for (let index = 0; index < source.length; index++) {
      const token = source[index];
      if (token === '"') {
        const start = index++;
        while (index < source.length && source[index] !== '"') {
          if (source[index] === "\\") index++;
          index++;
        }
        if (index >= source.length) throw new Error();
        const decoded: string = JSON.parse(source.slice(start, index + 1));
        // A decoded key is a sequence of Unicode scalars, never lone UTF-16 surrogates.
        // Validate values too, matching Foundation's strict string decoding.
        for (let offset = 0; offset < decoded.length; offset++) {
          const code = decoded.charCodeAt(offset);
          if (code >= 0xd800 && code <= 0xdbff) {
            const next = decoded.charCodeAt(++offset);
            if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error();
          } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error();
        }
        const scope = scopes.at(-1);
        if (scope?.object && scope.key) {
          // JS string equality preserves exact scalar sequences; no NFC normalization.
          if (scope.keys.has(decoded)) throw new Error();
          scope.keys.add(decoded);
        }
      } else if (token === "{" || token === "[") {
        if (scopes.length >= 16) throw new Error();
        scopes.push({ object: token === "{", keys: new Set(), key: token === "{" });
      } else if (token === "}" || token === "]") {
        const scope = scopes.pop();
        if (!scope || scope.object !== (token === "}")) throw new Error();
      } else if (token === ":" || token === ",") {
        const scope = scopes.at(-1);
        if (scope?.object) scope.key = token === ",";
      }
    }
    if (scopes.length !== 0) throw new Error();
    return JSON.parse(source);
  } catch {
    // Never include caller bytes or platform-parser diagnostics in the wire error.
    throw new Error("invalid_json");
  }
}
