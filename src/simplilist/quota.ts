import type { Env } from "../env.js";

type RateWindow = { count: number; windowStart: number };

export class SimplilistQuotaStore {
  private readonly rateWindows = new Map<string, RateWindow>();
  private readonly ratePerMin: number;

  constructor(env: Env) {
    this.ratePerMin = env.SIMPLILIST_RATE_LIMIT_PER_MINUTE;
  }

  checkRateLimit(deviceId: string): boolean {
    const now = Date.now();
    const window = this.rateWindows.get(deviceId) ?? { count: 0, windowStart: now };
    if (now - window.windowStart > 60_000) {
      window.count = 0;
      window.windowStart = now;
    }
    window.count += 1;
    this.rateWindows.set(deviceId, window);
    return window.count <= this.ratePerMin;
  }
}
