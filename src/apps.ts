import type { Env } from "./env.js";

export type AppConfig = {
  slug: string;
  bundleId: string;
  appAppleId?: number;
};

export type AppsRegistry = {
  bySlug: Record<string, AppConfig>;
  byBundleId: Record<string, AppConfig>;
  list: AppConfig[];
};

export function buildAppsRegistry(env: Env): AppsRegistry {
  const list: AppConfig[] = [
    {
      slug: "simpli-invoice",
      bundleId: env.SIMPLI_INVOICE_BUNDLE_ID,
      appAppleId: env.SIMPLI_INVOICE_APP_APPLE_ID,
    },
  ];

  const bySlug: Record<string, AppConfig> = {};
  const byBundleId: Record<string, AppConfig> = {};
  for (const app of list) {
    bySlug[app.slug] = app;
    byBundleId[app.bundleId] = app;
  }

  return { bySlug, byBundleId, list };
}
