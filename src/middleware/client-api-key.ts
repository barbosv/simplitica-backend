import { timingSafeEqual } from "node:crypto";
import type { ApiReply, ApiRequest } from "../http.js";
import type { Env } from "../env.js";

export function isClientApiKeyConfigured(
  env: Pick<Env, "SIMPLITICA_CLIENT_API_KEY">,
): boolean {
  return Boolean(env.SIMPLITICA_CLIENT_API_KEY?.trim());
}

function extractClientApiKey(req: ApiRequest): string | undefined {
  const raw = req.headers["x-api-key"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function keysMatch(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }
  return timingSafeEqual(providedBuf, expectedBuf);
}

export function createClientApiKeyHook(env: Env) {
  const expected = env.SIMPLITICA_CLIENT_API_KEY?.trim();
  if (!expected) {
    return async () => {};
  }

  return async (req: ApiRequest, reply: ApiReply) => {
    const provided = extractClientApiKey(req);
    if (!provided || !keysMatch(provided, expected)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  };
}
