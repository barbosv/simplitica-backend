import fs from "node:fs";
import path from "node:path";
import { Environment, SignedDataVerifier } from "@apple/app-store-server-library";
import type { AppConfig } from "../apps.js";

function loadRootCerts(): Buffer[] {
  const certDir = path.join(process.cwd(), "certs");
  const g2 = fs.readFileSync(path.join(certDir, "AppleRootCA-G2.cer"));
  const g3 = fs.readFileSync(path.join(certDir, "AppleRootCA-G3.cer"));
  return [g2, g3];
}

export function buildSignedDataVerifier(opts: {
  app: AppConfig;
  environment: "Sandbox" | "Production";
  enableOnlineChecks: boolean;
}) {
  const env =
    opts.environment === "Production" ? Environment.PRODUCTION : Environment.SANDBOX;

  return new SignedDataVerifier(
    loadRootCerts(),
    opts.enableOnlineChecks,
    env,
    opts.app.bundleId,
    opts.environment === "Sandbox" ? undefined : opts.app.appAppleId,
  );
}

