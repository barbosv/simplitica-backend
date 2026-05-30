import pg from "pg";

let pool: pg.Pool | null = null;

export function getPool(databaseUrl: string): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return pool;
}

export async function pingDatabase(databaseUrl: string): Promise<boolean> {
  const client = getPool(databaseUrl);
  try {
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
