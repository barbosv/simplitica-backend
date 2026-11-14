export interface ResponseCache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
}

export async function cachedResponse<T>(
  cache: ResponseCache | undefined,
  key: string,
  load: () => Promise<T>,
  ttl: (value: T) => number,
): Promise<T> {
  const cached = await cache?.get<T>(key);
  if (cached != null) return cached;
  const value = await load();
  await cache?.set(key, value, ttl(value));
  return value;
}
