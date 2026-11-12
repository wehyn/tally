import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { tsImport } from 'tsx/esm/api';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const scratch = mkdtempSync(path.join(tmpdir(), 'tally-goal-replay-'));

// Execute every real statement unchanged. At the old race boundaries, attempt
// the competing operation on another connection; its BEGIN IMMEDIATE must block.
function schedule(db, hooks) {
  return new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') return (sql) => {
        const stmt = target.prepare(sql);
        return new Proxy(stmt, {
          get(statement, method) {
            if (method === 'get') return (...args) => {
              const row = statement.get(...args);
              if (sql.startsWith('SELECT g.* FROM goals g JOIN goal_members')) hooks.goalRead?.();
              if (sql.startsWith('SELECT COALESCE(SUM(amount_minor),0) AS total FROM goal_contributions')) hooks.totalRead?.();
              return row;
            };
            const value = Reflect.get(statement, method, statement);
            return typeof value === 'function' ? value.bind(statement) : value;
          },
        });
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function run(source, name, initial, edited, order) {
  const { createStore } = await tsImport(pathToFileURL(path.join(source, 'store.ts')).href, import.meta.url);
  const filename = path.join(scratch, `${name}.sqlite`);
  const a = new Database(filename, { timeout: 0 });
  a.pragma('journal_mode = WAL');
  const seed = createStore(a);
  seed.migrate();
  const user = seed.registerUser('goal_checker', 'test-hash');
  const goal = seed.createGoal(user.id, { name: 'Shared goal', targetMinor: initial });
  const b = new Database(filename, { timeout: 0 });
  b.pragma('foreign_keys = ON');
  const contributionHooks = {};
  const editorHooks = {};
  const contributor = createStore(schedule(a, contributionHooks));
  const editor = createStore(schedule(b, editorHooks));
  const add = () => contributor.addContribution(user.id, goal, { amountMinor: 100, date: '2026-11-12' });
  const edit = () => editor.updateGoal(user.id, goal, { targetMinor: edited });
  let lockProbe = null;
  function probe(operation) {
    try { operation(); lockProbe = 'competing write succeeded'; }
    catch (error) {
      if (error.code !== 'SQLITE_BUSY') throw error;
      lockProbe = 'SQLITE_BUSY';
    }
  }
  try {
    if (order === 'contribution-first') {
      contributionHooks.goalRead = () => {
        contributionHooks.goalRead = null;
        probe(edit);
      };
      add();
      if (lockProbe === 'SQLITE_BUSY') edit();
    } else if (order === 'editor-first') {
      editorHooks.totalRead = () => {
        editorHooks.totalRead = null;
        probe(add);
      };
      edit();
      if (lockProbe === 'SQLITE_BUSY') add();
    } else add();
    const row = a.prepare(`SELECT target_minor AS target, status,
      (SELECT COALESCE(SUM(amount_minor),0) FROM goal_contributions WHERE goal_id=goals.id) AS raised
      FROM goals WHERE id=?`).get(goal);
    const violations = [];
    if (row.status === 'completed' && row.raised < row.target) violations.push('CompletionSound');
    if (row.raised >= row.target && row.status !== 'completed') violations.push('CompletionRecognized');
    let nextContribution;
    try {
      seed.addContribution(user.id, goal, { amountMinor: 1, date: '2026-11-12' });
      nextContribution = 'accepted';
    } catch (error) { nextContribution = error.message; }
    return { name, lockProbe, stored: row, violations, nextContribution };
  } finally { b.close(); a.close(); }
}

async function baseline(source, prefix) {
  const results = [await run(source, `${prefix}-equality`, 100, 100, 'serial')];
  for (const [label, initial, edited] of [['raise', 100, 200], ['lower', 200, 100]]) {
    for (const order of ['contribution-first', 'editor-first']) {
      results.push(await run(source, `${prefix}-${label}-${order}`, initial, edited, order));
    }
  }
  for (const result of results) {
    assert.deepEqual(result.violations, [], result.name);
    assert.equal(result.stored.status, result.stored.raised >= result.stored.target ? 'completed' : 'active');
    if (result.lockProbe !== null) assert.equal(result.lockProbe, 'SQLITE_BUSY', result.name);
    assert.equal(result.nextContribution === 'accepted', result.stored.status === 'active', result.name);
  }
  return results;
}

function mutateTransaction(source, name) {
  const start = source.indexOf(`  function ${name}(`);
  const end = source.indexOf('\n  function ', start + 1);
  const block = source.slice(start, end);
  assert.ok(block.includes('db.transaction(() => {') && block.includes('}).immediate();'));
  let broken;
  if (name === 'updateGoal') {
    broken = block.replace('    db.transaction(() => {\n', '').replace('    }).immediate();\n', '');
  } else {
    // Restore the old unlocked preflight while retaining the write transaction.
    const opening = '    return db.transaction(() => {\n';
    const preflightEnd = block.indexOf('      const username');
    const preflightStart = block.indexOf(opening) + opening.length;
    const preflight = block.slice(preflightStart, preflightEnd);
    broken = block.slice(0, block.indexOf(opening)) + preflight + opening + block.slice(preflightEnd);
  }
  assert.notEqual(broken, block);
  return source.slice(0, start) + broken + source.slice(end);
}

try {
  const source = path.join(root, 'src/lib');
  console.log(JSON.stringify({ baseline: await baseline(source, 'current') }, null, 2));
  if (process.argv.includes('--self-test')) {
    symlinkSync(path.join(root, 'node_modules'), path.join(scratch, 'node_modules'), 'dir');
    const storeSource = readFileSync(path.join(source, 'store.ts'), 'utf8');
    const lifecycle = readFileSync(path.join(source, 'lifecycle.ts'), 'utf8');
    const cases = [
      { name: 'unlocked-contribution-read', initial: 100, edited: 200, order: 'contribution-first', rule: 'CompletionSound', store: mutateTransaction(storeSource, 'addContribution') },
      { name: 'unlocked-target-edit', initial: 200, edited: 100, order: 'editor-first', rule: 'CompletionRecognized', store: mutateTransaction(storeSource, 'updateGoal') },
      { name: 'strict-equality', initial: 100, edited: 100, order: 'serial', rule: 'CompletionRecognized', predicate: 'raisedMinor > targetMinor' },
      { name: 'premature-completion', initial: 200, edited: 200, order: 'serial', rule: 'CompletionSound', predicate: 'true' },
    ];
    for (const variant of cases) {
      const mutant = path.join(scratch, variant.name);
      cpSync(source, mutant, { recursive: true });
      if (variant.store) writeFileSync(path.join(mutant, 'store.ts'), variant.store);
      if (variant.predicate) {
        const broken = lifecycle.replace('raisedMinor >= targetMinor', variant.predicate);
        assert.notEqual(broken, lifecycle, 'Mutation no longer applies; review source/model sync');
        writeFileSync(path.join(mutant, 'lifecycle.ts'), broken);
      }
      const result = await run(mutant, variant.name, variant.initial, variant.edited, variant.order);
      assert.deepEqual(result.violations, [variant.rule], variant.name);
      if (variant.store) assert.equal(result.lockProbe, 'competing write succeeded');
      console.log(JSON.stringify({ scratchBreak: result }, null, 2));
    }
    await baseline(source, 'after-scratch');
    console.log('SELF-TEST PASS: all four scratch breaks caught; original invariants and lock probes pass again.');
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
