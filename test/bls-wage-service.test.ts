import { describe, expect, it } from "vitest";
import {
  BLSWageService,
  decodeWage,
  lookupIssue,
  nationalSeriesID,
  stateSeriesID,
} from "../src/pricing/bls-wage-service.js";

describe("bls-wage-service", () => {
  it("builds 25-char OEWS series ids", () => {
    expect(nationalSeriesID("472031")).toHaveLength(25);
    expect(nationalSeriesID("472031")).toBe("OEUN000000000000047203103");
    expect(stateSeriesID("472031", "1300000")).toBe("OEUS130000000000047203103");
  });

  it("decodes REQUEST_SUCCEEDED payloads", () => {
    const payload = {
      status: "REQUEST_SUCCEEDED",
      Results: {
        series: [
          {
            seriesID: "OEUS130000000000047203103",
            data: [{ value: "24.50" }],
          },
        ],
      },
    };
    expect(decodeWage(payload, "OEUS130000000000047203103")).toBe(24.5);
  });

  it("detects daily limit responses", () => {
    const payload = {
      status: "REQUEST_NOT_PROCESSED",
      message: ["daily threshold for total number of requests allocated to the user has been reached."],
      Results: {},
    };
    expect(lookupIssue(payload)).toBe("daily_limit_exceeded");
  });

  it("returns live wage from stubbed BLS API", async () => {
    const service = new BLSWageService({
      apiKey: "test-key",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            status: "REQUEST_SUCCEEDED",
            Results: {
              series: [
                {
                  seriesID: "OEUS130000000000047203103",
                  data: [{ value: "26.75" }],
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    });

    const result = await service.lookup({
      soc_code: "47-2031",
      state_code: "GA",
      fallback: 24,
    });
    expect(result).toMatchObject({
      hourly_wage: 26.75,
      source: "bls_live",
      wage_state_code: "GA",
      live_lookup_attempted: true,
    });
  });

  it("falls back when API key is missing", async () => {
    const service = new BLSWageService({ apiKey: undefined });
    const result = await service.lookup({
      soc_code: "47-2031",
      state_code: "GA",
      fallback: 24,
    });
    expect(result).toMatchObject({
      hourly_wage: 24,
      source: "template_fallback",
      live_lookup_attempted: false,
    });
  });
});
