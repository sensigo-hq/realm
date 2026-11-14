// The home page's excerpt of the workflow the demo runs ("See it run", src/pages/index.astro): its
// steps, the gate and the two branches, cut at build time from src/live/workflow.yaml, the file the
// demo imports. Each line shown is a line of that file, as written; nothing is parsed and printed again.
//
// The build stops, naming the step and the key, when the file no longer fits SHOWN below: a shown step
// or key is missing, a shown key's value is not on its own line, or the file has a step SHOWN does not
// name. When the demo's workflow changes (pre-publication checklist Part B, step 11), change SHOWN.
import WORKFLOW from '../live/workflow.yaml?raw';
import ENGINE from '../live/engine.mjs?raw';
import manifest from '../live/manifest.json';

const MODULE = 'src/lib/workflow-excerpt.mjs';
const FILE = 'src/live/workflow.yaml';

// The steps shown, and under each the keys shown, in the file's order. `a.b` is the key b under a; the
// parent line comes with it.
export const SHOWN = {
  fetch_pr: ['execution', 'operation'],
  write_review: ['execution', 'depends_on', 'input_schema.required'],
  confirm_review: ['depends_on', 'trust', 'gate.choices'],
  post_approval: ['depends_on', 'when'],
  post_changes_request: ['depends_on', 'when'],
};

const fail = (problems) => {
  throw new Error(
    `The home page's workflow excerpt (${MODULE}) cannot be cut from ${FILE}:\n  ${problems.join('\n  ')}\nIt shows the steps and keys listed in SHOWN in ${MODULE}; when the demo's workflow changes, change that list to match.`,
  );
};

// The demo must run the file the excerpt is cut from: one `import … from '….yaml'` statement in
// src/live/engine.mjs, naming ./workflow.yaml. Comments that name the file do not count.
const imports = [...ENGINE.matchAll(/^\s*import\s[^;]*?\bfrom\s+['"]([^'"]+\.ya?ml)['"]/gm)].map(
  (m) => m[1],
);
if (imports.length !== 1 || imports[0] !== './workflow.yaml')
  fail([
    `src/live/engine.mjs ${imports.length === 0 ? 'imports no .yaml file' : `imports ${imports.map((i) => `"${i}"`).join(', ')}`}, not "./workflow.yaml", so the excerpt would not be the workflow the demo runs`,
  ]);

const text = WORKFLOW.replace(/\r\n/g, '\n');
const lines = text.split('\n');
if (text.endsWith('\n')) lines.pop();

const indent = (l) => l.length - l.trimStart().length;
const blank = (l) => l.trim() === '' || l.trimStart().startsWith('#');
// The lines under the line at `i` (those indented more), up to the next line that is not.
function block(i) {
  const out = [];
  for (let j = i + 1; j < lines.length; j++) {
    if (blank(lines[j])) continue;
    if (indent(lines[j]) <= indent(lines[i])) break;
    out.push(j);
  }
  return out;
}
// The line of `key` among `within`, at the indent of their first line (the block's own keys).
function keyLine(within, key) {
  if (within.length === 0) return undefined;
  const at = indent(lines[within[0]]);
  return within.find((j) => indent(lines[j]) === at && lines[j].trimStart().startsWith(`${key}:`));
}

const problems = [];
const shown = new Set();
const stepsAt = lines.findIndex((l) => /^steps:\s*$/.test(l));
if (stepsAt === -1) fail([`${FILE} has no "steps:" line`]);
shown.add(stepsAt);
const stepLines = block(stepsAt).filter(
  (j) => indent(lines[j]) === indent(lines[block(stepsAt)[0]]),
);
const steps = new Map(stepLines.map((j) => [lines[j].trim().replace(/:.*$/, ''), j]));
for (const name of steps.keys())
  if (!(name in SHOWN))
    problems.push(
      `step "${name}" is in ${FILE} but not in SHOWN, so the excerpt would leave a step out`,
    );
for (const [name, keys] of Object.entries(SHOWN)) {
  const at = steps.get(name);
  if (at === undefined) {
    problems.push(`step "${name}" (in SHOWN) is not in ${FILE}`);
    continue;
  }
  shown.add(at);
  for (const key of keys) {
    let within = block(at);
    let line;
    for (const part of key.split('.')) {
      line = keyLine(within, part);
      if (line === undefined) break;
      shown.add(line);
      within = block(line);
    }
    if (line === undefined) {
      problems.push(`step "${name}", key "${key}": not in ${FILE}`);
      continue;
    }
    // The key's value must be on its own line: a value that goes on (a block list, a | or > text)
    // would show only its first line.
    const value = lines[line]
      .trimStart()
      .slice(key.split('.').at(-1).length + 1)
      .trim();
    if (value === '' || /^[|>]/.test(value) || block(line).length > 0)
      problems.push(
        `step "${name}", key "${key}": its value is not on its own single line (a block list or a | or > text), so its first line alone would mislead`,
      );
  }
}
if (problems.length) fail(problems);

/** The excerpt: the file's lines, as written, in the file's order. */
export const EXCERPT = [...shown].sort((a, b) => a - b).map((j) => lines[j]);
/** How many lines the file has. */
export const FILE_LINES = lines.length;
/** The Realm release the demo runs (scripts/live/build.mjs writes it from @sensigo/realm). */
export const VERSION = manifest.realm_version;
/** The file at that release on GitHub (the demo's copy is that file: pre-publication Part B, step 11). */
export const FILE_URL = `https://github.com/sensigo-hq/realm/blob/v${VERSION}/examples/08-pr-review/workflow.yaml`;
