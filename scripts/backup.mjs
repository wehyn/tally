import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, renameSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const zone = "Asia/Manila";
const dataDir = path.resolve(process.env.TALLY_DATA_DIR || path.join(process.cwd(), "data"));
const databasePath = path.resolve(process.env.TALLY_DB_PATH || path.join(dataDir, "tally.sqlite"));
const backupDir = path.resolve(process.env.TALLY_BACKUP_DIR || path.join(dataDir, "backups"));
const MAX_SNAPSHOTS = 30;

function manilaParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")) };
}
function nextTwoAm(now = new Date()) {
  const { year, month, day } = manilaParts(now);
  let target = Date.UTC(year, month - 1, day, 2) - 8 * 60 * 60 * 1000;
  if (target <= now.getTime()) target = Date.UTC(year, month - 1, day + 1, 2) - 8 * 60 * 60 * 1000;
  return new Date(target);
}
function safeName(date) {
  return `tally-${date.toISOString().replaceAll(":", "-").replaceAll(".", "-")}-${randomUUID().slice(0, 8)}.sqlite`;
}
function validSnapshot(file) {
  let db;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    return db.pragma("integrity_check", { simple: true }) === "ok";
  } catch {
    return false;
  } finally {
    db?.close();
  }
}
function pruneSnapshots() {
  const snapshots = readdirSync(backupDir).filter((name) => /^tally-\d{4}-\d{2}-\d{2}T.*\.sqlite$/.test(name))
    .map((name) => ({ name, path: path.join(backupDir, name), mtime: statSync(path.join(backupDir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const valid = [];
  for (const snapshot of snapshots) {
    if (validSnapshot(snapshot.path)) valid.push(snapshot);
    else unlinkSync(snapshot.path);
  }
  for (const snapshot of valid.slice(MAX_SNAPSHOTS)) unlinkSync(snapshot.path);
}

export async function createBackup(now = new Date()) {
  if (!existsSync(databasePath)) throw new Error("SQLite database does not exist yet; backup was not created.");
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const fileName = safeName(now);
  const destination = path.join(backupDir, fileName);
  const temporary = `${destination}.tmp`;
  const source = new Database(databasePath, { timeout: 5000 });
  try {
    await source.backup(temporary);
  } finally {
    source.close();
  }
  if (!validSnapshot(temporary)) {
    unlinkSync(temporary);
    throw new Error("SQLite backup integrity check failed; the live database was not changed.");
  }
  renameSync(temporary, destination);
  pruneSnapshots();
  return destination;
}

function schedule() {
  const runAt = nextTwoAm();
  const delay = Math.max(0, runAt.getTime() - Date.now());
  console.log(`Next SQLite backup scheduled for ${runAt.toISOString()} (${zone}).`);
  setTimeout(async () => {
    try { console.log(`Created SQLite backup: ${await createBackup()}`); }
    catch (error) { console.error(`SQLite backup failed: ${error instanceof Error ? error.message : "unknown error"}`); }
    schedule();
  }, delay);
}

if (process.argv.includes("--once")) {
  try { console.log(`Created SQLite backup: ${await createBackup()}`); }
  catch (error) { console.error(error instanceof Error ? error.message : "SQLite backup failed"); process.exitCode = 1; }
} else schedule();
