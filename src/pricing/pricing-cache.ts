export type CachedMaterialQuote = {
  price: number;
  live: boolean;
  attemptedLiveLookup: boolean;
};

export interface PricingCacheStore<T> {
  get(key: string): T | null | undefined | Promise<T | null | undefined>;
  set(key: string, value: T, ttlMs: number): void | Promise<void>;
}

export class PricingCache<T> {
  private readonly ttlMs: number;
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(ttlMs = 24 * 60 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs = this.ttlMs): void {
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
}
