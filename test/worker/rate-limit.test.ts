import { beforeEach, expect, it } from "vitest";
import { env as workerEnv } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { consumeRateLimit } from "../../src/worker/rate-limit.js";
const env = workerEnv as {
  DB: D1Database;
  TEST_MIGRATIONS: import("@cloudflare/vitest-plugin").D1Migration[];
};
beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
it("enforces exact limits atomically under concurrent requests and resets after expiration", async () => {
  const key = crypto.randomUUID();
  const results = await Promise.all(
    Array.from({ length: 12 }, () => consumeRateLimit(env.DB, key, 10, 100000)),
  );
  expect(results.filter((result) => result.allowed)).toHaveLength(10);
  expect(await consumeRateLimit(env.DB, key, 10, 130000)).toMatchObject({
    allowed: false,
    retryAfter: 30,
  });
  expect(await consumeRateLimit(env.DB, key, 10, 160000)).toMatchObject({
    allowed: true,
    retryAfter: 60,
  });
});
it.each([120, 10, 30, 60])(
  "rejects request %i+1 across separate calls",
  async (limit) => {
    const key = crypto.randomUUID();
    for (let index = 0; index < limit; index++)
      expect((await consumeRateLimit(env.DB, key, limit)).allowed).toBe(true);
    expect((await consumeRateLimit(env.DB, key, limit)).allowed).toBe(false);
  },
);
