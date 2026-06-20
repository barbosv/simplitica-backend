import { describe, expect, it } from "vitest";
import { buildTestApp } from "./test-helpers.js";

describe("client API key on pricing routes", () => {
  it("allows pricing when SIMPLITICA_CLIENT_API_KEY is unset", async () => {
    const app = buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/pricing/wages",
      payload: { soc_code: "47-2031", fallback: 24 },
    });
    expect(res.statusCode).toBe(200);
  });

  it("returns 401 without X-API-Key when key is configured", async () => {
    const app = buildTestApp({ SIMPLITICA_CLIENT_API_KEY: "test-client-key" });
    const res = await app.inject({
      method: "POST",
      url: "/v1/pricing/materials",
      payload: { materials: ["faucet"], quantity: 1 },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Unauthorized" });
  });

  it("accepts matching X-API-Key", async () => {
    const app = buildTestApp({ SIMPLITICA_CLIENT_API_KEY: "test-client-key" });
    const res = await app.inject({
      method: "POST",
      url: "/v1/pricing/materials",
      headers: { "x-api-key": "test-client-key" },
      payload: { materials: ["faucet"], quantity: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().total_cost).toBeGreaterThan(0);
  });

  it("does not require client API key on health", async () => {
    const app = buildTestApp({ SIMPLITICA_CLIENT_API_KEY: "test-client-key" });
    const res = await app.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json().pricing).toMatchObject({ client_api_key_required: true });
  });
});
