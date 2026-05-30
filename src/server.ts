import { buildApp } from "./app.js";
import { readEnv } from "./env.js";
import { createAppContext } from "./db/context.js";
import { closePool, getPool } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";

async function main() {
  const env = readEnv();
  const ctx = await createAppContext(env, { runMigrations: false });
  const app = buildApp({ env, ctx });

  async function shutdown(signal: string) {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await closePool();
    process.exit(0);
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  app.log.info({ port: env.PORT }, "listening");

  if (env.STORAGE_BACKEND === "postgres" && env.DATABASE_URL && env.RUN_MIGRATIONS) {
    await runMigrations(getPool(env.DATABASE_URL));
    app.log.info("migrations applied");
  }
}

main().catch((err) => {
  console.error("Startup failed:", err);
  process.exit(1);
});
