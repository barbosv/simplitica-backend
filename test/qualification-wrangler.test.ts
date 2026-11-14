import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "jsonc-parser";
import { expect, it } from "vitest";

it("starts the documented probe command without binding unrelated local secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qualification-wrangler-"));
  const port = await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Missing test port"));
      server.close(() => resolvePort(address.port));
    });
  });
  const root = resolve(import.meta.dirname, "..");
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const configuration = parse(await readFile(join(root, "wrangler.qualify.jsonc"), "utf8"));
  // Only synthetic configuration and a harmless sentinel enter this isolated directory.
  configuration.main = join(directory, "inspect.mjs");
  configuration.vars = {
    QUALIFY_ENVIRONMENT: "development", QUALIFY_ISSUER: "https://issuer.test/",
    QUALIFY_MCP_AUDIENCE: "https://probe.test/mcp", QUALIFY_APPLE_IDENTITY_CLAIM: "https://probe.test/apple",
    QUALIFY_CLIENT_ID: "synthetic-third-party-client", QUALIFY_PROBE_SCOPE: "probe:read",
  };
  await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module", scripts: { "dev:qualify": pkg.scripts["dev:qualify"] } }));
  await writeFile(join(directory, "wrangler.qualify.jsonc"), JSON.stringify(configuration));
  await writeFile(join(directory, ".dev.vars"), "UNRELATED_APPLICATION_SENTINEL=synthetic-only\n");
  await writeFile(join(directory, "inspect.mjs"), `import probe from ${JSON.stringify(join(root, "src/worker/qualification/index.ts"))};
export default { fetch(request, env) {
  if (new URL(request.url).pathname === '/__test_bindings') return Response.json({ sentinelBound: 'UNRELATED_APPLICATION_SENTINEL' in env });
  return probe.fetch(request, env);
} };`);
  const child = spawn("npm", ["run", "dev:qualify", "--", "--port", String(port)], {
    cwd: directory, env: { ...process.env, PATH: `${join(root, "node_modules/.bin")}:${process.env.PATH}`, WRANGLER_SEND_METRICS: "false" },
    stdio: "ignore", detached: true,
  });
  const stopped = new Promise<void>(resolveStopped => { child.once("exit", () => resolveStopped()); });
  try {
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 20_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Wrangler exited ${child.exitCode}`);
      try {
        const response = await fetch(`${base}/__test_bindings`);
        if (response.ok) { ready = true; break; }
      } catch { /* Wait for local workerd startup, without contacting an external service. */ }
      await new Promise(resolveWait => setTimeout(resolveWait, 50));
    }
    expect(ready).toBe(true);
    const bindings = await (await fetch(`${base}/__test_bindings`)).json();
    expect(bindings).toEqual({ sentinelBound: false });
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ready", probe: "synthetic-development" });
    const metadata = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({ resource: "https://probe.test/mcp", authorization_servers: ["https://issuer.test/"] });
  } finally {
    if (child.pid && child.exitCode === null) process.kill(-child.pid, "SIGTERM");
    await stopped;
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
