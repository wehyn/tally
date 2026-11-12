import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const output = mkdtempSync(path.join(tmpdir(), 'tally-goal-check-'));
const checksum = '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88';
const tool = `http:tla2tools[url=https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar,checksum=sha256:${checksum}]@1.7.4`;
function command(program, args) {
  const result = spawnSync(program, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}
function locate(args) {
  const result = command('mise', args);
  return result.status === 0 ? result.stdout.trim() : null;
}
let jar = process.env.TLA2TOOLS;
let java = process.env.JAVA;
if (!jar || !java) {
  let home = locate(['where', tool]);
  java ??= locate(['which', 'java', '--tool', 'java@temurin-25']);
  if ((!home && !jar) || !java) {
    const install = command('mise', ['install', 'java@temurin-25', tool]);
    if (install.status !== 0) throw new Error(install.stderr);
    home = locate(['where', tool]);
    java ??= locate(['which', 'java', '--tool', 'java@temurin-25']);
  }
  jar ??= path.join(home, 'tla2tools.jar');
}
if (!java) throw new Error('Set JAVA to a Java 11+ executable or install mise');
if (createHash('sha256').update(readFileSync(jar)).digest('hex') !== checksum) {
  throw new Error('TLA2TOOLS must be the pinned tla2tools v1.7.4 release asset');
}
for (const file of ['GoalConcurrency.tla', 'raise.cfg', 'lower.cfg', 'view.mjs']) {
  cpSync(path.join(directory, file), path.join(output, file));
}
let violated = false;
let checkerError = false;
for (const scenario of ['raise', 'lower']) {
  const meta = path.join(output, `${scenario}-states`);
  mkdirSync(meta);
  const result = command(java, ['-XX:+UseParallelGC', '-cp', jar, 'tlc2.TLC',
    '-workers', '1', '-config', path.join(output, `${scenario}.cfg`),
    '-metadir', meta, path.join(output, 'GoalConcurrency.tla')]);
  const log = result.stdout + result.stderr;
  writeFileSync(path.join(output, `${scenario}-tlc.out`), log);
  console.log(`${scenario}:\n${log}`);
  const bug = /Error: Invariant \w+ is violated\./.test(log);
  violated ||= bug;
  checkerError ||= result.status !== 0 && !bug;
}
const selfTest = process.argv.includes('--self-test');
const replay = command(process.execPath, [path.join(directory, 'replay.mjs'), ...(selfTest ? ['--self-test'] : [])]);
writeFileSync(path.join(output, 'replay.out'), replay.stdout + replay.stderr);
console.log(replay.stdout + replay.stderr);
console.log(`Evidence: ${output}`);
console.log('Interpret both models with /statechart using the copied spec, configs, and view.');
// Both normal verification and detector self-test require a clean current model.
process.exitCode = checkerError || violated || replay.status !== 0 ? 1 : 0;
