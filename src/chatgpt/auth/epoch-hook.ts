import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { createCloudConnectionRepository } from "../accounts/connections.js";
import { isOpaqueIdentifier } from "../accounts/validation.js";
import { CLOUD_ISSUER, CLOUD_CLIENT_ID, CLOUD_EPOCH_HOOK_URL, CloudTokenConfigurationError, isCanonicalBase64url32 } from "./configuration.js";

class BodyFailure extends Error {
  constructor(readonly timedOut = false) { super("invalid_request"); }
}

// This private issuer endpoint has a stricter deadline than legacy HTTP routes.
// One timer covers all reads; cancellation is deliberately never awaited.
async function readLookupBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get("Content-Length")) > 4096 ||
      request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new BodyFailure();
  const reader = request.body?.getReader();
  if (!reader) throw new BodyFailure();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new BodyFailure(true)), 2000);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      total += value.byteLength;
      if (total > 4096) throw new BodyFailure();
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

// Internal constructor only: no Worker entrypoint mounts this app. Both external
// configuration scalars are captured before any asynchronous lookup.
export function createEpochHook(db: D1Database, secret: string, authorizationNamespace: string) {
  if (!isCanonicalBase64url32(authorizationNamespace)) throw new CloudTokenConfigurationError();
  const credential = isCanonicalBase64url32(secret) ? new TextEncoder().encode(secret) : null;
  const connections = createCloudConnectionRepository(db);
  const app = new Hono();
  app.all("*", async c => {
    const reply = (body: object, status: 200 | 400 | 401 | 404 | 405 | 408 | 503) =>
      c.json(body, status, { "Cache-Control": "no-store" });
    if (c.req.url !== CLOUD_EPOCH_HOOK_URL) return reply({ error: "not_found" }, 404);
    if (c.req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
    if (!credential) return reply({ error: "unavailable" }, 503);
    const authorization = c.req.header("Authorization");
    const candidate = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    if (!isCanonicalBase64url32(candidate) || !timingSafeEqual(credential, new TextEncoder().encode(candidate))) {
      return reply({ error: "unauthorized" }, 401);
    }
    let body: unknown;
    try { body = await readLookupBody(c.req.raw); }
    catch (error) {
      return error instanceof BodyFailure && error.timedOut
        ? reply({ error: "request_timeout" }, 408) : reply({ error: "invalid_request" }, 400);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body) ||
        Object.keys(body).length !== 1 || !("appleIdentity" in body) || !isOpaqueIdentifier(body.appleIdentity)) {
      return reply({ error: "invalid_request" }, 400);
    }
    try {
      const epoch = await connections.getActiveEpoch({ identity: { issuer: CLOUD_ISSUER, appleIdentity: body.appleIdentity }, clientId: CLOUD_CLIENT_ID });
      return reply(epoch === null ? { active: false } : { active: true, epoch, namespace: authorizationNamespace }, 200);
    } catch {
      return reply({ error: "unavailable" }, 503);
    }
  });
  return app;
}
