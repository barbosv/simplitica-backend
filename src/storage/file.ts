import fs from "node:fs/promises";
import path from "node:path";
import type { SubscriptionRecord } from "../db/types.js";

type StoreShape = { subscriptions: SubscriptionRecord[] };
const defaultStore: StoreShape = { subscriptions: [] };
let storeLockTail: Promise<void> = Promise.resolve();

async function withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const prior = storeLockTail;
  let release!: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  storeLockTail = prior.then(() => next, () => next);
  await prior;
  try { return await fn(); } finally { release(); }
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
function storePath() { return path.join(dataDir(), "store.json"); }
async function ensureDir() { await fs.mkdir(path.dirname(storePath()), { recursive: true }); }
async function readStore(): Promise<StoreShape> {
  try { return JSON.parse(await fs.readFile(storePath(), "utf8")) as StoreShape; }
  catch { return defaultStore; }
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
    const idx = store.subscriptions.findIndex((s) =>
      s.appSlug === rec.appSlug && s.appAccountToken === rec.appAccountToken &&
      s.originalTransactionId === rec.originalTransactionId);
    if (idx >= 0) store.subscriptions[idx] = rec; else store.subscriptions.push(rec);
    return rec;
  });
}

export async function getEntitlement(appSlug: string, appAccountToken: string) {
  const store = await readStore();
  const subs = store.subscriptions
    .filter((s) => s.appSlug === appSlug && s.appAccountToken === appAccountToken)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return subs[0] ?? null;
}
