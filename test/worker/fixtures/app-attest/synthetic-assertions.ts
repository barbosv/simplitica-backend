// Test-only synthetic ECDSA controls; these keys have no Apple attestation.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { encode } from "cbor2";

export const syntheticContext = {
  teamId: "V8H6LQ9448", bundleId: "io.uebelacker.AppAttestExample", environment: "development" as const,
};
export function syntheticSigner() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return {
    device: { publicKeyPem, counter: 0 },
    assertion(payload: Uint8Array, counter = 1, extensions?: Uint8Array, flags = extensions ? 0x80 : 0,
      algorithm: "nonce" | "direct" = "nonce", appId = `${syntheticContext.teamId}.${syntheticContext.bundleId}`) {
      const header = Buffer.alloc(37);
      createHash("sha256").update(appId).digest().copy(header);
      header[32] = flags;
      header.writeUInt32BE(counter, 33);
      const auth = Buffer.concat([header, extensions ?? new Uint8Array()]);
      const joined = Buffer.concat([auth, createHash("sha256").update(payload).digest()]);
      const data = algorithm === "nonce" ? createHash("sha256").update(joined).digest() : joined;
      return encode({ signature: new Uint8Array(sign("sha256", data, privateKey)), authenticatorData: new Uint8Array(auth) });
    },
  };
}
export function syntheticExtensions(category: unknown = 3, version: unknown = "42"): Uint8Array {
  return encode(new Map<string, unknown>([["validationCategory", category], ["bundleVersion", version]]));
}
