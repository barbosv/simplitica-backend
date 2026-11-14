import { createMcpHandler, McpServer, type AuthInfo } from "@modelcontextprotocol/server";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { z } from "zod";

const MAX_BODY_BYTES = 64 * 1024;
const configSchema = z.strictObject({
  QUALIFY_ENVIRONMENT: z.literal("development"),
  QUALIFY_ISSUER: z.string().min(1),
  QUALIFY_MCP_AUDIENCE: z.string().min(1),
  QUALIFY_APPLE_IDENTITY_CLAIM: z.string().min(1),
  QUALIFY_CLIENT_ID: z.string().min(1).refine(value => value === value.trim() && value !== "REPLACE_WITH_DEVELOPMENT_CLIENT_ID"),
  QUALIFY_PROBE_SCOPE: z.literal("probe:read"),
});
type Configuration = z.infer<typeof configSchema>;

function httpsUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.href !== value) {
    throw new Error("Invalid configuration");
  }
  return url;
}
function configuration(env: unknown): Configuration {
  // Strict parsing also refuses accidental database/service bindings on this isolated Worker.
  const config = configSchema.parse(env);
  const issuer = httpsUrl(config.QUALIFY_ISSUER);
  const audience = httpsUrl(config.QUALIFY_MCP_AUDIENCE);
  const claim = httpsUrl(config.QUALIFY_APPLE_IDENTITY_CLAIM);
  if (!issuer.pathname.endsWith("/") || audience.pathname !== "/mcp" || claim.pathname === "/") {
    throw new Error("Invalid configuration");
  }
  return config;
}
function errorResponse(status: number, error: string, headers?: HeadersInit) {
  return Response.json({ error }, { status, headers: { "cache-control": "no-store", ...headers } });
}
function isLoopback(url: URL) {
  return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}
function trustedRequest(request: Request, config: Configuration) {
  const canonical = new URL(config.QUALIFY_MCP_AUDIENCE);
  const target = new URL(request.url);
  if (target.origin !== canonical.origin && !isLoopback(target)) return false;
  const host = request.headers.get("host");
  if (host && host !== target.host) return false;
  const origin = request.headers.get("origin");
  if (origin === null || origin === canonical.origin) return true;
  try {
    const url = new URL(origin);
    return origin === url.origin && isLoopback(url);
  } catch {
    return false;
  }
}
function challenge(config: Configuration, insufficientScope = false) {
  const resourceMetadata = `${new URL(config.QUALIFY_MCP_AUDIENCE).origin}/.well-known/oauth-protected-resource/mcp`;
  return errorResponse(insufficientScope ? 403 : 401, insufficientScope ? "Insufficient scope" : "Unauthorized", {
    "www-authenticate": `Bearer ${insufficientScope ? 'error="insufficient_scope", ' : ""}resource_metadata="${resourceMetadata}", scope="probe:read"`,
  });
}
async function boundedBody(request: Request): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) return null;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}
function server() {
  const instance = new McpServer({ name: "simplitica-development-qualification", version: "1.0.0" });
  instance.registerTool("qualification_probe", {
    description: "Check authenticated access to a synthetic development probe.",
    inputSchema: z.strictObject({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { securitySchemes: [{ type: "oauth2", scopes: ["probe:read"] }] },
  }, async () => ({
    content: [{ type: "text", text: '{"success":true,"probe":"synthetic-development"}' }],
    structuredContent: { success: true, probe: "synthetic-development" },
  }));
  return instance;
}

/** Only the network boundary is injectable; token validation always uses jose and Web Crypto. */
export function createQualificationProbe(fetchJwks: typeof fetch = fetch) {
  return {
    async fetch(request: Request, env: unknown): Promise<Response> {
      let config: Configuration;
      try { config = configuration(env); }
      catch { return errorResponse(503, "Probe configuration unavailable"); }
      if (!trustedRequest(request, config)) return errorResponse(403, "Forbidden");
      const path = new URL(request.url).pathname;
      if (path === "/mcp" && request.method !== "POST") return errorResponse(405, "Method not allowed", { allow: "POST" });
      if (request.method === "GET" && path === "/health") {
        return Response.json({ status: "ready", probe: "synthetic-development" }, { headers: { "cache-control": "no-store" } });
      }
      if (request.method === "GET" && ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"].includes(path)) {
        return Response.json({ resource: config.QUALIFY_MCP_AUDIENCE, authorization_servers: [config.QUALIFY_ISSUER], scopes_supported: ["probe:read"], bearer_methods_supported: ["header"] }, { headers: { "cache-control": "no-store" } });
      }
      if (path !== "/mcp") return errorResponse(404, "Not found");
      const bearer = /^Bearer ([^\s,]+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
      if (!bearer) return challenge(config);
      let authInfo: AuthInfo;
      try {
        // Per-request resolver: no unbounded cache or cross-request I/O promises. Every request
        // refreshes keys from the configured issuer, so key removal/rotation is immediately observed.
        const jwks = createRemoteJWKSet(new URL(".well-known/jwks.json", config.QUALIFY_ISSUER), {
          timeoutDuration: 2000, [customFetch]: fetchJwks,
        });
        const { payload } = await jwtVerify(bearer, jwks, {
          algorithms: ["RS256"], issuer: config.QUALIFY_ISSUER, audience: config.QUALIFY_MCP_AUDIENCE,
          requiredClaims: ["exp", "sub"],
        });
        const apple = payload[config.QUALIFY_APPLE_IDENTITY_CLAIM];
        if (!payload.sub?.trim() || payload.azp !== config.QUALIFY_CLIENT_ID || typeof apple !== "string" || !apple.trim()) return challenge(config);
        // This signed issuer assertion does not prove native/web Apple identity continuity.
        const scopes = typeof payload.scope === "string" ? payload.scope.split(/\s+/) : [];
        if (!scopes.includes("probe:read")) return challenge(config, true);
        authInfo = { token: bearer, clientId: config.QUALIFY_CLIENT_ID, scopes, expiresAt: payload.exp, resource: new URL(config.QUALIFY_MCP_AUDIENCE) };
      } catch { return challenge(config); }
      let body: string | null;
      try {
        body = await boundedBody(request);
        if (body === null) return errorResponse(413, "Request too large");
        JSON.parse(body);
      } catch { return errorResponse(400, "Invalid request"); }
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      // Modern requests use JSON; the SDK's 2025 compatibility leg emits finite SSE.
      const handler = createMcpHandler(server, { responseMode: "json", maxSubscriptions: 0, keepAliveMs: 0, maxRequestBodySize: MAX_BODY_BYTES });
      return handler.fetch(new Request(request.url, { method: "POST", headers, body }), { authInfo });
    },
  };
}
export default createQualificationProbe() satisfies ExportedHandler;
