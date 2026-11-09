import { expect, it } from "vitest";
import { readEnv } from "../../src/env.js";
import { buildSignedDataVerifier } from "../../src/apple/verifier.js";

it("supports D1 without a PostgreSQL URL and parses explicit false booleans", () => {
  const config = {
    STORAGE_BACKEND: "d1",
    PUBLIX_DEALS_FIXTURE: "false",
    RUN_MIGRATIONS: "false",
  };
  expect(readEnv(config)).toMatchObject({
    STORAGE_BACKEND: "d1",
    PUBLIX_DEALS_FIXTURE: false,
    RUN_MIGRATIONS: false,
  });
  expect(
    readEnv({ ...config, PUBLIX_DEALS_FIXTURE: "true" }).PUBLIX_DEALS_FIXTURE,
  ).toBe(true);
  expect(readEnv(config).PUBLIX_DEALS_FIXTURE).toBe(false);
});
it("rejects incomplete production configuration", () => {
  expect(() =>
    readEnv({ STORAGE_BACKEND: "d1", NODE_ENV: "production" }),
  ).toThrow();
});
it("builds the production Apple verifier without reading disk", () => {
  expect(() =>
    buildSignedDataVerifier({
      app: {
        slug: "simpli-invoice",
        bundleId: "co.simplitica.simpli-invoice",
        appAppleId: 123,
      },
      environment: "Production",
      enableOnlineChecks: true,
    }),
  ).not.toThrow();
});
