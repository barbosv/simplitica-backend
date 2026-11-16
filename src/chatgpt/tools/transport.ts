import { createMcpHandler, type McpServer } from "@modelcontextprotocol/server";
import { createCloudToolServer } from "./server.js";
import { requireRecordAuthority, type CloudRecordAuthority } from "../records/authority.js";
import { createStrictJSONParser } from "../json.js";

const requestLimit = 1_048_576;
const responseLimit = requestLimit + 65_536;
const parseRequest = createStrictJSONParser({ maximumBytes: requestLimit });
class BoundaryError extends Error {
  constructor(readonly status: number, readonly fixedCode: "invalid_input" | "storage_unavailable") { super(fixedCode); }
}
async function boundedBytes(body: ReadableStream<Uint8Array> | null, limit: number, timeout: number, signal?: AbortSignal) {
  if (!body) return new Uint8Array();
  const reader = body.getReader(), chunks: Uint8Array[] = [];
  let size = 0, done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new BoundaryError(408, "invalid_input")), timeout);
    onAbort = () => reject(new BoundaryError(499, "invalid_input"));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
  try {
    await Promise.race([interrupted, (async () => {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) { done = true; break; }
        size += chunk.value.byteLength;
        if (size > limit) throw new BoundaryError(413, "invalid_input");
        chunks.push(chunk.value);
      }
    })()]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    if (!done) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const correlationId = (value: unknown) => object(value) && (typeof value.id === "string" || (typeof value.id === "number" && Number.isFinite(value.id))) ? value.id : null;
function protocolError(status: number, id: string | number | null, message: "invalid_input" | "storage_unavailable", code = message === "invalid_input" ? -32600 : -32603) {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { status, headers: { "cache-control": "no-store" } });
}
function cleanProtocolError(value: unknown) {
  if (!object(value) || !Object.hasOwn(value, "error")) return null;
  const code = object(value.error) && typeof value.error.code === "number" && Number.isSafeInteger(value.error.code) ? value.error.code : -32603;
  const message = [-32700, -32600, -32601, -32602].includes(code) ? "invalid_input" : "storage_unavailable";
  return { jsonrpc: "2.0", id: correlationId(value), error: { code, message } };
}
/** Internal finite-response parser; never accept open-ended notification streams. */
export function normalizeFiniteSSE(source: string): string {
  const text = source.replaceAll("\r\n", "\n");
  if (!text.endsWith("\n\n")) throw new Error("invalid_response");
  let foundData = false;
  const frames = text.split("\n\n").map(frame => {
    const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data) return frame;
    foundData = true;
    const error = cleanProtocolError(JSON.parse(data));
    return error ? `event: message\ndata: ${JSON.stringify(error)}` : frame;
  });
  if (!foundData) throw new Error("invalid_response");
  return frames.join("\n\n");
}

/** Internal stateless facade. Public entries must use this, not the bare SDK handler. */
export function createCloudToolTransport(factory: () => McpServer) {
  return { async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      const response = protocolError(405, null, "invalid_input");
      response.headers.set("allow", "POST");
      return response;
    }
    let parsedBody: unknown;
    try {
      const length = request.headers.get("content-length");
      if (length && (!/^\d+$/.test(length) || Number(length) > requestLimit)) throw new BoundaryError(413, "invalid_input");
      parsedBody = parseRequest(await boundedBytes(request.body, requestLimit, 2000, request.signal));
      // MCP does not expose JSON-RPC batching; avoid mixed unsanitized SDK envelopes.
      if (!object(parsedBody) || parsedBody.jsonrpc !== "2.0" || typeof parsedBody.method !== "string") throw new BoundaryError(400, "invalid_input");
      // The SDK's era router consults initialize.protocolVersion before its
      // protocol validator; reject invalid routing types before entering it.
      if (parsedBody.method === "initialize" && (!object(parsedBody.params) || typeof parsedBody.params.protocolVersion !== "string")) throw new BoundaryError(400, "invalid_input");
    } catch (error) {
      return protocolError(error instanceof BoundaryError ? error.status : 400, correlationId(parsedBody), "invalid_input", error instanceof BoundaryError ? -32600 : -32700);
    }
    if (request.signal.aborted) return protocolError(499, correlationId(parsedBody), "invalid_input");
    try {
      const sdk = createMcpHandler(factory, { responseMode: "json", maxSubscriptions: 0, keepAliveMs: 0, maxRequestBodySize: requestLimit });
      const response = await sdk.fetch(request, { parsedBody });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        return protocolError(response.status, correlationId(parsedBody), response.status >= 500 ? "storage_unavailable" : "invalid_input");
      }
      const headers = new Headers(response.headers);
      headers.set("cache-control", "no-store");
      headers.delete("content-length");
      const bytes = await boundedBytes(response.body, responseLimit, 10_000, request.signal);
      if (response.status === 202 || response.status === 204) return new Response(null, { status: response.status, headers });
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      const contentType = headers.get("content-type")?.split(";")[0].trim();
      if (contentType === "application/json") {
        const error = cleanProtocolError(JSON.parse(text));
        return new Response(error ? JSON.stringify(error) : bytes, { status: response.status, headers });
      }
      if (contentType === "text/event-stream") {
        return new Response(normalizeFiniteSSE(text), { status: response.status, headers });
      }
      throw new Error("invalid_response");
    } catch {
      return protocolError(503, correlationId(parsedBody), "storage_unavailable");
    }
  } };
}
export function createCloudToolHandler(db: D1Database, dependencies: { authorizationNamespace: string; now?: () => number }, authority: CloudRecordAuthority) {
  requireRecordAuthority(authority, dependencies.authorizationNamespace);
  return createCloudToolTransport(() => createCloudToolServer(db, dependencies, authority));
}
