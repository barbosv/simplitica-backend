import { describe, expect, it } from "vitest";
import { buildTestApp } from "./test-helpers.js";

const simplilistHeaders = {
  authorization: "Bearer test-simplilist-key",
  "x-device-id": "device-test-001",
};

describe("SimpliList routes", () => {
  const app = () =>
    buildTestApp({
      SIMPLILIST_BACKEND_API_KEY: "test-simplilist-key",
      PUBLIX_DEALS_FIXTURE: true,
    });

  it("returns 401 without Bearer token", async () => {
    const res = await app().inject({
      method: "GET",
      url: "/v1/deals/publix/stores?zip=33602",
      headers: { "x-device-id": "device-test-001" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthorized" });
  });

  it("returns 400 without X-Device-Id", async () => {
    const res = await app().inject({
      method: "GET",
      url: "/v1/deals/publix/stores?zip=33602",
      headers: { authorization: "Bearer test-simplilist-key" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "missing_x_device_id" });
  });

  it("returns 400 for invalid zip", async () => {
    const res = await app().inject({
      method: "GET",
      url: "/v1/deals/publix/stores?zip=abc",
      headers: simplilistHeaders,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_zip" });
  });

  it("returns fixture BOGO catalog", async () => {
    const res = await app().inject({
      method: "GET",
      url: "/v1/deals/publix/bogo?storeNumber=628",
      headers: simplilistHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.storeNumber).toBe("628");
    expect(body.source).toBe("fixture");
    expect(body.deals.length).toBeGreaterThan(0);
  });

  it("returns 403 for AI without Pro registration", async () => {
    const res = await app().inject({
      method: "POST",
      url: "/v1/ai/voice-items",
      headers: simplilistHeaders,
      payload: { transcript: "milk eggs" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "pro_required" });
  });

  it("returns 400 for iap register without payload", async () => {
    const res = await app().inject({
      method: "POST",
      url: "/v1/iap/register",
      headers: simplilistHeaders,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "transaction_payload_required" });
  });

  it("registers pro from signed transaction JWS payload", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        productId: "co.simplitica.simplilist.pro.monthly",
        originalTransactionId: "orig-123",
        expiresDate: Date.now() + 60_000,
      }),
    ).toString("base64url");
    const jws = `${header}.${payload}.`;

    const register = await app().inject({
      method: "POST",
      url: "/v1/iap/register",
      headers: simplilistHeaders,
      payload: { signedTransactionInfos: [jws] },
    });
    expect(register.statusCode).toBe(200);
    expect(register.json()).toMatchObject({ pro: true, originalTransactionId: "orig-123" });
  });

  it("exposes simplilist flags on health/ready", async () => {
    const res = await app().inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json().simplilist).toMatchObject({
      backend_api_key_configured: true,
      openai_key_configured: false,
    });
  });
});
