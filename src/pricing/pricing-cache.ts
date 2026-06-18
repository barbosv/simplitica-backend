export class PricingCache {
  private readonly ttlMs: number;
  private readonly entries = new Map<string, { value: number; expiresAt: number }>();

  constructor(ttlMs = 24 * 60 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  get(key: string): number | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: number): void {
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
}
