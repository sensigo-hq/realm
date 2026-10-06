// Loads the main comparison document (src/data/comparison.json) and checks that it is complete and
// consistent. The public page (src/pages/compare.astro) is built only from what this returns, so a
// document with a missing answer, an unknown value, an answer without a source, or a summary that
// contradicts its own answers stops the build here instead of reaching the site.
import doc from '../data/comparison.json';

const VALUES = ['Yes', 'Partial', 'No', 'N/A'];
const RANK = { Yes: 2, Partial: 1, No: 0, 'N/A': -1 };
const VERDICTS = ['lead', 'level', 'behind', 'open'];
const LABEL = /^(CODE|DOCS|EXECUTED|INFERRED)( \+ (CODE|DOCS|EXECUTED|INFERRED))*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[a-z][a-z0-9-]*$/;
// Section ids the page itself uses; a row id equal to one would make two elements share it.
const PAGE_IDS = ['table', 'answers', 'tools', 'how'];
// A column older than this is still published, but the build says it needs re-checking.
const STALE_DAYS = 120;
const DAY = 86_400_000;

function fail(where, what) {
  throw new Error(`src/data/comparison.json: ${where}: ${what}`);
}
function text(where, value) {
  if (typeof value !== 'string' || value.trim() === '') fail(where, 'is empty or missing');
}
function object(where, value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail(where, 'is missing or not an object');
}
function list(where, value) {
  if (!Array.isArray(value) || value.length === 0) fail(where, 'is missing or empty');
}

function check(d) {
  object('the document', d);
  if (d.schema !== 1) fail('schema', `is ${JSON.stringify(d.schema)}, this page reads schema 1`);
  list('tools', d.tools);
  list('rows', d.rows);
  list('facts', d.facts);
  object('strengths', d.strengths);

  const keys = [];
  const today = Date.now();
  for (const [i, t] of d.tools.entries()) {
    object(`tools[${i}]`, t);
    if (!ID.test(t.key ?? ''))
      fail(
        `tools[${i}] key`,
        `${JSON.stringify(t.key)} must be lower-case letters, digits and dashes`,
      );
    if (keys.includes(t.key)) fail(`tool ${t.key}`, 'key is used twice');
    keys.push(t.key);
    for (const f of ['name', 'group', 'version']) text(`tool ${t.key} ${f}`, t[f]);
    if (!DATE.test(t.checked ?? '') || Number.isNaN(Date.parse(`${t.checked}T00:00:00Z`)))
      fail(`tool ${t.key} checked`, 'is not a YYYY-MM-DD date');
    if (Date.parse(`${t.checked}T00:00:00Z`) > today + DAY)
      fail(`tool ${t.key} checked`, `${t.checked} is in the future`);
  }
  if (!keys.includes('realm'))
    fail('tools', 'has no tool with key "realm"; the page highlights and summarises that column');
  // The table header joins neighbouring tools of one group under one heading, so a group must be contiguous.
  const seen = [];
  for (const t of d.tools) {
    if (seen.at(-1) !== t.group) {
      if (seen.includes(t.group))
        fail(
          `tool ${t.key} group`,
          `"${t.group}" appears in two places; list a group's tools together`,
        );
      seen.push(t.group);
    }
  }

  const perTool = (where, cells) => {
    object(where, cells);
    for (const k of keys) if (!(k in cells)) fail(where, `has no answer for ${k}`);
    for (const k of Object.keys(cells))
      if (!keys.includes(k)) fail(where, `answers for ${k}, which is not a tool`);
  };

  const ids = [];
  for (const [i, r] of d.rows.entries()) {
    object(`rows[${i}]`, r);
    const w = `row ${r.id ?? i}`;
    if (!ID.test(r.id ?? ''))
      fail(
        `rows[${i}] id`,
        `${JSON.stringify(r.id)} must be lower-case letters, digits and dashes`,
      );
    if (PAGE_IDS.includes(r.id))
      fail(w, `id "${r.id}" is used by a section of the page; choose another`);
    if (ids.includes(r.id)) fail(w, 'id is used twice');
    ids.push(r.id);
    text(`${w} title`, r.title);
    text(`${w} ask`, r.ask);
    object(`${w} verdict`, r.verdict);
    if (!VERDICTS.includes(r.verdict.kind))
      fail(`${w} verdict`, `kind must be one of ${VERDICTS.join(', ')}`);
    text(`${w} verdict text`, r.verdict.text);
    perTool(w, r.cells);
    for (const k of keys) {
      const c = r.cells[k];
      object(`${w} ${k}`, c);
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
    // The summary chip must agree with the answers it summarises.
    const realm = RANK[r.cells.realm.value];
    const others = keys.filter((k) => k !== 'realm').map((k) => RANK[r.cells[k].value]);
    const anyYes = realm === 2 || others.includes(2);
    const rule = {
      lead: [realm === 2 && !others.includes(2), 'Realm is Yes and no other tool is'],
      level: [realm === 2 && others.includes(2), 'Realm is Yes and at least one other tool is too'],
      behind: [
        realm < 2 && others.some((o) => o >= realm),
        'Realm is not Yes and another tool is at least as good',
      ],
      open: [!anyYes, 'no tool is Yes'],
    }[r.verdict.kind];
    if (!rule[0]) fail(`${w} verdict`, `"${r.verdict.kind}" needs: ${rule[1]}`);
  }

  const factIds = [];
  for (const [i, f] of d.facts.entries()) {
    object(`facts[${i}]`, f);
    if (!ID.test(f.id ?? ''))
      fail(
        `facts[${i}] id`,
        `${JSON.stringify(f.id)} must be lower-case letters, digits and dashes`,
      );
    if (factIds.includes(f.id)) fail(`fact ${f.id}`, 'id is used twice');
    factIds.push(f.id);
    text(`fact ${f.id} title`, f.title);
    // The page shows every fact in this file, and the file is published. A fact the page should
    // not show does not belong here at all.
    if ('public' in f)
      fail(
        `fact ${f.id}`,
        'has a "public" field; every fact in this file is shown on the page, so a fact that should not be shown does not belong in it',
      );
    perTool(`fact ${f.id}`, f.cells);
    for (const k of keys) text(`fact ${f.id} ${k}`, f.cells[k]);
  }
  perTool('strengths', d.strengths);
  for (const k of keys) {
    object(`strengths ${k}`, d.strengths[k]);
    text(`strengths ${k} stronger`, d.strengths[k].stronger);
    text(`strengths ${k} weaker`, d.strengths[k].weaker);
  }
}

check(doc);

for (const t of doc.tools) {
  const days = Math.floor((Date.now() - Date.parse(`${t.checked}T00:00:00Z`)) / DAY);
  if (days > STALE_DAYS) {
    console.warn(
      `[comparison] ${t.name} was last checked ${days} days ago (${t.checked}); re-check it.`,
    );
  }
}

export const comparison = doc;
export const tools = doc.tools;
export const rows = doc.rows;
/** The facts rows; the page shows every one of them. */
export const facts = doc.facts;
export const strengths = doc.strengths;
export const rowsByVerdict = (kind) => doc.rows.filter((r) => r.verdict.kind === kind);
