export async function consumeRateLimit(
  db: D1Database,
  key: string,
  limit: number,
  now = Date.now(),
): Promise<{ allowed: boolean; retryAfter: number }> {
  const row = await db
    .prepare(
      `INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?)
    ON CONFLICT(key) DO UPDATE SET
      count=CASE WHEN expires_at<=? THEN 1 ELSE MIN(count+1,?) END,
      expires_at=CASE WHEN expires_at<=? THEN ? ELSE expires_at END
    RETURNING count,expires_at`,
    )
    .bind(key, now + 60000, now, limit + 1, now, now + 60000)
    .first<{ count: number; expires_at: number }>();
  if (!row) throw new Error("Rate limit storage unavailable");
  return {
    allowed: row.count <= limit,
    retryAfter: Math.max(1, Math.ceil((row.expires_at - now) / 1000)),
  };
}
