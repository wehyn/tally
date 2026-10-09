import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { isDateOnly } from "./dates";

export const STARTER_CATEGORIES = {
  income: ["Salary", "Other income"],
  expense: ["Food", "Transport", "Housing", "Utilities", "Health", "Shopping", "Education", "Entertainment", "Travel", "Other"],
} as const;

export type Role = "admin" | "user";
export type User = { id: string; username: string; passwordHash: string; role: Role; enabled: boolean; assistantOptIn: boolean; createdAt: string };
export type PublicUser = Omit<User, "passwordHash">;
export type AccountType = "cash" | "bank";
export type Account = { id: string; name: string; type: AccountType; openingMinor: number; balanceMinor: number; isDefault: boolean };
export type Category = { id: string; name: string; type: "income" | "expense" };
export type TransactionKind = "income" | "expense" | "transfer";
export type TransactionInput = { kind: TransactionKind; amountMinor: number; accountId: string; destinationAccountId?: string; categoryId?: string; description: string; date: string; source?: "manual" | "assistant" };
export type Transaction = TransactionInput & { id: string; categoryName: string | null; accountName: string; destinationAccountName: string | null; undoUntil: string | null };

const stamp = () => new Date().toISOString();
const publicUser = (row: Record<string, unknown>): PublicUser => ({
  id: String(row.id), username: String(row.username), role: row.role as Role, enabled: Boolean(row.enabled),
  assistantOptIn: Boolean(row.assistant_opt_in), createdAt: String(row.created_at),
});
const validMoney = (value: number) => Number.isSafeInteger(value) && value > 0;
const MAX_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);
function safeMinorNumber(value: unknown, label: string): number {
  const amount = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(amount)) throw new Error(`${label} exceeds the supported exact PHP minor-unit range.`);
  return amount;
}
function assertSafeMinorTotal(value: bigint, label: string): void {
  if (value > MAX_SAFE_MINOR || value < -MAX_SAFE_MINOR) throw new Error(`${label} exceeds the supported exact PHP minor-unit range.`);
}

export function createStore(db: Database.Database) {
  function migrate() {
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE, password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','user')), enabled INTEGER NOT NULL DEFAULT 1,
        assistant_opt_in INTEGER NOT NULL DEFAULT 0, reset_token_hash TEXT, reset_expires_at TEXT,
        default_account_id TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS financial_accounts (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('cash','bank')), opening_minor INTEGER NOT NULL DEFAULT 0 CHECK(opening_minor >= 0),
        is_default INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS accounts_one_default ON financial_accounts(user_id) WHERE is_default = 1;
      CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL COLLATE NOCASE, type TEXT NOT NULL CHECK(type IN ('income','expense')),
        UNIQUE(user_id, type, name)
      );
      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('income','expense','transfer')), amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
        account_id TEXT NOT NULL REFERENCES financial_accounts(id) ON DELETE RESTRICT,
        destination_account_id TEXT REFERENCES financial_accounts(id) ON DELETE RESTRICT,
        category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
        description TEXT NOT NULL, date TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','assistant')),
        undo_until TEXT, created_at TEXT NOT NULL,
        CHECK((kind = 'transfer' AND destination_account_id IS NOT NULL AND category_id IS NULL) OR (kind != 'transfer' AND destination_account_id IS NULL AND category_id IS NOT NULL)),
        CHECK(destination_account_id IS NULL OR destination_account_id != account_id)
      );
      CREATE INDEX IF NOT EXISTS transactions_owner_date ON transactions(user_id, date DESC);
      CREATE TABLE IF NOT EXISTS assistant_consents (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        disclosure_hash TEXT NOT NULL, consented_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS assistant_messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('user','assistant')),
        content TEXT NOT NULL, transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,
        needs_followup INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY, manager_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        name TEXT NOT NULL, target_minor INTEGER NOT NULL CHECK(target_minor > 0), deadline TEXT,
        status TEXT NOT NULL CHECK(status IN ('active','completed','archived')), created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS goal_members (
        id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL, username_snapshot TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('invited','accepted','left','removed','former')),
        invited_at TEXT NOT NULL, accepted_at TEXT,
        UNIQUE(goal_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS goal_members_user ON goal_members(user_id, status);
      CREATE TABLE IF NOT EXISTS goal_contributions (
        id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL, member_name TEXT NOT NULL,
        amount_minor INTEGER NOT NULL CHECK(amount_minor > 0), note TEXT NOT NULL DEFAULT '', date TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS contributions_goal ON goal_contributions(goal_id, date DESC);
    `);
    const messageColumns = db.pragma("table_info(assistant_messages)") as { name: string }[];
    if (!messageColumns.some((column) => column.name === "transaction_id")) db.exec("ALTER TABLE assistant_messages ADD COLUMN transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL");
    if (!messageColumns.some((column) => column.name === "needs_followup")) db.exec("ALTER TABLE assistant_messages ADD COLUMN needs_followup INTEGER NOT NULL DEFAULT 0");
  }

  function registerUser(username: string, passwordHash: string): PublicUser {
    const normalized = username.trim();
    if (!/^[A-Za-z0-9_]{3,32}$/.test(normalized)) throw new Error("Username must be 3–32 letters, numbers, or underscores.");
    if (!passwordHash) throw new Error("A password hash is required.");
    return db.transaction(() => {
      const exists = db.prepare("SELECT 1 FROM users WHERE username = ?").get(normalized);
      if (exists) throw new Error("That username is already taken.");
      const role: Role = db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get() ? "user" : "admin";
      const user = { id: randomUUID(), username: normalized, passwordHash, role, enabled: true, assistantOptIn: false, createdAt: stamp() };
      db.prepare("INSERT INTO users(id,username,password_hash,role,enabled,assistant_opt_in,created_at) VALUES(?,?,?,?,1,0,?)")
        .run(user.id, normalized, passwordHash, role, user.createdAt);
      const insert = db.prepare("INSERT INTO categories(id,user_id,name,type) VALUES(?,?,?,?)");
      for (const type of ["income", "expense"] as const) for (const name of STARTER_CATEGORIES[type]) insert.run(randomUUID(), user.id, name, type);
      return { id: user.id, username: user.username, role, enabled: true, assistantOptIn: false, createdAt: user.createdAt };
    }).immediate();
  }

  function getUserByUsername(username: string): User | null {
    const row = db.prepare("SELECT * FROM users WHERE username = ?").get(username.trim()) as Record<string, unknown> | undefined;
    return row ? { ...publicUser(row), passwordHash: String(row.password_hash) } : null;
  }
  function getUserById(id: string): User | null {
    const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? { ...publicUser(row), passwordHash: String(row.password_hash) } : null;
  }
  function listUsers(): PublicUser[] {
    return (db.prepare("SELECT id,username,role,enabled,assistant_opt_in,created_at FROM users ORDER BY created_at")
      .all() as Record<string, unknown>[]).map(publicUser);
  }
  function setUserEnabled(adminId: string, userId: string, enabled: boolean): void {
    if (adminId === userId) throw new Error("You cannot disable your own admin account.");
    const result = db.prepare("UPDATE users SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, userId);
    if (!result.changes) throw new Error("User not found.");
  }
  function setResetCredential(userId: string, hash: string, expiresAt: string): void {
    const result = db.prepare("UPDATE users SET reset_token_hash = ?, reset_expires_at = ? WHERE id = ?").run(hash, expiresAt, userId);
    if (!result.changes) throw new Error("User not found.");
  }
  function consumeResetCredential(userId: string, tokenHash: string, newPasswordHash: string): boolean {
    return db.transaction(() => {
      const row = db.prepare("SELECT reset_token_hash, reset_expires_at FROM users WHERE id = ? AND enabled = 1").get(userId) as { reset_token_hash: string | null; reset_expires_at: string | null } | undefined;
      if (!row || row.reset_token_hash !== tokenHash || !row.reset_expires_at || row.reset_expires_at < stamp()) return false;
      db.prepare("UPDATE users SET password_hash = ?, reset_token_hash = NULL, reset_expires_at = NULL WHERE id = ?").run(newPasswordHash, userId);
      return true;
    }).immediate();
  }

  function listAccounts(userId: string): Account[] {
    const rows = db.prepare(`SELECT a.id,a.name,a.type,a.opening_minor,a.is_default,
      a.opening_minor + COALESCE(SUM(CASE
        WHEN t.kind='income' AND t.account_id=a.id THEN t.amount_minor
        WHEN t.kind='expense' AND t.account_id=a.id THEN -t.amount_minor
        WHEN t.kind='transfer' AND t.account_id=a.id THEN -t.amount_minor
        WHEN t.kind='transfer' AND t.destination_account_id=a.id THEN t.amount_minor ELSE 0 END),0) AS balance_minor
      FROM financial_accounts a LEFT JOIN transactions t ON t.user_id=a.user_id AND (t.account_id=a.id OR t.destination_account_id=a.id)
      WHERE a.user_id=? GROUP BY a.id ORDER BY a.created_at,a.rowid`).all(userId) as Record<string, unknown>[];
    return rows.map((row) => ({ id: String(row.id), name: String(row.name), type: row.type as AccountType,
      openingMinor: safeMinorNumber(row.opening_minor, "Account opening balance"), balanceMinor: safeMinorNumber(row.balance_minor, "Account balance"), isDefault: Boolean(row.is_default) }));
  }
  function assertLedgerTotalsSafe(userId: string): void {
    const totals = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN kind='income' THEN amount_minor ELSE 0 END),0) AS income_minor,
      COALESCE(SUM(CASE WHEN kind='expense' THEN amount_minor ELSE 0 END),0) AS spending_minor
      FROM transactions WHERE user_id=?`).get(userId) as { income_minor: number; spending_minor: number };
    safeMinorNumber(totals.income_minor, "Recorded income total");
    safeMinorNumber(totals.spending_minor, "Recorded spending total");
    const totalBalance = listAccounts(userId).reduce((sum, account) => sum + BigInt(account.balanceMinor), 0n);
    assertSafeMinorTotal(totalBalance, "Combined account balance");
  }
  function safeGoalTotal(goalId: string): number {
    const result = db.prepare("SELECT COALESCE(SUM(amount_minor),0) AS total FROM goal_contributions WHERE goal_id=?").get(goalId) as { total: number };
    return safeMinorNumber(result.total, "Goal contribution total");
  }
  function createAccount(userId: string, input: { name: string; type: AccountType; openingMinor: number }): Account {
    const name = input.name.trim();
    if (!name || name.length > 80) throw new Error("Account name must be 1–80 characters.");
    if (!Number.isSafeInteger(input.openingMinor) || input.openingMinor < 0) throw new Error("Opening balance must be a valid non-negative PHP amount.");
    if (!(["cash", "bank"] as string[]).includes(input.type)) throw new Error("Choose cash or bank.");
    return db.transaction(() => {
      const isDefault = !db.prepare("SELECT 1 FROM financial_accounts WHERE user_id=? LIMIT 1").get(userId);
      const account = { id: randomUUID(), name, type: input.type, openingMinor: input.openingMinor, balanceMinor: input.openingMinor, isDefault };
      db.prepare("INSERT INTO financial_accounts(id,user_id,name,type,opening_minor,is_default,created_at) VALUES(?,?,?,?,?,?,?)")
        .run(account.id, userId, name, input.type, input.openingMinor, isDefault ? 1 : 0, stamp());
      if (isDefault) db.prepare("UPDATE users SET default_account_id=? WHERE id=?").run(account.id, userId);
      assertLedgerTotalsSafe(userId);
      return account;
    }).immediate();
  }
  function setDefaultAccount(userId: string, accountId: string): void {
    db.transaction(() => {
      const account = db.prepare("SELECT 1 FROM financial_accounts WHERE id=? AND user_id=?").get(accountId, userId);
      if (!account) throw new Error("Financial account not found.");
      db.prepare("UPDATE financial_accounts SET is_default=0 WHERE user_id=?").run(userId);
      db.prepare("UPDATE financial_accounts SET is_default=1 WHERE id=? AND user_id=?").run(accountId, userId);
      db.prepare("UPDATE users SET default_account_id=? WHERE id=?").run(accountId, userId);
    }).immediate();
  }
  function updateAccount(userId: string, accountId: string, input: { name?: string; openingMinor?: number; type?: AccountType }): void {
    db.transaction(() => {
      const account = db.prepare("SELECT id FROM financial_accounts WHERE id=? AND user_id=?").get(accountId, userId);
      if (!account) throw new Error("Financial account not found.");
      const updates: string[] = [];
      const params: (string | number)[] = [];
      if (input.name !== undefined) { const name = input.name.trim(); if (!name || name.length > 80) throw new Error("Account name must be 1–80 characters."); updates.push("name=?"); params.push(name); }
      if (input.openingMinor !== undefined) { if (!Number.isSafeInteger(input.openingMinor) || input.openingMinor < 0) throw new Error("Opening balance must be non-negative."); updates.push("opening_minor=?"); params.push(input.openingMinor); }
      if (input.type !== undefined) { if (!(input.type === "cash" || input.type === "bank")) throw new Error("Choose cash or bank."); updates.push("type=?"); params.push(input.type); }
      if (updates.length) db.prepare(`UPDATE financial_accounts SET ${updates.join(",")} WHERE id=? AND user_id=?`).run(...params, accountId, userId);
      assertLedgerTotalsSafe(userId);
    }).immediate();
  }
  function deleteAccount(userId: string, accountId: string): void {
    db.transaction(() => {
      const account = db.prepare("SELECT is_default FROM financial_accounts WHERE id=? AND user_id=?").get(accountId, userId) as { is_default: number } | undefined;
      if (!account) throw new Error("Financial account not found.");
      const count = Number((db.prepare("SELECT COUNT(*) AS n FROM financial_accounts WHERE user_id=?").get(userId) as { n: number }).n);
      if (count <= 1) throw new Error("Keep at least one financial account.");
      if (db.prepare("SELECT 1 FROM transactions WHERE user_id=? AND (account_id=? OR destination_account_id=?) LIMIT 1").get(userId, accountId, accountId)) throw new Error("This account has transaction history and cannot be deleted.");
      db.prepare("DELETE FROM financial_accounts WHERE id=? AND user_id=?").run(accountId, userId);
      if (account.is_default) {
        const next = db.prepare("SELECT id FROM financial_accounts WHERE user_id=? ORDER BY created_at LIMIT 1").get(userId) as { id: string };
        db.prepare("UPDATE financial_accounts SET is_default=1 WHERE id=?").run(next.id);
        db.prepare("UPDATE users SET default_account_id=? WHERE id=?").run(next.id, userId);
      }
      assertLedgerTotalsSafe(userId);
    }).immediate();
  }

  function listCategories(userId: string): Category[] {
    return (db.prepare("SELECT id,name,type FROM categories WHERE user_id=? ORDER BY CASE type WHEN 'income' THEN 0 ELSE 1 END, rowid").all(userId) as Record<string, unknown>[])
      .map((row) => ({ id: String(row.id), name: String(row.name), type: row.type as Category["type"] }));
  }
  function createCategory(userId: string, input: { name: string; type: Category["type"] }): Category {
    const name = input.name.trim();
    if (!name || name.length > 40 || !(input.type === "income" || input.type === "expense")) throw new Error("Enter a category name (1–40 characters) and type.");
    const category = { id: randomUUID(), name, type: input.type };
    db.prepare("INSERT INTO categories(id,user_id,name,type) VALUES(?,?,?,?)").run(category.id, userId, name, input.type);
    return category;
  }
  function renameCategory(userId: string, categoryId: string, name: string): void {
    const value = name.trim();
    if (!value || value.length > 40) throw new Error("Category name must be 1–40 characters.");
    const result = db.prepare("UPDATE categories SET name=? WHERE id=? AND user_id=?").run(value, categoryId, userId);
    if (!result.changes) throw new Error("Category not found.");
  }

  function assertTransactionInput(userId: string, input: TransactionInput) {
    if (!validMoney(input.amountMinor)) throw new Error("Transaction amount must be a positive PHP value.");
    if (!input.description.trim() || input.description.trim().length > 180) throw new Error("Description must be 1–180 characters.");
    if (!isDateOnly(input.date)) throw new Error("Enter a valid transaction date.");
    if (!(["income", "expense", "transfer"] as string[]).includes(input.kind)) throw new Error("Choose income, expense, or transfer.");
    const account = db.prepare("SELECT id FROM financial_accounts WHERE id=? AND user_id=?").get(input.accountId, userId);
    if (!account) throw new Error("Source account is not owned by this user.");
    if (input.kind === "transfer") {
      if (!input.destinationAccountId || input.destinationAccountId === input.accountId || input.categoryId) throw new Error("A transfer needs two different owned accounts and no category.");
      if (!db.prepare("SELECT 1 FROM financial_accounts WHERE id=? AND user_id=?").get(input.destinationAccountId, userId)) throw new Error("Destination account is not owned by this user.");
    } else {
      if (!input.categoryId || input.destinationAccountId) throw new Error("Income and expense need a category and one account.");
      if (!db.prepare("SELECT 1 FROM categories WHERE id=? AND user_id=? AND type=?").get(input.categoryId, userId, input.kind)) throw new Error("Category is not owned by this user or has the wrong type.");
    }
  }
  function createTransaction(userId: string, input: TransactionInput): Transaction {
    return db.transaction(() => {
      assertTransactionInput(userId, input);
      const id = randomUUID();
      const source = input.source ?? "manual";
      const undoUntil = source === "assistant" ? new Date(Date.now() + 10_000).toISOString() : null;
      const description = input.description.trim();
      db.prepare(`INSERT INTO transactions(id,user_id,kind,amount_minor,account_id,destination_account_id,category_id,description,date,source,undo_until,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, userId, input.kind, input.amountMinor, input.accountId, input.destinationAccountId ?? null,
        input.categoryId ?? null, description, input.date, source, undoUntil, stamp());
      assertLedgerTotalsSafe(userId);
      return getTransaction(userId, id)!;
    }).immediate();
  }
  function getTransaction(userId: string, id: string): Transaction | null {
    const row = db.prepare(`SELECT t.*,c.name AS category_name,a.name AS account_name,d.name AS destination_account_name
      FROM transactions t JOIN financial_accounts a ON a.id=t.account_id
      LEFT JOIN categories c ON c.id=t.category_id LEFT JOIN financial_accounts d ON d.id=t.destination_account_id
      WHERE t.user_id=? AND t.id=?`).get(userId, id) as Record<string, unknown> | undefined;
    return row ? mapTransaction(row) : null;
  }
  function mapTransaction(row: Record<string, unknown>): Transaction {
    return {
      id: String(row.id), kind: row.kind as TransactionKind, amountMinor: Number(row.amount_minor), accountId: String(row.account_id),
      destinationAccountId: row.destination_account_id ? String(row.destination_account_id) : undefined,
      categoryId: row.category_id ? String(row.category_id) : undefined, description: String(row.description), date: String(row.date),
      source: row.source as "manual" | "assistant", undoUntil: row.undo_until ? String(row.undo_until) : null,
      categoryName: row.category_name ? String(row.category_name) : null, accountName: String(row.account_name),
      destinationAccountName: row.destination_account_name ? String(row.destination_account_name) : null,
    };
  }
  function listTransactions(userId: string, range?: { start: string; end: string }, limit = 100): Transaction[] {
    const start = range?.start && isDateOnly(range.start) ? range.start : "0000-01-01";
    const end = range?.end && isDateOnly(range.end) ? range.end : "9999-12-31";
    return (db.prepare(`SELECT t.*,c.name AS category_name,a.name AS account_name,d.name AS destination_account_name
      FROM transactions t JOIN financial_accounts a ON a.id=t.account_id LEFT JOIN categories c ON c.id=t.category_id
      LEFT JOIN financial_accounts d ON d.id=t.destination_account_id
      WHERE t.user_id=? AND t.date BETWEEN ? AND ? ORDER BY t.date DESC,t.created_at DESC LIMIT ?`).all(userId, start, end, Math.min(Math.max(limit, 1), 500)) as Record<string, unknown>[]).map(mapTransaction);
  }
  function updateTransaction(userId: string, id: string, input: TransactionInput): Transaction {
    return db.transaction(() => {
      assertTransactionInput(userId, input);
      const result = db.prepare(`UPDATE transactions SET kind=?,amount_minor=?,account_id=?,destination_account_id=?,category_id=?,description=?,date=?
        WHERE id=? AND user_id=?`).run(input.kind, input.amountMinor, input.accountId, input.destinationAccountId ?? null, input.categoryId ?? null,
        input.description.trim(), input.date, id, userId);
      if (!result.changes) throw new Error("Transaction not found.");
      assertLedgerTotalsSafe(userId);
      return getTransaction(userId, id)!;
    }).immediate();
  }
  function deleteTransaction(userId: string, id: string, undoOnly = false): void {
    db.transaction(() => {
      const row = db.prepare("SELECT source,undo_until FROM transactions WHERE id=? AND user_id=?").get(id, userId) as { source: string; undo_until: string | null } | undefined;
      if (!row) throw new Error("Transaction not found.");
      if (undoOnly && (row.source !== "assistant" || !row.undo_until || Date.now() > Date.parse(row.undo_until))) throw new Error("The 10-second Undo period has expired.");
      db.prepare("DELETE FROM transactions WHERE id=? AND user_id=?").run(id, userId);
      assertLedgerTotalsSafe(userId);
    }).immediate();
  }

  function getDashboard(userId: string, start: string, end: string) {
    if (!isDateOnly(start) || !isDateOnly(end) || start > end) throw new Error("Choose a valid date range.");
    const totals = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN kind='income' THEN amount_minor ELSE 0 END),0) AS income_minor,
      COALESCE(SUM(CASE WHEN kind='expense' THEN amount_minor ELSE 0 END),0) AS spending_minor
      FROM transactions WHERE user_id=? AND date BETWEEN ? AND ?`).get(userId, start, end) as { income_minor: number; spending_minor: number };
    const categorySpending = db.prepare(`SELECT c.id,c.name,SUM(t.amount_minor) AS amount_minor FROM transactions t
      JOIN categories c ON c.id=t.category_id WHERE t.user_id=? AND t.kind='expense' AND t.date BETWEEN ? AND ?
      GROUP BY c.id,c.name ORDER BY amount_minor DESC`).all(userId, start, end) as { id: string; name: string; amount_minor: number }[];
    const activity = db.prepare(`SELECT date,
      COALESCE(SUM(CASE WHEN kind='income' THEN amount_minor ELSE 0 END),0) AS income_minor,
      COALESCE(SUM(CASE WHEN kind='expense' THEN amount_minor ELSE 0 END),0) AS spending_minor
      FROM transactions WHERE user_id=? AND date BETWEEN ? AND ? AND kind!='transfer' GROUP BY date ORDER BY date`)
      .all(userId, start, end) as { date: string; income_minor: number; spending_minor: number }[];
    const transactions = listTransactions(userId, { start, end }, 8);
    const goals = listGoals(userId);
    const accounts = listAccounts(userId);
    assertSafeMinorTotal(accounts.reduce((sum, account) => sum + BigInt(account.balanceMinor), 0n), "Combined account balance");
    return { start, end, incomeMinor: safeMinorNumber(totals.income_minor, "Period income total"), spendingMinor: safeMinorNumber(totals.spending_minor, "Period spending total"),
      accounts, categorySpending: categorySpending.map((r) => ({ id: r.id, name: r.name, amountMinor: safeMinorNumber(r.amount_minor, "Category spending total") })),
      activity: activity.map((row) => ({ date: row.date, income_minor: safeMinorNumber(row.income_minor, "Daily income total"), spending_minor: safeMinorNumber(row.spending_minor, "Daily spending total") })), transactions, goals };
  }

  function getFinanceFacts(userId: string, start: string, end: string, requestedCategory?: string) {
    if (!isDateOnly(start) || !isDateOnly(end) || start > end) throw new Error("Choose a valid date range.");
    const totals = db.prepare(`SELECT COALESCE(SUM(CASE WHEN kind='income' THEN amount_minor ELSE 0 END),0) AS income_minor,
      COALESCE(SUM(CASE WHEN kind='expense' THEN amount_minor ELSE 0 END),0) AS spending_minor FROM transactions
      WHERE user_id=? AND date BETWEEN ? AND ?`).get(userId, start, end) as { income_minor: number; spending_minor: number };
    const byCategory = db.prepare(`SELECT c.name,SUM(t.amount_minor) AS amount_minor FROM transactions t JOIN categories c ON c.id=t.category_id
      WHERE t.user_id=? AND t.kind='expense' AND t.date BETWEEN ? AND ? GROUP BY c.name ORDER BY amount_minor DESC`).all(userId, start, end) as { name: string; amount_minor: number }[];
    const category = requestedCategory ? byCategory.find((entry) => entry.name.toLowerCase() === requestedCategory.trim().toLowerCase()) : undefined;
    const accounts = listAccounts(userId).map(({ name, type, balanceMinor }) => ({ name, type, balanceMinor }));
    return { start, end, incomeMinor: safeMinorNumber(totals.income_minor, "Period income total"), spendingMinor: safeMinorNumber(totals.spending_minor, "Period spending total"),
      byCategory: byCategory.map((entry) => ({ name: entry.name, amountMinor: safeMinorNumber(entry.amount_minor, "Category spending total") })),
      requestedCategory: requestedCategory ?? null, categoryAmountMinor: category ? safeMinorNumber(category.amount_minor, "Category spending total") : requestedCategory ? 0 : null, accounts };
  }

  function setAssistantConsent(userId: string, disclosureHash: string | null): void {
    db.transaction(() => {
      db.prepare("UPDATE users SET assistant_opt_in=? WHERE id=?").run(disclosureHash ? 1 : 0, userId);
      if (disclosureHash) db.prepare(`INSERT INTO assistant_consents(user_id,disclosure_hash,consented_at) VALUES(?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET disclosure_hash=excluded.disclosure_hash,consented_at=excluded.consented_at`).run(userId, disclosureHash, stamp());
      else db.prepare("DELETE FROM assistant_consents WHERE user_id=?").run(userId);
    }).immediate();
  }
  function getAssistantOptIn(userId: string, disclosureHash?: string): boolean {
    const enabled = Boolean((db.prepare("SELECT assistant_opt_in FROM users WHERE id=?").get(userId) as { assistant_opt_in: number } | undefined)?.assistant_opt_in);
    if (!enabled) return false;
    if (!disclosureHash) return true;
    const consent = db.prepare("SELECT disclosure_hash FROM assistant_consents WHERE user_id=?").get(userId) as { disclosure_hash: string } | undefined;
    return consent?.disclosure_hash === disclosureHash;
  }

  function createConversation(userId: string, title: string): string {
    const id = randomUUID(); const now = stamp();
    db.prepare("INSERT INTO conversations(id,user_id,title,created_at,updated_at) VALUES(?,?,?,?,?)").run(id, userId, title.slice(0, 120), now, now);
    return id;
  }
  function listConversations(userId: string) {
    return db.prepare("SELECT id,title,created_at AS createdAt,updated_at AS updatedAt FROM conversations WHERE user_id=? ORDER BY updated_at DESC")
      .all(userId) as { id: string; title: string; createdAt: string; updatedAt: string }[];
  }
  function getConversation(userId: string, id: string) {
    const conversation = db.prepare("SELECT id,title FROM conversations WHERE user_id=? AND id=?").get(userId, id) as { id: string; title: string } | undefined;
    if (!conversation) return null;
    const messages = db.prepare(`SELECT m.id,m.role,m.content,m.created_at AS createdAt,m.transaction_id AS transactionId,m.needs_followup AS needsFollowup,
      t.kind,t.amount_minor AS amountMinor,t.description AS transactionDescription,t.date AS transactionDate,c.name AS categoryName,a.name AS accountName,t.undo_until AS undoUntil
      FROM assistant_messages m LEFT JOIN transactions t ON t.id=m.transaction_id
      LEFT JOIN categories c ON c.id=t.category_id LEFT JOIN financial_accounts a ON a.id=t.account_id
      WHERE m.user_id=? AND m.conversation_id=? ORDER BY m.created_at`).all(userId, id) as Record<string, unknown>[];
    return { ...conversation, messages: messages.map((message) => ({ id: String(message.id), role: message.role as "user" | "assistant", content: String(message.content), createdAt: String(message.createdAt), needsFollowup: Boolean(message.needsFollowup),
      transaction: message.transactionId ? { id: String(message.transactionId), kind: message.kind as TransactionKind, amountMinor: Number(message.amountMinor), description: String(message.transactionDescription), date: String(message.transactionDate), categoryName: message.categoryName ? String(message.categoryName) : null, accountName: message.accountName ? String(message.accountName) : "", undoUntil: message.undoUntil ? String(message.undoUntil) : null } : null })) };
  }
  function addMessage(userId: string, conversationId: string, role: "user" | "assistant", content: string, transactionId?: string, needsFollowup = false): void {
    if (!db.prepare("SELECT 1 FROM conversations WHERE id=? AND user_id=?").get(conversationId, userId)) throw new Error("Conversation not found.");
    const now = stamp();
    db.prepare("INSERT INTO assistant_messages(id,conversation_id,user_id,role,content,transaction_id,needs_followup,created_at) VALUES(?,?,?,?,?,?,?,?)").run(randomUUID(), conversationId, userId, role, content.slice(0, 8000), transactionId ?? null, needsFollowup ? 1 : 0, now);
    db.prepare("UPDATE conversations SET updated_at=? WHERE id=? AND user_id=?").run(now, conversationId, userId);
  }
  function deleteConversation(userId: string, id: string): void {
    const result = db.prepare("DELETE FROM conversations WHERE id=? AND user_id=?").run(id, userId);
    if (!result.changes) throw new Error("Conversation not found.");
  }

  function createGoal(userId: string, input: { name: string; targetMinor: number; deadline?: string }): string {
    const name = input.name.trim();
    if (!name || name.length > 100 || !validMoney(input.targetMinor) || (input.deadline && !isDateOnly(input.deadline))) throw new Error("Enter a goal name, positive target, and valid optional deadline.");
    const id = randomUUID();
    db.transaction(() => {
      db.prepare("INSERT INTO goals(id,manager_id,name,target_minor,deadline,status,created_at) VALUES(?,?,?,?,?,'active',?)").run(id, userId, name, input.targetMinor, input.deadline ?? null, stamp());
      const username = (db.prepare("SELECT username FROM users WHERE id=?").get(userId) as { username: string }).username;
      db.prepare("INSERT INTO goal_members(id,goal_id,user_id,username_snapshot,status,invited_at,accepted_at) VALUES(?,?,?,?,'accepted',?,?)").run(randomUUID(), id, userId, username, stamp(), stamp());
    }).immediate();
    return id;
  }
  function listGoals(userId: string) {
    return (db.prepare(`SELECT g.*,m.status AS my_status,
      COALESCE((SELECT SUM(amount_minor) FROM goal_contributions c WHERE c.goal_id=g.id),0) AS raised_minor
      FROM goals g JOIN goal_members m ON m.goal_id=g.id
      WHERE m.user_id=? AND m.status='accepted' AND g.status!='archived' ORDER BY g.created_at DESC`).all(userId) as Record<string, unknown>[])
      .map((goal) => {
        const members = db.prepare("SELECT user_id AS userId,username_snapshot AS username,status FROM goal_members WHERE goal_id=? ORDER BY invited_at").all(goal.id);
        const contributions = db.prepare("SELECT id,user_id AS userId,member_name AS memberName,amount_minor AS amountMinor,note,date FROM goal_contributions WHERE goal_id=? ORDER BY date DESC,created_at DESC").all(goal.id);
        const safeContributions = (contributions as Record<string, unknown>[]).map((item) => ({ ...item, amountMinor: safeMinorNumber(item.amountMinor, "Contribution amount") }));
        return { id: String(goal.id), name: String(goal.name), targetMinor: safeMinorNumber(goal.target_minor, "Goal target"), deadline: goal.deadline ? String(goal.deadline) : null,
          status: goal.status as string, managerId: goal.manager_id ? String(goal.manager_id) : null,
          raisedMinor: safeMinorNumber(goal.raised_minor, "Goal contribution total"), members, contributions: safeContributions };
      });
  }
  function requireGoalMember(userId: string, goalId: string, accepted = true) {
    const row = db.prepare(`SELECT g.* FROM goals g JOIN goal_members m ON m.goal_id=g.id WHERE g.id=? AND m.user_id=? ${accepted ? "AND m.status='accepted'" : ""}`)
      .get(goalId, userId) as Record<string, unknown> | undefined;
    if (!row) throw new Error("Goal not found.");
    return row;
  }
  function inviteToGoal(managerId: string, goalId: string, username: string): void {
    const goal = requireGoalMember(managerId, goalId);
    if (goal.manager_id !== managerId) throw new Error("Only the goal manager can invite members.");
    const invitee = db.prepare("SELECT id,username,enabled FROM users WHERE username=? COLLATE NOCASE").get(username.trim()) as { id: string; username: string; enabled: number } | undefined;
    if (!invitee || !invitee.enabled) throw new Error("No enabled user has that username.");
    if (invitee.id === managerId) throw new Error("You are already the goal manager.");
    const existing = db.prepare("SELECT status FROM goal_members WHERE goal_id=? AND user_id=?").get(goalId, invitee.id) as { status: string } | undefined;
    if (existing?.status === "accepted" || existing?.status === "invited") throw new Error("That user is already a member or has a pending invitation.");
    if (existing) db.prepare("UPDATE goal_members SET username_snapshot=?,status='invited',invited_at=?,accepted_at=NULL WHERE goal_id=? AND user_id=?").run(invitee.username, stamp(), goalId, invitee.id);
    else db.prepare("INSERT INTO goal_members(id,goal_id,user_id,username_snapshot,status,invited_at) VALUES(?,?,?,?, 'invited',?)").run(randomUUID(), goalId, invitee.id, invitee.username, stamp());
  }
  function respondInvitation(userId: string, membershipId: string, accept: boolean): void {
    const result = db.prepare("UPDATE goal_members SET status=?,accepted_at=? WHERE id=? AND user_id=? AND status='invited'")
      .run(accept ? "accepted" : "left", accept ? stamp() : null, membershipId, userId);
    if (!result.changes) throw new Error("Invitation not found or already answered.");
  }
  function listInvitations(userId: string) {
    return db.prepare(`SELECT m.id,g.id AS goalId,g.name AS goalName,u.username AS managerName,m.invited_at AS invitedAt
      FROM goal_members m JOIN goals g ON g.id=m.goal_id JOIN users u ON u.id=g.manager_id
      WHERE m.user_id=? AND m.status='invited' AND g.status!='archived' ORDER BY m.invited_at`).all(userId);
  }
  function updateGoal(managerId: string, goalId: string, input: { name?: string; targetMinor?: number; deadline?: string | null }): void {
    const goal = requireGoalMember(managerId, goalId);
    if (goal.manager_id !== managerId) throw new Error("Only the goal manager can edit it.");
    if (input.name !== undefined && (!input.name.trim() || input.name.trim().length > 100)) throw new Error("Goal name must be 1–100 characters.");
    if (input.targetMinor !== undefined && !validMoney(input.targetMinor)) throw new Error("Goal target must be positive.");
    if (input.deadline && !isDateOnly(input.deadline)) throw new Error("Enter a valid deadline.");
    const updates: string[] = []; const args: (string | number | null)[] = [];
    if (input.name !== undefined) { updates.push("name=?"); args.push(input.name.trim()); }
    if (input.targetMinor !== undefined) { updates.push("target_minor=?"); args.push(input.targetMinor); }
    if (input.deadline !== undefined) { updates.push("deadline=?"); args.push(input.deadline); }
    if (!updates.length) return;
    const target = input.targetMinor ?? Number(goal.target_minor);
    const raised = safeGoalTotal(goalId);
    updates.push("status=?"); args.push(raised >= target ? "completed" : "active");
    db.prepare(`UPDATE goals SET ${updates.join(",")} WHERE id=?`).run(...args, goalId);
  }
  function succession(goalId: string, outgoingUserId: string): void {
    const successor = db.prepare(`SELECT m.user_id FROM goal_members m JOIN users u ON u.id=m.user_id
      WHERE m.goal_id=? AND m.status='accepted' AND m.user_id!=? AND u.enabled=1 ORDER BY m.accepted_at,m.invited_at LIMIT 1`).get(goalId, outgoingUserId) as { user_id: string } | undefined;
    if (successor) db.prepare("UPDATE goals SET manager_id=? WHERE id=?").run(successor.user_id, goalId);
    else db.prepare("UPDATE goals SET manager_id=NULL,status='archived' WHERE id=?").run(goalId);
  }
  function changeMembership(actorId: string, goalId: string, targetUserId: string, action: "leave" | "remove"): void {
    const goal = requireGoalMember(actorId, goalId);
    if (action === "remove" && goal.manager_id !== actorId) throw new Error("Only the goal manager can remove a member.");
    if (action === "leave" && actorId !== targetUserId) throw new Error("You can only leave your own membership.");
    const target = db.prepare("SELECT id FROM goal_members WHERE goal_id=? AND user_id=? AND status='accepted'").get(goalId, targetUserId);
    if (!target) throw new Error("Member not found.");
    if (goal.manager_id === targetUserId) succession(goalId, targetUserId);
    db.prepare("UPDATE goal_members SET status=? WHERE goal_id=? AND user_id=?").run(action === "leave" ? "left" : "removed", goalId, targetUserId);
  }
  function addContribution(userId: string, goalId: string, input: { amountMinor: number; note?: string; date: string }): string {
    const goal = requireGoalMember(userId, goalId);
    if (goal.status === "completed") throw new Error("This goal is complete. Its manager must raise the target before continuing.");
    if (goal.status === "archived") throw new Error("This goal is archived.");
    if (!validMoney(input.amountMinor) || !isDateOnly(input.date) || (input.note ?? "").length > 200) throw new Error("Enter a valid contribution amount, date, and note.");
    const username = (db.prepare("SELECT username FROM users WHERE id=?").get(userId) as { username: string }).username;
    const id = randomUUID(); const now = stamp();
    db.transaction(() => {
      db.prepare("INSERT INTO goal_contributions(id,goal_id,user_id,member_name,amount_minor,note,date,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(id, goalId, userId, username, input.amountMinor, input.note?.trim() ?? "", input.date, now);
      const total = safeGoalTotal(goalId);
      if (total >= Number(goal.target_minor)) db.prepare("UPDATE goals SET status='completed' WHERE id=?").run(goalId);
    }).immediate();
    return id;
  }
  function updateContribution(userId: string, contributionId: string, input: { amountMinor?: number; note?: string; date?: string }): void {
    db.transaction(() => {
      const row = db.prepare("SELECT c.*,g.target_minor,g.id AS goal_id FROM goal_contributions c JOIN goals g ON g.id=c.goal_id WHERE c.id=? AND c.user_id=?")
        .get(contributionId, userId) as Record<string, unknown> | undefined;
      if (!row) throw new Error("Your contribution was not found.");
      const goalId = String(row.goal_id);
      requireGoalMember(userId, goalId);
      if (input.amountMinor !== undefined && !validMoney(input.amountMinor)) throw new Error("Contribution amount must be positive.");
      if (input.date !== undefined && !isDateOnly(input.date)) throw new Error("Enter a valid date.");
      if (input.note !== undefined && input.note.length > 200) throw new Error("Note is too long.");
      const fields: string[] = []; const params: (string | number)[] = [];
      if (input.amountMinor !== undefined) { fields.push("amount_minor=?"); params.push(input.amountMinor); }
      if (input.note !== undefined) { fields.push("note=?"); params.push(input.note); }
      if (input.date !== undefined) { fields.push("date=?"); params.push(input.date); }
      if (fields.length) db.prepare(`UPDATE goal_contributions SET ${fields.join(",")} WHERE id=? AND user_id=?`).run(...params, contributionId, userId);
      const raised = safeGoalTotal(goalId);
      db.prepare("UPDATE goals SET status=? WHERE id=? AND status!='archived'").run(raised >= Number(row.target_minor) ? "completed" : "active", goalId);
    }).immediate();
  }
  function deleteContribution(userId: string, contributionId: string): void {
    db.transaction(() => {
      const row = db.prepare("SELECT c.goal_id,g.target_minor FROM goal_contributions c JOIN goals g ON g.id=c.goal_id WHERE c.id=? AND c.user_id=?")
        .get(contributionId, userId) as { goal_id: string; target_minor: number } | undefined;
      if (!row) throw new Error("Your contribution was not found.");
      requireGoalMember(userId, row.goal_id);
      db.prepare("DELETE FROM goal_contributions WHERE id=? AND user_id=?").run(contributionId, userId);
      const raised = safeGoalTotal(row.goal_id);
      db.prepare("UPDATE goals SET status=? WHERE id=? AND status!='archived'").run(raised >= row.target_minor ? "completed" : "active", row.goal_id);
    }).immediate();
  }
  function deleteAccountOwner(userId: string, adminHandoffTo?: string): void {
    db.transaction(() => {
      const user = getUserById(userId);
      if (!user) throw new Error("User not found.");
      if (user.role === "admin") {
        const enabled = db.prepare("SELECT id FROM users WHERE enabled=1 AND id!=?").all(userId) as { id: string }[];
        if (enabled.length && !adminHandoffTo) throw new Error("Choose an enabled user to receive admin access before deleting this account.");
        if (adminHandoffTo) {
          if (!enabled.some((entry) => entry.id === adminHandoffTo)) throw new Error("Admin handoff must go to another enabled user.");
          db.prepare("UPDATE users SET role='user' WHERE id=?").run(userId);
          db.prepare("UPDATE users SET role='admin' WHERE id=? AND enabled=1").run(adminHandoffTo);
        }
      }
      const managed = db.prepare("SELECT id FROM goals WHERE manager_id=? AND status!='archived'").all(userId) as { id: string }[];
      for (const goal of managed) succession(goal.id, userId);
      db.prepare("UPDATE goal_contributions SET user_id=NULL,member_name='Former member' WHERE user_id=?").run(userId);
      db.prepare("UPDATE goal_members SET user_id=NULL,username_snapshot='Former member',status='former' WHERE user_id=?").run(userId);
      db.prepare("DELETE FROM users WHERE id=?").run(userId);
    }).immediate();
  }
  function deleteAllConversations(userId: string): void {
    db.prepare("DELETE FROM conversations WHERE user_id=?").run(userId);
  }

  return {
    migrate, registerUser, getUserByUsername, getUserById, listUsers, setUserEnabled, setResetCredential, consumeResetCredential,
    listAccounts, createAccount, setDefaultAccount, updateAccount, deleteAccount, listCategories, createCategory, renameCategory,
    createTransaction, getTransaction, listTransactions, updateTransaction, deleteTransaction, getDashboard, getFinanceFacts,
    setAssistantConsent, getAssistantOptIn, createConversation, listConversations, getConversation, addMessage, deleteConversation, deleteAllConversations,
    createGoal, listGoals, inviteToGoal, respondInvitation, listInvitations, updateGoal, changeMembership, addContribution, updateContribution,
    deleteContribution, deleteAccountOwner,
  };
}

export type Store = ReturnType<typeof createStore>;
