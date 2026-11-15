import { verifyAttestationFacts } from "./facts";
import { verifyAssertionFacts } from "./assertions";
import type { AttestationContext, AttestationAdmissionPolicy, AssertionInput, AttestedDevice } from "./types";

/**
 * The only admission boundary future enrollment services may import. Internal
 * facts helpers deliberately accept legacy extension-free cryptographic evidence.
 * This wrapper still grants no command authority: canonical action/challenge and
 * owner/session/revision/purchase binding plus atomic consumption remain required.
 *
 * Assertion extension encoding/flags are provisional until fresh paired-device
 * qualification. Select the previously attested device record for this captured
 * environment before verifying; assertion bytes contain no environment marker.
 */
export function createAttestationAdmission(context: AttestationContext, policy: AttestationAdmissionPolicy) {
  if (!context || typeof context.teamId !== "string" || !/^[A-Z0-9]{10}$/.test(context.teamId) ||
      typeof context.bundleId !== "string" || context.bundleId.length > 255 ||
      !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(context.bundleId) ||
      (context.environment !== "development" && context.environment !== "production") ||
      !policy || !Array.isArray(policy.validationCategories) || !policy.validationCategories.length ||
      !Array.isArray(policy.bundleVersions) || !policy.bundleVersions.length) {
    throw new Error("invalid_configuration");
  }
  const validationCategories = new Set(policy.validationCategories);
  const bundleVersions = new Set(policy.bundleVersions);
  if (validationCategories.size !== policy.validationCategories.length || bundleVersions.size !== policy.bundleVersions.length) {
    throw new Error("invalid_configuration");
  }
  for (const category of validationCategories) {
    if (!Number.isInteger(category) || ![2, 3, 4].includes(category)) throw new Error("invalid_configuration");
  }
  for (const version of bundleVersions) {
    if (typeof version !== "string" || !version.length || Buffer.byteLength(version, "utf8") > 128 ||
        Buffer.from(version, "utf8").toString("utf8") !== version) throw new Error("invalid_configuration");
  }
  // Private copies cannot be broadened by mutating caller-owned arrays/context.
  const trustedContext = Object.freeze({ teamId: context.teamId, bundleId: context.bundleId, environment: context.environment });
  const allows = (category: unknown, version: unknown): boolean =>
    typeof category === "number" && validationCategories.has(category) &&
    typeof version === "string" && bundleVersions.has(version);
  return Object.freeze({
    async verifyAttestation(input: Parameters<typeof verifyAttestationFacts>[0]) {
      const facts = await verifyAttestationFacts(input, trustedContext);
      return facts && allows(facts.extensions.validationCategory, facts.extensions.bundleVersion) ? facts : null;
    },
    async verifyAssertion(input: AssertionInput, device: AttestedDevice) {
      const facts = await verifyAssertionFacts(input, device, trustedContext);
      return facts && allows(facts.extensions.get("validationCategory"), facts.extensions.get("bundleVersion")) ? facts : null;
    },
  });
}
