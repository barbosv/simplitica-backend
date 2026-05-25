import { buildApp } from "./app.js";
import { readEnv } from "./env.js";

const env = readEnv();
const app = buildApp(env);

try {
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

