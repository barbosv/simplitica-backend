import { createServer } from "node:http";

export async function nativeProofReceiver(hostedIdentity: string, verify: (token: string) => Promise<string>,
  timeoutMs = 600_000, port = 8793): Promise<{ url: string; qualified: Promise<void>; close: () => Promise<void> }> {
  if (!hostedIdentity.trim() || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("invalid_native_proof_configuration");
  let resolveProof!: () => void, rejectProof!: (error: Error) => void;
  let consumed = false, verifying = false;
  const qualified = new Promise<void>((resolve, reject) => { resolveProof = resolve; rejectProof = reject; });
  void qualified.catch(() => undefined);
  const timer = setTimeout(() => { consumed = true; rejectProof(new Error("native_proof_timeout")); }, timeoutMs);
  const server = createServer({ maxHeaderSize: 16_384, requestTimeout: 10_000 }, async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Connection", "close");
    const reject = (status: number) => { response.writeHead(status); response.end('{"qualified":false}'); };
    const address = server.address();
    if (!address || typeof address === "string" || request.headers.host !== `127.0.0.1:${address.port}`) return reject(400);
    // Exact request-target comparison avoids parsing/echoing any attacker-controlled URL.
    if (request.url !== "/native-proof") return reject(404);
    if (request.method !== "POST") { response.setHeader("Allow", "POST"); return reject(405); }
    if (request.headers.origin || request.headers["transfer-encoding"]
      || (request.headers["content-length"] && request.headers["content-length"] !== "0")) return reject(400);
    if (consumed || verifying) return reject(409);
    const authorization = request.headers.authorization;
    if (!authorization || !/^Bearer [^\s]+$/.test(authorization) || authorization.length > 12_000) return reject(401);
    verifying = true;
    try {
      const nativeIdentity = await verify(authorization.slice(7));
      if (consumed) return reject(409);
      if (nativeIdentity !== hostedIdentity) return reject(403);
      consumed = true;
      clearTimeout(timer);
      resolveProof();
      response.end('{"qualified":true}');
    } catch { reject(401); }
    finally { verifying = false; }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
    });
  } catch { clearTimeout(timer); throw new Error("native_proof_listen_failed"); }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("native_proof_listen_failed");
  return { url: `http://127.0.0.1:${address.port}/native-proof`, qualified,
    close: async () => {
      clearTimeout(timer);
      if (!consumed) { consumed = true; rejectProof(new Error("native_proof_closed")); }
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } };
}
