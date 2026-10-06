// Loads the main comparison document (src/data/comparison.json) and checks that it is complete.
// The public page (src/pages/compare.astro) is built only from what this returns, so a document
// with a missing answer, an unknown value or an answer without a source stops the build here
// instead of reaching the site.
import doc from '../data/comparison.json';

const VALUES = ['Yes', 'Partial', 'No', 'N/A'];
const VERDICTS = ['lead', 'level', 'behind', 'open'];
const LABEL = /^(CODE|DOCS|EXECUTED|INFERRED)( \+ (CODE|DOCS|EXECUTED|INFERRED))*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// A column older than this is still published, but the build says it needs re-checking.
const STALE_DAYS = 120;

function fail(where, what) {
  throw new Error(`src/data/comparison.json: ${where}: ${what}`);
}
function text(where, value) {
  if (typeof value !== 'string' || value.trim() === '') fail(where, 'is empty or missing');
}

function check(d) {
  if (d.schema !== 1) fail('schema', `is ${JSON.stringify(d.schema)}, this page reads schema 1`);
  if (!Array.isArray(d.tools) || d.tools.length === 0) fail('tools', 'is empty or missing');
  const keys = d.tools.map((t) => t.key);
  if (new Set(keys).size !== keys.length) fail('tools', 'has a key twice');
  for (const t of d.tools) {
    for (const f of ['key', 'name', 'group', 'version']) text(`tool ${t.key ?? '?'} ${f}`, t[f]);
    if (!DATE.test(t.checked ?? '')) fail(`tool ${t.key} checked`, 'is not a YYYY-MM-DD date');
  }
  const sameTools = (where, cells) => {
    const have = Object.keys(cells ?? {});
    for (const k of keys) if (!have.includes(k)) fail(where, `has no answer for ${k}`);
    for (const k of have)
      if (!keys.includes(k)) fail(where, `answers for ${k}, which is not a tool`);
  };
  const ids = new Set();
  for (const r of d.rows ?? []) {
    const w = `row ${r.id ?? '?'}`;
    if (ids.has(r.id)) fail(w, 'id is used twice');
    ids.add(r.id);
    for (const f of ['id', 'title', 'ask']) text(`${w} ${f}`, r[f]);
    if (!VERDICTS.includes(r.verdict?.kind))
      fail(`${w} verdict`, `kind must be one of ${VERDICTS.join(', ')}`);
    text(`${w} verdict text`, r.verdict.text);
    sameTools(w, r.cells);
    for (const [k, c] of Object.entries(r.cells)) {
      if (!VALUES.includes(c.value))
        fail(`${w} ${k}`, `value ${JSON.stringify(c.value)} is not one of ${VALUES.join(', ')}`);
      text(`${w} ${k} note`, c.note);
      text(`${w} ${k} source`, c.source);
      if (!LABEL.test(c.label ?? ''))
        fail(
          `${w} ${k} label`,
          `${JSON.stringify(c.label)} is not CODE, DOCS, EXECUTED or INFERRED`,
        );
    }
  }
  if (ids.size === 0) fail('rows', 'is empty or missing');
  for (const f of d.facts ?? []) {
    text(`fact ${f.id ?? '?'} title`, f.title);
    if (typeof f.public !== 'boolean') fail(`fact ${f.id}`, 'public must be true or false');
    sameTools(`fact ${f.id}`, f.cells);
  }
  sameTools('strengths', d.strengths);
  for (const k of keys) {
    text(`strengths ${k} stronger`, d.strengths[k].stronger);
    text(`strengths ${k} weaker`, d.strengths[k].weaker);
  }
}

check(doc);

const now = Date.now();
for (const t of doc.tools) {
  const days = Math.floor((now - Date.parse(`${t.checked}T00:00:00Z`)) / 86_400_000);
  if (days > STALE_DAYS) {
    console.warn(
      `[comparison] ${t.name} was last checked ${days} days ago (${t.checked}); re-check it.`,
    );
  }
}

export const comparison = doc;
export const tools = doc.tools;
export const rows = doc.rows;
/** The facts rows the public page shows (a fact marked public: false stays in the main document only). */
export const publicFacts = doc.facts.filter((f) => f.public);
export const strengths = doc.strengths;
export const rowsByVerdict = (kind) => doc.rows.filter((r) => r.verdict.kind === kind);
