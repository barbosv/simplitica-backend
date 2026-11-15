import type { AttestationContext } from "./types";

/** Validate trusted configuration before inspecting untrusted proof input. */
export function validateAttestationContext(context: AttestationContext): void {
  if (!context || typeof context.teamId !== "string" || !/^[A-Z0-9]{10}$/.test(context.teamId) ||
      typeof context.bundleId !== "string" || context.bundleId.length > 255 ||
      !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(context.bundleId) ||
      (context.environment !== "development" && context.environment !== "production")) {
    throw new Error("invalid_configuration");
  }
}
