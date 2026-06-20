import type { Env } from "../env.js";

export function simplilistProProductIDs(env: Env): Set<string> {
  return new Set(
    env.SIMPLILIST_PRO_PRODUCT_IDS.split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}
