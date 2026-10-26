// break-members.mjs — P2's break script (GHSA-gxfq correction). It removes ONE member, or one
// structural part (E1, E2, LINES, D), at a time from `redaction-variants.ts` (in core since #729 PR-3),
// rebuilds core and the CLI, runs `redaction-printers.test.ts` and core's P2 (`redaction-variants.test.ts`,
// with `--tests`), records the red rows, then restores the file with
// `git checkout HEAD -- <file>`. It also runs E1 and E2 together, and the trim dropped from B1 and
// B2 together. Its log goes to stdout.
//
//   node break-members.mjs [--only <break,break,...>] [--tests <file,file,...>]
//
// Run it on a committed tree: each break is undone from HEAD, and the script refuses to start when
// the file differs from HEAD. `--only` runs the named breaks alone (any id below, or a named break
// from NAMED); `--tests` adds test files (paths from `packages/cli`) to run under each break.
/* global console, process, URL */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const here = new URL('.', import.meta.url).pathname;
const cli = join(here, '..', '..', '..', '..');
const root = join(cli, '..', '..');
const FILE = 'packages/core/src/utils/redaction-variants.ts';
const PRINTERS = 'src/agent/providers/redaction-printers.test.ts';

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1].split(',').filter(Boolean);
};
const only = option('--only');
const tests = [PRINTERS, ...(option('--tests') ?? [])];

const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
if (git('status', '--porcelain', '--', FILE) !== '') {
  console.error(`${FILE} differs from HEAD: commit it first.`);
  process.exit(2);
}
const source = readFileSync(join(root, FILE), 'utf8');

/** Each member's line in MEMBERS, in order. */
const membersBlock = source.slice(
  source.indexOf('const MEMBERS'),
  source.indexOf('};', source.indexOf('const MEMBERS')),
);
const MEMBER_IDS = [...membersBlock.matchAll(/^ {2}(\w+): \w+,$/gm)].map((m) => m[1]);

/** A break: exact replacements, each of which must match exactly once. */
const memberBreak = (id) => [[new RegExp(`^ {2}${id}: \\w+,\\n`, 'm'), '']];
const partLine = (marker) => [[new RegExp(`^.*// ${marker}:.*\\n`, 'm'), '']];
const NAMED = {
  E1: partLine('E1'),
  E2: partLine('E2'),
  LINES: partLine('LINES'),
  D: partLine('D'),
  'E1+E2': [...partLine('E1'), ...partLine('E2')],
  'B1+B2 trim': [['return [...untrimmed, ...trimmed].filter(', 'return [...untrimmed].filter(']],
  'B1+B2': [...memberBreak('B1'), ...memberBreak('B2')],
  'B1+B2 shift-1': [['const shifts = [0, 1, 2]', 'const shifts = [0, 2]']],
  'B1+B2 shift-2': [['const shifts = [0, 1, 2]', 'const shifts = [0, 1]']],
  'J4a+J5': [...memberBreak('J4a'), ...memberBreak('J5')],
  'base64 floor': [
    [
      'return [...untrimmed, ...trimmed].filter((form) => form.length >= MIN_FORM_LENGTH);',
      'return [...untrimmed, ...trimmed];',
    ],
    [
      '.map(toBase64Url)\n      .filter((form) => form.length >= MIN_FORM_LENGTH),',
      '.map(toBase64Url),',
    ],
  ],
  'lines floor': [
    [
      '.filter((line) => line.length >= MIN_FORM_LENGTH && !/\\s/.test(line));',
      '.filter((line) => !/\\s/.test(line));',
    ],
  ],
  'lines blank rule': [
    [
      '.filter((line) => line.length >= MIN_FORM_LENGTH && !/\\s/.test(line));',
      '.filter((line) => line.length >= MIN_FORM_LENGTH);',
    ],
  ],
};
const DEFAULT = [...MEMBER_IDS, 'E1', 'E2', 'LINES', 'D', 'E1+E2', 'B1+B2 trim'];
const breaks = (only ?? DEFAULT).map((id) => {
  const edits = NAMED[id] ?? (MEMBER_IDS.includes(id) ? memberBreak(id) : undefined);
  if (edits === undefined) throw new Error(`unknown break ${id}`);
  return { id, edits };
});

function apply(text, edits, id) {
  let out = text;
  for (const [from, to] of edits) {
    const count =
      typeof from === 'string'
        ? out.split(from).length - 1
        : (out.match(new RegExp(from.source, `${from.flags}g`)) ?? []).length;
    if (count !== 1) throw new Error(`break ${id}: an edit matches ${count} times, not once`);
    out = out.replace(from, to);
  }
  return out;
}

const env = { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1' };
function build() {
  execFileSync('npx', ['tsc', '--build', 'packages/cli/tsconfig.json'], {
    cwd: root,
    env,
    stdio: 'inherit',
  });
}

/** Runs the test files; returns the titles of the failed tests and the counts. */
function run() {
  const home = mkdtempSync(join(tmpdir(), 'break-members-'));
  const report = join(home, 'report.json');
  spawnSync('npx', ['vitest', 'run', ...tests, '--reporter=json', `--outputFile=${report}`], {
    cwd: cli,
    env: { ...env, HOME: home },
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  const json = JSON.parse(readFileSync(report, 'utf8'));
  rmSync(home, { recursive: true, force: true });
  const results = json.testResults.flatMap((f) => f.assertionResults);
  return {
    total: results.length,
    red: results.filter((r) => r.status === 'failed').map((r) => r.fullName),
  };
}

console.log(`break-members: ${breaks.length} breaks; tests: ${tests.join(', ')}`);
const summary = [];
for (const { id, edits } of breaks) {
  writeFileSync(join(root, FILE), apply(source, edits, id));
  try {
    build();
    const { total, red } = run();
    // vitest writes each P1 title as `P1 — '<printer>' x '<case>' ('<runtime>')`.
    const sepRed =
      MEMBER_IDS.includes(id) || ['E1', 'E2', 'LINES', 'D'].includes(id)
        ? red.some((t) => t.includes(` x 'sep_${id}' (`))
        : undefined;
    summary.push({ id, red: red.length, sepRed });
    console.log(
      `\nBREAK ${id}: ${red.length} of ${total} red${sepRed === undefined ? '' : `; separating row ${sepRed ? 'RED' : 'green'}`}`,
    );
    for (const t of red) console.log(`  red: ${t}`);
  } finally {
    git('checkout', 'HEAD', '--', FILE);
  }
}
build();
console.log('\nSUMMARY (break: red tests; separating row)');
for (const s of summary)
  console.log(
    `  ${s.id}: ${s.red}${s.sepRed === undefined ? '' : `; ${s.sepRed ? 'RED' : 'green'}`}`,
  );
console.log(
  `\ngit status after the script: ${git('status', '--porcelain', '--', FILE) === '' ? 'clean' : 'DIRTY'}`,
);
