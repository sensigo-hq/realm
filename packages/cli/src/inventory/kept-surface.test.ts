// kept-surface.test.ts — CP-I: the kept surface of the CLI and of `realm listen` / `realm serve` in one
// committed file, `kept-surface.txt`, which this test regenerates from the code and compares.
//
// WHAT IT CHECKS:
// - the snapshot cell: the command tree the binary runs (`buildRealmProgram`, walked in this process),
//   the exit codes and the reply codes, rendered and compared with the committed file by
//   `toMatchFileSnapshot`. Locally `vitest -u` rewrites the file; with `CI` set a difference, or a
//   missing file, fails and nothing is written. Before comparing, the walk must have reached the tree.
// - the exit-code census: every literal code passed to `process.exit(`, `exitProcess(` or
//   `process.exitCode =` is one of the file's codes, and every call with a computed code is at a site
//   the file lists, with its count; fail-closed both ways.
// - the reply census: every (route family, status, shape) Realm's own HTTP code sends is a row of the
//   file, and every row has a site; a status passed as a variable is listed as a site; fail-closed
//   both ways.
//
// WHAT IT SEES: the TypeScript syntax of `packages/{core,cli,mcp-server,testing,store-sqlite}/src/**/*.ts`
// (not `*.test.ts`, not `*.d.ts`; the clock census's file rule). The reply shapes, in the files that
// declare or import one of the four reply helpers: a helper's call (the name resolved to the helper,
// never a bare word: other files have their own `refuse`), `writeHead(` with its status, an object
// literal with a numeric `status` (listen's reply builders), and a raw `HTTP/1.1 ${…}` reply.
// WHAT IT CANNOT SEE, in words: `.mjs` files (two child processes' `exit(3)`, a test capture's
// `exit(2)`), an exit through an injected function (`deps.exit`), Commander's own exits (a usage
// error 1, `--help` and `--version` 0 — the file states them), the MCP SDK's statuses inside
// `realm serve`, and the Slack gate's receiver under `realm agent` (no reply helper; not a kept surface).
//
// Each cell carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import type { Argument, Command, Option } from 'commander';
import { buildRealmProgram } from '../commands-registry.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = join(HERE, '..', '..', '..');
const SCANNED = ['core', 'cli', 'mcp-server', 'testing', 'store-sqlite'];
const LIVE = join(HERE, 'kept-surface.txt');
/** The key of a row is the text before this separator. */
const SEP = ' — ';

// ---------------------------------------------------------------------------------------------------
// The source files and their syntax.

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && e.name !== 'dist') sourceFiles(p, out);
    } else if (p.endsWith('.ts') && !p.endsWith('.d.ts') && !p.endsWith('.test.ts')) {
      out.push(p);
    }
  }
  return out;
}

/** `cli/src/commands/run.ts`: the file's path under `packages/`, as the clock census keys it. */
const rel = (path: string): string => relative(PACKAGES, path).split(sep).join('/');

interface Source {
  file: string;
  path: string;
  ast: ts.SourceFile;
}

const SOURCES: Source[] = SCANNED.flatMap((p) => sourceFiles(join(PACKAGES, p, 'src')))
  .sort()
  .map((path) => ({
    file: rel(path),
    path,
    ast: ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true),
  }));

function visit(node: ts.Node, fn: (n: ts.Node) => void): void {
  fn(node);
  ts.forEachChild(node, (c) => visit(c, fn));
}

/** The nearest enclosing function that has a name, with that name. */
function enclosingFunction(
  node: ts.Node,
): { name: string; fn: ts.SignatureDeclaration } | undefined {
  for (let n = node.parent; n !== undefined; n = n.parent) {
    if (
      ts.isFunctionDeclaration(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n)
    ) {
      let name: string | undefined =
        n.name !== undefined && !ts.isArrowFunction(n) ? n.name.getText() : undefined;
      if (name === undefined && ts.isVariableDeclaration(n.parent)) name = n.parent.name.getText();
      if (name === undefined && ts.isPropertyAssignment(n.parent)) name = n.parent.name.getText();
      if (name !== undefined) return { name, fn: n };
    }
  }
  return undefined;
}

const unwrap = (e: ts.Expression): ts.Expression => {
  let x = e;
  while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x)) {
    x = x.expression;
  }
  return x;
};

/** The number literals an expression can only be: `1`, `cut > 0 ? 1 : 0`; else undefined (computed). */
function literalNumbers(e: ts.Expression | undefined): number[] | undefined {
  if (e === undefined) return undefined;
  const x = unwrap(e);
  if (ts.isNumericLiteral(x)) return [Number(x.text)];
  if (ts.isConditionalExpression(x)) {
    const a = literalNumbers(x.whenTrue);
    const b = literalNumbers(x.whenFalse);
    return a !== undefined && b !== undefined ? [...a, ...b] : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------
// The command tree.

/** Every command node of the tree, the implicit `help` commands included, with its path. */
function nodesOf(cmd: Command, path: string): Array<{ path: string; cmd: Command; help: boolean }> {
  const visible = cmd.createHelp().visibleCommands(cmd);
  const implicit = visible.filter((c) => !cmd.commands.includes(c));
  return [
    { path, cmd, help: false },
    ...[...cmd.commands, ...implicit]
      .map((c) => ({ c, name: c.name() }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .flatMap(({ c, name }) =>
        implicit.includes(c)
          ? [{ path: `${path} ${name}`, cmd: c, help: true }]
          : nodesOf(c, `${path} ${name}`),
      ),
  ];
}

/**
 * Whether each default given in the source for these flags is a literal (a string, a number, a
 * boolean, or a `const` of the same file bound to one); a default worked out any other way is rendered
 * as `computed`, so the file is the same on every machine.
 */
const LITERAL_DEFAULT: Map<string, boolean> = (() => {
  const isLiteral = (e: ts.Expression): boolean => {
    const x = unwrap(e);
    return (
      ts.isStringLiteral(x) ||
      ts.isNoSubstitutionTemplateLiteral(x) ||
      ts.isNumericLiteral(x) ||
      x.kind === ts.SyntaxKind.TrueKeyword ||
      x.kind === ts.SyntaxKind.FalseKeyword ||
      (ts.isPrefixUnaryExpression(x) &&
        x.operator === ts.SyntaxKind.MinusToken &&
        ts.isNumericLiteral(x.operand))
    );
  };
  const found = new Map<string, boolean>();
  for (const s of SOURCES.filter((x) => x.file.startsWith('cli/'))) {
    // A top-level `const` of this file bound to a literal counts as that literal
    // (`const SCHEMA_RETRIES_DEFAULT = 2`).
    const constants = new Set<string>();
    for (const st of s.ast.statements) {
      if (ts.isVariableStatement(st) && st.declarationList.flags & ts.NodeFlags.Const) {
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.initializer !== undefined && isLiteral(d.initializer)) {
            constants.add(d.name.text);
          }
        }
      }
    }
    const isLiteralHere = (e: ts.Expression): boolean =>
      isLiteral(e) ||
      (ts.isIdentifier(unwrap(e)) && constants.has((unwrap(e) as ts.Identifier).text));
    visit(s.ast, (n) => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        ['option', 'requiredOption'].includes(n.expression.name.text) &&
        n.arguments.length >= 3 &&
        ts.isStringLiteralLike(n.arguments[0]!)
      ) {
        const flags = n.arguments[0].text;
        const literal = isLiteralHere(n.arguments[n.arguments.length - 1]!);
        found.set(flags, (found.get(flags) ?? true) && literal);
      }
    });
  }
  return found;
})();

const json = (v: unknown): string => JSON.stringify(v);

function defaultOf(flags: string | undefined, value: unknown): string {
  if (value === undefined) return '';
  return flags !== undefined && LITERAL_DEFAULT.get(flags) === true
    ? `, default ${json(value)}`
    : ', default computed';
}

function argumentRow(path: string, a: Argument, i: number): string {
  return (
    `${path} <${a.name()}>${SEP}argument ${i + 1}, ${a.required ? 'required' : 'optional'}` +
    (a.variadic ? ', variadic' : '') +
    (a.defaultValue !== undefined ? ', default computed' : '') +
    (a.argChoices !== undefined ? `, one of ${a.argChoices.join('|')}` : '')
  );
}

function optionRow(path: string, o: Option): string {
  const name = o.long ?? o.short ?? o.flags;
  const opt = o as Option & { conflictsWith?: string[]; implied?: Record<string, unknown> };
  return (
    `${path} ${name}${SEP}option` +
    (o.long !== undefined && o.short !== undefined ? `, short ${o.short}` : '') +
    (o.required ? ', takes a value' : o.optional ? ', takes an optional value' : ', no value') +
    (o.variadic ? ', variadic' : '') +
    (o.negate ? ', negates' : '') +
    (o.mandatory ? ', mandatory' : '') +
    defaultOf(o.flags, o.defaultValue) +
    (o.presetArg !== undefined ? `, preset ${json(o.presetArg)}` : '') +
    (o.envVar !== undefined ? `, read from ${o.envVar}` : '') +
    (o.argChoices !== undefined ? `, one of ${o.argChoices.join('|')}` : '') +
    (opt.conflictsWith !== undefined && opt.conflictsWith.length > 0
      ? `, conflicts with ${opt.conflictsWith.join(', ')}`
      : '') +
    (opt.implied !== undefined ? `, implies ${json(opt.implied)}` : '') +
    (o.hidden ? ', hidden' : '')
  );
}

interface Walk {
  rows: string[];
  leaves: number;
  options: number;
}

function walkTree(program: Command): Walk {
  const rows: string[] = [];
  let leaves = 0;
  let options = 0;
  for (const { path, cmd, help } of nodesOf(program, 'realm')) {
    const parent = cmd.parent ?? undefined;
    const isHidden =
      parent !== undefined && !help && !parent.createHelp().visibleCommands(parent).includes(cmd);
    rows.push(
      `${path}${SEP}command${help ? ", Commander's help" : ''}${isHidden ? ', hidden' : ''}`,
    );
    for (const alias of cmd.aliases())
      rows.push(`${path.replace(/ \S+$/, '')} ${alias}${SEP}alias of ${path}`);
    if (!help && cmd.commands.length === 0) leaves++;
    cmd.registeredArguments.forEach((a, i) => rows.push(argumentRow(path, a, i)));
    // The command's own options, then Commander's `-h, --help` where the command has it.
    const own = [...cmd.options];
    options += help ? 0 : own.length;
    const builtIn = cmd
      .createHelp()
      .visibleOptions(cmd)
      .filter((o) => !own.includes(o));
    for (const o of [...own, ...builtIn].sort((a, b) => {
      const x = a.long ?? a.short ?? '';
      const y = b.long ?? b.short ?? '';
      return x < y ? -1 : x > y ? 1 : 0;
    })) {
      rows.push(optionRow(path, o));
    }
  }
  return { rows, leaves, options };
}

// ---------------------------------------------------------------------------------------------------
// The exit-code census.

/** The codes a command can end with, and what each means (exit code 2 comes from `migrateExitCode`). */
const EXIT_CODES: ReadonlyArray<readonly [number, string]> = [
  [0, 'success; also `--help` and `--version`'],
  [
    1,
    'a failure of any kind, a usage error included (an unknown command or flag, a missing argument or value)',
  ],
  [
    2,
    '`realm run migrate --detailed-exitcode` only: it succeeded, and a finished run is left whose ending cannot be worked out or whose record disagrees with its stored ending',
  ],
];

interface ExitCensus {
  literals: Array<{ file: string; code: number }>;
  computed: Map<string, number>;
  exitProcessDeclarations: string[];
}

function exitCensus(): ExitCensus {
  const literals: ExitCensus['literals'] = [];
  const computed = new Map<string, number>();
  const exitProcessDeclarations: string[] = [];
  const isProcessMember = (e: ts.Expression, member: string): boolean =>
    ts.isPropertyAccessExpression(e) &&
    ts.isIdentifier(e.expression) &&
    e.expression.text === 'process' &&
    e.name.text === member;
  for (const s of SOURCES) {
    const record = (arg: ts.Expression | undefined): void => {
      const codes = literalNumbers(arg);
      if (codes === undefined) computed.set(s.file, (computed.get(s.file) ?? 0) + 1);
      else for (const code of codes) literals.push({ file: s.file, code });
    };
    visit(s.ast, (n) => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === 'exitProcess') {
        exitProcessDeclarations.push(s.file);
      }
      if (
        ts.isCallExpression(n) &&
        (isProcessMember(n.expression, 'exit') ||
          (ts.isIdentifier(n.expression) && n.expression.text === 'exitProcess'))
      ) {
        record(n.arguments[0]);
      }
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        isProcessMember(n.left, 'exitCode')
      ) {
        record(n.right);
      }
    });
  }
  return { literals, computed, exitProcessDeclarations };
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function exitRows(census: ExitCensus): string[] {
  return [
    ...EXIT_CODES.map(([code, meaning]) => `exit code ${code}${SEP}${meaning}`),
    ...[...census.computed.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([file, n]) => `exit site ${file}${SEP}${plural(n, 'call')} with a computed code`),
  ];
}

// ---------------------------------------------------------------------------------------------------
// The reply census.

/** The four reply helpers: where each is declared, which argument is its status, its route family. */
const HELPERS: ReadonlyArray<{ name: string; file: string; status?: number; family: string }> = [
  { name: 'respond', file: 'cli/src/commands/listen.ts', status: 1, family: 'realm listen' },
  { name: 'refuse', file: 'cli/src/commands/listen.ts', status: 2, family: 'realm listen' },
  {
    name: 'sendRead',
    file: 'cli/src/lib/run-read-address.ts',
    status: 2,
    family: 'realm listen read',
  },
  { name: 'answerHealth', file: 'cli/src/lib/health-address.ts', family: '/health' },
];

/** A reply written outside a helper takes its family from the command whose server writes it. */
const FILE_FAMILY: Record<string, string> = {
  'cli/src/commands/listen.ts': 'realm listen',
  'cli/src/commands/serve.ts': 'realm serve',
};

/**
 * One meaning per (family, status, shape), in the words of the docs' reply tables
 * (`docs/reference/workflow/webhook-trigger.md`, `docs/reference/cli/realm-mcp-and-serve.md`).
 */
const MEANINGS: Record<string, string> = {
  '/health 200 answerHealth': 'the program is accepting connections',
  '/health 503 answerHealth': 'the program has been asked to stop (Ctrl+C or SIGTERM)',
  'realm listen 200 respond':
    'the `filter` skipped the event, or a run already has the event ID (deduplicated)',
  'realm listen 202 respond':
    'the request started a run; to a request that waits, its run has not ended',
  'realm listen 400 clientErrorReply': 'a request that is not valid HTTP',
  'realm listen 400 refuse':
    'an HTTP/1.1 request without a `Host` header, or a body that broke off while it was read',
  'realm listen 400 respond':
    'the body is not JSON, the event ID cannot be found with `on_missing_id: reject`, or the parameters do not fit `params_schema`',
  'realm listen 403 refuse': 'no workflow is mounted at the address',
  'realm listen 403 respond': 'the `auth` check failed',
  'realm listen 405 refuse': 'the method is not POST, and the request is not a read request',
  'realm listen 408 clientErrorReply': 'the headers, or the whole request, did not arrive in time',
  'realm listen 408 refuse': 'the body did not arrive within `--body-timeout-ms`',
  'realm listen 413 clientErrorReply': "a chunked body's extensions are too large",
  'realm listen 413 refuse': 'the body is larger than `--max-body-bytes`',
  'realm listen 415 respond': '`Content-Type` is not `application/json`',
  'realm listen 417 refuse': 'an `Expect` header that does not include `100-continue`',
  'realm listen 431 clientErrorReply': 'the headers are larger than Node accepts',
  'realm listen 500 respond': 'the store failed, or an unexpected error',
  'realm listen 500 spawnFailedReply':
    "the run's agent failed to start; every retry of that delivery gets it again",
  'realm listen 503 refuse': 'as many requests are being handled as `--max-concurrent` allows',
  'realm listen read 200 sendRead':
    "the run's phase and, once it has completed, its result; also the answer to a request that waited for its run to end",
  'realm listen read 403 sendRead': 'a refused read, whatever the reason',
  'realm listen read 503 sendRead':
    'the store cannot be read, or the values cannot be checked for secrets',
  'realm serve 400 writeHead': 'a body that is not JSON',
  'realm serve 401 writeHead': 'no token, or a wrong one',
  'realm serve 413 writeHead': 'a body larger than 1 MiB',
  'realm serve 500 writeHead': 'the request failed inside the server',
};

interface ReplyCensus {
  pairs: Map<string, string[]>;
  computed: Map<string, number>;
  unresolved: string[];
  helpersFound: string[];
}

function replyCensus(): ReplyCensus {
  const pairs = new Map<string, string[]>();
  const computed = new Map<string, number>();
  const unresolved: string[] = [];
  const helpersFound: string[] = [];
  const add = (
    family: string | undefined,
    file: string,
    shape: string,
    statuses: number[] | undefined,
  ): void => {
    if (statuses === undefined) {
      const k = `${file}${SEP}${shape}`;
      computed.set(k, (computed.get(k) ?? 0) + 1);
      return;
    }
    if (family === undefined) {
      unresolved.push(`${file} ${shape} ${statuses.join('/')}`);
      return;
    }
    for (const status of statuses) {
      const k = `${family} ${status} ${shape}`;
      pairs.set(k, [...(pairs.get(k) ?? []), file]);
    }
  };
  for (const s of SOURCES) {
    // The helpers this file can call: the ones it declares (a function, or a function held by a
    // `const`, at any depth), and the ones it imports from a helper's own file.
    const callable = new Map<string, (typeof HELPERS)[number]>();
    visit(s.ast, (n) => {
      const declared =
        ts.isFunctionDeclaration(n) && n.name !== undefined
          ? { name: n.name.text, fn: n as ts.SignatureDeclaration }
          : ts.isVariableDeclaration(n) &&
              ts.isIdentifier(n.name) &&
              n.initializer !== undefined &&
              (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
            ? { name: n.name.text, fn: n.initializer as ts.SignatureDeclaration }
            : undefined;
      const h = HELPERS.find((x) => x.name === declared?.name && x.file === s.file);
      if (declared !== undefined && h !== undefined) {
        callable.set(h.name, h);
        const p = h.status === undefined ? undefined : declared.fn.parameters[h.status];
        helpersFound.push(`${h.name}(${p === undefined ? '' : p.name.getText()})`);
      }
    });
    for (const st of s.ast.statements) {
      if (
        ts.isImportDeclaration(st) &&
        ts.isStringLiteral(st.moduleSpecifier) &&
        st.importClause?.namedBindings !== undefined &&
        ts.isNamedImports(st.importClause.namedBindings)
      ) {
        const target = rel(
          resolve(dirname(s.path), st.moduleSpecifier.text.replace(/\.js$/, '.ts')),
        );
        for (const el of st.importClause.namedBindings.elements) {
          const h = HELPERS.find(
            (x) => x.name === (el.propertyName ?? el.name).text && x.file === target,
          );
          if (h !== undefined) callable.set(el.name.text, h);
        }
      }
    }
    if (callable.size === 0) continue;
    visit(s.ast, (n) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const h = callable.get(n.expression.text);
        if (h !== undefined && h.status !== undefined) {
          add(h.family, s.file, h.name, literalNumbers(n.arguments[h.status]));
        }
      }
      const inside = enclosingFunction(n);
      const insideHelper = HELPERS.find((h) => h.name === inside?.name && h.file === s.file);
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === 'writeHead'
      ) {
        const arg = n.arguments[0];
        // A helper writing the status it was given is the helper itself, counted at its calls.
        const own =
          insideHelper !== undefined &&
          arg !== undefined &&
          ts.isIdentifier(unwrap(arg)) &&
          inside!.fn.parameters.some(
            (p) => p.name.getText() === (unwrap(arg) as ts.Identifier).text,
          );
        if (!own) {
          add(
            insideHelper?.family ?? FILE_FAMILY[s.file],
            s.file,
            insideHelper?.name ?? 'writeHead',
            literalNumbers(arg),
          );
        }
      }
      if (ts.isObjectLiteralExpression(n)) {
        for (const p of n.properties) {
          if (
            ts.isPropertyAssignment(p) &&
            p.name.getText() === 'status' &&
            ts.isNumericLiteral(unwrap(p.initializer))
          ) {
            add(
              FILE_FAMILY[s.file],
              s.file,
              inside?.name ?? 'reply object',
              literalNumbers(p.initializer),
            );
          }
        }
      }
      if (ts.isTemplateExpression(n) && /^HTTP\/1\.[01] $/.test(n.head.text)) {
        add(
          FILE_FAMILY[s.file],
          s.file,
          'raw reply',
          literalNumbers(n.templateSpans[0]?.expression),
        );
      }
    });
  }
  return { pairs, computed, unresolved, helpersFound };
}

function replyRows(census: ReplyCensus): string[] {
  const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return [
    ...[...census.pairs.keys()].sort(byCode).map((k) => {
      const [family, status, shape] = splitPair(k);
      return `${family} ${status}${SEP}${shape}: ${MEANINGS[k] ?? '(no meaning yet: add one to MEANINGS in kept-surface.test.ts)'}`;
    }),
    ...[...census.computed.entries()]
      .sort(([a], [b]) => byCode(a, b))
      .map(([k, n]) => {
        const [file, shape] = k.split(SEP) as [string, string];
        return `reply site ${file}${SEP}${plural(n, `${shape} call`)} with a computed status`;
      }),
  ];
}

/** `realm listen read 403 sendRead` → [`realm listen read`, `403`, `sendRead`]. */
function splitPair(k: string): [string, string, string] {
  const m = /^(.*) (\d{3}) (\S.*)$/.exec(k);
  if (m === null) throw new Error(`not a reply pair: ${k}`);
  return [m[1]!, m[2]!, m[3]!];
}

// ---------------------------------------------------------------------------------------------------
// The file.

const HEADER = [
  "# The kept surface of realm's CLI and of `realm listen` / `realm serve`: the commands, flags, exit",
  '# codes and reply codes the compatibility page promises to keep. kept-surface.test.ts, beside this',
  '# file, regenerates it from the code and fails when it differs.',
  '#',
  '# A change here is made on purpose: regenerate it with `npx vitest run src/inventory -u` (from',
  '# packages/cli) and run it once more without `-u` (the two censuses read the committed file as it',
  '# was), commit it in the same change, and name each changed key under `## [Unreleased]` in',
  '# CHANGELOG.md, in backticks. A row\'s key is its text before " — "; for example',
  '# `realm run migrate --detailed-exitcode`, `exit code 2`, `realm listen 403`. Rows marked `hidden`',
  '# and the `exit site` / `reply site` rows are listed to be seen, not promised: a change to them',
  '# needs no changelog line. kept-surface.frozen.txt is this file as of the last release.',
];

const ENVIRONMENT =
  "# The REALM_* names are kept by two cells, not by this file: core's redaction.test.ts (the names the source reads are the lists) and cli's docs-disclosure-729.test.ts (the lists are the docs page's rows).";

function renderInventory(tree: Walk, exits: ExitCensus, replies: ReplyCensus): string {
  return [
    ...HEADER,
    '',
    '## commands',
    ...tree.rows,
    '',
    '## exit codes',
    ...exitRows(exits),
    '',
    '## HTTP',
    ...replyRows(replies),
    '',
    '## environment',
    ENVIRONMENT,
    '',
  ].join('\n');
}

/** The committed file's rows of one section (comment lines and blank lines dropped). */
function committedSection(name: string): string[] {
  const lines = readFileSync(LIVE, 'utf8').split('\n');
  const start = lines.indexOf(`## ${name}`);
  if (start === -1) return [];
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .filter((l) => l !== '' && !l.startsWith('#'));
}

// ---------------------------------------------------------------------------------------------------

describe('CP-I — the kept surface, regenerated from the code', () => {
  it('the inventory file is the command tree, the exit codes and the reply codes as the code has them', async () => {
    const tree = walkTree(buildRealmProgram());
    // The instrument first (a) red when the walk reaches less than the tree — an emptied command list,
    // a group left out — so an empty walk can never pass as "no change"; (b) prints the counts.
    expect({
      leavesAtLeast31: tree.leaves >= 31,
      optionsAtLeast121: tree.options >= 121,
      leaves: tree.leaves,
      options: tree.options,
    }).toEqual({
      leavesAtLeast31: true,
      optionsAtLeast121: true,
      leaves: tree.leaves,
      options: tree.options,
    });
    // (a) red when a command, an argument, a flag (its value, default, `hidden`), an exit code, an exit
    //     site, a reply code or a reply site differs from the committed file; (b) prints the diff.
    await expect(renderInventory(tree, exitCensus(), replyCensus())).toMatchFileSnapshot(
      './kept-surface.txt',
    );
  });

  it('the exit-code census: every literal code is a listed code, every computed code is at a listed site', () => {
    const census = exitCensus();
    const rows = committedSection('exit codes');
    const codes = new Set(
      rows.flatMap((r) => {
        const m = /^exit code (\d+) — /.exec(r);
        return m === null ? [] : [Number(m[1])];
      }),
    );
    const sites = new Map<string, number>(
      rows.flatMap((r) => {
        const m = /^exit site (\S+) — (\d+) calls? with a computed code$/.exec(r);
        return m === null ? [] : [[m[1]!, Number(m[2])] as const];
      }),
    );
    // (a) red on a new literal code (`process.exit(3)`), a computed code at a site the file does not
    //     list or at a listed site more or fewer times, or a listed site with no such call; (b) prints
    //     the literal and its file, or the site and its counts.
    expect({
      unlistedCodes: census.literals
        .filter((l) => !codes.has(l.code))
        .map((l) => `${l.code} in ${l.file}`),
      unlistedSites: [...census.computed.entries()]
        .filter(([f, n]) => sites.get(f) !== n)
        .map(([f, n]) => `${f}: ${n} in the code, ${sites.get(f) ?? 0} in the file`),
      sitesWithNoCall: [...sites.keys()].filter((f) => !census.computed.has(f)),
      exitProcessDeclaredOnce: census.exitProcessDeclarations,
    }).toEqual({
      unlistedCodes: [],
      unlistedSites: [],
      sitesWithNoCall: [],
      exitProcessDeclaredOnce: ['cli/src/output/writer.ts'],
    });
    // Non-vacuity: the census reached the literal exits and the computed ones.
    expect({ literals: census.literals.length > 100, sites: census.computed.size > 0 }).toEqual({
      literals: true,
      sites: true,
    });
  });

  it('the reply census: every (family, status, shape) Realm sends is a row of the file, and every row has a site', () => {
    const census = replyCensus();
    const rows = committedSection('HTTP');
    const filed = new Set(
      rows.flatMap((r) => {
        const m = /^(.* \d{3}) — (.+?): /.exec(r);
        return m === null ? [] : [`${m[1]} ${m[2]}`];
      }),
    );
    const filedSites = new Map<string, number>(
      rows.flatMap((r) => {
        const m = /^reply site (\S+) — (\d+) (.+) calls? with a computed status$/.exec(r);
        return m === null ? [] : [[`${m[1]}${SEP}${m[3]}`, Number(m[2])] as const];
      }),
    );
    // The helpers are where the census looks for them, each with its status parameter.
    expect(census.helpersFound.sort()).toEqual([
      'answerHealth()',
      'refuse(status)',
      'respond(status)',
      'sendRead(status)',
    ]);
    // (a) red on a new status at any site (`refuse(req, res, 418, …)`), a row whose site is gone, a
    //     status passed as a variable at a site the file does not list, or a reply in a file with no
    //     route family; (b) prints the pair, the row or the site.
    expect({
      notInTheFile: [...census.pairs]
        .filter(([k]) => !filed.has(k))
        .map(([k, files]) => `${k} at ${[...new Set(files)].join(', ')}`),
      rowWithNoSite: [...filed].filter((k) => !census.pairs.has(k)),
      computedNotListed: [...census.computed.entries()]
        .filter(([k, n]) => filedSites.get(k) !== n)
        .map(([k, n]) => `${k}: ${n} in the code, ${filedSites.get(k) ?? 0} in the file`),
      listedSiteWithNoCall: [...filedSites.keys()].filter((k) => !census.computed.has(k)),
      noFamily: census.unresolved,
      noMeaning: [...census.pairs.keys()].filter((k) => MEANINGS[k] === undefined),
      meaningWithNoPair: Object.keys(MEANINGS).filter((k) => !census.pairs.has(k)),
    }).toEqual({
      notInTheFile: [],
      rowWithNoSite: [],
      computedNotListed: [],
      listedSiteWithNoCall: [],
      noFamily: [],
      noMeaning: [],
      meaningWithNoPair: [],
    });
  });
});
