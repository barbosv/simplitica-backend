import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { upsertSubscription } from "../src/storage.js";

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
    const app = buildApp({
      PORT: 0,
      NODE_ENV: "test",
      APPLE_ENVIRONMENT: "Sandbox",
      SIMPLI_INVOICE_BUNDLE_ID: "co.simplitica.simpli-invoice",
      SIMPLI_INVOICE_APP_APPLE_ID: undefined,
    });

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

    const app = buildApp({
      PORT: 0,
      NODE_ENV: "test",
      APPLE_ENVIRONMENT: "Sandbox",
      SIMPLI_INVOICE_BUNDLE_ID: "co.simplitica.simpli-invoice",
      SIMPLI_INVOICE_APP_APPLE_ID: undefined,
    });

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
