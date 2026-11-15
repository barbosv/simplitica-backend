import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

async function execute(overrides: Record<string, unknown> = {}) {
  const logs: string[] = [], denied: string[] = [], claims: unknown[][] = [];
  const exported: { onExecutePostLogin?: (event: unknown, api: unknown) => Promise<void> } = {};
  runInNewContext(await readFile("scripts/auth0/development-apple-identity.cjs", "utf8"), {
    exports: exported, console: { log: (message: string) => logs.push(message) },
  });
  await exported.onExecutePostLogin!({
    client: { client_id: "tpc_5RjUULWf1V9koMnfWj1Xg3" },
    resource_server: { identifier: "https://simpli-invoice-mcp-dev.simplitica.co/mcp" },
    connection: { strategy: "apple" },
    user: { identities: [{ provider: "apple", user_id: "PRIVATE-APPLE-ID" }] },
    transaction: { protocol: "oidc-basic-profile" },
    request: { query: { code_challenge_method: "S256", code_challenge: "PRIVATE-CHALLENGE",
      scope: "offline_access probe:read", resource: "https://simpli-invoice-mcp-dev.simplitica.co/mcp",
      state: "PRIVATE-STATE" }, body: { refresh_token: "PRIVATE-TOKEN", client_secret: "PRIVATE-SECRET" } },
    ...overrides,
  }, { access: { deny: (reason: string) => denied.push(reason) },
    accessToken: { setCustomClaim: (...args: unknown[]) => claims.push(args) } });
  return { logs, denied, claims };
}

it("records sanitized live PKCE/scope evidence without identities or credentials", async () => {
  const result = await execute();
  expect(result.denied).toEqual([]);
  expect(result.claims).toEqual([["https://simplitica.co/apple_identity", "PRIVATE-APPLE-ID"]]);
  expect(result.logs).toHaveLength(1);
  expect(JSON.parse(result.logs[0]!)).toEqual({ event: "development-oauth-qualification", flow: "authorization",
    pkceS256: true, resourceMatches: true, probeScope: true, offlineAccess: true, unexpectedScopes: false });
  expect(result.logs.join()).not.toContain("PRIVATE");
});

it("reports an incompatible authorization request without rewriting provider metadata", async () => {
  const result = await execute({ request: { query: { code_challenge_method: "plain", scope: "openid probe:read",
    resource: "https://other.test/mcp" } } });
  expect(result.logs).toHaveLength(1);
  expect(JSON.parse(result.logs[0]!)).toMatchObject({ pkceS256: false, resourceMatches: false,
    probeScope: true, offlineAccess: false, unexpectedScopes: true });
});

it("denies legacy MCP refresh without logging refresh bodies", async () => {
  const result = await execute({ transaction: { protocol: "oauth2-refresh-token" },
    request: { body: { refresh_token: "PRIVATE-TOKEN" } } });
  expect(result.claims).toEqual([]);
  expect(result.denied).toEqual(["Development MCP authorization-code flow required"]);
  expect(result.logs).toEqual([]);
  expect(result.logs.join()).not.toContain("PRIVATE");
});

it("does not log or issue claims for an unrelated client", async () => {
  expect(await execute({ client: { client_id: "unrelated" } })).toEqual({ logs: [], claims: [], denied: [] });
});

it.each([
  { connection: { strategy: "google-oauth2" } },
  { user: { identities: [] } },
  { user: { identities: [{ provider: "apple", user_id: " " }] } },
  { user: { identities: [{ provider: "apple", user_id: "a" }, { provider: "apple", user_id: "b" }] } },
  { resource_server: { identifier: "https://other.test/mcp" } },
])("denies incompatible identity/audience without emitting a claim: %j", async (input) => {
  const result = await execute(input);
  expect(result.denied).toHaveLength(1);
  expect(result.claims).toEqual([]);
  expect(result.logs).toEqual([]);
});

const nativeEvent = {
  client: { client_id: "WXTblf8z8B9kGNaX9QgR6dUzexXT5Ixa" },
  resource_server: { identifier: "https://simpli-invoice-native-dev.simplitica.co/api" },
  request: { query: { audience: "https://simpli-invoice-native-dev.simplitica.co/api",
    scope: "openid profile offline_access qualification:read", code_challenge_method: "S256", code_challenge: "PRIVATE-CHALLENGE" } },
};

it("maps the same trusted opaque identity for the separately scoped native development client", async () => {
  const result = await execute(nativeEvent);
  expect(result.denied).toEqual([]);
  expect(result.claims).toEqual([["https://simplitica.co/apple_identity", "PRIVATE-APPLE-ID"]]);
  expect(result.logs).toHaveLength(1);
  expect(JSON.parse(result.logs[0]!)).toEqual({ event: "development-native-qualification", flow: "authorization",
    pkceS256: true, audienceMatches: true, qualificationScope: true, offlineAccess: true, unexpectedScopes: false });
  expect(result.logs.join()).not.toContain("PRIVATE");
});

it.each([
  { ...nativeEvent, resource_server: { identifier: "https://simpli-invoice-mcp-dev.simplitica.co/mcp" } },
  { resource_server: nativeEvent.resource_server },
  { ...nativeEvent, connection: { strategy: "google-oauth2" } },
])("rejects cross-client resource use or non-Apple native login: %j", async input => {
  const result = await execute(input);
  expect(result.denied).toHaveLength(1);
  expect(result.claims).toEqual([]);
  expect(result.logs).toEqual([]);
});

it("preserves first-party native refresh claim issuance", async () => {
  const result = await execute({ ...nativeEvent, transaction: { protocol: "oauth2-refresh-token" }, request: { body: { refresh_token: "PRIVATE-TOKEN" } } });
  expect(result.denied).toEqual([]);
  expect(result.claims).toEqual([["https://simplitica.co/apple_identity", "PRIVATE-APPLE-ID"]]);
  expect(JSON.parse(result.logs[0]!)).toEqual({ event: "development-native-qualification", flow: "refresh" });
  expect(result.logs.join()).not.toContain("PRIVATE");
});

it.each([
  ["oversize", "x".repeat(1025)], ["unpaired high surrogate", "\ud800"],
  ["unpaired low surrogate", "\udfff"], ["embedded unpaired surrogate", "before\ud800after"],
])("denies native malformed %s consistently on initial login and refresh", async (_name, user_id) => {
  for (const protocol of ["oidc-basic-profile", "oauth2-refresh-token"]) {
    const result = await execute({ ...nativeEvent, transaction: { protocol }, user: { identities: [{ provider: "apple", user_id }] } });
    expect(result.denied).toEqual(["A single verified Apple identity is required"]);
    expect(result.claims).toEqual([]);
    expect(result.logs).toEqual([]);
  }
});

it.each(["\ufffd", "😀", " apple|雪\u0000 ", "😀".repeat(512)])("preserves native opaque identity %j on initial login and refresh", async user_id => {
  for (const protocol of ["oidc-basic-profile", "oauth2-refresh-token"]) {
    const result = await execute({ ...nativeEvent, transaction: { protocol }, user: { identities: [{ provider: "apple", user_id }] } });
    expect(result.denied).toEqual([]);
    expect(result.claims).toEqual([["https://simplitica.co/apple_identity", user_id]]);
  }
});
