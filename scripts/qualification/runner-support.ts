import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";

// Live entrypoints consume only this fixed, Git-ignored, owner-provided one-use file.
export const developmentClientSecretPath = ".superpowers/sdd/chatgpt-integration/auth0-client-secret";

export async function consumeClientSecret(path = developmentClientSecretPath): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let secret: string;
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.() || info.size > 4096) {
      throw new Error("secret_file_permissions");
    }
    secret = (await handle.readFile("utf8")).trim();
    if (!secret) throw new Error("secret_file_empty");
  } finally { await handle.close(); }
  await unlink(path);
  return secret;
}

const reasons = new Set(["secret_file_permissions", "secret_file_empty", "provider_invalid_grant", "provider_request_failed",
  "invalid_token_response", "access_token_verification_failed", "rotation_not_observed", "refresh_identity_changed",
  "refresh_denial_unproven", "invalidated_refresh_accepted", "callback_timeout", "callback_closed", "callback_listen_failed",
  "hosted_identity_changed", "hosted_identity_missing", "native_proof_timeout", "native_proof_closed", "native_proof_listen_failed"]);

export function qualificationFailureReason(error: unknown): string {
  return error instanceof Error && reasons.has(error.message) ? error.message : "qualification_failed";
}
