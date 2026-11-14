import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
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

it("propagates real client disconnects with the configured probe runtime flags", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qualification-disconnect-"));
  const root = resolve(import.meta.dirname, "..");
  const configuration = parse(await readFile(join(root, "wrangler.qualify.jsonc"), "utf8"));
  const port = await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Missing test port"));
      server.close(() => resolvePort(address.port));
    });
  });
  // Exercise the configured incoming-network feature directly: Wrangler's local proxy
  // adds another transport boundary that does not reliably forward client disconnects.
  await writeFile(join(directory, "worker.mjs"), `let outcome = 'idle';
export default { fetch(request, env, ctx) {
  if (new URL(request.url).pathname === '/state') return new Response(outcome);
  outcome = 'started';
  ctx.waitUntil(new Promise(resolve => {
    const timeout = setTimeout(() => resolve('no_event'), 1200);
    request.signal?.addEventListener('abort', () => { clearTimeout(timeout); resolve('observed'); }, { once: true });
  }).then(value => { outcome = value; }));
  return new Response(new ReadableStream({ async start(controller) {
    const deadline = Date.now() + 1600;
    while (Date.now() < deadline) {
      try { controller.enqueue(new Uint8Array([42])); } catch { return; }
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    controller.close();
  } }));
} };`);
  await writeFile(join(directory, "config.capnp"), `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "main", worker = (
    modules = [(name = "worker.mjs", esModule = embed "worker.mjs")],
    compatibilityDate = ${JSON.stringify(configuration.compatibility_date)},
    compatibilityFlags = ${JSON.stringify(configuration.compatibility_flags ?? [])}
  ))],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")]
);`);
  const child = spawn(join(root, "node_modules/.bin/workerd"), ["serve", "config.capnp"], { cwd: directory, stdio: "ignore" });
  const stopped = new Promise<void>(resolveStopped => { child.once("exit", () => resolveStopped()); });
  try {
    const state = async () => (await fetch(`http://127.0.0.1:${port}/state`, { signal: AbortSignal.timeout(500) })).text();
    const startupDeadline = Date.now() + 3000;
    let ready = false;
    while (Date.now() < startupDeadline) {
      if (child.exitCode !== null) throw new Error(`workerd exited ${child.exitCode}`);
      try { if (await state() === "idle") { ready = true; break; } } catch { /* Local runtime startup. */ }
      await new Promise(resolveWait => setTimeout(resolveWait, 25));
    }
    expect(ready).toBe(true);
    await new Promise<void>((resolveDisconnected, reject) => {
      const socket = connect(port, "127.0.0.1", () => socket.write(`GET /hold HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`));
      let received = Buffer.alloc(0);
      let streamed = false;
      socket.on("data", chunk => {
        received = Buffer.concat([received, chunk]);
        const headersEnd = received.indexOf("\r\n\r\n");
        if (headersEnd >= 0 && received.subarray(headersEnd + 4).includes(42)) {
          streamed = true;
          socket.destroy();
        }
      });
      socket.once("error", reject);
      socket.once("close", () => streamed ? resolveDisconnected() : reject(new Error("No streamed response bytes")));
      socket.setTimeout(1500, () => socket.destroy(new Error("Disconnect fixture did not stream")));
    });
    const observedDeadline = Date.now() + 2000;
    let outcome = "started";
    while (Date.now() < observedDeadline) {
      outcome = await state();
      if (outcome === "observed" || outcome === "no_event") break;
      await new Promise(resolveWait => setTimeout(resolveWait, 25));
    }
    expect(outcome).toBe("observed");
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await stopped;
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);
