export type CachedMaterialQuote = {
  price: number;
  live: boolean;
  attemptedLiveLookup: boolean;
};

export class PricingCache {
  private readonly ttlMs: number;
  private readonly entries = new Map<string, { value: CachedMaterialQuote; expiresAt: number }>();

  constructor(ttlMs = 24 * 60 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  get(key: string): CachedMaterialQuote | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: CachedMaterialQuote): void {
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
}
