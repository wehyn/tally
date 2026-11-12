#!/usr/bin/env node
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync, openSync } from 'node:fs';
import { createServer } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { chromium, expect } from '@playwright/test';

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), '../../../..');
const [command, suppliedRun] = process.argv.slice(2);
const run = path.resolve(suppliedRun || path.join(root, '.verification', `repayment-${Date.now()}`));
assert.equal(path.dirname(run), path.join(root, '.verification'), 'Run must be an immediate child of .verification');
const manifestPath = path.join(run, 'instance.json');
const json = (name, value) => writeFileSync(path.join(run, name), JSON.stringify(value, null, 2));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const load = () => JSON.parse(readFileSync(manifestPath, 'utf8'));
const fixtures = new Map([
  ['Maybe Mom paid me 100', { counterparty: 'Mom', amount: '100' }],
  ['Mom did not pay me 100', { counterparty: 'Mom', amount: '100' }],
  ['Nobody paid me 100', { counterparty: 'Nobody', amount: '100' }],
  ['Mom and Ari paid me 100', { counterparty: 'Mom', amount: '100' }],
  ['Mom paid me 1001', { counterparty: 'Mom', amount: '1001' }],
  ['Mom paid me 10 into Wallet', { counterparty: 'Ari', amount: '10', account: 'Wallet' }],
  ['Mom paid me', { counterparty: 'Mom', amount: '100' }],
  ['100', { counterparty: 'Mom', amount: '100' }],
  ['Mom paid me 900', { counterparty: 'Mom', amount: '900' }],
]);

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function owned(instance) {
  try {
    const argv = readFileSync(`/proc/${instance.pid}/cmdline`, 'utf8').split('\0');
    return argv.includes(script) && argv.includes('serve') && argv.includes(run);
  } catch { return false; }
}
async function doctor() {
  const instance = load();
  assert(owned(instance), 'Owned verification supervisor is not alive');
  assert.equal(instance.head, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), 'Checkout HEAD changed; start a fresh run');
  const health = await fetch(`${instance.url}/api/health`, { signal: AbortSignal.timeout(5000) }).then(r => r.json());
  assert.equal(health.service, 'tally');
  const register = await fetch(`${instance.url}/register`, { signal: AbortSignal.timeout(5000) });
  assert(register.ok && (await register.text()).includes('Create your account'), 'Registration page is not usable');
  const provider = await fetch(`${instance.providerUrl}/health`, { signal: AbortSignal.timeout(5000) }).then(r => r.json());
  assert.equal(provider.run, run, 'Provider belongs to another run');
  if (existsSync(path.join(run, 'data/tally.sqlite'))) {
    const db = new Database(path.join(run, 'data/tally.sqlite'), { readonly: true });
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
    db.close();
  }
  const result = { status: 'PASS', url: instance.url, pid: instance.pid, head: instance.head, checkedAt: new Date().toISOString() };
  json('doctor.json', result);
  console.log(JSON.stringify(result));
}
async function up() {
  assert(!existsSync(run), 'Use a fresh run directory');
  mkdirSync(run, { recursive: true });
  json('ownership.json', { root, run, script });
  let child;
  try {
    const app = path.join(run, 'app');
    mkdirSync(app);
    for (const item of ['src', 'public', 'package.json', 'package-lock.json', 'next.config.ts', 'tsconfig.json', 'next-env.d.ts', 'postcss.config.mjs']) {
      if (existsSync(path.join(root, item))) cpSync(path.join(root, item), path.join(app, item), { recursive: true });
    }
    symlinkSync(path.join(root, 'node_modules'), path.join(app, 'node_modules'), 'dir');
    const port = await freePort();
    let providerPort = await freePort();
    while (providerPort === port) providerPort = await freePort();
    const log = openSync(path.join(run, 'server.log'), 'a');
    child = spawn(process.execPath, [script, 'serve', run, String(port), String(providerPort)], { cwd: root, detached: true, stdio: ['ignore', log, log] });
    child.unref();
    for (let attempt = 0; attempt < 120; attempt++) {
      if (existsSync(manifestPath)) {
        const instance = load();
        assert(owned(instance), 'Verification process exited; inspect server.log');
        try { await doctor(); console.log(`RUN=${run}`); return; } catch { /* Next may still be compiling. */ }
      }
      await pause(500);
    }
    throw new Error(`Startup timed out; inspect ${run}/server.log`);
  } catch (error) {
    if (child && !existsSync(manifestPath)) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
    await down();
    throw error;
  }
}
async function serve() {
  const [port, providerPort] = process.argv.slice(4).map(Number);
  const calls = [];
  const provider = createServer(async (request, response) => {
    if (request.url === '/health') { response.end(JSON.stringify({ run })); return; }
    try {
      assert.equal(request.url, '/v1/chat/completions');
      let raw = '';
      for await (const part of request) raw += part;
      const body = JSON.parse(raw);
      const prompt = body.messages.filter(message => message.role === 'user').at(-1).content;
      const args = fixtures.get(prompt);
      assert(args, `No provider fixture for ${prompt}`);
      calls.push({ prompt, messages: body.messages, args });
      json('provider-calls.json', calls);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'verification-call', type: 'function', function: { name: 'record_debt_payment', arguments: JSON.stringify(args) } }] } }] }));
    } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => provider.listen(providerPort, '127.0.0.1', resolve));
  const instance = { run, script, pid: process.pid, url: `http://127.0.0.1:${port}`, providerUrl: `http://127.0.0.1:${providerPort}`, head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), startedAt: new Date().toISOString() };
  json('instance.json', instance);
  const env = { ...process.env, TALLY_DATA_DIR: path.join(run, 'data'), TALLY_DB_PATH: path.join(run, 'data/tally.sqlite'), TALLY_COOKIE_SECURE: 'false', SESSION_SECRET: 'isolated-verification-only-session-secret', CODEX_LB_BASE_URL: `${instance.providerUrl}/v1`, CODEX_LB_MODEL: 'verification-fixtures', CODEX_LB_API_KEY: 'local-stub-only', CODEX_LB_PRIVACY_DISCLOSURE: 'Local verification stub. Synthetic prompts and debt context are saved in this run directory. No external provider is contacted.' };
  let next;
  let stopping = false;
  let retriedUpgradeNudge = false;
  function startNext() {
    next = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: path.join(run, 'app'), env, stdio: 'inherit' });
    next.on('exit', code => {
      const log = readFileSync(path.join(run, 'server.log'), 'utf8');
      if (!stopping && !retriedUpgradeNudge && log.includes('This command stopped to show the upgrade recommendation.')) {
        retriedUpgradeNudge = true;
        console.log('Retrying Next once after its upgrade advisory stop; dependencies stay unchanged.');
        startNext();
      } else { provider.close(); process.exit(code ?? 1); }
    });
  }
  startNext();
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stopping = true; next.kill(signal); provider.close(); });
}
function financialState(db) {
  return {
    accounts: db.prepare('SELECT id,user_id,name,opening_minor,balance_adjustment_minor_exact,is_default FROM financial_accounts ORDER BY id').all(),
    debts: db.prepare('SELECT id,user_id,counterparty,direction,amount_minor,status FROM debts ORDER BY created_at,id').all(),
    transactions: db.prepare('SELECT user_id,kind,amount_minor,account_id,category_id,debt_id,undo_until FROM transactions ORDER BY created_at,id').all(),
    payments: db.prepare('SELECT user_id,debt_id,amount_minor,transaction_id FROM debt_payments ORDER BY created_at,id').all(),
  };
}
async function drive() {
  await doctor();
  const instance = load();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const page = await context.newPage();
  const actions = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let db;
  const shot = async name => page.screenshot({ path: path.join(run, `${name}.png`), fullPage: true });
  try {
    await page.goto(`${instance.url}/register`);
    await page.getByLabel('Username', { exact: true }).fill('verify_repayment');
    await page.getByLabel('Password', { exact: true }).fill('synthetic-verification-password');
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await page.waitForURL('**/dashboard');
    actions.push('Registered a fresh owner through the UI');
    await page.goto(`${instance.url}/accounts`);
    await page.getByRole('button', { name: 'New account', exact: true }).click();
    await page.getByLabel('Account name').fill('Wallet');
    await page.getByLabel('Set balance').fill('0');
    await page.getByRole('dialog').getByRole('button', { name: 'Create account', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.goto(`${instance.url}/debts`);
    for (const [name, amount] of [['Mom', '1000'], ['Mom', '200'], ['Ari', '500']]) {
      await page.getByRole('button', { name: 'Add debt', exact: true }).first().click();
      await page.getByLabel('Person or organization').fill(name);
      await page.getByLabel('Current amount').fill(amount);
      await page.getByRole('dialog').getByRole('button', { name: 'Add debt', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }
    actions.push('Created Wallet and three debts through the UI, including two Mom debts');
    await shot('01-debts-before');
    await page.goto(`${instance.url}/settings`);
    await expect(page.locator('.disclosure')).toBeVisible();
    await expect(page.locator('.disclosure')).toContainText('Local verification stub. Synthetic prompts and debt context are saved in this run directory. No external provider is contacted.');
    await page.getByRole('checkbox', { name: /I have read this disclosure/ }).check();
    await page.getByRole('switch', { name: 'Enable hosted assistant' }).click();
    await expect(page.getByRole('switch', { name: 'Enable hosted assistant' })).toHaveAttribute('aria-checked', 'true');
    db = new Database(path.join(run, 'data/tally.sqlite'), { readonly: true });
    const before = financialState(db);
    assert.equal(before.transactions.length, 0);
    json('before.json', before);
    async function prompt(text) {
      if (await page.getByRole('button', { name: 'Open Tally assistant', exact: true }).isVisible()) await page.getByRole('button', { name: 'Open Tally assistant', exact: true }).click();
      await page.getByPlaceholder('Ask Tally anything…').fill(text);
      await shot(`action-${actions.length}`);
      const responsePromise = page.waitForResponse(r => r.url().endsWith('/api/assistant') && r.request().method() === 'POST');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      const response = await responsePromise;
      const result = await response.json();
      assert.equal(response.status(), 200, JSON.stringify(result));
      actions.push({ prompt: text, response: result });
      json('actions.json', actions);
      if (result.transaction) {
        await expect(page.getByRole('article', { name: 'Recorded transaction' }).last()).toContainText('Debt repayment');
      } else await expect(page.getByLabel('Conversation', { exact: true })).toContainText(result.answer);
      return result;
    }
    const rejections = [
      ['Maybe Mom paid me 100', /confirm that the payment happened/i],
      ['Mom did not pay me 100', /confirm that the payment happened/i],
      ['Nobody paid me 100', /ordinary income/i],
      ['Mom and Ari paid me 100', /which person's open debt/i],
      ['Mom paid me 1001', /more than.*1,000/i],
      ['Mom paid me 10 into Wallet', /confirm which person/i],
    ];
    for (const [text, expectedAnswer] of rejections) {
      await page.reload();
      const result = await prompt(text);
      assert.equal(result.transaction, null, `Unexpected transaction for ${text}`);
      assert.match(result.answer, expectedAnswer);
      assert.deepEqual(financialState(db), before, `Financial writes during clarification: ${text}`);
      await shot(`clarification-${actions.length}`);
    }
    await page.reload();
    const missing = await prompt('Mom paid me');
    assert.equal(missing.transaction, null);
    assert.match(missing.answer, /amount/i);
    assert.deepEqual(financialState(db), before);
    const partial = await prompt('100');
    assert.equal(partial.transaction.kind, 'debt_repayment');
    assert.equal(partial.transaction.amountMinor, 10000);
    assert.equal(partial.transaction.categoryName, null);
    assert.equal(partial.transaction.undoUntil, null);
    assert.equal(partial.debt.amountMinor, 90000);
    const oldest = before.debts.find(debt => debt.counterparty === 'Mom');
    assert.equal(partial.debt.id, oldest.id);
    await expect(page.getByRole('article', { name: 'Recorded transaction' })).toContainText('100.00');
    await expect(page.getByRole('dialog', { name: 'Tally assistant' }).getByRole('button', { name: /Undo/ })).toHaveCount(0);
    json('partial.json', financialState(db));
    await shot('02-partial-payment');
    const full = await prompt('Mom paid me 900');
    assert.equal(full.debt.id, oldest.id);
    assert.equal(full.debt.status, 'settled');
    assert.equal(full.debt.amountMinor, 90000);
    assert.equal(full.transaction.amountMinor, 90000);
    await shot('03-settled-assistant');
    await page.goto(`${instance.url}/debts`);
    await page.getByRole('button', { name: 'Settled', exact: true }).click();
    await expect(page.locator('.debt-row').filter({ hasText: 'Mom' })).toContainText('last outstanding balance');
    await shot('04-settled-debt');
    await page.goto(`${instance.url}/transactions`);
    await expect(page.getByRole('cell', { name: 'Debt repayment', exact: true })).toHaveCount(2);
    await shot('05-ledger');
    const dashboard = await context.request.get(`${instance.url}/api/dashboard`).then(r => r.json());
    json('dashboard.json', dashboard);
    assert.equal(dashboard.incomeMinor, 0);
    assert.equal(dashboard.spendingMinor, 0);
    assert.equal(dashboard.debtRepaymentMinor, 100000);
    assert.equal(dashboard.netCashFlowMinor, 100000);
    const accounts = await context.request.get(`${instance.url}/api/accounts`).then(r => r.json());
    json('accounts.json', accounts);
    assert.equal(accounts.accounts.length, 1);
    assert.equal(accounts.accounts[0].balanceMinor, 100000);
    assert.equal(accounts.accounts[0].name, 'Wallet');
    const after = financialState(db);
    assert.equal(after.transactions.length, 2);
    assert.equal(after.payments.length, 2);
    const settled = after.debts.find(debt => debt.id === oldest.id);
    assert.equal(settled.status, 'settled');
    assert.equal(settled.amount_minor, 90000);
    assert.equal(after.payments.reduce((sum, payment) => sum + payment.amount_minor, 0), 100000);
    assert(after.payments.every(payment => payment.debt_id === oldest.id));
    assert(after.transactions.every(t => t.kind === 'debt_repayment' && t.category_id === null && t.undo_until === null && t.debt_id === oldest.id));
    assert.deepEqual(after.debts.filter(d => d.id !== oldest.id), before.debts.filter(d => d.id !== oldest.id));
    const calls = JSON.parse(readFileSync(path.join(run, 'provider-calls.json'), 'utf8'));
    assert(calls.every(call => !/Mom|Ari/.test(call.messages.filter(m => m.role === 'system').map(m => m.content).join(' '))), 'Counterparty leaked into system prompt');
    assert(calls.some(call => call.messages.some(m => m.role !== 'system' && m.content.includes('"counterparty":"Mom","amount":"₱1,000.00"'))), 'Debt context missing');
    assert.deepEqual(errors, []);
    json('after.json', after);
    json('result.json', { status: 'PASS', provider: 'local stub; live model not verified', actions: actions.length, pageErrors: errors, completedAt: new Date().toISOString() });
    console.log(`PASS ${run}`);
  } catch (error) {
    await shot('failure').catch(() => {});
    json('result.json', { status: 'FAIL', error: error.stack, actions, pageErrors: errors });
    throw error;
  } finally {
    db?.close();
    await context.tracing.stop({ path: path.join(run, 'trace.zip') });
    await browser.close();
  }
}
async function down() {
  const ownership = JSON.parse(readFileSync(path.join(run, 'ownership.json'), 'utf8'));
  assert.deepEqual(ownership, { root, run, script }, 'Refusing cleanup of an unowned run');
  if (existsSync(manifestPath)) {
    const instance = load();
    assert.equal(instance.run, run, 'Manifest belongs to another run');
    assert.equal(instance.script, script, 'Manifest belongs to another helper');
    if (owned(instance)) {
      process.kill(-instance.pid, 'SIGTERM');
      for (let i = 0; i < 40 && owned(instance); i++) await pause(100);
      assert(!owned(instance), 'Owned supervisor did not stop');
    }
    for (const url of [instance.url, instance.providerUrl]) {
      let reachable = false;
      try { await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) }); reachable = true; } catch {}
      assert(!reachable, `Port still responds after cleanup: ${url}`);
    }
  }
  rmSync(path.join(run, 'app'), { recursive: true, force: true });
  rmSync(path.join(run, 'data'), { recursive: true, force: true });
  json('cleanup.json', { status: 'PASS', processesStopped: true, scratchRemoved: true, evidenceRetained: existsSync(path.join(run, 'result.json')), completedAt: new Date().toISOString() });
  console.log(`Stopped verification instance; evidence retained at ${run}`);
}
try {
  assert(['up', 'serve', 'doctor', 'drive', 'down'].includes(command), 'Usage: verify.mjs up|doctor|drive|down [absolute run directory]');
  await ({ up, serve, doctor, drive, down })[command]();
} catch (error) { console.error(error); process.exitCode = 1; }
