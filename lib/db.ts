// env.DB is D1-shaped but backed by MySQL, so stick to SQL both dialects accept.

export type DB = {
  prepare(sql: string): { bind(...v: unknown[]): Stmt } & Stmt;
};
type Stmt = { all<T = any>(): Promise<{ results: T[] }>; run(): Promise<unknown> };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS followers (
    actor VARCHAR(500) NOT NULL PRIMARY KEY,
    inbox VARCHAR(1000) NOT NULL,
    shared_inbox VARCHAR(1000),
    handle VARCHAR(300),
    created_at VARCHAR(40) NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS deliveries (
    note_id VARCHAR(200) NOT NULL PRIMARY KEY,
    hash VARCHAR(100) NOT NULL,
    status VARCHAR(20) NOT NULL,
    detail TEXT,
    updated_at VARCHAR(40) NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS interactions (
    id VARCHAR(500) NOT NULL PRIMARY KEY,
    note_id VARCHAR(200) NOT NULL,
    kind VARCHAR(20) NOT NULL,
    actor VARCHAR(500) NOT NULL,
    handle VARCHAR(300),
    url VARCHAR(1000),
    content TEXT,
    created_at VARCHAR(40) NOT NULL
  )`,
];

let ready: Promise<void> | null = null;

export function ensureSchema(db: DB) {
  ready ??= (async () => {
    for (const sql of SCHEMA) await db.prepare(sql).run();
  })().catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}

export async function all<T = any>(db: DB, sql: string, ...args: unknown[]) {
  return (await db.prepare(sql).bind(...args).all<T>()).results ?? [];
}

export async function run(db: DB, sql: string, ...args: unknown[]) {
  await db.prepare(sql).bind(...args).run();
}

/** INSERT that reports false instead of throwing when the key already exists. */
export async function tryInsert(db: DB, sql: string, ...args: unknown[]) {
  try {
    await run(db, sql, ...args);
    return true;
  } catch (e) {
    if (/duplicate|unique|constraint/i.test(String(e))) return false;
    throw e;
  }
}
