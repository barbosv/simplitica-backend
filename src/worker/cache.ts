import { createHash } from "node:crypto";
import type { ResponseCache } from "../cache.js";

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class D1Cache implements ResponseCache {
  constructor(
    private readonly db: D1Database,
    private readonly namespace: string,
  ) {}
  private key(key: string) {
    return `${this.namespace}:${key}`;
  }
  async get<T>(key: string): Promise<T | null> {
    const row = await this.db
      .prepare(
        "SELECT payload FROM upstream_cache WHERE key=? AND expires_at>?",
      )
      .bind(this.key(key), Date.now())
      .first<{ payload: string }>();
    return row ? (JSON.parse(row.payload) as T) : null;
  }
  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO upstream_cache(key,payload,expires_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at",
      )
      .bind(this.key(key), JSON.stringify(value), Date.now() + ttlMs)
      .run();
  }
}

export async function cleanupExpired(
  db: D1Database,
  now = Date.now(),
): Promise<void> {
  await db.batch([
    db
      .prepare(
        "DELETE FROM rate_limits WHERE key IN (SELECT key FROM rate_limits WHERE expires_at<=? LIMIT 1000)",
      )
      .bind(now),
    db
      .prepare(
        "DELETE FROM upstream_cache WHERE key IN (SELECT key FROM upstream_cache WHERE expires_at<=? LIMIT 1000)",
      )
      .bind(now),
  ]);
}
