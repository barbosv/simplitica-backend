import { beforeEach, expect, it, vi } from "vitest";
import { env as workerEnv } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { createCloudAccountRepository } from "../../src/chatgpt/accounts/d1.js";
import { createCloudConnectionRepository } from "../../src/chatgpt/accounts/connections.js";
import { createEpochHook } from "../../src/chatgpt/auth/epoch-hook.js";

const env = workerEnv as { DB: D1Database; TEST_MIGRATIONS: import("@cloudflare/vitest-plugin").D1Migration[]; TEST_CLOUD_MIGRATIONS: import("@cloudflare/vitest-plugin").D1Migration[] };
const url = "https://simpli-invoice-native-dev.simplitica.co/api/internal/oauth/connection-epoch";
const secret = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI";
const namespace = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const issuer = "https://dev-i8usug5fp48kepvr.us.auth0.com/";
const clientId = "tpc_5RjUULWf1V9koMnfWj1Xg3";
const now = 1_800_000_000_000;
const command = (appleIdentity = "PRIVATE-apple|owner", deviceKeyId = "device", client = clientId) => ({ identity: { issuer, appleIdentity }, deviceKeyId, clientId: client, now, expectedRevision: 0 });
const hook = (db = env.DB, token = secret, space = namespace) => createEpochHook(db, token, space);
const request = (body: BodyInit | null = JSON.stringify({ appleIdentity: "PRIVATE-apple|owner" }), headers: HeadersInit = {}) => new Request(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}`, ...headers }, body });
async function result(response: Response, status: number, body: unknown) {
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Content-Type")).toContain("application/json");
  expect(await response.json()).toEqual(body);
}
async function enroll(input = command(), key = 1) {
  const accounts = createCloudAccountRepository(env.DB);
  const challengeHash = key.toString(16).padStart(64, "0");
  await accounts.issueChallenge({ ...input, challengeHash, expiresAt: now + 1000 });
  await accounts.commitEnrollment({ challengeHash, now, evidence: { identity: input.identity, deviceKeyId: input.deviceKeyId, purchase: { appSlug: "simpli-invoice", environment: "Sandbox", originalTransactionId: `lineage-${key}` } } });
}
beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await applyD1Migrations(env.DB, env.TEST_CLOUD_MIGRATIONS);
  for (const table of ["cloud_connections", "cloud_enrollment_commits", "cloud_purchase_lineages", "cloud_devices", "cloud_businesses", "cloud_identities", "cloud_owners", "cloud_enrollment_challenges", "cloud_batch_guards"]) await env.DB.prepare(`DELETE FROM ${table}`).run();
});

it("returns a coherent captured namespace and active epoch from real D1 across reconnect", async () => {
  const app = hook();
  await result(await app.fetch(request()), 200, { active: false });
  await enroll();
  await result(await app.fetch(request()), 200, { active: false });
  const repo = createCloudConnectionRepository(env.DB);
  await repo.approve(command());
  await result(await app.fetch(request()), 200, { active: true, epoch: 1, namespace });
  await repo.revoke({ ...command(), expectedRevision: 1 });
  await result(await app.fetch(request()), 200, { active: false });
  await repo.approve({ ...command(), expectedRevision: 2 });
  await result(await app.fetch(request()), 200, { active: true, epoch: 3, namespace });
});

it("requires the exact identity, fixed client and active device owned by the connection owner", async () => {
  await enroll();
  const repo = createCloudConnectionRepository(env.DB);
  await repo.approve(command());
  const app = hook();
  await result(await app.fetch(request(JSON.stringify({ appleIdentity: "PRIVATE-apple|Owner" }))), 200, { active: false });
  await env.DB.prepare("UPDATE cloud_connections SET client_id = 'other-client'").run();
  await result(await app.fetch(request()), 200, { active: false });
  await env.DB.prepare("UPDATE cloud_connections SET client_id = ?").bind(clientId).run();
  await env.DB.prepare("UPDATE cloud_devices SET status = 'revoked'").run();
  await result(await app.fetch(request()), 200, { active: false });
  await env.DB.prepare("UPDATE cloud_devices SET status = 'active'").run();
  await enroll(command("other-owner", "other-device"), 2);
  await repo.approve(command("other-owner", "other-device"));
  await env.DB.prepare("UPDATE cloud_devices SET status = 'revoked' WHERE device_key_id = 'other-device'").run();
  await result(await app.fetch(request(JSON.stringify({ appleIdentity: "other-owner" }))), 200, { active: false });
  await result(await app.fetch(request()), 200, { active: true, epoch: 1, namespace });
});

it("fixes the issuer server-side even when the same opaque identity has another issuer's active connection", async () => {
  const input = { ...command(), identity: { ...command().identity, issuer: "https://other-issuer.test/" } };
  await enroll(input);
  await createCloudConnectionRepository(env.DB).approve(input);
  await result(await hook().fetch(request()), 200, { active: false });
});

it.each(["\ufffd", "😀", " apple|雪\u0000 ", "😀".repeat(512)])("preserves exact well-formed identity %j", async appleIdentity => {
  await enroll(command(appleIdentity));
  await createCloudConnectionRepository(env.DB).approve(command(appleIdentity));
  await result(await hook().fetch(request(JSON.stringify({ appleIdentity }))), 200, { active: true, epoch: 1, namespace });
});

it.each(["", "Bearer wrong", `Bearer ${"A".repeat(42)}`, `Bearer ${"A".repeat(42)}B`, `Basic ${secret}`, `bearer ${secret}`, `Bearer ${secret} extra`])("rejects unauthorized credentials before reading any body: %j", async authorization => {
  // A locked body is unreadable; attempting to consume it would produce a 400/503.
  const req = request("private", { Authorization: authorization });
  const reader = req.body!.getReader();
  try { await result(await hook(null as never).fetch(req), 401, { error: "unauthorized" }); }
  finally { reader.releaseLock(); }
});

it.each(["", "A".repeat(42), "A".repeat(42) + "B", "A".repeat(44), "a=".repeat(22)])("fails closed on invalid configured hook credential %j", async value => {
  await result(await hook(null as never, value).fetch(request()), 503, { error: "unavailable" });
});

it.each(["", "A".repeat(42) + "B", "A".repeat(44), undefined])("rejects invalid external namespace before serving requests %j", value => {
  expect(() => createEpochHook(null as never, secret, value as string)).toThrow("invalid_configuration");
});

it.each([
  ["http://simpli-invoice-native-dev.simplitica.co/api/internal/oauth/connection-epoch", 404],
  ["https://other.test/api/internal/oauth/connection-epoch", 404],
  ["https://simpli-invoice-native-dev.simplitica.co:8443/api/internal/oauth/connection-epoch", 404],
  [url + "/", 404], [url + "?unexpected=1", 404], [url.replace("connection-epoch", "other"), 404],
] as const)("rejects noncanonical hook URL %s", async (target, status) => {
  await result(await hook(null as never).fetch(new Request(target, { method: "POST" })), status, { error: "not_found" });
});

it.each(["GET", "PUT", "DELETE", "OPTIONS"])("returns no-store JSON for unsupported %s", async method => {
  await result(await hook(null as never).fetch(new Request(url, { method })), 405, { error: "method_not_allowed" });
});

it.each(["", "null", "[]", "{}", "not-json", '{"appleIdentity":1}', '{"appleIdentity":""}', '{"appleIdentity":"\\ud800"}', '{"appleIdentity":"\\udfff"}', JSON.stringify({ appleIdentity: "x".repeat(1025) }), JSON.stringify({ appleIdentity: "owner", clientId }), JSON.stringify({ appleIdentity: "owner", namespace })])("rejects malformed or non-strict body %j before storage", async body => {
  await result(await hook(null as never).fetch(request(body)), 400, { error: "invalid_request" });
});

it("bounds decoded bytes and rejects invalid UTF-8 or non-JSON media types", async () => {
  const app = hook(null as never);
  await result(await app.fetch(request(JSON.stringify({ appleIdentity: "😀".repeat(512) }) + " ".repeat(2100))), 400, { error: "invalid_request" });
  await result(await app.fetch(request(new Uint8Array([0xff]))), 400, { error: "invalid_request" });
  await result(await app.fetch(request("{}", { "Content-Type": "text/plain" })), 400, { error: "invalid_request" });
  await result(await app.fetch(request("{}", { "Content-Length": "4097" })), 400, { error: "invalid_request" });
});

it("accepts the 4096 byte boundary and stops reading an unterminated body after two seconds", async () => {
  await enroll();
  await createCloudConnectionRepository(env.DB).approve(command());
  const body = JSON.stringify({ appleIdentity: "PRIVATE-apple|owner" });
  await result(await hook().fetch(request(body.padEnd(4096))), 200, { active: true, epoch: 1, namespace });
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(body)); }, cancel() { cancelled = true; return new Promise<void>(() => {}); } });
  const start = Date.now();
  await result(await hook(null as never).fetch(request(stream)), 408, { error: "request_timeout" });
  expect(Date.now() - start).toBeGreaterThanOrEqual(1900);
  expect(Date.now() - start).toBeLessThan(3000);
  expect(cancelled).toBe(true);
});

it("sanitizes a real storage error without logging private data", async () => {
  const logs = vi.spyOn(console, "error");
  await env.DB.prepare("ALTER TABLE cloud_connections RENAME TO unavailable_connections").run();
  try { await result(await hook().fetch(request()), 503, { error: "unavailable" }); expect(logs).not.toHaveBeenCalled(); }
  finally { await env.DB.prepare("ALTER TABLE unavailable_connections RENAME TO cloud_connections").run(); logs.mockRestore(); }
});
