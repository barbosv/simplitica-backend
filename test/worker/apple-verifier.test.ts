import { afterEach, describe, expect, it, vi } from "vitest";
import { sign, X509Certificate } from "node:crypto";
import {
  Environment,
  SignedDataVerifier,
} from "@apple/app-store-server-library";
import roots from "./fixtures/apple-root.json";
import chain from "./fixtures/apple-chain.json";

function signed(payload: object) {
  const header = Buffer.from(
    JSON.stringify({
      alg: "ES256",
      x5c: [chain.leaf, chain.intermediate, chain.root],
    }),
  ).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const input = `${header}.${body}`;
  return `${input}.${sign("sha256", Buffer.from(input), { key: chain.leafKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

function verifier(
  online = false,
  bundleId = "co.simplitica.simpli-invoice",
  environment = Environment.PRODUCTION,
) {
  return new SignedDataVerifier(
    [Buffer.from(chain.root, "base64")],
    online,
    environment,
    bundleId,
    123456789,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Apple verifier runtime compatibility", () => {
  it("supports the certificate-chain signature check used by Apple's verifier", () => {
    const root = new X509Certificate(Buffer.from(roots.g3, "base64"));
    expect(root.verify(root.publicKey)).toBe(true);
  });

  it("constructs Apple's real verifier with bundled trust roots and rejects unsigned data", async () => {
    const verifier = new SignedDataVerifier(
      [Buffer.from(roots.g3, "base64")],
      true,
      Environment.PRODUCTION,
      "co.simplitica.simpli-invoice",
      123456789,
    );
    await expect(
      verifier.verifyAndDecodeTransaction("invalid.invalid.invalid"),
    ).rejects.toThrow();
  });

  const transaction = {
    bundleId: "co.simplitica.simpli-invoice",
    environment: "Production",
    productId: "monthly",
    originalTransactionId: "123",
    signedDate: chain.signedDate,
  };
  it("verifies a trusted signed transaction using the real certificate chain", async () => {
    await expect(
      verifier().verifyAndDecodeTransaction(signed(transaction)),
    ).resolves.toMatchObject({ productId: "monthly" });
  });
  it("rejects wrong app, wrong environment, untrusted root, and tampered signatures", async () => {
    const jwt = signed(transaction);
    await expect(
      verifier(false, "wrong.app").verifyAndDecodeTransaction(jwt),
    ).rejects.toMatchObject({ status: 3 });
    await expect(
      verifier(
        false,
        transaction.bundleId,
        Environment.SANDBOX,
      ).verifyAndDecodeTransaction(jwt),
    ).rejects.toMatchObject({ status: 4 });
    const untrusted = new SignedDataVerifier(
      [Buffer.from(roots.g3, "base64")],
      false,
      Environment.PRODUCTION,
      transaction.bundleId,
      123456789,
    );
    await expect(untrusted.verifyAndDecodeTransaction(jwt)).rejects.toThrow();
    await expect(
      verifier().verifyAndDecodeTransaction(jwt.slice(0, -8) + "AAAAAAAA"),
    ).rejects.toThrow();
  });
  it("verifies signed renewals and notifications with app identity checks", async () => {
    await expect(
      verifier().verifyAndDecodeRenewalInfo(
        signed({ environment: "Production", signedDate: chain.signedDate }),
      ),
    ).resolves.toMatchObject({ environment: "Production" });
    const notification = {
      signedDate: chain.signedDate,
      data: {
        bundleId: transaction.bundleId,
        appAppleId: 123456789,
        environment: "Production",
        signedTransactionInfo: signed(transaction),
      },
    };
    await expect(
      verifier().verifyAndDecodeNotification(signed(notification)),
    ).resolves.toMatchObject({ data: { appAppleId: 123456789 } });
    await expect(
      verifier(false, "wrong.app").verifyAndDecodeNotification(
        signed(notification),
      ),
    ).rejects.toMatchObject({ status: 3 });
  });
  it("verifies production OCSP responses in workerd and rejects online failures", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(chain.signedDate);
    await expect(
      verifier(true).verifyAndDecodeTransaction(signed(transaction)),
    ).resolves.toMatchObject({ productId: "monthly" });
    await expect(
      verifier(true).verifyAndDecodeTransaction(signed(transaction)),
    ).rejects.toMatchObject({ status: 2 });
  });
  it("rejects expired chains with production checks enabled", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2046-01-01");
    await expect(
      verifier(true).verifyAndDecodeTransaction(signed(transaction)),
    ).rejects.toMatchObject({ status: 6 });
  });
});
