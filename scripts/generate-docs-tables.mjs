#!/usr/bin/env node
// scripts/generate-docs-tables.mjs — Q1 (#592) d1: two reference pages kept equal to core's word
// lists, read from the BUILT core (`packages/core/dist`), never from the `.ts` text.
// - `mcp/run-state-and-health.md`: writes the intro's two counts; checks that the
//   `next_actions_status` table has one row per word of `NEXT_ACTIONS_STATUS` and no other, and
//   that the findings section documents exactly `RUN_HEALTH_KINDS` (as a table row's first cell, or
//   a whole backticked token in its sentences).
// - `error-codes.md`: writes the intro's three counts, the "nothing raises" header's count and its
//   list, from `ERROR_CODES` and a scan of where Realm's code writes each code; checks that each
//   code has a row under "The codes Realm raises" or is in that list, never both and never neither,
//   and that no row names a code outside `ERROR_CODES`.
// Nothing else changes, and a second run changes nothing. A count it cannot place, a stray row or a
// word left out is printed with its page, and it exits 1 writing nothing.
// Usage: node scripts/generate-docs-tables.mjs [--pages <dir>] (default: docs/reference). After
// `npm run build`, `npm run docs:tables` regenerates the committed pages.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let pagesDir = join(ROOT, 'docs/reference');
if (args.length === 2 && args[0] === '--pages') pagesDir = resolve(args[1]);
else if (args.length !== 0) {
  console.error('usage: node scripts/generate-docs-tables.mjs [--pages <dir>]');
  process.exit(2);
}
const CORE = join(ROOT, 'packages/core/dist/index.js');
if (!existsSync(CORE)) {
  console.error(`${CORE} does not exist: run \`npm run build\` first`);
  process.exit(1);
}
const { NEXT_ACTIONS_STATUS, RUN_HEALTH_KINDS, ERROR_CODES } = await import(
  pathToFileURL(CORE).href
);

const errors = [];
const RUN_STATE = 'mcp/run-state-and-health.md';
const ERROR_PAGE = 'error-codes.md';

/** Writes `n` for the `<N>` of `sentence`, which must be on the page exactly once. */
function setCount(page, text, [sentence, n]) {
  const [a, b] = sentence.split('<N>').map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`(?<=${a})\\d+(?=${b})`, 'g');
  const found = text.match(pattern) ?? [];
  if (found.length === 1) return text.replace(pattern, String(n));
  errors.push(`${page}: cannot place the count in "${sentence}": found ${found.length} times`);
  return text;
}

/** The lines from the heading `heading` to the next line starting with `stop` (any heading). */
function section(page, text, heading, stop = /^#/) {
  const lines = text.split('\n');
  const start = lines.indexOf(heading);
  if (start === -1) {
    errors.push(`${page}: the heading "${heading}" is not on the page`);
    return [];
  }
  const end = lines.findIndex((l, i) => i > start && stop.test(l));
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

/** The first cell of every row of every table in `lines`, after each table's header and rule. */
function firstCells(lines) {
  const cells = [];
  lines.forEach((line, i) => {
    const row = i >= 2 && line.startsWith('|') && lines[i - 1].startsWith('|');
    if (row && lines[i - 2].startsWith('|')) cells.push(line.split('|')[1].trim());
  });
  return cells;
}

/** The backticked word a cell holds alone, or undefined. */
const wordOf = (cell) => /^`([^`]+)`$/.exec(cell)?.[1];

// --- run-state-and-health.md ---------------------------------------------------------------------
let runState = readFileSync(join(pagesDir, RUN_STATE), 'utf8');
for (const count of [
  ['the <N> values of `next_actions_status`', NEXT_ACTIONS_STATUS.length],
  ['and the <N> health findings, which', RUN_HEALTH_KINDS.length],
])
  runState = setCount(RUN_STATE, runState, count);
const statusRows = firstCells(section(RUN_STATE, runState, '## `next_actions_status`'));
const statusSeen = new Set();
for (const cell of statusRows) {
  const word = wordOf(cell);
  if (word === undefined || !NEXT_ACTIONS_STATUS.includes(word))
    errors.push(`${RUN_STATE}: next_actions_status has a row for ${cell}, not one of its words`);
  else if (statusSeen.has(word))
    errors.push(`${RUN_STATE}: the next_actions_status table has two rows for \`${word}\``);
  statusSeen.add(word);
}
for (const word of NEXT_ACTIONS_STATUS)
  if (!statusSeen.has(word))
    errors.push(`${RUN_STATE}: the next_actions_status table has no row for \`${word}\``);
const findings = section(RUN_STATE, runState, '### The findings');
const documented = new Set();
for (const cell of firstCells(findings)) {
  const kind = wordOf(cell);
  if (kind === undefined || !RUN_HEALTH_KINDS.includes(kind))
    errors.push(`${RUN_STATE}: the findings have a row for ${cell}, not a finding kind`);
  else documented.add(kind);
}
for (const line of findings.filter((l) => !l.startsWith('|')))
  for (const [, token] of line.matchAll(/`([^`]+)`/g))
    if (RUN_HEALTH_KINDS.includes(token)) documented.add(token);
for (const kind of RUN_HEALTH_KINDS)
  if (!documented.has(kind))
    errors.push(`${RUN_STATE}: the findings section does not document \`${kind}\``);

// --- error-codes.md ------------------------------------------------------------------------------
// Realm's own code, every file but tests, `.d.ts`, `test-support/` and the type itself: a code is
// raised when its quoted name is written in it.
const sources = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'node_modules' && name !== 'test-support') walk(path);
    } else if (/\.ts$/.test(name) && !/\.(test|d)\.ts$/.test(name)) {
      if (!path.endsWith(join('types', 'workflow-error.ts')))
        sources.push(readFileSync(path, 'utf8'));
    }
  }
};
for (const pkg of readdirSync(join(ROOT, 'packages'))) {
  const src = join(ROOT, 'packages', pkg, 'src');
  if (existsSync(src) && statSync(src).isDirectory()) walk(src);
}
const unraised = ERROR_CODES.filter((code) => !sources.some((s) => s.includes(`'${code}'`)));

let errorPage = readFileSync(join(pagesDir, ERROR_PAGE), 'utf8');
for (const count of [
  ['This page lists all <N> codes that Realm defines', ERROR_CODES.length],
  ['Realm defines: the <N> it raises,', ERROR_CODES.length - unraised.length],
  [', and the <N> that nothing raises.', unraised.length],
  ['These <N> are in the `ErrorCode` type, and no code in Realm raises them:', unraised.length],
])
  errorPage = setCount(ERROR_PAGE, errorPage, count);
// The block: the list, comma-separated, each line at most 100 characters.
const block = [''];
unraised.forEach((code, i) => {
  const word = i < unraised.length - 1 ? `${code},` : code;
  const last = block.length - 1;
  if (block[last] === '') block[last] = word;
  else if (block[last].length + 1 + word.length <= 100) block[last] += ` ${word}`;
  else block.push(word);
});
const blockAt =
  /(\n## The codes nothing raises\n(?:(?!\n#)[\s\S])*?\n```text\n)(?:(?!\n```)[\s\S])*(\n```\n)/;
if (blockAt.test(errorPage))
  errorPage = errorPage.replace(blockAt, (_, a, b) => a + block.join('\n') + b);
else errors.push(`${ERROR_PAGE}: no \`\`\`text block under "## The codes nothing raises"`);
const raisesPart = section(ERROR_PAGE, errorPage, '## The codes Realm raises', /^## /);
const rowCodes = new Set();
for (const line of raisesPart) {
  const code = /^\| `([A-Z][A-Z0-9_]*)` +\|/.exec(line)?.[1];
  if (code === undefined) continue;
  if (!ERROR_CODES.includes(code))
    errors.push(`${ERROR_PAGE}: a row names \`${code}\`, which is not an ErrorCode`);
  rowCodes.add(code);
}
for (const code of ERROR_CODES) {
  const inRows = rowCodes.has(code);
  const inBlock = unraised.includes(code);
  if (inRows && inBlock)
    errors.push(`${ERROR_PAGE}: \`${code}\` has a row, but nothing in Realm's code raises it`);
  if (!inRows && !inBlock)
    errors.push(`${ERROR_PAGE}: \`${code}\` is raised in Realm's code but has no row`);
}

if (errors.length > 0) {
  for (const e of errors) console.error(e);
  process.exit(1);
}
writeFileSync(join(pagesDir, RUN_STATE), runState);
writeFileSync(join(pagesDir, ERROR_PAGE), errorPage);
console.log(
  `${RUN_STATE}: ${NEXT_ACTIONS_STATUS.length} next_actions_status values, ${RUN_HEALTH_KINDS.length} health findings\n` +
    `${ERROR_PAGE}: ${ERROR_CODES.length} codes defined, ${ERROR_CODES.length - unraised.length} raised, ${unraised.length} that nothing raises`,
);
