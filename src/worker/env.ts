import { readEnv } from "../env.js";
import type { WorkerBindings } from "./bindings.js";

export function readWorkerEnv(bindings: WorkerBindings) {
  const strings = Object.fromEntries(
    Object.entries(bindings).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  return readEnv({
    ...strings,
    STORAGE_BACKEND: "d1",
    RUN_MIGRATIONS: "false",
  });
}
