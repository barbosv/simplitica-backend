import type { Env } from "../env.js";

type RateWindow = { count: number; windowStart: number };
type DailyQuota = { day: string; aiCalls: number };

export class SimplilistQuotaStore {
  private readonly rateWindows = new Map<string, RateWindow>();
  private readonly dailyQuotas = new Map<string, DailyQuota>();
  private readonly ratePerMin: number;
  private readonly aiDailyCap: number;

  constructor(env: Env) {
    this.ratePerMin = env.SIMPLILIST_RATE_LIMIT_PER_MINUTE;
    this.aiDailyCap = env.SIMPLILIST_AI_DAILY_CAP_PER_DEVICE;
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

  consumeAiQuota(deviceId: string): boolean {
    const day = new Date().toISOString().slice(0, 10);
    let quota = this.dailyQuotas.get(deviceId);
    if (!quota || quota.day !== day) {
      quota = { day, aiCalls: 0 };
    }
    if (quota.aiCalls >= this.aiDailyCap) return false;
    quota.aiCalls += 1;
    this.dailyQuotas.set(deviceId, quota);
    return true;
  }
}
