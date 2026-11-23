#!/usr/bin/env node
// scripts/generate-run-state-schema.mjs — Q1 (#592) d2a: the published schema of get_run_state's
// reply, read from the BUILT mcp-server (`packages/mcp-server/dist/tools/run-state-schema.js`), never
// from the `.ts` text. Writes two files in `docs/reference/mcp/`:
// - `run-state.schema.json`: the module's `runStateSchemaFile()` (both arms, draft 2020-12).
// - `run-state.added-after.json`: the release each field and word arrived after. A field or word
//   already in the file keeps its release; a new one takes its release from the module's
//   `RUN_STATE_ADDED_AFTER`; with no file yet (the first publication) every one reads
//   `RUN_STATE_FIRST_PUBLISHED`. It also lists the placeholder paths under `described_loosely`.
// A new field or word with no release, a field or word the file has and the tree does not (a removal
// is a ladder step, made by hand), an entry of `RUN_STATE_ADDED_AFTER` the tree does not have, a
// placeholder path the tree does not have, or a tree that cannot be rendered is printed, and it exits
// 1 writing nothing. A second run changes nothing.
// Usage: node scripts/generate-run-state-schema.mjs [--out <dir>] (default: docs/reference/mcp).
// After `npm run build`, `npm run docs:schema` regenerates the committed files.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let outDir = join(ROOT, 'docs/reference/mcp');
if (args.length === 2 && args[0] === '--out') outDir = resolve(args[1]);
else if (args.length !== 0) {
  console.error('usage: node scripts/generate-run-state-schema.mjs [--out <dir>]');
  process.exit(2);
}
const MODULE = join(ROOT, 'packages/mcp-server/dist/tools/run-state-schema.js');
if (!existsSync(MODULE)) {
  console.error(`${MODULE} does not exist: run \`npm run build\` first`);
  process.exit(1);
}
const tree = await import(pathToFileURL(MODULE).href);
const SCHEMA = 'run-state.schema.json';
const SIDECAR = 'run-state.added-after.json';
const errors = [];

let schema;
try {
  schema = tree.runStateSchemaFile();
} catch (err) {
  console.error(
    `${SCHEMA}: the tree cannot be rendered: ${err instanceof Error ? err.message : err}`,
  );
  process.exit(1);
}

/** Every field path and every word of one arm: dotted keys, `[]` for entries, `.*` for map values. */
function inventory(arm) {
  const fields = [];
  const words = new Map();
  const visit = (node, path) => {
    if (node === null || typeof node !== 'object') return;
    for (const branch of node.anyOf ?? []) visit(branch, path);
    const listed = Array.isArray(node.enum) ? node.enum : 'const' in node ? [node.const] : [];
    for (const w of listed) {
      if (!words.has(path)) words.set(path, []);
      if (!words.get(path).includes(w)) words.get(path).push(w);
    }
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      const at = path === '' ? key : `${path}.${key}`;
      if (!fields.includes(at)) fields.push(at);
      visit(child, at);
    }
    if (node.items !== undefined) visit(node.items, `${path}[]`);
    if (node.propertyNames !== undefined) visit(node.additionalProperties, `${path}.*`);
  };
  visit(arm, '');
  return { fields, words };
}

const previous = existsSync(join(outDir, SIDECAR))
  ? JSON.parse(readFileSync(join(outDir, SIDECAR), 'utf8'))
  : undefined;
const sidecar = {
  _about:
    "The release each field and word of get_run_state's reply arrived after (run-state.schema.json). A path is dotted keys: `[]` stands for a list's entries and `.*` for a map's values (`steps.*.attempts[]`). `described_loosely` names the ok reply's fields the schema does not yet describe in full.",
  first_published: tree.RUN_STATE_FIRST_PUBLISHED,
  described_loosely: [...tree.RUN_STATE_DESCRIBED_LOOSELY],
};
const ARMS = ['ok', 'refusal'];
for (const [i, name] of ARMS.entries()) {
  const { fields, words } = inventory(schema.anyOf[i]);
  const later = tree.RUN_STATE_ADDED_AFTER[name];
  const before = previous?.[name];
  /** The release of one field or word: kept from the file, else the hand-kept map's. */
  const releaseOf = (what, kept, added) => {
    if (kept !== undefined) return kept;
    if (added !== undefined) return added;
    if (previous === undefined) return tree.RUN_STATE_FIRST_PUBLISHED;
    errors.push(`${SIDECAR}: ${name} ${what} is new: give it a release in RUN_STATE_ADDED_AFTER`);
    return undefined;
  };
  const out = { fields: {}, words: {} };
  for (const path of fields) {
    out.fields[path] = releaseOf(`field ${path}`, before?.fields[path], later.fields[path]);
  }
  for (const [path, list] of words) {
    out.words[path] = {};
    for (const w of list) {
      out.words[path][w] = releaseOf(
        `word '${w}' at ${path}`,
        before?.words[path]?.[w],
        later.words[path]?.[w],
      );
    }
  }
  for (const path of Object.keys(before?.fields ?? {})) {
    if (!(path in out.fields))
      errors.push(`${SIDECAR}: ${name} field ${path} is gone from the tree`);
  }
  for (const [path, list] of Object.entries(before?.words ?? {})) {
    for (const w of Object.keys(list)) {
      if (words.get(path)?.includes(w) !== true)
        errors.push(`${SIDECAR}: ${name} word '${w}' at ${path} is gone from the tree`);
    }
  }
  for (const path of Object.keys(later.fields)) {
    if (!fields.includes(path))
      errors.push(`RUN_STATE_ADDED_AFTER: ${name} field ${path} is not in the tree`);
  }
  for (const [path, list] of Object.entries(later.words)) {
    for (const w of Object.keys(list)) {
      if (words.get(path)?.includes(w) !== true)
        errors.push(`RUN_STATE_ADDED_AFTER: ${name} word '${w}' at ${path} is not in the tree`);
    }
  }
  if (name === 'ok') {
    for (const path of sidecar.described_loosely) {
      if (!fields.includes(path))
        errors.push(`${SIDECAR}: the placeholder ${path} is not in the tree`);
    }
  }
  sidecar[name] = out;
}

if (errors.length > 0) {
  for (const e of errors) console.error(e);
  process.exit(1);
}
writeFileSync(join(outDir, SCHEMA), `${JSON.stringify(schema, null, 2)}\n`);
writeFileSync(join(outDir, SIDECAR), `${JSON.stringify(sidecar, null, 2)}\n`);
const count = (arm) =>
  `${Object.keys(sidecar[arm].fields).length} fields, ${Object.values(sidecar[arm].words).reduce((n, l) => n + Object.keys(l).length, 0)} words`;
console.log(
  `${SCHEMA}: ok ${count('ok')}; refusal ${count('refusal')}; ${sidecar.described_loosely.length} described loosely`,
);
