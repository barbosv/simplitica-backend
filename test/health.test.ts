import { describe, expect, it } from "vitest";
import { buildTestApp } from "./test-helpers.js";

describe("health", () => {
  it("returns ok", async () => {
    const app = buildTestApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("ready skips database when file storage", async () => {
    const app = buildTestApp();
    const res = await app.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, database: "skipped" });
  });
});
