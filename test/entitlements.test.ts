import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upsertSubscription } from "../src/storage.js";
import { buildTestAppWithContext, createTestContextFromEnv } from "./test-helpers.js";

describe("entitlements", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "simplitica-test-"));
    process.env.DATA_DIR = dir;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });

  it("returns 400 without token", async () => {
    const { env, ctx } = await createTestContextFromEnv({ STORAGE_BACKEND: "file" });
    const app = buildTestAppWithContext(env, ctx);
    const res = await app.inject({ method: "GET", url: "/v1/entitlements" });
    expect(res.statusCode).toBe(400);
  });

  it("returns latest entitlement snapshot", async () => {
    const token = "11111111-1111-1111-1111-111111111111";
    await upsertSubscription({
      appSlug: "simpli-invoice",
      appAccountToken: token,
      originalTransactionId: "1",
      productId: "co.simplitica.simpli_invoice.subscription.monthly",
      state: "trial",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      environment: "Sandbox",
    });

    const { env, ctx } = await createTestContextFromEnv({ STORAGE_BACKEND: "file" });
    const app = buildTestAppWithContext(env, ctx);
    const res = await app.inject({
      method: "GET",
      url: "/v1/entitlements",
      headers: {
        "x-app-account-token": token,
      },
    });

    expect(res.statusCode).toBe(200);
    const json = res.json() as { entitlement: { state: string } | null };
    expect(json.entitlement?.state).toBe("trial");
  });
});
