import { describe, expect, it } from "vitest";
import { buildTestApp } from "./test-helpers.js";

describe("request validation", () => {
  it("returns 400 for malformed sync body", async () => {
    const app = buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/subscriptions/sync",
      payload: { appAccountToken: "not-a-uuid", signedTransactionInfo: "short" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Invalid request body" });
  });

  it("returns 400 for malformed webhook body", async () => {
    const app = buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/app-store",
      payload: { signedPayload: "short" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Invalid request body" });
  });

  it("returns 400 (not 500) for invalid signedTransactionInfo on sync", async () => {
    const app = buildTestApp();
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
