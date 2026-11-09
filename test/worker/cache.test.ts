import { beforeEach, expect, it } from "vitest";
import { env as workerEnv } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { D1Cache } from "../../src/worker/cache.js";
const env = workerEnv as {
  DB: D1Database;
  TEST_MIGRATIONS: import("@cloudflare/vitest-plugin").D1Migration[];
};
beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
it("shares cache values across instances and honors expiration and namespace", async () => {
  const key = crypto.randomUUID();
  const cache = new D1Cache(env.DB, "one");
  await cache.set(key, { price: 12.34, source: "fixture" }, 60000);
  expect(await new D1Cache(env.DB, "one").get(key)).toEqual({
    price: 12.34,
    source: "fixture",
  });
  expect(await new D1Cache(env.DB, "two").get(key)).toBeNull();
  await cache.set(key, { price: 99 }, -1);
  expect(await cache.get(key)).toBeNull();
});
