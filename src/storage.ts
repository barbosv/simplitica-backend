import fs from "node:fs/promises";
import path from "node:path";

export type EntitlementState =
  | "unknown"
  | "inactive"
  | "trial"
  | "active"
  | "gracePeriod";

export type SubscriptionRecord = {
  appSlug: string;
  appAccountToken: string; // UUID
  originalTransactionId: string;
  productId: string;
  state: EntitlementState;
  expiresAt?: string; // ISO
  environment?: string;
  latestSignedTransactionInfo?: string;
  latestSignedRenewalInfo?: string;
  updatedAt: string; // ISO
};

type StoreShape = {
  subscriptions: SubscriptionRecord[];
};

const defaultStore: StoreShape = { subscriptions: [] };

// In-process mutex to serialize read-modify-write updates to the store file.
// This prevents concurrent requests (e.g. webhook + client sync) from clobbering
// each other's updates when they overlap in time.
let storeLockTail: Promise<void> = Promise.resolve();

async function withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const prior = storeLockTail;
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });

  // Ensure the chain continues even if a prior holder throws.
  storeLockTail = prior.then(
    () => next,
    () => next,
  );

  await prior;
  try {
    return await fn();
  } finally {
    release();
  }
}

async function updateStore<T>(mutate: (store: StoreShape) => Promise<T> | T): Promise<T> {
  return withStoreLock(async () => {
    const store = await readStore();
    const result = await mutate(store);
    await writeStore(store);
    return result;
  });
}

function dataDir() {
  return process.env.DATA_DIR?.trim() ? process.env.DATA_DIR.trim() : path.join(process.cwd(), "data");
}

function storePath() {
  return path.join(dataDir(), "store.json");
}

async function ensureDir() {
  await fs.mkdir(path.dirname(storePath()), { recursive: true });
}

async function readStore(): Promise<StoreShape> {
  try {
    const raw = await fs.readFile(storePath(), "utf8");
    return JSON.parse(raw) as StoreShape;
  } catch {
    return defaultStore;
  }
}

async function writeStore(store: StoreShape) {
  await ensureDir();
  const tmp = storePath() + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
  await fs.rename(tmp, storePath());
}

export async function upsertSubscription(next: Omit<SubscriptionRecord, "updatedAt">) {
  const updatedAt = new Date().toISOString();
  const rec: SubscriptionRecord = { ...next, updatedAt };

  return updateStore((store) => {
    const idx = store.subscriptions.findIndex(
      (s) =>
        s.appSlug === rec.appSlug &&
        s.appAccountToken === rec.appAccountToken &&
        s.originalTransactionId === rec.originalTransactionId,
    );

    if (idx >= 0) store.subscriptions[idx] = rec;
    else store.subscriptions.push(rec);

    return rec;
  });
}

export async function getEntitlement(appSlug: string, appAccountToken: string) {
  const store = await readStore();
  const subs = store.subscriptions
    .filter((s) => s.appSlug === appSlug && s.appAccountToken === appAccountToken)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));

  const best = subs[0];
  return best ?? null;
}

