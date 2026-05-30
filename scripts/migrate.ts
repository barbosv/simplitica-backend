import { readEnv } from "../src/env.js";
import { getPool, closePool } from "../src/db/pool.js";
import { runMigrations } from "../src/db/migrate.js";

const env = readEnv();
if (!env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = getPool(env.DATABASE_URL);
try {
  await runMigrations(pool);
  console.log("Migrations applied");
} finally {
  await closePool();
}
