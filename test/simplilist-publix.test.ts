import { describe, expect, it } from "vitest";
import { isBOGOPromoText } from "../src/simplilist/publix-weekly-ad.js";

describe("isBOGOPromoText", () => {
  it("matches common Publix BOGO phrases", () => {
    expect(isBOGOPromoText("Buy One Get One Free")).toBe(true);
    expect(isBOGOPromoText("BOGO")).toBe(true);
    expect(isBOGOPromoText("Buy 1 Get 1 Free")).toBe(true);
    expect(isBOGOPromoText("B1G1")).toBe(true);
    expect(isBOGOPromoText("Buy 2 Get 1 Free")).toBe(true);
  });

  it("rejects non-BOGO promos", () => {
    expect(isBOGOPromoText("Save $2.00")).toBe(false);
    expect(isBOGOPromoText("On Sale")).toBe(false);
    expect(isBOGOPromoText("")).toBe(false);
  });
});
