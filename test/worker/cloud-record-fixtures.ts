import { env as workerEnv } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createCloudAccountRepository } from "../../src/chatgpt/accounts/d1.js";
import { createCloudConnectionRepository } from "../../src/chatgpt/accounts/connections.js";
import { CLOUD_ISSUER, CLOUD_AUDIENCE, CLOUD_CLIENT_ID } from "../../src/chatgpt/auth/cloud-token.js";
import { createCloudRecordAuthorizer } from "../../src/chatgpt/records/authority.js";
import { applyVerifiedEntitlement, initializeVerifiedOwnerRecords } from "../../src/chatgpt/records/entitlements.js";
export const env = workerEnv as { DB: D1Database; TEST_CLOUD_MIGRATIONS: import("@cloudflare/vitest-plugin").D1Migration[] };
export const namespace = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
export const start = 1_800_000_010_000;
export const fact = (id = "one") => ({ appSlug: "simpli-invoice" as const, environment: "Sandbox" as const, originalTransactionId: `lineage-${id}`, state: "active" as const, expiresAt: start + 999_999, graceExpiresAt: null, signedAt: start, checkedAt: start });
export async function reset() {
  await applyD1Migrations(env.DB, env.TEST_CLOUD_MIGRATIONS);
  for (const table of ["cloud_issued_numbers", "cloud_number_reservations", "cloud_number_state", "cloud_record_feed", "cloud_mutation_receipts", "cloud_business_profiles", "cloud_customers", "cloud_saved_rates", "cloud_entitlements", "cloud_record_state", "cloud_connections", "cloud_enrollment_commits", "cloud_purchase_lineages", "cloud_devices", "cloud_businesses", "cloud_identities", "cloud_owners", "cloud_enrollment_challenges", "cloud_batch_guards"]) await env.DB.prepare(`DELETE FROM ${table}`).run();
}
export async function setup(id = "one", ready = true) {
  const identity = { issuer: CLOUD_ISSUER, appleIdentity: `apple-${id}` };
  const deviceKeyId = `device-${id}`;
  const accounts = createCloudAccountRepository(env.DB);
  const challengeHash = (id === "one" ? "1" : "2").repeat(64);
  await accounts.issueChallenge({ identity, deviceKeyId, challengeHash, now: start - 1000, expiresAt: start + 1000 });
  const owner = await accounts.commitEnrollment({ challengeHash, now: start, evidence: { identity, deviceKeyId, purchase: fact(id) } });
  await createCloudConnectionRepository(env.DB).approve({ identity, deviceKeyId, clientId: CLOUD_CLIENT_ID, now: start, expectedRevision: 0 });
  await initializeVerifiedOwnerRecords(env.DB, owner, deviceKeyId);
  if (ready) await env.DB.prepare("UPDATE cloud_record_state SET phase = 'ready' WHERE owner_id = ?").bind(owner.ownerId).run();
  await applyVerifiedEntitlement(env.DB, owner, fact(id), start);
  const keys = await generateKeyPair("RS256");
  const resolveKey = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: "test", alg: "RS256" }] });
  const token = await new SignJWT({ iss: CLOUD_ISSUER, aud: CLOUD_AUDIENCE, sub: "subject", azp: CLOUD_CLIENT_ID, scope: "cloud:access", iat: start / 1000, exp: start / 1000 + 3600, "https://simplitica.co/apple_identity": identity.appleIdentity, "https://simplitica.co/connection_epoch": 1, "https://simplitica.co/authorization_namespace": namespace }).setProtectedHeader({ alg: "RS256", kid: "test" }).sign(keys.privateKey);
  const authority = await createCloudRecordAuthorizer(env.DB, { authorizationNamespace: namespace, keys: resolveKey, now: () => start })(token);
  if (!authority) throw new Error("fixture authority missing");
  return { owner, authority, deviceKeyId, token, resolveKey };
}
export async function state() {
  const entries = await Promise.all(["cloud_customers", "cloud_mutation_receipts", "cloud_record_feed", "cloud_batch_guards", "cloud_record_state"].map(async table => [table, (await env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results]));
  return Object.fromEntries(entries);
}
