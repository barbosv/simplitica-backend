import type { ResponseBodyV2DecodedPayload } from "@apple/app-store-server-library";
import type { AppConfig } from "../apps.js";
import type { Env } from "../env.js";
import { buildSignedDataVerifier } from "./verifier.js";

export async function verifyNotificationForConfiguredApps(opts: {
  signedPayload: string;
  apps: AppConfig[];
  env: Env;
}): Promise<{ decoded: ResponseBodyV2DecodedPayload; app: AppConfig }> {
  let lastError: unknown;
  for (const app of opts.apps) {
    try {
      const verifier = buildSignedDataVerifier({
        app,
        environment: opts.env.APPLE_ENVIRONMENT,
        enableOnlineChecks: opts.env.NODE_ENV === "production",
      });
      const decoded = await verifier.verifyAndDecodeNotification(opts.signedPayload);
      return { decoded, app };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Unable to verify notification");
}
