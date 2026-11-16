#!/usr/bin/env node
// scripts/generate-library-reference.mjs — CP-1 PR 2: the library reference, generated. Six pages under
// `docs/reference/library/`, one per job a program does with Realm's library, each listing every
// `@public` or `@beta` name of `@sensigo/realm` and `@sensigo/realm-mcp` that the job reaches, with its
// description and its declaration.
//
// Inputs: `docs/reference/library/jobs.json` (the six jobs, their pages, their words and their entry
// points); the API reports CP-1 PR 1 commits (`packages/{core,mcp-server}/src/inventory/api-report.txt`),
// which give each tagged name's declaration text (their normaliser is the only one: this script never
// prints a declaration itself); and the BUILT d.ts of the three entries the reports cover, which give
// each name's tag, its JSDoc and the references the walk follows.
//
// What it computes: which tagged names each job reaches from its entry points (the reference kinds of
// the reports' closure rule: type references, `extends`/`implements` expressions, `typeof` queries by
// their left-most name, import-type qualifiers; aliases resolved, type parameters and private members
// skipped), and where each name goes. A documented entry point goes under the job whose docs name it
// (named by two, the first in the table's order); any other reached name under the first job that
// reaches it in the precedence order (the most specific first). Every other job that reaches a name
// links to its entry. A tagged name no job reaches, two names equal when lowercased, or an entry point
// that is not a tagged export is an error: the script prints it and exits 1.
//
// Usage: node scripts/generate-library-reference.mjs [--out <dir>] [--manifest <file>]
//   --out       where the six pages are written (default: docs/reference/library)
//   --manifest  also write a JSON record of every tagged name: its page, the pages linking to it, and
//               whether its declaration has a description (the test's cell reads it)
// `npm run docs:library` regenerates the committed pages after `npm run build`.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
let outDir = join(ROOT, 'docs/reference/library');
let manifestFile;
for (let i = 0; i < args.length; i += 2) {
  if (args[i] === '--out' && args[i + 1] !== undefined) outDir = resolve(args[i + 1]);
  else if (args[i] === '--manifest' && args[i + 1] !== undefined)
    manifestFile = resolve(args[i + 1]);
  else {
    console.error(
      'usage: node scripts/generate-library-reference.mjs [--out <dir>] [--manifest <file>]',
    );
    process.exit(2);
  }
}

const errors = [];

// ---------------------------------------------------------------------------------------------------
// The entries the reports cover.

const ENTRIES = [
  {
    pkg: '@sensigo/realm',
    section: '.',
    dts: join(ROOT, 'packages/core/dist/index.d.ts'),
    report: join(ROOT, 'packages/core/src/inventory/api-report.txt'),
  },
  {
    pkg: '@sensigo/realm-mcp',
    section: '.',
    dts: join(ROOT, 'packages/mcp-server/dist/index.d.ts'),
    report: join(ROOT, 'packages/mcp-server/src/inventory/api-report.txt'),
  },
  {
    pkg: '@sensigo/realm-mcp',
    section: './home',
    dts: join(ROOT, 'packages/mcp-server/dist/home-server.d.ts'),
    report: join(ROOT, 'packages/mcp-server/src/inventory/api-report.txt'),
  },
];
const importPath = (e) => (e.section === '.' ? e.pkg : `${e.pkg}/${e.section.slice(2)}`);

// ---------------------------------------------------------------------------------------------------
// The reports: each tagged row's header and declaration block, by section (the reports' own parsing:
// a `## ` heading names the section, a row is `name · kind · tag` and its indented lines).

function parseReport(text) {
  const rows = [];
  let section = '';
  let cur;
  const flush = () => {
    if (cur === undefined) return;
    const [name, kind, tag] = cur.head.split(' · ');
    rows.push({ section: cur.section, name, kind, tag, lines: cur.lines.map((l) => l.slice(2)) });
    cur = undefined;
  };
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      flush();
      const heading = line.slice(3);
      section =
        heading.includes('/') && heading.indexOf('/') !== heading.lastIndexOf('/')
          ? `./${heading.split('/').at(-1)}`
          : '.';
      continue;
    }
    if (line.startsWith('#') || line === '') {
      if (line === '') flush();
      continue;
    }
    if (line.startsWith('  ') && cur !== undefined) cur.lines.push(line);
    else {
      flush();
      cur = { section, head: line, lines: [] };
    }
  }
  flush();
  return rows;
}

/** `${pkg}\0${section}\0${name}` → the report's row. */
const reportRows = new Map();
for (const report of new Set(ENTRIES.map((e) => e.report))) {
  const pkg = ENTRIES.find((e) => e.report === report).pkg;
  for (const row of parseReport(readFileSync(report, 'utf8'))) {
    reportRows.set(`${pkg}\u0000${row.section}\u0000${row.name}`, row);
  }
}

// ---------------------------------------------------------------------------------------------------
// The program over the built d.ts (the reports' options).

for (const e of ENTRIES) {
  if (!existsSync(e.dts)) {
    console.error(`no built d.ts at ${e.dts}: run \`npm run build\` first`);
    process.exit(1);
  }
}
const program = ts.createProgram(
  ENTRIES.map((e) => e.dts),
  {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  },
);
const checker = program.getTypeChecker();
const resolveAlias = (s) => (s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s);
const tagsOf = (node) => ts.getJSDocTags(node).map((t) => t.tagName.text);
const tierOf = (symbol) => {
  const tags = (symbol.declarations ?? []).flatMap((d) => tagsOf(d));
  return tags.includes('public') ? 'public' : tags.includes('beta') ? 'beta' : 'internal';
};
const isPrivate = (m) => {
  const name = m.name;
  return (
    (ts.getCombinedModifierFlags(m) & ts.ModifierFlags.Private) !== 0 ||
    (name !== undefined && ts.isPrivateIdentifier(name))
  );
};
/** The type references inside `node` (the reports' closure rule's kinds). */
function referencesIn(node) {
  const out = [];
  const visit = (n) => {
    let target;
    if (ts.isTypeReferenceNode(n)) target = n.typeName;
    else if (ts.isExpressionWithTypeArguments(n)) target = n.expression;
    else if (ts.isTypeQueryNode(n)) {
      let e = n.exprName;
      while (ts.isQualifiedName(e)) e = e.left;
      target = e;
    } else if (ts.isImportTypeNode(n) && n.qualifier !== undefined) target = n.qualifier;
    if (target !== undefined) {
      const s = checker.getSymbolAtLocation(target);
      if (s !== undefined) {
        const r = resolveAlias(s);
        if (!(r.flags & ts.SymbolFlags.TypeParameter) && (r.declarations?.length ?? 0) > 0)
          out.push(r);
      }
    }
    if (!isPrivate(n)) ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

// ---------------------------------------------------------------------------------------------------
// The tagged names: one per symbol, with the entries that export it and its report row.

/** name → { name, symbol, tier, exports: [entry], declaring: entry, row } */
const names = new Map();
/** resolved symbol → name */
const nameOf = new Map();
for (const e of ENTRIES) {
  const sf = program.getSourceFile(e.dts);
  const mod = checker.getSymbolAtLocation(sf);
  for (const exported of checker.getExportsOfModule(mod)) {
    const symbol = resolveAlias(exported);
    const tier = tierOf(symbol);
    if (tier === 'internal') continue;
    const name = exported.name;
    const held = names.get(name);
    if (held !== undefined) {
      if (held.symbol !== symbol)
        errors.push(`two tagged names \`${name}\` declare different things`);
      held.exports.push(e);
      continue;
    }
    names.set(name, { name, symbol, tier, exports: [e] });
    nameOf.set(symbol, name);
  }
}
// The declaring entry: the package whose files declare the symbol; its report row gives the text.
for (const n of names.values()) {
  const file = n.symbol.declarations?.[0]?.getSourceFile().fileName ?? '';
  const inMcp = file.includes(`${sep}mcp-server${sep}`) || file.includes('/mcp-server/');
  n.declaring = n.exports.find((e) => (e.pkg === '@sensigo/realm-mcp') === inMcp) ?? n.exports[0];
  n.row = reportRows.get(`${n.declaring.pkg}\u0000${n.declaring.section}\u0000${n.name}`);
  if (n.row === undefined || n.row.tag.startsWith('internal'))
    errors.push(
      `\`${n.name}\` is tagged in the build but has no tagged row in its report: regenerate the report`,
    );
}
// Two names equal when lowercased would share an anchor.
const lowered = new Map();
for (const name of names.keys()) {
  const k = name.toLowerCase();
  if (lowered.has(k))
    errors.push(`\`${lowered.get(k)}\` and \`${name}\` are equal when lowercased: one anchor`);
  lowered.set(k, name);
}

/** The tagged names a name's declarations refer to. */
const refsCache = new Map();
function refsOf(name) {
  if (refsCache.has(name)) return refsCache.get(name);
  const out = new Set();
  for (const d of names.get(name).symbol.declarations ?? []) {
    for (const s of referencesIn(d)) {
      const n = nameOf.get(s);
      if (n !== undefined && n !== name) out.add(n);
    }
  }
  const sorted = [...out].sort();
  refsCache.set(name, sorted);
  return sorted;
}

// ---------------------------------------------------------------------------------------------------
// The jobs: what each reaches, and where each name goes.

const jobsFile = join(ROOT, 'docs/reference/library/jobs.json');
const jobs = JSON.parse(readFileSync(jobsFile, 'utf8')).jobs;
for (const job of jobs) {
  for (const ep of job.entryPoints) {
    if (!names.has(ep))
      errors.push(`jobs.json: \`${ep}\` (job "${job.title}") is not a tagged export`);
  }
  // Reach: the entry points and every tagged name their declarations refer to, transitively.
  const reach = new Set();
  const queue = job.entryPoints.filter((ep) => names.has(ep));
  while (queue.length > 0) {
    const n = queue.shift();
    if (reach.has(n)) continue;
    reach.add(n);
    for (const r of refsOf(n)) if (!reach.has(r)) queue.push(r);
  }
  job.reach = reach;
}
const byPrecedence = [...jobs].sort((a, b) => a.precedence - b.precedence);
for (const n of names.values()) {
  const documented = jobs.find((j) => j.entryPoints.includes(n.name));
  const home = documented ?? byPrecedence.find((j) => j.reach.has(n.name));
  if (home === undefined) {
    errors.push(
      `\`${n.name}\` is tagged but no job reaches it: add it to a job's entry points, or untag it`,
    );
    continue;
  }
  n.home = home;
  n.links = jobs.filter((j) => j !== home && j.reach.has(n.name));
}

if (errors.length > 0) {
  for (const e of [...new Set(errors)].sort()) console.error(e);
  process.exit(1);
}

// ---------------------------------------------------------------------------------------------------
// What an entry shows: its kind words, its description, its other block tags.

const KIND_OF = (d) =>
  ts.isFunctionDeclaration(d)
    ? 'function'
    : ts.isClassDeclaration(d)
      ? 'class'
      : ts.isInterfaceDeclaration(d)
        ? 'interface'
        : ts.isTypeAliasDeclaration(d)
          ? 'type'
          : ts.isVariableDeclaration(d)
            ? d.parent.flags & ts.NodeFlags.Const
              ? 'const'
              : 'let'
            : ts.isEnumDeclaration(d)
              ? 'enum'
              : ts.isModuleDeclaration(d)
                ? 'namespace'
                : 'declaration';
const GROUPS = [
  ['function', 'Functions'],
  ['class', 'Classes'],
  ['interface', 'Interfaces'],
  ['type', 'Types'],
  ['enum', 'Types'],
  ['namespace', 'Types'],
  ['const', 'Constants'],
  ['let', 'Constants'],
  ['declaration', 'Types'],
];
const GROUP_ORDER = ['Functions', 'Classes', 'Interfaces', 'Types', 'Constants'];

/** `{@link X}` and `{@link X text}` as `X` in backticks; any other text as it is. */
const plain = (text) =>
  text.replace(
    /\{@link(?:code|plain)?\s+([^\s}|]+)(?:[\s|]+[^}]*)?\}/g,
    (_m, target) => `\`${target}\``,
  );
const jsDocsOf = (d) => ts.getJSDocCommentsAndTags(d).filter((x) => ts.isJSDoc(x));
/** A declaration's description: its JSDoc's text before the block tags (a tag line alone has none). */
function descriptionOf(d) {
  const parts = jsDocsOf(d)
    .map((doc) => (doc.comment === undefined ? '' : (ts.getTextOfJSDocComment(doc.comment) ?? '')))
    .map((t) => t.trim())
    .filter((t) => t !== '');
  return plain(parts.join('\n\n'));
}
/** A declaration's block tags other than the release tags, `@deprecated` first. */
function blockTagsOf(d) {
  const tags = [];
  for (const doc of jsDocsOf(d)) {
    for (const tag of doc.tags ?? []) {
      const tagName = tag.tagName.text;
      if (tagName === 'public' || tagName === 'beta') continue;
      const comment =
        tag.comment === undefined ? '' : plain(ts.getTextOfJSDocComment(tag.comment) ?? '').trim();
      const named =
        (ts.isJSDocParameterTag(tag) || ts.isJSDocPropertyTag(tag)) && tag.name !== undefined
          ? `${tag.name.getText()} `
          : '';
      tags.push({ tagName, text: `${named}${comment}`.trim() });
    }
  }
  return tags.sort((a, b) =>
    a.tagName === 'deprecated' ? -1 : b.tagName === 'deprecated' ? 1 : 0,
  );
}

for (const n of names.values()) {
  const decls = [...(n.symbol.declarations ?? [])].sort(
    (a, b) => a.getSourceFile().fileName.localeCompare(b.getSourceFile().fileName) || a.pos - b.pos,
  );
  n.kinds = [...new Set(decls.map(KIND_OF))];
  n.group = GROUPS.find(([k]) => k === n.kinds[0])[1];
  n.description = decls.map(descriptionOf).find((t) => t !== '') ?? '';
  n.blockTags = decls.flatMap(blockTagsOf);
}

/** The first sentence of a description, for the index table: up to the first full stop that ends one. */
function firstSentence(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  let inCode = false;
  for (let i = 0; i < flat.length; i++) {
    const c = flat[i];
    if (c === '`') inCode = !inCode;
    if (inCode || !'.!?'.includes(c)) continue;
    if (i + 1 < flat.length && flat[i + 1] !== ' ') continue;
    const before = flat.slice(Math.max(0, i - 4), i);
    if (/(?:^|\W)(?:e\.g|i\.e|etc|vs)$/.test(before)) continue;
    return flat.slice(0, i + 1);
  }
  return flat;
}
// A table cell: backslashes first, then pipes (a `|` would end the cell; a backslash before it would
// undo its escape).
const cell = (text) => text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
const anchor = (name) => name.toLowerCase().replace(/[^a-z0-9_-]/g, '');
const byName = (a, b) => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

// ---------------------------------------------------------------------------------------------------
// The pages.

const GENERATED =
  '<!-- Generated by scripts/generate-library-reference.mjs from the API reports and the built declarations; do not edit by hand: after `npm run build`, run `npm run docs:library`. -->';

function tagWords(n) {
  const tag = n.row.tag;
  if (tag === 'beta') return 'beta: may change in a minor release until it settles';
  if (tag.startsWith('public (beta:'))
    return `${tag}: those members may change in a minor release until they settle`;
  return tag;
}

function pageOf(job) {
  const entries = [...names.values()].filter((n) => n.home === job);
  const links = [...names.values()]
    .filter((n) => n.links.includes(job))
    .sort((a, b) => byName(a.name, b.name));
  const lines = [
    `# ${job.title}`,
    '',
    `<!-- description: ${job.description} -->`,
    '',
    GENERATED,
    '',
    job.purpose,
    '',
    `Where the docs teach it: ${job.handPages.map((p) => `[${p.title}](${p.link})`).join(', ')}.`,
    '',
  ];
  const grouped = GROUP_ORDER.map((g) => [
    g,
    entries.filter((n) => n.group === g).sort((a, b) => byName(a.name, b.name)),
  ]).filter(([, list]) => list.length > 0);
  lines.push('| Name | Kind | What it is |', '| --- | --- | --- |');
  for (const [, list] of grouped) {
    for (const n of list) {
      lines.push(
        `| [\`${n.name}\`](#${anchor(n.name)}) | ${n.kinds.join(', ')} | ${cell(firstSentence(n.description))} |`,
      );
    }
  }
  lines.push('');
  for (const [g, list] of grouped) {
    lines.push(`## ${g}`, '');
    for (const n of list) {
      const also = n.exports
        .filter((e) => e !== n.declaring)
        .map((e) => `also exported from \`${importPath(e)}\``);
      const from =
        n.declaring.pkg === '@sensigo/realm' ? [] : [`from \`${importPath(n.declaring)}\``];
      lines.push(
        `### ${n.name}`,
        '',
        [n.kinds.join(', '), tagWords(n), ...from, ...also].join(' · '),
        '',
      );
      if (n.description !== '') lines.push(n.description, '');
      for (const t of n.blockTags)
        lines.push(`\`@${t.tagName}\`${t.text === '' ? '' : ` ${t.text}`}`, '');
      lines.push('```ts', ...n.row.lines, '```', '');
    }
  }
  if (links.length > 0) {
    lines.push('## Also used by this job', '');
    lines.push('Names this job reaches whose entry is on another page.', '');
    for (const n of links) {
      lines.push(
        `- [\`${n.name}\`](${n.home.page}#${anchor(n.name)}): ${firstSentence(n.description)}`,
      );
    }
    lines.push('');
  }
  while (lines.at(-1) === '') lines.pop();
  return `${lines.join('\n')}\n`;
}

mkdirSync(outDir, { recursive: true });
for (const job of jobs) writeFileSync(join(outDir, job.page), pageOf(job));

if (manifestFile !== undefined) {
  const manifest = {
    names: Object.fromEntries(
      [...names.values()]
        .sort((a, b) => byName(a.name, b.name))
        .map((n) => [
          n.name,
          {
            page: n.home.page,
            links: n.links.map((j) => j.page),
            description: n.description !== '',
            tier: n.tier,
            entries: n.exports.map(importPath),
          },
        ]),
    ),
    pages: Object.fromEntries(
      jobs.map((j) => [j.page, [...names.values()].filter((n) => n.home === j).length]),
    ),
  };
  mkdirSync(dirname(manifestFile), { recursive: true });
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
}
