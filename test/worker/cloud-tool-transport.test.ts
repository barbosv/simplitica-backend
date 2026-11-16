import { beforeEach, expect, it } from "vitest";
import { createCloudToolHandler } from "../../src/chatgpt/tools/transport.js";
import { createStrictJSONParser, parseStrictJSON } from "../../src/chatgpt/json.js";
import { env, namespace, reset, setup, start } from "./cloud-record-fixtures.js";

beforeEach(reset);
const deps = { authorizationNamespace: namespace, now: () => start };
function request(body: string | Uint8Array, headers: Record<string, string> = {}) {
  return new Request("https://test.invalid/mcp", { method: "POST", body, headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25", ...headers } });
}
async function decoded(response: Response) {
  const text = await response.text();
  return JSON.parse(text.startsWith("event:") ? text.split("\n").find(line => line.startsWith("data: "))!.slice(6) : text);
}
it.each([{ name: 42, arguments: {} }, { name: "get_business_context", arguments: "sentinel-secret" }])("sanitizes pre-dispatch protocol envelope failures %#", async params => {
  const { authority } = await setup();
  const result = await decoded(await createCloudToolHandler(env.DB, deps, authority).fetch(request(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params }))));
  expect(result).toMatchObject({ jsonrpc: "2.0", id: 1, error: { message: "invalid_input" } });
  expect(JSON.stringify(result)).not.toMatch(/sentinel|Zod|Invalid tools\/call|expected|issues/);
});
it("does not echo unsupported protocol headers", async () => {
  const { authority } = await setup();
  const response = await createCloudToolHandler(env.DB, deps, authority).fetch(request(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), { "mcp-protocol-version": "sentinel-secret" }));
  expect(response.status).toBe(400);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const result = await decoded(response);
  expect(result.error.message).toBe("invalid_input");
  expect(JSON.stringify(result)).not.toContain("sentinel-secret");
});
it("rejects ambiguous raw customer JSON before any mutation", async () => {
  const { authority } = await setup();
  const body = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_customer","arguments":{"operationKey":"duplicate","expectedRevision":0,"value":{"name":"A","\\u006eame":"B","billingAddressLines":[],"savedJobSites":[]}}}}';
  const response = await createCloudToolHandler(env.DB, deps, authority).fetch(request(body));
  expect(response.status).toBe(400);
  expect((await decoded(response)).error.message).toBe("invalid_input");
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_customers").first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_mutation_receipts").first("n")).toBe(0);
});
it.each([
  new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]),
  new Uint8Array([0xc3, 0x28]),
  new TextEncoder().encode("[".repeat(17) + "0" + "]".repeat(17)),
  new TextEncoder().encode(" ".repeat(1_048_577)),
])("rejects invalid or over-limit raw ingress %#", async bytes => {
  const { authority } = await setup();
  const response = await createCloudToolHandler(env.DB, deps, authority).fetch(request(bytes));
  expect([400, 413]).toContain(response.status);
  expect((await decoded(response)).error.message).toBe("invalid_input");
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_mutation_receipts").first("n")).toBe(0);
});
it("preserves default calculator bounds while trusted ingress allows larger bodies", () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ value: "x".repeat(70_000) }));
  expect(() => parseStrictJSON(bytes)).toThrow("invalid_json");
  const config = { maximumBytes: 1_048_576 };
  const parse = createStrictJSONParser(config);
  config.maximumBytes = 1;
  expect(parse(bytes)).toEqual({ value: "x".repeat(70_000) });
  for (const maximumBytes of [0, -1, Infinity, 1_048_577, 1.5]) expect(() => createStrictJSONParser({ maximumBytes })).toThrow("invalid_configuration");
});
it("rejects invalid declared lengths and unsupported methods", async () => {
  const { authority } = await setup();
  const handler = createCloudToolHandler(env.DB, deps, authority);
  for (const length of ["1048577", "invalid"]) {
    const response = await handler.fetch(request("{}", { "content-length": length }));
    expect(response.status).toBe(413);
    expect((await decoded(response)).error.message).toBe("invalid_input");
  }
  const response = await handler.fetch(new Request("https://test.invalid/mcp"));
  expect(response.status).toBe(405);
  expect(response.headers.get("allow")).toBe("POST");
});
it.each(["abort", "timeout"])("bounds incomplete upload with a stalled cancel: %s", async mode => {
  const { authority } = await setup();
  const controller = new AbortController();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(stream) { stream.enqueue(new TextEncoder().encode('{"jsonrpc":')); },
    cancel() { cancelled = true; return new Promise<void>(() => {}); },
  });
  const pending = createCloudToolHandler(env.DB, deps, authority).fetch(new Request("https://test.invalid/mcp", { method: "POST", body, signal: controller.signal }));
  if (mode === "abort") controller.abort();
  const response = await pending;
  expect(response.status).toBe(mode === "abort" ? 499 : 408);
  expect((await decoded(response)).error.message).toBe("invalid_input");
  expect(cancelled).toBe(true);
});
it.each(["2025-11-25", "2025-06-18"])("preserves legacy initialize and tools success for protocol %s", async protocolVersion => {
  const { authority } = await setup();
  const handler = createCloudToolHandler(env.DB, deps, authority);
  const initialized = await decoded(await handler.fetch(request(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion, capabilities: {}, clientInfo: { name: "transport-test", version: "1" } } }), { "mcp-protocol-version": protocolVersion })));
  expect(initialized.result.serverInfo.name).toBe("simplitica-cloud-tools");
  const response = await handler.fetch(request(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }), { "mcp-protocol-version": protocolVersion }));
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect((await decoded(response)).result.tools).toHaveLength(12);
});
it("sanitizes unknown methods and protocol validation errors", async () => {
  const { authority } = await setup();
  const handler = createCloudToolHandler(env.DB, deps, authority);
  for (const body of [
    { jsonrpc: "2.0", id: 9, method: "sentinel-secret" },
    { jsonrpc: "2.0", id: 9, method: "initialize", params: { protocolVersion: 42, capabilities: "sentinel-secret" } },
    [{ jsonrpc: "2.0", id: 9, method: "sentinel-secret" }],
  ]) {
    const response = await handler.fetch(request(JSON.stringify(body)));
    const result = await decoded(response);
    expect(result.error.message).toBe("invalid_input");
    expect(JSON.stringify(result)).not.toMatch(/sentinel|Zod|expected|issues/);
  }
});
