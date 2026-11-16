// api-report.test.ts — CP-1 PR 1: the library's public interface, kept by tests. `@sensigo/realm` and
// `@sensigo/realm-mcp` tag every public declaration `@public` (the claim window's settling part
// `@beta`, at the member where a public interface reaches it); this test regenerates one API report
// per package from the BUILT d.ts and compares it with the committed file, beside this one and in
// `packages/mcp-server/src/inventory/` (one test writes both: `test-support` is not under `exports`,
// so a shared helper cannot live in realm-mcp, and turbo builds every package before any `test`).
//
// WHAT A REPORT HOLDS: one block per exported name of an entry, sorted, headed `name · kind · tag`
// (kind `value`, `type` or `both`; tag `public`, `beta` or `internal`, and for a public declaration
// with `@beta` members or parameters `public (beta: leases, outbound)`). A tagged name's block holds its
// declaration text: every declaration of the symbol in source order, printed by the TypeScript printer
// with comments removed, multi-line, `private` members dropped, `import("…").` prefixes stripped, and
// a `uses` line naming each type it references from another package with that package's major (the
// leading number of the referring package's own `dependencies` entry: a major bump changes the row).
//
// THE CELLS: (a) the closure rule — a `@public` declaration references only exported `@public` types (a
// member or parameter tagged `@beta`, and a `@beta` declaration, may reference `@beta` ones too); a
// type from another package needs a `dependencies` entry with a major; (b) the changelog rule — a
// tagged row changed, added or gone since the frozen copy (`api-report.frozen.txt`, the last
// release's rows) is named in backticks under `## [Unreleased]`; (c) the report equals the file; (d) a
// tagged row carries text and an internal row does not; (e) the words the docs say about it.
//
// TO REGENERATE (a change made on purpose): `npm run build` (from the repository root),
// then from packages/core `npx vitest run src/inventory -u`, commit both reports, and name each
// changed tagged name under `## [Unreleased]` in CHANGELOG.md, in backticks.
//
// ANOTHER BUILD (the frozen copy of a published release): with `REALM_API_REPORT_DIST=<dir>` (a folder
// whose `node_modules/@sensigo/{realm,realm-mcp}` hold the published packages) and
// `REALM_API_REPORT_OUT=<dir>`, only the generation cell runs: it writes that build's reports there,
// each row tagged by the committed reports' tag for its name; `scripts/freeze-api-report.mjs` turns a
// report into a frozen copy.
//
// Each cell carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');
const OTHER_DIST = process.env['REALM_API_REPORT_DIST'];
const OTHER_OUT = process.env['REALM_API_REPORT_OUT'];

// ---------------------------------------------------------------------------------------------------
// The packages and their entries.

interface Pkg {
  readonly name: '@sensigo/realm' | '@sensigo/realm-mcp';
  /** The package's root: its `package.json` and `dist/`. */
  readonly dir: string;
  /** Where its report lives in this repository. */
  readonly report: string;
  readonly entries: ReadonlyArray<{ readonly entry: string; readonly dts: string }>;
}

function packagesAt(core: string, mcp: string): Pkg[] {
  return [
    {
      name: '@sensigo/realm',
      dir: core,
      report: join(ROOT, 'packages/core/src/inventory/api-report.txt'),
      entries: [{ entry: '.', dts: join(core, 'dist/index.d.ts') }],
    },
    {
      name: '@sensigo/realm-mcp',
      dir: mcp,
      report: join(ROOT, 'packages/mcp-server/src/inventory/api-report.txt'),
      entries: [
        { entry: '.', dts: join(mcp, 'dist/index.d.ts') },
        { entry: './home', dts: join(mcp, 'dist/home-server.d.ts') },
      ],
    },
  ];
}

const PACKAGES =
  OTHER_DIST === undefined
    ? packagesAt(join(ROOT, 'packages/core'), join(ROOT, 'packages/mcp-server'))
    : packagesAt(
        join(OTHER_DIST, 'node_modules/@sensigo/realm'),
        join(OTHER_DIST, 'node_modules/@sensigo/realm-mcp'),
      );
const OURS = new Set<string>(['@sensigo/realm', '@sensigo/realm-mcp']);

// ---------------------------------------------------------------------------------------------------
// Where a declaration lives: one of the two packages, the platform (TypeScript's lib, Node's types),
// or another package (named, with the major the referring package depends on).

const packageCache = new Map<string, { name: string; dir: string } | null>();
/** The nearest `package.json` with a `name` above `file`. */
function packageOf(file: string): { name: string; dir: string } | null {
  let dir = dirname(realpathSync(file));
  const seen: string[] = [];
  for (;;) {
    if (packageCache.has(dir)) {
      const hit = packageCache.get(dir)!;
      for (const d of seen) packageCache.set(d, hit);
      return hit;
    }
    seen.push(dir);
    const p = join(dir, 'package.json');
    if (existsSync(p)) {
      const name = (JSON.parse(readFileSync(p, 'utf8')) as { name?: unknown }).name;
      if (typeof name === 'string') {
        for (const d of seen) packageCache.set(d, { name, dir });
        return { name, dir };
      }
    }
    const up = dirname(dir);
    if (up === dir) {
      for (const d of seen) packageCache.set(d, null);
      return null;
    }
    dir = up;
  }
}

type Place =
  | { readonly kind: 'ours'; readonly pkg: string }
  | { readonly kind: 'platform' }
  | { readonly kind: 'external'; readonly pkg: string };

function placeOf(decl: ts.Declaration): Place {
  const file = realpathSync(decl.getSourceFile().fileName);
  if (/[\\/]typescript[\\/]lib[\\/]/.test(file)) return { kind: 'platform' };
  const pkg = packageOf(file);
  if (pkg === null || pkg.name === '@types/node') return { kind: 'platform' };
  if (OURS.has(pkg.name)) return { kind: 'ours', pkg: pkg.name };
  return {
    kind: 'external',
    pkg: pkg.name.replace(/^@types\/(?:(.+)__(.+)|(.+))$/, (_, s, n, p) => p ?? `@${s}/${n}`),
  };
}

/** The major the referring package depends on for `pkg`, or the reason there is none. */
function majorOf(referrer: string, pkg: string): { major: number } | { problem: string } {
  const dir = PACKAGES.find((p) => p.name === referrer)?.dir;
  if (dir === undefined) return { problem: `no package ${referrer}` };
  const deps = (
    JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    }
  ).dependencies;
  const spec = deps?.[pkg];
  if (spec === undefined)
    return { problem: `${referrer}'s package.json has no dependencies entry for ${pkg}` };
  const m = /^\D*(\d+)/.exec(spec);
  if (m === null)
    return {
      problem: `${referrer}'s dependencies entry for ${pkg} ("${spec}") has no leading number`,
    };
  return { major: Number(m[1]) };
}

// ---------------------------------------------------------------------------------------------------
// The program over the built d.ts.

const program = ts.createProgram(
  PACKAGES.flatMap((p) => p.entries.map((e) => e.dts)),
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
const resolveAlias = (s: ts.Symbol): ts.Symbol =>
  s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;

type Tier = 'public' | 'beta' | 'internal';
const tagsOf = (node: ts.Node): string[] => ts.getJSDocTags(node).map((t) => t.tagName.text);
/** A symbol's release tier: its declarations' `@public` or `@beta` (public first), else internal. */
function tierOf(symbol: ts.Symbol): Tier {
  const tags = (symbol.declarations ?? []).flatMap((d) => tagsOf(d));
  return tags.includes('public') ? 'public' : tags.includes('beta') ? 'beta' : 'internal';
}

const isPrivate = (m: ts.Node): boolean => {
  const name = (m as ts.Node & { name?: ts.Node }).name;
  return (
    (ts.getCombinedModifierFlags(m as ts.Declaration) & ts.ModifierFlags.Private) !== 0 ||
    (name !== undefined && ts.isPrivateIdentifier(name))
  );
};

/** The type references inside `node`: left-most for `typeof A.b`, aliases resolved, type parameters skipped. */
function referencesIn(node: ts.Node): ts.Symbol[] {
  const out: ts.Symbol[] = [];
  const visit = (n: ts.Node): void => {
    let target: ts.Node | undefined;
    if (ts.isTypeReferenceNode(n)) target = n.typeName;
    else if (ts.isExpressionWithTypeArguments(n)) target = n.expression;
    else if (ts.isTypeQueryNode(n)) {
      let e: ts.EntityName = n.exprName;
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

/** A declaration in parts: the head, each member, each parameter — each with its own `@beta`. */
interface Part {
  readonly path: string;
  readonly beta: boolean;
  readonly refs: ts.Symbol[];
}
function partsOf(owner: string, symbol: ts.Symbol): Part[] {
  const parts: Part[] = [];
  const memberName = (m: ts.Node & { name?: ts.Node }): string =>
    m.name === undefined ? '(call)' : m.name.getText();
  for (const d of symbol.declarations ?? []) {
    const members =
      ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)
        ? d.members
        : ts.isTypeAliasDeclaration(d) && ts.isTypeLiteralNode(d.type)
          ? d.type.members
          : undefined;
    if (members !== undefined) {
      const head: ts.Symbol[] = [];
      const withHead = d as ts.InterfaceDeclaration | ts.ClassDeclaration | ts.TypeAliasDeclaration;
      for (const h of (withHead as ts.InterfaceDeclaration).heritageClauses ?? [])
        head.push(...referencesIn(h));
      for (const tp of withHead.typeParameters ?? []) head.push(...referencesIn(tp));
      parts.push({ path: owner, beta: false, refs: head });
      for (const m of members) {
        if (isPrivate(m)) continue;
        const path = `${owner}.${memberName(m)}`;
        const mBeta = tagsOf(m).includes('beta');
        // A method, constructor, call, construct or index signature, or a set accessor: its parameters.
        const sig = m as unknown as Partial<ts.SignatureDeclarationBase>;
        const params = sig.parameters ?? [];
        if (params.length > 0) {
          const rest: ts.Symbol[] = [];
          if (sig.type !== undefined) rest.push(...referencesIn(sig.type));
          for (const tp of sig.typeParameters ?? []) rest.push(...referencesIn(tp));
          parts.push({ path, beta: mBeta, refs: rest });
          for (const p of params) {
            parts.push({
              path: `${path}.${p.name.getText()}`,
              beta: mBeta || tagsOf(p).includes('beta'),
              refs: referencesIn(p),
            });
          }
        } else parts.push({ path, beta: mBeta, refs: referencesIn(m) });
      }
    } else if (ts.isFunctionDeclaration(d)) {
      const rest: ts.Symbol[] = [];
      if (d.type !== undefined) rest.push(...referencesIn(d.type));
      for (const tp of d.typeParameters ?? []) rest.push(...referencesIn(tp));
      parts.push({ path: owner, beta: false, refs: rest });
      for (const p of d.parameters) {
        parts.push({
          path: `${owner}.${p.name.getText()}`,
          beta: tagsOf(p).includes('beta'),
          refs: referencesIn(p),
        });
      }
    } else parts.push({ path: owner, beta: false, refs: referencesIn(d) });
  }
  return parts;
}

// ---------------------------------------------------------------------------------------------------
// The rows.

interface Row {
  readonly name: string;
  readonly kind: 'value' | 'type' | 'both';
  readonly tier: Tier;
  /** The header's tag: the tier, and for a public declaration its `@beta` members/parameters. */
  readonly tag: string;
  /** The block's text lines after the header (empty for an internal row). */
  readonly text: string[];
  readonly symbol: ts.Symbol;
  readonly pkg: Pkg;
}

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

/** One declaration as the report prints it. */
function printed(d: ts.Declaration): string {
  let node: ts.Node = ts.isVariableDeclaration(d) ? d.parent.parent : d;
  if (ts.isClassDeclaration(node)) {
    node = ts.factory.updateClassDeclaration(
      node,
      node.modifiers,
      node.name,
      node.typeParameters,
      node.heritageClauses,
      node.members.filter((m) => !isPrivate(m)),
    );
  }
  const text = printer
    .printNode(ts.EmitHint.Unspecified, node, d.getSourceFile())
    .replace(/import\("[^"]*"\)\./g, '')
    .replace(/^(?:export )?(?:default )?(?:declare )?/, '');
  return text;
}

/** A row's `uses` line: each type from another package, with that package's major; problems apart. */
function externalsOf(owner: Pkg, symbol: ts.Symbol): { uses: string[]; problems: string[] } {
  const uses = new Set<string>();
  const problems: string[] = [];
  for (const d of symbol.declarations ?? []) {
    for (const r of referencesIn(d)) {
      const place = placeOf(r.declarations![0]!);
      if (place.kind !== 'external') continue;
      const m = majorOf(owner.name, place.pkg);
      if ('problem' in m) problems.push(`${symbol.name} → ${r.name} (${place.pkg}): ${m.problem}`);
      else uses.add(`${r.name} (${place.pkg} ${m.major})`);
    }
  }
  return { uses: [...uses].sort(), problems };
}

/** The tags the committed reports give each name, for another build's report (`REALM_API_REPORT_DIST`). */
function committedTiers(pkg: Pkg): Map<string, Tier> {
  const tiers = new Map<string, Tier>();
  for (const r of parseReport(readFileSync(pkg.report, 'utf8'))) {
    tiers.set(`${r.section}\u0000${r.name}`, r.tag.split(' ')[0] as Tier);
  }
  return tiers;
}

interface Entry {
  readonly pkg: Pkg;
  readonly entry: string;
  readonly rows: Row[];
}

function entriesOf(pkg: Pkg): Entry[] {
  const fromCommitted = OTHER_DIST !== undefined ? committedTiers(pkg) : undefined;
  return pkg.entries.map(({ entry, dts }) => {
    const sf = program.getSourceFile(dts);
    if (sf === undefined) throw new Error(`no built d.ts at ${dts}: run the build first`);
    const mod = checker.getSymbolAtLocation(sf)!;
    const rows: Row[] = checker.getExportsOfModule(mod).map((exported) => {
      const symbol = resolveAlias(exported);
      const value = (symbol.flags & ts.SymbolFlags.Value) !== 0;
      const type = (symbol.flags & ts.SymbolFlags.Type) !== 0;
      const kind = value && type ? 'both' : value ? 'value' : 'type';
      const tier =
        fromCommitted?.get(`${entry}\u0000${exported.name}`) ??
        (fromCommitted ? 'internal' : tierOf(symbol));
      const betaParts =
        tier === 'public'
          ? partsOf(symbol.name, symbol)
              .filter((p) => p.beta)
              .map((p) => p.path.slice(symbol.name.length + 1))
              .sort()
          : [];
      const tag = betaParts.length > 0 ? `${tier} (beta: ${betaParts.join(', ')})` : tier;
      let text: string[] = [];
      if (tier !== 'internal') {
        const decls = [...(symbol.declarations ?? [])].sort(
          (a, b) =>
            a.getSourceFile().fileName.localeCompare(b.getSourceFile().fileName) || a.pos - b.pos,
        );
        text = decls.flatMap((d) => printed(d).split('\n'));
        const { uses } = externalsOf(pkg, symbol);
        if (uses.length > 0) text.push(`uses ${uses.join(', ')}`);
      }
      return { name: exported.name, kind, tier, tag, text, symbol, pkg } as Row;
    });
    rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { pkg, entry, rows };
  });
}

// ---------------------------------------------------------------------------------------------------
// The report's text, its blocks and their hashes (the same rules as scripts/freeze-api-report.mjs).

const HEADER = (pkg: string): string[] => [
  `# The API report of ${pkg}: every exported name of its entries, its kind and its release tag, and`,
  '# for a name tagged `@public` or `@beta` its declaration as the built d.ts declares it (comments',
  '# removed, `private` members dropped, and a `uses` line for a type from another package, with the',
  '# major this package depends on). api-report.test.ts (packages/core/src/inventory) regenerates it',
  '# from the build and fails when it differs.',
  '#',
  '# A change here is made on purpose: rebuild with `npm run build` (from the repository root),',
  '# regenerate with `npx vitest run src/inventory -u` (from packages/core), commit it in the same change,',
  '# and name each tagged name added, removed or changed under `## [Unreleased]` in CHANGELOG.md, in',
  '# backticks. A `@beta` declaration may change in a minor release; an untagged one is internal.',
];

function render(pkg: Pkg, entries: Entry[]): string {
  const lines = [...HEADER(pkg.name)];
  for (const e of entries) {
    lines.push('', `## ${e.entry === '.' ? `${pkg.name}` : `${pkg.name}/${e.entry.slice(2)}`}`, '');
    for (const r of e.rows) {
      lines.push(`${r.name} · ${r.kind} · ${r.tag}`);
      for (const t of r.text) lines.push(`  ${t}`);
      if (r.text.length > 0) lines.push('');
    }
  }
  while (lines.at(-1) === '') lines.pop();
  return `${lines.join('\n')}\n`;
}

interface Parsed {
  readonly section: string;
  readonly name: string;
  readonly kind: string;
  readonly tag: string;
  readonly block: string;
  readonly textLines: number;
}
/** The report's rows (a header line `name · kind · tag`, then its indented lines), by section. */
function parseReport(text: string): Parsed[] {
  const rows: Parsed[] = [];
  let section = '';
  let cur: { section: string; head: string; lines: string[] } | undefined;
  const flush = (): void => {
    if (cur === undefined) return;
    const [name, kind, tag] = cur.head.split(' · ');
    rows.push({
      section: cur.section,
      name: name!,
      kind: kind!,
      tag: tag!,
      block: [cur.head, ...cur.lines].join('\n'),
      textLines: cur.lines.length,
    });
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
const hashOf = (block: string): string =>
  createHash('sha256').update(block, 'utf8').digest('hex').slice(0, 10);

// ---------------------------------------------------------------------------------------------------
// The words.

const flat = (t: string): string => t.replace(/\s+/g, ' ');
const WORDS: ReadonlyArray<readonly [string, string]> = [
  [
    'docs/reference/compatibility.md',
    "and the library's exported names not tagged `@public` or `@beta`, on the main entry or any subpath (`@sensigo/realm-mcp`'s `./dist/tools/*.js` included); the API reports (`packages/core/src/inventory/api-report.txt`, `packages/mcp-server/src/inventory/api-report.txt`) list every name of the main entries and `./home`, each tagged declaration with its text; a `@beta` declaration may change in a minor release, named in the changelog, until it settles.",
  ],
  [
    'docs/reference/compatibility.md',
    "the library's public interface tagged in the source, each declaration checked by a test, with the rest importable from the main entry until 1.0 and from an internal entry after;",
  ],
  [
    'docs/reference/core-library.md',
    'The package exports many more names than this page covers. The ones Realm promises are tagged `@public` in the source and listed, each with its declaration, in `packages/core/src/inventory/api-report.txt`; a change to one is named in the changelog. The rest are the parts the `realm` command is built from; they may change in a minor release, and at 1.0 they move to an internal entry.',
  ],
  [
    'docs/reference/core-library.md',
    'Left out, every figure comes from the installed price list and notes that no economics file is configured.',
  ],
  [
    'CHANGELOG.md',
    "- The library's public interface is decided on purpose and kept by tests: every public declaration of `@sensigo/realm` and `@sensigo/realm-mcp` is tagged `@public` (or `@beta` while it settles) and listed with its declaration in a committed API report the test suite regenerates and compares; a public declaration refers only to public types (a member or parameter marked `@beta` may refer to `@beta` ones); a tagged declaration changed since the last release must be named under `[Unreleased]`, or a test fails. Names without a tag stay importable until 1.0 and may change in a minor release.",
  ],
  [
    '.github/instructions/pre-publication.instructions.md',
    "`packages/core/src/inventory/api-report.frozen.txt` and `packages/mcp-server/src/inventory/api-report.frozen.txt` are written from their reports by `node scripts/freeze-api-report.mjs <report> 'frozen at v<version>'`, and added to the same commit: the changelog cell starts clean for the next release.",
  ],
  [
    'docs/reference/compatibility.md',
    "A promised list of words — an exported list of literals, or a table keyed by them, that the API reports tag, such as `WAY_VERBS`, `UNAVAILABLE_CODES`, `STOP_KINDS` and `PARTIES`, and the types over them — may gain a member in a minor release, named in the changelog, and a type keyed by such a list (`WayRenderer`, one function per verb) gains the member with it; a program's switch over such a list keeps a default branch, and a program that renders ways builds its map with `PartialWayRenderer` completed by `withLibraryWords`, so a verb added later renders with Realm's words until the program writes its own; a program that writes the full `WayRenderer` itself adds a function when a verb is added.",
  ],
  [
    'docs/reference/core-library.md',
    "To render a reply's `ways` with your own words for some verbs and Realm's for the rest, build the map with `withLibraryWords({ respond: …, run_step: … })`; a verb Realm adds later renders with its own words until you write yours.",
  ],
];

/** The changelog's `## [Unreleased]` section. */
function unreleased(): string {
  const text = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
  const at = text.indexOf('\n## [Unreleased]');
  const next = text.indexOf('\n## [', at + 1);
  return at === -1 ? '' : text.slice(at, next === -1 ? undefined : next);
}

// ---------------------------------------------------------------------------------------------------

const ENTRIES = new Map(PACKAGES.map((p) => [p, entriesOf(p)]));

describe.skipIf(OTHER_DIST === undefined)(
  'CP-1 — another build’s reports (REALM_API_REPORT_DIST)',
  () => {
    it('writes each package’s report of that build, tagged by the committed reports', () => {
      expect(OTHER_OUT, 'REALM_API_REPORT_OUT names the folder to write to').toBeDefined();
      mkdirSync(OTHER_OUT!, { recursive: true });
      for (const [pkg, entries] of ENTRIES) {
        writeFileSync(
          join(OTHER_OUT!, `${pkg.name.split('/')[1]}.api-report.txt`),
          render(pkg, entries),
        );
      }
    });
  },
);

describe.skipIf(OTHER_DIST !== undefined)('CP-1 — the API reports', () => {
  for (const [pkg, entries] of ENTRIES) {
    const short = pkg.name;

    it(`${short}: (c) the report equals the committed file`, async () => {
      const live = render(pkg, entries);
      const committed = existsSync(pkg.report) ? readFileSync(pkg.report, 'utf8') : '';
      // The instrument: the build was read in full.
      const rows = entries.reduce((n, e) => n + e.rows.length, 0);
      expect({ rows: rows > (pkg.name === '@sensigo/realm' ? 1000 : 40) }).toEqual({ rows: true });
      // (a) red when a tagged declaration, a tag or the export list changed and the report was not
      //     regenerated; (b) prints the blocks missing and new, each changed block's line diff, and
      //     what to do.
      let message = '';
      if (live !== committed) {
        const want = new Map(
          parseReport(committed).map((r) => [`${r.section} ${r.name}`, r.block]),
        );
        const got = new Map(parseReport(live).map((r) => [`${r.section} ${r.name}`, r.block]));
        const out: string[] = [];
        for (const k of [...want.keys()].filter((k) => !got.has(k)).sort())
          out.push(`- ${k} (missing)`);
        for (const k of [...got.keys()].filter((k) => !want.has(k)).sort())
          out.push(`+ ${k} (new)`);
        for (const [k, b] of got) {
          const was = want.get(k);
          if (was === undefined || was === b) continue;
          out.push(`~ ${k}:`);
          const a = was.split('\n');
          const c = b.split('\n');
          for (const l of a.filter((l) => !c.includes(l))) out.push(`    - ${l}`);
          for (const l of c.filter((l) => !a.includes(l))) out.push(`    + ${l}`);
        }
        message = `${pkg.report} differs from the build:\n${out.join('\n')}\nRegenerate it: npm run build (from the repository root), then (from packages/core) npx vitest run src/inventory -u; and name each tagged name added, removed or changed under ## [Unreleased] in CHANGELOG.md, in backticks.`;
      }
      await expect(live, message).toMatchFileSnapshot(pkg.report);
    });

    it(`${short}: (a) a public declaration refers only to exported public types (a @beta member or parameter, and a @beta declaration, may refer to @beta ones)`, () => {
      const tierBySymbol = new Map<ts.Symbol, Tier>();
      for (const es of ENTRIES.values())
        for (const e of es) for (const r of e.rows) tierBySymbol.set(r.symbol, r.tier);
      const problems: string[] = [];
      for (const e of entries) {
        for (const r of e.rows) {
          if (r.tier === 'internal') continue;
          for (const part of partsOf(r.symbol.name, r.symbol)) {
            const beta = r.tier === 'beta' || part.beta;
            for (const ref of part.refs) {
              const place = placeOf(ref.declarations![0]!);
              if (place.kind === 'platform') continue;
              if (place.kind === 'external') {
                const m = majorOf(pkg.name, place.pkg);
                if ('problem' in m)
                  problems.push(`${part.path} → ${ref.name} (${place.pkg}): ${m.problem}`);
                continue;
              }
              const t = tierBySymbol.get(ref);
              if (t === undefined) problems.push(`${part.path} → ${ref.name} (not exported)`);
              else if (t === 'internal' || (t === 'beta' && !beta))
                problems.push(`${part.path} → ${ref.name} (${t})`);
            }
          }
        }
      }
      // (a) red when a public declaration names an untagged or unexported type, a beta type outside a
      //     @beta member or parameter, or a type from a package it does not depend on with a major;
      //     (b) prints each referrer, the reference and its tag (or "not exported").
      expect([...new Set(problems)].sort()).toEqual([]);
    });

    it(`${short}: (d) every tagged row in the committed report carries its declaration; an internal row carries none`, () => {
      const rows = parseReport(existsSync(pkg.report) ? readFileSync(pkg.report, 'utf8') : '');
      const wrong = rows
        .filter((r) => (r.tag.startsWith('internal') ? r.textLines > 0 : r.textLines === 0))
        .map((r) => `${r.name} · ${r.tag} (${r.textLines} text lines)`);
      // (a) red when a tier is misspelled or a tagged row lost its text; (b) prints those rows.
      expect({ rows: rows.length > 40, wrong }).toEqual({ rows: true, wrong: [] });
    });

    it(`${short}: (b) a tagged row added, changed or gone since the frozen copy is named under [Unreleased]`, () => {
      const frozenFile = pkg.report.replace(/\.txt$/, '.frozen.txt');
      const frozenText = readFileSync(frozenFile, 'utf8');
      const frozen = new Map<string, { tag: string; hash: string }>();
      let section = '.';
      for (const line of frozenText.split('\n')) {
        if (line.startsWith('## ')) {
          const heading = line.slice(3);
          section = heading.split('/').length > 2 ? `./${heading.split('/').at(-1)}` : '.';
        }
        if (line === '' || line.startsWith('#')) continue;
        const [name, , tag, hash] = line.split(' · ');
        frozen.set(`${section} ${name}`, { tag: tag!, hash: hash! });
      }
      const live = new Map<string, { tag: string; hash: string }>();
      for (const r of parseReport(render(pkg, entries))) {
        if (r.tag.startsWith('internal')) continue;
        live.set(`${r.section} ${r.name}`, { tag: r.tag, hash: hashOf(r.block) });
      }
      // The instrument: the frozen copy is one, and both were read in full.
      expect({
        frozenHeader: /^# frozen at /m.test(frozenText),
        liveRows: live.size > (pkg.name === '@sensigo/realm' ? 300 : 4),
        frozenRows: frozen.size > (pkg.name === '@sensigo/realm' ? 300 : 4),
      }).toEqual({ frozenHeader: true, liveRows: true, frozenRows: true });
      const changes: string[] = [];
      const nameOf = (k: string): string => k.slice(k.indexOf(' ') + 1);
      for (const [k, v] of live) {
        const was = frozen.get(k);
        if (was === undefined) changes.push(`+ ${nameOf(k)}`);
        else if (was.tag.split(' ')[0] !== v.tag.split(' ')[0])
          changes.push(`~ ${nameOf(k)}: ${was.tag.split(' ')[0]} → ${v.tag.split(' ')[0]}`);
        else if (was.hash !== v.hash || was.tag !== v.tag) changes.push(`~ ${nameOf(k)}`);
      }
      for (const k of frozen.keys()) if (!live.has(k)) changes.push(`- ${nameOf(k)}`);
      const section_ = unreleased();
      const missing = changes
        .filter((c) => !section_.includes(`\`${c.slice(2).split(':')[0]}\``))
        .sort();
      // (a) red when a tagged declaration was added, changed, retagged or removed and the changelog's
      //     [Unreleased] section does not name it in backticks; (b) prints each such name with its change.
      expect(
        { missingFromTheChangelog: missing },
        'name each under ## [Unreleased] in CHANGELOG.md, in backticks (+ added, ~ changed, - gone)',
      ).toEqual({ missingFromTheChangelog: [] });
    });

    it(`${short}: scripts/freeze-api-report.mjs writes the rows and hashes this test reads`, async () => {
      const script = (await import(
        pathToFileURL(join(ROOT, 'scripts/freeze-api-report.mjs')).href
      )) as {
        frozenText: (report: string, header: string) => string;
      };
      const text = script.frozenText(render(pkg, entries), 'frozen at test');
      const expected = parseReport(render(pkg, entries))
        .filter((r) => !r.tag.startsWith('internal'))
        .map((r) => `${r.name} · ${r.kind} · ${r.tag} · ${hashOf(r.block)}`);
      const rows = text.split('\n').filter((l) => l !== '' && !l.startsWith('#'));
      // (a) red when the script's rows or hashes drift from this test's (a freeze would then make
      //     every row read as changed); (b) prints the rows that differ.
      expect({
        header: text.startsWith('# frozen at test\n'),
        notIn: rows.filter((r) => !expected.includes(r)),
        missing: expected.filter((r) => !rows.includes(r)),
      }).toEqual({ header: true, notIn: [], missing: [] });
    });
  }

  it('(e) the words: the compatibility page, the core library page, the changelog and the release checklist', () => {
    const found = WORDS.map(([page, sentence]) => [
      page,
      flat(readFileSync(join(ROOT, page), 'utf8')).includes(flat(sentence)),
    ]);
    // (a) red when one word of a sentence differs; (b) prints each page and whether it was found.
    expect(found).toEqual(WORDS.map(([page]) => [page, true]));
  });
});
