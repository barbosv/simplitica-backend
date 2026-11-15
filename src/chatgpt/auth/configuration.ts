export const CLOUD_ISSUER = "https://dev-i8usug5fp48kepvr.us.auth0.com/";
export const CLOUD_AUDIENCE = "https://simpli-invoice-mcp-dev.simplitica.co/mcp";
export const CLOUD_CLIENT_ID = "tpc_5RjUULWf1V9koMnfWj1Xg3";
export const CLOUD_EPOCH_HOOK_URL = "https://simpli-invoice-native-dev.simplitica.co/api/internal/oauth/connection-epoch";

export class CloudTokenConfigurationError extends Error {
  readonly code = "invalid_configuration";
  constructor() {
    super("invalid_configuration");
    this.name = "CloudTokenConfigurationError";
  }
}

// Canonical unpadded base64url for exactly 32 bytes, including zero pad bits.
// Used for trusted external namespaces and the separate hook credential.
export function isCanonicalBase64url32(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  try {
    const decoded = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    return decoded.length === 32 && btoa(decoded).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_") === value;
  } catch {
    return false;
  }
}
