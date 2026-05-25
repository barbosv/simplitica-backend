import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
describe("health", () => {
    it("returns ok", async () => {
        const app = buildApp({
            PORT: 0,
            NODE_ENV: "test",
            APPLE_ENVIRONMENT: "Sandbox",
            SIMPLI_INVOICE_BUNDLE_ID: "co.simplitica.simpli-invoice",
            SIMPLI_INVOICE_APP_APPLE_ID: undefined,
        });
        const res = await app.inject({ method: "GET", url: "/health" });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ ok: true });
    });
});
