import { PricingCache } from "./pricing-cache.js";

export type WageLookupRequest = {
  soc_code: string;
  state_code?: string;
  fallback: number;
};

export type WageLookupResponse = {
  hourly_wage: number;
  source: "bls_live" | "template_fallback";
  wage_state_code?: string;
  live_lookup_attempted: boolean;
  lookup_issue?: "daily_limit_exceeded" | "no_data";
};

const BLS_API_URL = "https://api.bls.gov/publicAPI/v2/timeseries/data/";

const blsStateAreaByCode: Record<string, string> = {
  AL: "0100000", AK: "0200000", AZ: "0400000", AR: "0500000", CA: "0600000",
  CO: "0800000", CT: "0900000", DE: "1000000", DC: "1100000", FL: "1200000",
  GA: "1300000", HI: "1500000", ID: "1600000", IL: "1700000", IN: "1800000",
  IA: "1900000", KS: "2000000", KY: "2100000", LA: "2200000", ME: "2300000",
  MD: "2400000", MA: "2500000", MI: "2600000", MN: "2700000", MS: "2800000",
  MO: "2900000", MT: "3000000", NE: "3100000", NV: "3200000", NH: "3300000",
  NJ: "3400000", NM: "3500000", NY: "3600000", NC: "3700000", ND: "3800000",
  OH: "3900000", OK: "4000000", OR: "4100000", PA: "4200000", RI: "4400000",
  SC: "4500000", SD: "4600000", TN: "4700000", TX: "4800000", UT: "4900000",
  VT: "5000000", VA: "5100000", WA: "5300000", WV: "5400000", WI: "5500000",
  WY: "5600000",
};

export function isBLSWageConfigured(env: { BLS_API_KEY?: string }): boolean {
  return Boolean(env.BLS_API_KEY?.trim());
}

export function oewsSeriesID(
  areaType: "N" | "S",
  areaCode: string,
  soc: string,
  datatype = "03",
): string {
  return `OEU${areaType}${areaCode}000000${soc}${datatype}`;
}

export function nationalSeriesID(soc: string): string {
  return oewsSeriesID("N", "0000000", soc);
}

export function stateSeriesID(soc: string, blsAreaCode: string): string {
  return oewsSeriesID("S", blsAreaCode, soc);
}

function normalizedSOC(socCode: string): string | undefined {
  const normalized = socCode.replace(/-/g, "");
  return /^\d{6}$/.test(normalized) ? normalized : undefined;
}

type BlsSeriesRow = { value?: string };
type BlsSeries = { seriesID?: string; data?: BlsSeriesRow[]; message?: string };
type BlsPayload = {
  status?: string;
  message?: string[];
  Results?: { series?: BlsSeries[] };
};

export function decodeWage(payload: BlsPayload, seriesID?: string): number | undefined {
  if (payload.status !== "REQUEST_SUCCEEDED") return undefined;
  const series = payload.Results?.series ?? [];
  const matches = seriesID
    ? series.filter((entry) => entry.seriesID?.toUpperCase() === seriesID.toUpperCase())
    : series;
  for (const entry of matches) {
    for (const row of entry.data ?? []) {
      const value = Number(row.value);
      if (Number.isFinite(value) && value > 0) return value;
    }
  }
  return undefined;
}

export function lookupIssue(payload: BlsPayload): WageLookupResponse["lookup_issue"] | undefined {
  if (payload.status !== "REQUEST_NOT_PROCESSED" && payload.status !== "REQUEST_FAILED") {
    return undefined;
  }
  const message = (payload.message ?? []).join(" ").toLowerCase();
  if (message.includes("threshold") || message.includes("limit")) {
    return "daily_limit_exceeded";
  }
  return "no_data";
}

export class BLSWageService {
  private readonly apiKey?: string;
  private readonly cache: PricingCache<number>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: {
    apiKey?: string;
    cache?: PricingCache<number>;
    fetchImpl?: typeof fetch;
  }) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.cache = options.cache ?? new PricingCache<number>(7 * 24 * 60 * 60 * 1000);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async lookup(request: WageLookupRequest): Promise<WageLookupResponse> {
    const fallback = Math.max(request.fallback, 0);
    const soc = normalizedSOC(request.soc_code);
    if (!soc) {
      return {
        hourly_wage: fallback,
        source: "template_fallback",
        live_lookup_attempted: Boolean(this.apiKey),
      };
    }

    if (!this.apiKey) {
      return {
        hourly_wage: fallback,
        source: "template_fallback",
        live_lookup_attempted: false,
      };
    }

    const state = request.state_code?.trim().toUpperCase();
    const candidates: Array<{ seriesID: string; wageState?: string }> = [];
    if (state && blsStateAreaByCode[state]) {
      candidates.push({
        seriesID: stateSeriesID(soc, blsStateAreaByCode[state]),
        wageState: state,
      });
    }
    candidates.push({ seriesID: nationalSeriesID(soc) });

    for (const candidate of candidates) {
      const cacheKey = `${candidate.wageState ?? "US"}:${candidate.seriesID}`;
      const cached = this.cache.get(cacheKey);
      if (cached !== undefined && cached > 0) {
        return {
          hourly_wage: cached,
          source: "bls_live",
          wage_state_code: candidate.wageState,
          live_lookup_attempted: true,
        };
      }
    }

    const uncached = candidates.filter((candidate) => {
      const cacheKey = `${candidate.wageState ?? "US"}:${candidate.seriesID}`;
      const cached = this.cache.get(cacheKey);
      return cached === undefined;
    });

    if (uncached.length > 0) {
      const year = new Date().getFullYear();
      const response = await this.fetchImpl(BLS_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          seriesid: uncached.map((candidate) => candidate.seriesID),
          startyear: String(year - 1),
          endyear: String(year),
          registrationkey: this.apiKey,
        }),
        signal: AbortSignal.timeout(15_000),
      });

      const payload = (await response.json()) as BlsPayload;
      const issue = lookupIssue(payload);
      if (issue) {
        return {
          hourly_wage: fallback,
          source: "template_fallback",
          live_lookup_attempted: true,
          lookup_issue: issue,
        };
      }

      for (const candidate of uncached) {
        const wage = decodeWage(payload, candidate.seriesID);
        if (!wage) continue;
        const cacheKey = `${candidate.wageState ?? "US"}:${candidate.seriesID}`;
        this.cache.set(cacheKey, wage);
        return {
          hourly_wage: wage,
          source: "bls_live",
          wage_state_code: candidate.wageState,
          live_lookup_attempted: true,
        };
      }
    }

    return {
      hourly_wage: fallback,
      source: "template_fallback",
      live_lookup_attempted: true,
      lookup_issue: "no_data",
    };
  }
}
