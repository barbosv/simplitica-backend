import fs from "node:fs/promises";
import path from "node:path";
import type pg from "pg";

const migrationsDir = path.join(process.cwd(), "migrations");

export async function runMigrations(client: pg.Pool | pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const entries = await fs.readdir(migrationsDir);
  const files = entries.filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    const existing = await client.query(`SELECT 1 FROM schema_migrations WHERE version = $1`, [version]);
    if (existing.rowCount && existing.rowCount > 0) continue;

    const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [version]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  }
}
