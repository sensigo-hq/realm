// Loads the main comparison document (src/data/comparison.json) and checks that it is complete and
// consistent. The public page (src/pages/compare.astro) is built only from what this returns, so a
// document with a missing answer, an unknown value, an answer without a source, or a summary that
// contradicts its own answers stops the build here instead of reaching the site.
//
// Realm's answers each name the Realm release they were checked on (`release`): the 12 row cells (in
// `cells.realm`), each fact (beside its `cells`, whose values stay plain strings) and its strengths
// (in `strengths.realm`). Every one must be an X.Y.Z release, and Realm's column `version` must start
// with the newest of them, compared as numbers, so a column left behind and a column bumped ahead of
// its answers both stop the build. The page's line about Realm is computed from these releases.
import doc from '../data/comparison.json';

const VALUES = ['Yes', 'Partial', 'No', 'N/A'];
const RANK = { Yes: 2, Partial: 1, No: 0, 'N/A': -1 };
const VERDICTS = ['lead', 'level', 'behind', 'open'];
const LABEL = /^(CODE|DOCS|EXECUTED|INFERRED)( \+ (CODE|DOCS|EXECUTED|INFERRED))*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[a-z][a-z0-9-]*$/;
const RELEASE = /^\d+\.\d+\.\d+$/;
// A column's version starts with its release, read out whole: `0.49.10 (npm)` is 0.49.10, not 0.49.1.
const LEADING_RELEASE = /^(\d+\.\d+\.\d+)(?![\d.])/;
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

/** Compares two X.Y.Z releases as numbers: negative when a is older, positive when newer. */
export function compareReleases(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** Every Realm answer with the release it names, in page order: the rows, the facts, the strengths. */
function realmAnswers(d) {
  return [
    ...d.rows.map((r) => ({ where: `row ${r.id} realm`, release: r.cells.realm.release })),
    ...d.facts.map((f) => ({ where: `fact ${f.id}`, release: f.release })),
    { where: 'strengths realm', release: d.strengths.realm.release },
  ];
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
  if (keys[0] !== 'realm')
    fail('tools', 'must start with the tool whose key is "realm"; the page shows Realm first');
  // The other tools are listed in an order the page states, so the document must say what it rests on.
  object('order', d.order);
  text('order by', d.order.by);
  if (!DATE.test(d.order.on ?? '') || Number.isNaN(Date.parse(`${d.order.on}T00:00:00Z`)))
    fail('order on', 'is not a YYYY-MM-DD date');
  if (Date.parse(`${d.order.on}T00:00:00Z`) > today + DAY)
    fail('order on', `${d.order.on} is in the future`);

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

  // Each of Realm's answers names the release it was checked on; the column names the newest.
  const answers = realmAnswers(d);
  for (const a of answers) {
    if (a.release === undefined) fail(`${a.where} release`, 'is missing');
    if (typeof a.release !== 'string' || !RELEASE.test(a.release))
      fail(`${a.where} release`, `${JSON.stringify(a.release)} is not a release of the form X.Y.Z`);
  }
  const newest = answers.reduce(
    (best, a) => (compareReleases(a.release, best.release) > 0 ? a : best),
    answers[0],
  );
  const column = d.tools[0].version.match(LEADING_RELEASE)?.[1];
  if (column === undefined)
    fail(
      'tool realm version',
      `${JSON.stringify(d.tools[0].version)} does not start with a release X.Y.Z`,
    );
  if (column !== newest.release)
    fail(
      'tool realm version',
      `${column} is not the newest release Realm's answers name, ${newest.release} (${newest.where})`,
    );
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
/** What the order of the tools after Realm rests on, and the date it was read. */
export const order = doc.order;
export const rows = doc.rows;
/** The facts rows; the page shows every one of them. */
export const facts = doc.facts;
export const strengths = doc.strengths;
/** Realm's answers, each with the release it was checked on, and the newest of those releases. */
export const realmReleases = realmAnswers(doc);
export const newestRealmRelease = realmReleases
  .map((a) => a.release)
  .reduce((best, r) => (compareReleases(r, best) > 0 ? r : best));
export const rowsByVerdict = (kind) => doc.rows.filter((r) => r.verdict.kind === kind);
