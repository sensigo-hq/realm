// The words of the comparison, in one place: the page (src/pages/compare.astro) and its Markdown copy
// (src/pages/compare.md.js) both read these sentences and headings, so they cannot drift apart. The facts come from
// the main comparison document through src/lib/comparison.mjs; this module only phrases them.
import {
  tools,
  rows,
  facts,
  rowsByVerdict,
  order,
  realmReleases,
  newestRealmRelease,
  compareReleases,
} from './comparison.mjs';
import { createHash } from 'node:crypto';
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
  open: 'Nobody has it in full',
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
/** The page's title, og:title, heading and the Markdown copy's title: one string. */
export const pageTitle = `Realm vs ${TITLE_NAMES.slice(0, -1).join(', ')}, ${TITLE_NAMES.at(-1)} and others`;

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

/** The release each of Realm's answers names, newest first, with how many answers name it. */
const releaseCounts = [...new Set(realmReleases.map((a) => a.release))]
  .sort((a, b) => compareReleases(b, a))
  .map((release) => ({ release, n: realmReleases.filter((a) => a.release === release).length }));
const realmTool = tools.find((t) => t.key === 'realm');
/** The line under the column dates: what Realm's answers were checked against, computed from them. */
/** What Realm's answers were checked against, when they name more than one release: the words the
 *  page's line and llms.txt's both use. */
const mixedReleaseWords = `Realm's answers (${rows.length} questions, ${facts.length} facts and its strengths) were checked against more than one release: ${releaseCounts
  .map(({ release, n }) => `${release} (${n} ${n === 1 ? 'answer' : 'answers'})`)
  .join(', ')}`;
export const releaseLine =
  releaseCounts.length === 1
    ? `Realm's answers re-checked against ${newestRealmRelease} on ${longDate(realmTool.checked)}.`
    : `${mixedReleaseWords}. Each one checked on an older release says so beside it.`;
/** What an answer checked on an older release than the newest says beside it, or `null`. */
export const olderNote = (release) =>
  compareReleases(release, newestRealmRelease) < 0 ? `Checked against Realm ${release}.` : null;

export const lede = `Realm against ${othersWord} tools people consider for the same job: getting an AI agent to do multi-step work reliably. Every answer below cites the tool's own code or docs, and each column names the release that was checked and when. Where Realm is behind, the page says so.`;
export const difference = `The difference that matters most: the other ${othersWord} run the work themselves and call the model when they need it. Realm can do that too, but an outside assistant, such as Claude or Cursor, can also work through a Realm workflow one step at a time. Realm refuses a step taken out of order, and an answer that breaks the schema the step declares.`;
export const orderLine = `After Realm, the tools are ordered by ${order.by} on ${longDate(order.on)}, most first. The order says how popular each one is, not how good.`;
export const tableHeading = `${totalWord.charAt(0).toUpperCase() + totalWord.slice(1)} tools, ${rows.length} questions`;
/** The section headings both the page and its Markdown copy use. */
export const HEADINGS = {
  answers: 'Every answer, with its source',
  tools: 'What each one does better, and where it falls short',
  how: 'Sources, dates and corrections',
};
export const partialNote = 'Partial always means something is missing; the answers below say what.';
export const toolsIntro =
  "Realm's own strengths and gaps come first. Then each other tool: where it is stronger than Realm, and where it falls short for making an agent follow steps and show what it did.";

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
    "Realm's own column was re-checked claim by claim by a separate pass, against the release each answer names, and its key answers were run on that release.",
  ],
  [
    `${Object.values(VERDICT_LABEL)
      .map((label) => `"${label}"`)
      .reduce(
        (all, label, i, list) =>
          i === 0 ? label : `${all}${i === list.length - 1 ? ' and ' : ', '}${label}`,
        '',
      )} are our reading of each row. The answers and their sources are the evidence.`,
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

/** Words the page keeps on one line: a command-line flag that, broken after its "--", would read as
 *  a dash. Only the page marks them; the Markdown copy and llms.txt are plain text. */
const ONE_LINE = ['--gate-answers withheld'];
const ONE_LINE_SPLIT = new RegExp(
  `(${ONE_LINE.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
);
/** Text split so each of ONE_LINE's words is a part of its own (`oneLine`), as linkParts splits off
 *  issue numbers. */
export const oneLineParts = (text) =>
  text
    .split(ONE_LINE_SPLIT)
    .filter((part) => part !== '')
    .map((part) => (ONE_LINE.includes(part) ? { oneLine: part } : { text: part }));

/** Text split so issue numbers (#625) can become links to the issue. */
export const linkParts = (text) =>
  text
    .split(/(#\d+)/)
    .map((part) => (/^#\d+$/.test(part) ? { issue: part.slice(1) } : { text: part }));
export const issueLink = (number) => `${SOURCE_URL}/issues/${number}`;

// ─── llms.txt's comparison and /compare/'s "Other tools" section ──────────────────────────────────
// Both texts were checked against one Realm release, named here. Their figures are computed from the
// table, and each clause llms.txt says about one of Realm's answers carries the fingerprint of the
// answer it was written from, so neither can drift from the table without stopping the build.

/** The Realm release llms.txt's text and /compare/'s "Other tools" section were checked against. */
export const TEXTS_CHECKED_ON = '0.49.0';
if (!/^\d+\.\d+\.\d+$/.test(TEXTS_CHECKED_ON)) {
  throw new Error(
    `compare-text.mjs: TEXTS_CHECKED_ON is "${TEXTS_CHECKED_ON}", not a release of the form X.Y.Z.`,
  );
}
if (compareReleases(newestRealmRelease, TEXTS_CHECKED_ON) > 0) {
  throw new Error(
    `compare-text.mjs: llms.txt's text and /compare/'s "Other tools" section were checked against Realm ${TEXTS_CHECKED_ON}, but Realm's column now names ${newestRealmRelease}. Re-check both on ${newestRealmRelease}, then set TEXTS_CHECKED_ON.`,
  );
}

const answersOf = (key, value) => rows.filter((r) => r.cells[key].value === value).length;
const otherTools = tools.filter((t) => t.key !== 'realm');
/** The other tools, most Yes first, then fewest No, then the table's order. */
const othersByAnswers = otherTools
  .map((t, i) => ({ name: t.name, i, yes: answersOf(t.key, 'Yes'), no: answersOf(t.key, 'No') }))
  .sort((a, b) => b.yes - a.yes || a.no - b.no || a.i - b.i);
const andList = (names) =>
  names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
const otherDates = otherTools.map((t) => t.checked).sort();
const firstRead = parts(otherDates[0]);
const lastRead = parts(otherDates.at(-1));
const realmNo = answersOf('realm', 'No');

/** The figures llms.txt's comparison section states, each computed from the table. */
export const llmsFigures = {
  /** The other tools, in the order above, as one list: "n8n, Mastra, … and CrewAI". */
  toolList: andList(othersByAnswers.map((t) => t.name)),
  realmYes: answersOf('realm', 'Yes'),
  /** "none", or the number. */
  realmNo: realmNo === 0 ? 'none' : String(realmNo),
  othersMostYes: Math.max(...othersByAnswers.map((t) => t.yes)),
  othersFewestNo: Math.min(...othersByAnswers.map((t) => t.no)),
  /** What Realm's answers were checked against: one release, or the page's mixed-release words
   *  (without its note on answers checked on an older release, which llms.txt does not show). */
  realmChecked:
    releaseCounts.length === 1
      ? `Realm's answers were checked against ${newestRealmRelease}`
      : mixedReleaseWords,
  /** When the other tools' columns were read: "in October 2026", "between … and …". */
  othersRead:
    firstRead.y === lastRead.y && firstRead.m === lastRead.m
      ? `in ${lastRead.m} ${lastRead.y}`
      : firstRead.y === lastRead.y
        ? `between ${firstRead.m} and ${lastRead.m} ${lastRead.y}`
        : `between ${firstRead.m} ${firstRead.y} and ${lastRead.m} ${lastRead.y}`,
};

// llms.txt also says the other tools give an outside agent, at most, a tool that runs a whole
// workflow: every other tool's "drive" answer must be No.
for (const t of otherTools) {
  const value = driveRow.cells[t.key].value;
  if (value !== 'No') {
    throw new Error(
      `compare-text.mjs: llms.txt says the other tools give an outside agent at most a tool that runs a whole workflow, but ${t.name}'s "drive" answer is now ${value}. Re-word that sentence.`,
    );
  }
}

/** The first 12 hex characters of sha256 over a row's title, Realm's value and Realm's note. */
const fingerprint = (row) =>
  createHash('sha256')
    .update([row.title, row.cells.realm.value, row.cells.realm.note].join('\n'))
    .digest('hex')
    .slice(0, 12);

/** What llms.txt's numbered list says after each row's head, as approved, keyed by row id, with the
 *  fingerprint of Realm's answer it was written from. */
const LLMS_CLAUSES = {
  drive: { fingerprint: '4a1a8cec138d', clause: '.' },
  order: {
    fingerprint: '47fcea732dc9',
    clause: '. When several steps are ready at once, the agent picks which goes first.',
  },
  schema: { fingerprint: '10ed4f5822ed', clause: ', when the step declares one.' },
  gate: { fingerprint: '410ac6a5e849', clause: ' (the time limit is optional).' },
  who: { fingerprint: '9785f8dfa2c4', clause: '. It records the name given, and checks nothing.' },
  record: { fingerprint: '6743027cac6e', clause: '.' },
  tamper: {
    fingerprint: 'b2ac85a678b7',
    clause:
      '. Realm stores a hash of each record entry, and `realm db check` finds an entry someone edited by hand. It does not find one whose hash was recomputed too. Nothing is signed.',
  },
  crash: {
    fingerprint: '8d64bd543d3b',
    clause:
      '. The run is kept, but a person restarts it; a crash during an agent step needs `realm run reclaim --force`, which may repeat that step.',
  },
  mcpserver: { fingerprint: '78251d436176', clause: '.' },
  mcpclient: {
    fingerprint: '8a20270d2310',
    clause: '. Only servers it starts on the same machine, under `realm agent`.',
  },
  'cache-record': {
    fingerprint: 'cf17cdaef452',
    clause: ', for the model calls `realm agent` makes.',
  },
  'cache-cost': { fingerprint: '909cd13efdd1', clause: ', from a price list you supply.' },
};
const clauseProblems = [];
for (const [id, { fingerprint: written }] of Object.entries(LLMS_CLAUSES)) {
  const row = rows.find((r) => r.id === id);
  if (row === undefined) {
    clauseProblems.push(
      `compare-text.mjs: llms.txt's text has a clause for row "${id}", which is no longer in the table. Remove or re-word that clause.`,
    );
  } else if (fingerprint(row) !== written) {
    clauseProblems.push(
      `compare-text.mjs: Realm's answer on row "${id}" changed since llms.txt's text was written (it now reads ${row.cells.realm.value}; fingerprint ${written} is now ${fingerprint(row)}). Re-word that row's clause in llms.txt's text, then update its fingerprint.`,
    );
  }
}
for (const r of rows) {
  const value = r.cells.realm.value;
  if ((value === 'Yes' || value === 'Partial') && !Object.hasOwn(LLMS_CLAUSES, r.id)) {
    clauseProblems.push(
      `compare-text.mjs: llms.txt's text has no clause for Realm's ${value} answer on row "${r.id}". Add one, with its fingerprint.`,
    );
  }
}
if (clauseProblems.length > 0) throw new Error(clauseProblems.join('\n'));

/** llms.txt's numbered list: one line per row, in the table's order. A No row with no clause ends
 *  with its head. */
export const llmsQuestionLines = rows.map(
  (r, i) =>
    `${i + 1}. ${r.title}: **${r.cells.realm.value}**${Object.hasOwn(LLMS_CLAUSES, r.id) ? LLMS_CLAUSES[r.id].clause : '.'}`,
);

/** /compare/'s section on using Realm with n8n, Zapier or Make, for the page and its Markdown copy.
 *  An item's `strong` is bold; its text can hold an issue number, which becomes a link. */
export const OTHER_TOOLS = {
  eyebrow: 'Other tools',
  heading: 'Using Realm with n8n, Zapier or Make',
  paragraph:
    "n8n, Zapier and Make connect apps from a visual editor and count their integrations in the thousands: n8n's README says 1,500+, Zapier's home page 9,000+ apps and Make's own summary 3,500+ apps (each read on 14 November 2026). Realm holds an AI agent to the steps of a workflow. The two can work together.",
  question: 'How do they connect?',
  answer: `In two ways, each checked on Realm ${TEXTS_CHECKED_ON}:`,
  items: [
    {
      strong: 'By webhook.',
      text: " The other tool POSTs to realm listen, which starts a run and answers 202 with the run's run_id straight away. That is a hand-off: the reply comes when the run starts, not when it ends. To send a result back, a later step in the Realm workflow can POST to the other tool's webhook with the http adapter. That webhook must reply with JSON, or Realm records the step as failed although the POST arrived. We ran Realm's side with requests and replies shaped as n8n's code sends them, not with n8n, Zapier or Make.",
    },
    {
      strong: 'Over MCP.',
      text: " realm serve is an MCP server reached over HTTP with a bearer token. n8n's MCP Client nodes connect to it when set to HTTP Streamable, with Bearer auth; their SSE option, the one n8n's docs page shows, does not connect to Realm. We checked Realm's server with the MCP library and version that n8n 2.47.7 uses, not with n8n itself. Zapier and Make have MCP clients in beta; we have not checked them against Realm. Over realm serve the other tool's agent also gets the tool that answers gates: start realm serve with --gate-answers withheld when a person must answer.",
    },
    {
      text: 'Either way, the other tool must reach Realm. realm listen and realm serve listen on the machine Realm runs on (127.0.0.1) over plain HTTP by default, so a cloud service needs a public address you provide, and Make accepts only HTTPS.',
    },
    {
      text: "Over MCP, the other direction is not there yet. Realm's own agent steps take tools only from MCP servers they start on the machine Realm runs on (stdio), so they cannot call n8n's or Zapier's MCP servers directly, which are reached over HTTP (#788).",
    },
  ],
};
