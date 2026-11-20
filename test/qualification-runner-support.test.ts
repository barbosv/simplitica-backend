import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { consumeClientSecret, qualificationFailureReason } from "../scripts/qualification/runner-support.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function secretFile(secret = "synthetic-private-secret\n", mode = 0o600) {
  const directory = await mkdtemp(join(tmpdir(), "qualification-secret-"));
  directories.push(directory);
  const path = join(directory, "secret");
  await writeFile(path, secret, { mode });
  await chmod(path, mode);
  return { directory, path };
}

it("consumes a protected owner-only secret file once and removes it before returning", async () => {
  const { path } = await secretFile();
  expect(await consumeClientSecret(path)).toBe("synthetic-private-secret");
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(consumeClientSecret(path)).rejects.toThrow();
});
it.each([0o644, 0o660])("rejects secret file permissions %s without consuming the input", async mode => {
  const { path } = await secretFile("synthetic-private-secret", mode);
  await expect(consumeClientSecret(path)).rejects.toThrow("secret_file_permissions");
  expect(await readFile(path, "utf8")).toBe("synthetic-private-secret");
});
it("refuses symlinks without consuming or reading their protected target", async () => {
  const { directory, path } = await secretFile();
  const link = join(directory, "link");
  await symlink(path, link);
  await expect(consumeClientSecret(link)).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe("synthetic-private-secret\n");
});
it.each(["", "a".repeat(4097)])("rejects an empty or oversized secret input", async value => {
  const { path } = await secretFile(value);
  await expect(consumeClientSecret(path)).rejects.toThrow();
});
it("reports only allowlisted runner failures without provider details or causes", () => {
  expect(qualificationFailureReason(new Error("native_proof_timeout"))).toBe("native_proof_timeout");
  expect(qualificationFailureReason(new Error("provider_request_failed", { cause: new Error("synthetic-private-secret") })))
    .toBe("provider_request_failed");
  expect(qualificationFailureReason(new Error("synthetic-private-secret-and-token"))).toBe("qualification_failed");
  expect(qualificationFailureReason({ message: "synthetic-private-identity" })).toBe("qualification_failed");
});
