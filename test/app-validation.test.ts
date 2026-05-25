import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

const testEnv = {
  PORT: 0,
  NODE_ENV: "test" as const,
  APPLE_ENVIRONMENT: "Sandbox" as const,
  SIMPLI_INVOICE_BUNDLE_ID: "co.simplitica.simpli-invoice",
  SIMPLI_INVOICE_APP_APPLE_ID: undefined,
};

describe("request validation", () => {
  it("returns 400 for malformed sync body", async () => {
    const app = buildApp(testEnv);
    const res = await app.inject({
      method: "POST",
      url: "/v1/subscriptions/sync",
      payload: { appAccountToken: "not-a-uuid", signedTransactionInfo: "short" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Invalid request body" });
  });

  it("returns 400 for malformed webhook body", async () => {
    const app = buildApp(testEnv);
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/app-store",
      payload: { signedPayload: "short" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Invalid request body" });
  });

  it("returns 400 (not 500) for invalid signedTransactionInfo on sync", async () => {
    const app = buildApp(testEnv);
    const res = await app.inject({
      method: "POST",
      url: "/v1/subscriptions/sync",
      headers: { "content-type": "application/json" },
      payload: {
        appAccountToken: "11111111-1111-1111-1111-111111111111",
        signedTransactionInfo:
          "eyJhbGciOiJFUzI1NiIsIng1YyI6WyJleGFtcGxlIl0sInR5cCI6IkpXVCJ9.eyJ0ZXN0IjoxfQ.invalid",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty("error");
  });
});
