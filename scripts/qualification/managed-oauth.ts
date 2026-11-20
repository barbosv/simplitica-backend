import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { jwtVerify, type JWTVerifyGetKey } from "jose";

export const developmentOAuth = {
  issuer: "https://dev-i8usug5fp48kepvr.us.auth0.com/",
  clientId: "tpc_5RjUULWf1V9koMnfWj1Xg3",
  resource: "https://simpli-invoice-mcp-dev.simplitica.co/mcp",
  appleClaim: "https://simplitica.co/apple_identity",
} as const;
export const nativeDevelopmentOAuth = {
  clientId: "WXTblf8z8B9kGNaX9QgR6dUzexXT5Ixa",
  audience: "https://simpli-invoice-native-dev.simplitica.co/api",
  scope: "qualification:read",
} as const;

export interface TokenPair { accessToken: string; refreshToken: string }
export interface TokenClient {
  refresh(token: string): Promise<TokenPair>;
  revoke(token: string): Promise<void>;
}
export class InvalidGrantError extends Error { constructor() { super("provider_invalid_grant"); } }

export function tokenClient(secret: string, transport: typeof fetch = fetch): TokenClient & {
  exchange(code: string, verifier: string, redirect: string): Promise<TokenPair>;
} {
  if (!secret || secret.length > 4096) throw new Error("invalid_client_configuration");
  async function post(path: string, fields: Record<string, string>) {
    try {
      const response = await transport(new URL(path, developmentOAuth.issuer).href, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...fields, client_id: developmentOAuth.clientId, client_secret: secret }),
      });
      const reader = response.body?.getReader();
      let text = "", bytes = 0;
      if (reader) {
        const decoder = new TextDecoder();
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) { text += decoder.decode(); break; }
          bytes += chunk.value.byteLength;
          if (bytes > 65_536) { void reader.cancel().catch(() => undefined); throw new Error("oversize"); }
          text += decoder.decode(chunk.value, { stream: true });
        }
      }
      const body: unknown = text ? JSON.parse(text) : {};
      if (!response.ok) {
        if (response.status === 400 && typeof body === "object" && body !== null && "error" in body && body.error === "invalid_grant") {
          throw new InvalidGrantError();
        }
        throw new Error("provider_request_failed");
      }
      return body;
    } catch (error) {
      if (error instanceof InvalidGrantError) throw error;
      // The provider/transport cause may contain credentials; deliberately discard it.
      // eslint-disable-next-line preserve-caught-error
      throw new Error("provider_request_failed");
    }
  }
  function pair(body: unknown): TokenPair {
    if (!body || typeof body !== "object" || !("access_token" in body) || !("refresh_token" in body)
      || !("token_type" in body) || body.token_type !== "Bearer"
      || typeof body.access_token !== "string" || !body.access_token
      || typeof body.refresh_token !== "string" || !body.refresh_token) throw new Error("invalid_token_response");
    return { accessToken: body.access_token, refreshToken: body.refresh_token };
  }
  return {
    async exchange(code, verifier, redirect) {
      if (redirect !== "http://127.0.0.1:8792/callback") throw new Error("invalid_redirect");
      return pair(await post("oauth/token", { grant_type: "authorization_code", code, code_verifier: verifier,
        redirect_uri: redirect, resource: developmentOAuth.resource }));
    },
    async refresh(token) { return pair(await post("oauth/token", { grant_type: "refresh_token", refresh_token: token,
      resource: developmentOAuth.resource })); },
    async revoke(token) { await post("oauth/revoke", { token, token_type_hint: "refresh_token" }); },
  };
}

export async function verifyAccessToken(token: string, keys: JWTVerifyGetKey): Promise<string> {
  return verifiedIdentity(token, keys, developmentOAuth.resource, developmentOAuth.clientId, "probe:read");
}

export async function verifyNativeAccessToken(token: string, keys: JWTVerifyGetKey): Promise<string> {
  return verifiedIdentity(token, keys, nativeDevelopmentOAuth.audience, nativeDevelopmentOAuth.clientId, nativeDevelopmentOAuth.scope);
}

async function verifiedIdentity(token: string, keys: JWTVerifyGetKey, audience: string, clientId: string, scope: string) {
  try {
    const { payload } = await jwtVerify(token, keys, { algorithms: ["RS256"], issuer: developmentOAuth.issuer,
      audience, requiredClaims: ["exp", "sub"] });
    const identity = payload[developmentOAuth.appleClaim];
    if (payload.azp !== clientId || typeof payload.sub !== "string" || !payload.sub.trim()
      || typeof payload.scope !== "string" || !payload.scope.split(/\s+/).includes(scope)
      || typeof identity !== "string" || !identity.trim()) throw new Error("claims");
    return identity;
  } catch { throw new Error("access_token_verification_failed"); }
}

async function assertDenied(client: TokenClient, token: string) {
  try { await client.refresh(token); }
  catch (error) {
    if (error instanceof InvalidGrantError) return;
    // eslint-disable-next-line preserve-caught-error -- Never retain a token-bearing transport cause.
    throw new Error("refresh_denial_unproven");
  }
  throw new Error("invalidated_refresh_accepted");
}

async function rotatedPair(client: TokenClient, initial: TokenPair, verify: (token: string) => Promise<string>) {
  const identity = await verify(initial.accessToken);
  const next = await client.refresh(initial.refreshToken);
  if (!identity || !next.refreshToken || next.refreshToken === initial.refreshToken) throw new Error("rotation_not_observed");
  if (await verify(next.accessToken) !== identity) throw new Error("refresh_identity_changed");
  return next;
}

export async function checkRotation(client: TokenClient, initial: TokenPair,
  verify: (token: string) => Promise<string>): Promise<void> {
  const next = await rotatedPair(client, initial, verify);
  await assertDenied(client, initial.refreshToken);
  await assertDenied(client, next.refreshToken);
}

export async function checkRevocation(client: TokenClient, initial: TokenPair,
  verify: (token: string) => Promise<string>): Promise<void> {
  const next = await rotatedPair(client, initial, verify);
  await client.revoke(next.refreshToken);
  await assertDenied(client, next.refreshToken);
}

export function authorizationURL(redirect: string, state: string, verifier: string): URL {
  if (redirect !== "http://127.0.0.1:8792/callback" || !state || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
    throw new Error("invalid_authorization_configuration");
  }
  const url = new URL("authorize", developmentOAuth.issuer);
  url.search = new URLSearchParams({ client_id: developmentOAuth.clientId, response_type: "code",
    redirect_uri: redirect, state, scope: "probe:read offline_access", resource: developmentOAuth.resource,
    code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    connection: "apple" }).toString();
  return url;
}

export async function callbackReceiver(state: string, timeoutMs = 600_000, port = 8792): Promise<{
  redirect: string; code: Promise<string>; close: () => Promise<void>;
}> {
  if (!state || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("invalid_callback_configuration");
  let resolveCode!: (code: string) => void, rejectCode!: (error: Error) => void;
  let consumed = false;
  const code = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  // The browser handoff may occur before the caller begins awaiting this promise.
  void code.catch(() => undefined);
  const timer = setTimeout(() => { consumed = true; rejectCode(new Error("callback_timeout")); }, timeoutMs);
  const server = createServer({ maxHeaderSize: 4096, requestTimeout: 10_000 }, (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("Connection", "close");
    const fail = (status: number) => { response.writeHead(status); response.end("Callback rejected."); };
    const address = server.address();
    if (!address || typeof address === "string" || request.headers.host !== `127.0.0.1:${address.port}`) return fail(400);
    let url: URL;
    try {
      const target = request.url ?? "/";
      if (!target.startsWith("/") || target.startsWith("//")) return fail(400);
      url = new URL(target, "http://127.0.0.1");
    } catch { return fail(400); }
    if (url.pathname !== "/callback") return fail(404);
    if (request.method !== "GET") { response.setHeader("Allow", "GET"); return fail(405); }
    if (consumed) return fail(409);
    const states = url.searchParams.getAll("state"), codes = url.searchParams.getAll("code");
    const supplied = Buffer.from(states[0] ?? ""), expected = Buffer.from(state);
    if (states.length !== 1 || codes.length !== 1 || !codes[0] || codes[0].length > 4096
      || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)
      || url.searchParams.has("error")) return fail(400);
    consumed = true;
    clearTimeout(timer);
    resolveCode(codes[0]);
    response.end("Development authorization received. Return to Codex. No tokens are displayed here.");
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
    });
  } catch { clearTimeout(timer); throw new Error("callback_listen_failed"); }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("callback_listen_failed");
  return { redirect: `http://127.0.0.1:${address.port}/callback`, code,
    close: async () => {
      clearTimeout(timer);
      if (!consumed) { consumed = true; rejectCode(new Error("callback_closed")); }
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } };
}
