import type { Context, Hono } from "hono";
import type {
  ApiHandler,
  ApiReply,
  ApiRequest,
  ApiRouteOptions,
  ApiRouter,
} from "../http.js";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function readBoundedBody(
  request: Request,
  maxBytes = 262144,
): Promise<Uint8Array> {
  if (Number(request.headers.get("Content-Length")) > maxBytes)
    throw new HttpError(413, "Request body is too large");
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new HttpError(413, "Request body is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export class FetchReply implements ApiReply {
  status = 200;
  contentType = "application/json; charset=utf-8";
  response?: Response;
  code(status: number) {
    this.status = status;
    return this;
  }
  type(contentType: string) {
    this.contentType = contentType;
    return this;
  }
  send(body: unknown) {
    this.response = new Response(
      this.contentType.startsWith("application/json")
        ? JSON.stringify(body)
        : String(body),
      { status: this.status, headers: { "Content-Type": this.contentType } },
    );
    return this.response;
  }
}

export function routeAdapter(app: Hono, before?: ApiHandler): ApiRouter {
  function register(
    method: string,
    path: string,
    optionsOrHandler: ApiRouteOptions | ApiHandler,
    handler?: ApiHandler,
  ) {
    const options =
      typeof optionsOrHandler === "function" ? {} : optionsOrHandler;
    const action =
      typeof optionsOrHandler === "function" ? optionsOrHandler : handler!;
    app.on(method, path, async (c: Context) => {
      const reply = new FetchReply();
      // Log only the fixed operation label; SDK error objects may contain secrets.
      const log = {
        error: (_info: unknown, message?: string) =>
          console.error(message ?? "API operation failed"),
        warn: (_info: unknown, message?: string) =>
          console.warn(message ?? "API operation warning"),
      };
      const req: ApiRequest = {
        headers: Object.fromEntries(c.req.raw.headers),
        params: c.req.param(),
        query: c.req.query(),
        body: undefined,
        ip: c.req.header("CF-Connecting-IP") ?? "unknown",
        log,
      };
      for (const hook of [before, ...(options.onRequest ?? [])]) {
        if (hook) await hook(req, reply);
        if (reply.response) return reply.response;
      }
      if (!["GET", "HEAD"].includes(method)) {
        const raw = await readBoundedBody(c.req.raw);
        req.rawBody = Buffer.from(raw);
        if (raw.length) {
          if (
            !c.req
              .header("Content-Type")
              ?.toLowerCase()
              .startsWith("application/json")
          )
            return c.json({ error: "Unsupported Media Type" }, 415);
          try {
            req.body = JSON.parse(new TextDecoder().decode(raw));
          } catch {
            return c.json({ error: "Invalid JSON" }, 400);
          }
        }
      }
      const result = await action(req, reply);
      return reply.response ?? reply.send(result ?? null);
    });
  }
  return {
    get: (
      path: string,
      options: ApiRouteOptions | ApiHandler,
      handler?: ApiHandler,
    ) => register("GET", path, options, handler),
    post: (
      path: string,
      options: ApiRouteOptions | ApiHandler,
      handler?: ApiHandler,
    ) => register("POST", path, options, handler),
  };
}
