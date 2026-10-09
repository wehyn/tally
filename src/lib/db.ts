import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { createStore, type Store } from "./store";

const globalDb = globalThis as typeof globalThis & { __tallyDb?: Database.Database; __tallyStore?: Store };

export function getStore(): Store {
  if (globalDb.__tallyStore) return globalDb.__tallyStore;
  const dataDir = path.resolve(/*turbopackIgnore: true*/ process.env.TALLY_DATA_DIR || path.join(process.cwd(), "data"));
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const dbPath = process.env.TALLY_DB_PATH ? path.resolve(process.env.TALLY_DB_PATH) : path.join(dataDir, "tally.sqlite");
  mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new Database(dbPath, { timeout: 5000 });
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  const store = createStore(db);
  store.migrate();
  globalDb.__tallyDb = db;
  globalDb.__tallyStore = store;
  return store;
}
