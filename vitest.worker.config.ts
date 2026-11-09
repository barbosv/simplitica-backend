import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import chain from "./test/worker/fixtures/apple-chain.json";

let ocspCalls = 0;
let storeCalls = 0;
let flyerCalls = 0;

export default defineConfig({
  resolve: {
    alias: {
      "node-fetch": new URL("./src/worker/node-fetch.cjs", import.meta.url)
        .pathname,
    },
  },
  plugins: [
    cloudflareTest({
      miniflare: {
        d1Databases: ["DB"],
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations/d1"),
        },
        compatibilityDate: "2026-11-09",
        compatibilityFlags: ["nodejs_compat"],
        outboundService: async (request) => {
          const url = new URL(request.url);
          if (url.hostname === "ocsp.test" && ++ocspCalls <= 2) {
            const value =
              url.pathname === "/leaf"
                ? chain.leafOCSP
                : chain.intermediateOCSP;
            return new Response(Buffer.from(value, "base64"));
          }
          if (url.hostname === "services.publix.com")
            return Response.json({
              Stores: [
                {
                  KEY: "123",
                  NAME: `Store ${++storeCalls}`,
                  CITY: "Test",
                  ZIP: url.searchParams.get("zipCode"),
                },
              ],
            });
          if (url.hostname === "backflipp.wishabi.com") {
            if (url.pathname === "/flipp/flyers")
              return Response.json([
                { id: 1, merchant_id: 2361, name: "Weekly Ad" },
              ]);
            return Response.json({
              items: [
                {
                  id: String(++flyerCalls),
                  name: "Milk BOGO",
                  sale_story: "Buy one get one free",
                },
              ],
            });
          }
          return new Response("test upstream unavailable", { status: 503 });
        },
      },
    }),
  ],
  test: { include: ["test/worker/**/*.test.ts"] },
});
