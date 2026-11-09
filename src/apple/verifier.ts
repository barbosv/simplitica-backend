import { appleRootCertificates } from "./root-certificates.js";
import {
  Environment,
  SignedDataVerifier,
} from "@apple/app-store-server-library";
import type { AppConfig } from "../apps.js";

export function buildSignedDataVerifier(opts: {
  app: AppConfig;
  environment: "Sandbox" | "Production";
  enableOnlineChecks: boolean;
}) {
  const env =
    opts.environment === "Production"
      ? Environment.PRODUCTION
      : Environment.SANDBOX;

  return new SignedDataVerifier(
    appleRootCertificates.map((cert) => Buffer.from(cert, "base64")),
    opts.enableOnlineChecks,
    env,
    opts.app.bundleId,
    opts.environment === "Sandbox" ? undefined : opts.app.appAppleId,
  );
}
