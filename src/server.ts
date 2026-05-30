import { buildApp } from "./app.js";
import { readEnv } from "./env.js";
import { createAppContext } from "./db/context.js";
import { closePool } from "./db/pool.js";

const env = readEnv();
const ctx = await createAppContext(env);
const app = buildApp({ env, ctx });

async function shutdown(signal: string) {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await closePool();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

try {
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
