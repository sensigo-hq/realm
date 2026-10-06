// The words of the comparison, in one place: the page (src/pages/compare.astro) and its Markdown copy
// (src/pages/compare.md.js) both read them, so the two cannot say different things. The facts come from
// the main comparison document through src/lib/comparison.mjs; this module only phrases them.
import { tools, rows, rowsByVerdict, order } from './comparison.mjs';
import { SOURCE_URL } from './site-meta.mjs';

const WORDS = [
  'no',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
];
const word = (n) => WORDS[n] ?? String(n);
export const othersWord = word(tools.length - 1);
export const totalWord = word(tools.length);

/** The words for each verdict a row can have, in the order the summary lists them. */
export const VERDICT_LABEL = {
  lead: 'Only Realm',
  level: 'Level with the field',
  behind: 'Realm is behind',
  open: 'Nobody has it',
};
/** The summary's four groups, leaving out any group with no row. */
export const verdictGroups = Object.entries(VERDICT_LABEL)
  .map(([kind, label]) => ({ kind, label, rows: rowsByVerdict(kind) }))
  .filter((g) => g.rows.length > 0);

/** How each answer's source was checked, as the labels on the answers say it. */
export const LABEL_MEANINGS = [
  ['CODE', "read in the tool's source"],
  ['DOCS', 'stated in its own docs'],
  ['EXECUTED', 'run'],
  ['INFERRED', 'reasoned from what was read'],
];

// Every product named in the page title must be a column of the table.
const TITLE_NAMES = ['LangGraph', 'CrewAI', 'Temporal', 'n8n'];
for (const name of TITLE_NAMES) {
  if (!tools.some((t) => t.name === name)) {
    throw new Error(
      `compare-text.mjs: the page title names ${name}, which is not a tool in src/data/comparison.json`,
    );
  }
}
export const pageTitle = `How Realm compares with ${TITLE_NAMES.slice(0, -1).join(', ')}, ${TITLE_NAMES.at(-1)} and others`;

// The introduction says what only Realm does; that is the claim of the row "drive". If that row stops
// being "Only Realm", the sentence would be false, so the build stops instead.
const driveRow = rows.find((r) => r.id === 'drive');
if (!driveRow || driveRow.verdict.kind !== 'lead') {
  throw new Error(
    'compare-text.mjs: the introduction says only Realm can be walked step by step from outside, but the row "drive" in src/data/comparison.json is missing or not "lead"',
  );
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const parts = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m: MONTHS[m - 1], d };
};
const longDate = (iso) => {
  const p = parts(iso);
  return `${p.d} ${p.m} ${p.y}`;
};
const checkedDates = [...new Set(tools.map((t) => t.checked))].sort();
const first = parts(checkedDates[0]);
const last = parts(checkedDates.at(-1));
/** The range of the columns' check dates, e.g. "5–6 October 2026". */
export const checkedRange =
  checkedDates.length === 1
    ? `${last.d} ${last.m} ${last.y}`
    : first.y !== last.y
      ? `${first.d} ${first.m} ${first.y} – ${last.d} ${last.m} ${last.y}`
      : first.m !== last.m
        ? `${first.d} ${first.m} – ${last.d} ${last.m} ${last.y}`
        : `${first.d}–${last.d} ${last.m} ${last.y}`;

export const lede = `Realm against ${othersWord} tools people consider for the same job: getting an AI agent to do multi-step work reliably. Every answer below cites the tool's own code or docs, and each column names the release that was checked and when. Where Realm is behind, the page says so.`;
export const difference = `The difference that matters most: the other ${othersWord} run the work themselves and call the model when they need it. Realm can do that too, but an outside assistant, such as Claude or Cursor, can also work through a Realm workflow one step at a time. Realm refuses a step taken out of order, and an answer that breaks the schema the step declares.`;
export const orderLine = `After Realm, the tools are ordered by ${order.by} on ${longDate(order.on)}, most first. The order says how popular each one is, not how good.`;
export const tableHeading = `${totalWord.charAt(0).toUpperCase() + totalWord.slice(1)} tools, ${rows.length} questions`;
export const partialNote = 'Partial always means something is missing; the answers below say what.';
export const toolsIntro =
  'Where each tool is stronger than Realm, and where it falls short for making an agent follow steps and show what it did.';

export const dataUrl = `${SOURCE_URL}/blob/main/website/src/data/comparison.json`;
export const issueUrl = `${SOURCE_URL}/issues/new?title=${encodeURIComponent('Comparison: ')}&body=${encodeURIComponent(
  "Which tool and which question:\n\nWhat the page says:\n\nWhat is true (with a link to the tool's own code or docs, and its version):\n",
)}`;

/** "How this was checked", one item per entry; a link is { href, text }. */
export const howChecked = [
  [
    "Each answer was read in the tool's own source code, docs or release notes. A column names the main release that was read; where an answer comes from a companion package, such as a tool's SDK, CLI or MCP server, its source names the file. Blog posts, comparison articles and AI summaries were not used.",
  ],
  [
    "Realm's own column was checked by a separate pass told to find its weaknesses, and its key answers were run on the published release.",
  ],
  [
    '"Only Realm", "Level with the field", "Realm is behind" and "Nobody has it" are our reading of each row. The answers and their sources are the evidence.',
  ],
  [
    'Claims a tool makes only in its docs are labelled DOCS and were not checked in its code. Prices change often and are not listed here.',
  ],
  [
    'Every answer and its source is also in one data file, ',
    { href: dataUrl, text: 'comparison.json' },
    '.',
  ],
  [
    'Something wrong or out of date? ',
    { href: issueUrl, text: 'Open an issue' },
    " with a link to the tool's own code or docs, and we will check it and correct the page.",
  ],
];

/** Text split so issue numbers (#625) can become links to the issue. */
export const linkParts = (text) =>
  text
    .split(/(#\d+)/)
    .map((part) => (/^#\d+$/.test(part) ? { issue: part.slice(1) } : { text: part }));
export const issueLink = (number) => `${SOURCE_URL}/issues/${number}`;
