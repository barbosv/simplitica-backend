export type WorkerBindings = { DB: D1Database } & {
  [name: string]: string | D1Database | undefined;
};
