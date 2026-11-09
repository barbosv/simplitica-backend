import { timingSafeEqual } from "node:crypto";
import type { ApiReply, ApiRequest } from "../http.js";
import type { Env } from "../env.js";

function extractBearerToken(req: ApiRequest): string | undefined {
  const raw = req.headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value?.startsWith("Bearer ")) return undefined;
  const token = value.slice(7).trim();
  return token || undefined;
}

function extractDeviceId(req: ApiRequest): string | undefined {
  const raw = req.headers["x-device-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function secretsMatch(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

export function isSimplilistBackendConfigured(
  env: Pick<Env, "SIMPLILIST_BACKEND_API_KEY">,
): boolean {
  return Boolean(env.SIMPLILIST_BACKEND_API_KEY?.trim());
}

export function createSimplilistAuthHook(env: Env) {
  const expected = env.SIMPLILIST_BACKEND_API_KEY?.trim();
  if (!expected) {
    return async (_req: ApiRequest, reply: ApiReply) => {
      return reply.code(503).send({ error: "simplilist_not_configured" });
    };
  }

  return async (req: ApiRequest, reply: ApiReply) => {
    const token = extractBearerToken(req);
    if (!token || !secretsMatch(token, expected)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const deviceId = extractDeviceId(req);
    if (!deviceId) {
      return reply.code(400).send({ error: "missing_x_device_id" });
    }
    req.simplilistDeviceId = deviceId;
  };
}
