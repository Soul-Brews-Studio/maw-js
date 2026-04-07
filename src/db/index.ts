/**
 * MAW Database — Drizzle ORM + bun:sqlite
 *
 * Usage:
 *   import { db, initDb } from "./db";
 *   await initDb();  // call once on startup
 *   db.insert(feedEvents).values({ ... });
 */

import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { join } from "path";
import { mkdirSync } from "fs";
import { CONFIG_DIR } from "../paths";
import { migrate } from "./migrate";
import * as schema from "./schema";

export { schema };
export type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";

const DB_DIR = join(CONFIG_DIR, "db");
const DB_PATH = process.env.MAW_DB_PATH || join(DB_DIR, "maw.db");

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

/** Get the database instance. Throws if initDb() hasn't been called. */
export function getDb() {
  if (!_db) throw new Error("Database not initialized — call initDb() first");
  return _db;
}

/**
 * Initialize the database. Safe to call multiple times (idempotent).
 * Creates the db directory, opens SQLite, runs migrations.
 */
export async function initDb() {
  if (_db) return _db;

  mkdirSync(DB_DIR, { recursive: true });

  const sqlite = new Database(DB_PATH, { create: true });

  // Performance pragmas for local dashboard use
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA synchronous = NORMAL");
  sqlite.exec("PRAGMA foreign_keys = ON");

  _db = drizzle(sqlite, { schema });

  // Run auto-migrations
  migrate(sqlite);

  console.log(`[db] SQLite ready at ${DB_PATH}`);
  return _db;
}
