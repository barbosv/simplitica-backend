import type { Env } from "../env.js";
import { getPool } from "./pool.js";
import { runMigrations } from "./migrate.js";
import { createPostgresRepositories } from "./repositories/postgres.js";
import { createMemoryRepositories } from "./repositories/memory.js";
import type { Repositories } from "./types.js";
import * as fileStorage from "../storage/file.js";

export type AppContext = {
  repos: Repositories;
  databaseUrl: string | null;
};

export async function createAppContext(env: Env): Promise<AppContext> {
  if (env.STORAGE_BACKEND === "file") {
    const memory = createMemoryRepositories();
    return {
      repos: {
        subscriptions: {
          upsert: fileStorage.upsertSubscription,
          getEntitlement: fileStorage.getEntitlement,
        },
        businesses: memory.businesses,
        invoicePayments: memory.invoicePayments,
        stripeEvents: memory.stripeEvents,
      },
      databaseUrl: null,
    };
  }

  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required when STORAGE_BACKEND=postgres");
  }

  const pool = getPool(env.DATABASE_URL);
  if (env.RUN_MIGRATIONS) {
    await runMigrations(pool);
  }

  return {
    repos: createPostgresRepositories(pool),
    databaseUrl: env.DATABASE_URL,
  };
}

export function createTestContext(repos?: Repositories): AppContext {
  return {
    repos: repos ?? createMemoryRepositories(),
    databaseUrl: null,
  };
}
