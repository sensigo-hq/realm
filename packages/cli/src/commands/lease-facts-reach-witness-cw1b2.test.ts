// lease-facts-reach-witness-cw1b2.test.ts — issue #729, the claim window, unit CW-1b part 2: the
// source witnesses that hold the conversion that makes the lease facts reach every judge. Read with
// the TypeScript parser (a comment is never code; a Prettier-wrapped call is one call).
//   - The rebuild census (check 2): outside the stores, no production `writtenSnapshot` call drops
//     the facts (a third argument absent, `undefined` or `NO_LEASE_FACTS`) unless the closed census
//     names it with where its record came from; every `composeWaysAt` call passes `lease_facts`, and
//     never as `undefined` or `NO_LEASE_FACTS`; `NO_LEASE_FACTS` appears only in the lease-facts
//     module, `snapshot.ts`, the stores and core's export line.
//   - The consumer witness (check 3): every production call of `classifyClaim` and
//     `describeClaimHolder` passes a lease argument that is a real reading of the facts:
//     `leaseFactOf(x, …)` with `x` a name or a property (a snapshot the code holds), or a name declared
//     that way in the same function. An object literal (`{ absent: 'unleased' }`, which makes a leased
//     claim be judged by its deadline) passes only at an entry of the closed literal census, checked
//     both ways (correction 1).
//
// SCOPE: every package's production source. Part 2a held core; part 2b converted the CLI, the MCP
// server and the testing package, and widened `SCANNED` to them and to the SQLite store's package.
//
// WHAT IT SEES: every `.ts` file under the scanned packages' `src` but tests, declarations and the
// `test-support` folders. WHAT IT CANNOT SEE: a call through another name (`const w = writtenSnapshot`),
// a facts argument that is a variable holding `undefined`, a record that a judge reads without one of
// these calls.
//
// HOME: the cli package, as the source censuses: cli's test task waits for every package's build.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The packages whose production source the witnesses read: every package (part 2b). */
const SCANNED = ['core', 'cli', 'mcp-server', 'testing', 'store-sqlite'];

/** The stores and the snapshot module: they build the snapshots they return, facts and all. */
const STORE_FILES = [
  'store-sqlite/src/run-store.ts',
  'testing/src/store/in-memory-store.ts',
  'core/src/store/json-file-store.ts',
  'testing/src/store/settlement-contract.ts',
  'testing/src/store/fence-run-source.ts',
  'core/src/engine/snapshot.ts',
];

/** Where `NO_LEASE_FACTS` may appear: its module, the snapshot module, the stores, core's export. */
const NO_FACTS_ALLOWED = ['core/src/store/lease-facts.ts', 'core/src/index.ts', ...STORE_FILES];

/**
 * The closed census: each production `writtenSnapshot` call outside the stores that passes no facts,
 * by `file#function`, with where its record came from. There are none: core's rebuilds were converted
 * in part 2a, the CLI's, the MCP server's and the testing package's in part 2b.
 */
const CENSUS: Record<string, string> = {};

/**
 * The closed literal census (check 3): each production `classifyClaim` or `describeClaimHolder` call
 * whose lease argument is an object literal, by `file#function`, with why its claim names no lease.
 */
const LITERAL_CENSUS: Record<string, string> = {
  'core/src/engine/execution-loop.ts#withGateClaim':
    "the gate claim's `{ holder, since }` copy is no run's claim: an opened gate's claim is written " +
    'without a lease',
};

function productionFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== 'node_modules' && name !== 'test-support') walk(path);
      } else if (name.endsWith('.ts') && !/\.(test|d|probe)\.ts$/.test(name)) out.push(path);
    }
  };
  for (const pkg of SCANNED) walk(join(PACKAGES, pkg, 'src'));
  return out;
}

const rel = (path: string): string => relative(PACKAGES, path).split(sep).join('/');

/** The name of the function a node sits in (a declaration, a method, or a variable's function). */
function enclosing(node: ts.Node): string {
  for (let n = node.parent; n !== undefined; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name !== undefined)
      return n.name.getText();
    if (
      ts.isVariableDeclaration(n) &&
      n.initializer !== undefined &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
    )
      return n.name.getText();
  }
  return '(top)';
}

function calleeName(call: ts.CallExpression): string {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return '';
}

/** A facts argument that drops the facts: absent, `undefined`, or `NO_LEASE_FACTS`. */
function dropsFacts(arg: ts.Expression | undefined): boolean {
  return (
    arg === undefined ||
    (ts.isIdentifier(arg) && ['undefined', 'NO_LEASE_FACTS'].includes(arg.text))
  );
}

/** Whether `expr` reads the facts of a snapshot the code holds: `leaseFactOf(x, …)`, `x` a name or a property. */
function readsFacts(expr: ts.Expression | undefined): boolean {
  if (expr === undefined || !ts.isCallExpression(expr) || calleeName(expr) !== 'leaseFactOf')
    return false;
  const snap = expr.arguments[0];
  return snap !== undefined && (ts.isIdentifier(snap) || ts.isPropertyAccessExpression(snap));
}

/** The nearest function around `node` (its own body is where a lease name must be declared). */
function functionOf(node: ts.Node): ts.Node | undefined {
  for (let n = node.parent; n !== undefined; n = n.parent) {
    if (ts.isFunctionLike(n)) return n;
  }
  return undefined;
}

/** Whether the name `id` is declared, in the function around it, from a real reading of the facts. */
function declaredFromFacts(id: ts.Identifier): boolean {
  const fn = functionOf(id);
  if (fn === undefined) return false;
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === id.text) {
      found = readsFacts(n.initializer);
      return;
    }
    // A function inside this one declares its own names.
    if (n !== fn && ts.isFunctionLike(n)) return;
    ts.forEachChild(n, visit);
  };
  visit(fn);
  return found;
}

/**
 * Why a lease argument is no real reading of the facts, or `undefined` when it is one;
 * `'object literal'` for a literal (allowed only at a literal-census entry).
 */
function badLease(arg: ts.Expression | undefined): string | undefined {
  if (arg === undefined) return 'no lease argument';
  if (ts.isIdentifier(arg) && arg.text === 'undefined') return 'undefined';
  if (ts.isCallExpression(arg) && calleeName(arg) === 'leaseFactOf')
    return readsFacts(arg) ? undefined : 'leaseFactOf of a snapshot built in place';
  if (ts.isIdentifier(arg))
    return declaredFromFacts(arg) ? undefined : 'a name not declared from leaseFactOf';
  if (ts.isObjectLiteralExpression(arg)) return 'object literal';
  return 'no reading of the facts';
}

interface Finding {
  rule: string;
  at: string;
  fn: string;
  /** A literal at a literal-census entry: not a breach, but the census's own use (for the stale check). */
  census?: true;
}

/** Every breach of checks 2 and 3 in `text` (a file at `path`, relative to the packages). */
function breaches(path: string, text: string): Finding[] {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const out: Finding[] = [];
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const add = (rule: string, n: ts.Node) =>
    out.push({ rule, at: `${path}:${line(n)}`, fn: enclosing(n) });
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n);
      if (name === 'writtenSnapshot' && !STORE_FILES.includes(path) && dropsFacts(n.arguments[2]))
        add('writtenSnapshot without facts', n);
      if (name === 'composeWaysAt') {
        const input = n.arguments[2];
        const facts =
          input !== undefined && ts.isObjectLiteralExpression(input)
            ? input.properties.find(
                (p): p is ts.PropertyAssignment =>
                  ts.isPropertyAssignment(p) && p.name.getText(sf) === 'lease_facts',
              )
            : undefined;
        if (facts === undefined) add('composeWaysAt without lease_facts', n);
        else if (dropsFacts(facts.initializer)) add('composeWaysAt with lease_facts dropped', n);
      }
      if (name === 'classifyClaim' || name === 'describeClaimHolder') {
        const why = badLease(n.arguments[2]);
        if (why === 'object literal') {
          if (`${path}#${enclosing(n)}` in LITERAL_CENSUS)
            out.push({
              rule: `${name}: a census literal`,
              at: `${path}:${line(n)}`,
              fn: enclosing(n),
              census: true,
            });
          else add(`${name}: an object literal outside the census`, n);
        } else if (why !== undefined) add(`${name}: ${why}`, n);
      }
    }
    if (ts.isIdentifier(n) && n.text === 'NO_LEASE_FACTS' && !NO_FACTS_ALLOWED.includes(path))
      add('NO_LEASE_FACTS outside its homes', n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe('#729 CW-1b part 2 — the lease facts reach every judge (checks 2 and 3, every package)', () => {
  it('the instrument: it finds every breach spelling, and no conversion', () => {
    const breachesIn = (path: string, code: string) =>
      breaches(path, code)
        .filter((b) => b.census !== true)
        .map((b) => b.rule);
    const at = (code: string) => breachesIn('core/src/engine/x.ts', code);
    const must: Array<[string, string]> = [
      ['writtenSnapshot(run, at);', 'writtenSnapshot without facts'],
      ['writtenSnapshot(\n  run,\n  at,\n);', 'writtenSnapshot without facts'],
      ['writtenSnapshot(run, at, undefined);', 'writtenSnapshot without facts'],
      ['writtenSnapshot(run, at, NO_LEASE_FACTS);', 'writtenSnapshot without facts'],
      ['composeWaysAt(run, at, { definition });', 'composeWaysAt without lease_facts'],
      ['composeWaysAt(run, at, input);', 'composeWaysAt without lease_facts'],
      [
        'composeWaysAt(run, at, { definition, lease_facts: undefined });',
        'composeWaysAt with lease_facts dropped',
      ],
      ['classifyClaim(claim, now);', 'classifyClaim: no lease argument'],
      ['classifyClaim(claim, now, undefined);', 'classifyClaim: undefined'],
      [
        'describeClaimHolder(c, true, leaseFactOf({}, c));',
        'describeClaimHolder: leaseFactOf of a snapshot built in place',
      ],
      [
        'describeClaimHolder(c, true, leaseFactOf(writtenSnapshot(r, a, f), c));',
        'describeClaimHolder: leaseFactOf of a snapshot built in place',
      ],
      ['const x = NO_LEASE_FACTS;', 'NO_LEASE_FACTS outside its homes'],
      // Correction 1: the spellings that are no reading of the facts.
      [
        "describeClaimHolder(c, true, { absent: 'unleased' });",
        'describeClaimHolder: an object literal outside the census',
      ],
      [
        'function f() {\n  const l = leaseFactOf({}, c);\n  classifyClaim(c, now, l);\n}',
        'classifyClaim: a name not declared from leaseFactOf',
      ],
      [
        'function f() {\n  classifyClaim(c, now, lease);\n}',
        'classifyClaim: a name not declared from leaseFactOf',
      ],
    ];
    const mustNot = [
      'writtenSnapshot(run, at, snap.lease_facts);',
      'composeWaysAt(run, at, { definition, lease_facts: snap.lease_facts });',
      'classifyClaim(claim, now, leaseFactOf(snap, claim));',
      'classifyClaim(claim, now, leaseFactOf(this.snap, claim));',
      'function f() {\n  const l = leaseFactOf(snap, c);\n  classifyClaim(c, now, l);\n}',
      '// writtenSnapshot(run, at)',
    ];
    // The literal at its census entry is the census's own use, never a breach there.
    const atCensus = breachesIn(
      'core/src/engine/execution-loop.ts',
      "function withGateClaim() {\n  describeClaimHolder(c, true, { absent: 'unleased' });\n}",
    );
    // (1) red when the reader stops finding a breach spelling (a Prettier-wrapped call is one call) or
    //     starts flagging a conversion or a comment; (2) prints which fixture and what it found.
    expect({
      found: must.filter(([code, rule]) => !at(code).includes(rule)).map(([code]) => code),
      wrongly: mustNot.filter((code) => at(code).length > 0),
      atCensus,
    }).toEqual({ found: [], wrongly: [], atCensus: [] });
  });

  it('every package’s production source: no breach of the census or the consumer witness, and the census is closed', () => {
    const files = productionFiles();
    const found = files.flatMap((path) => breaches(rel(path), readFileSync(path, 'utf8')));
    const unlisted = found.filter(
      (b) =>
        b.census !== true &&
        !(b.rule === 'writtenSnapshot without facts' && `${b.at.split(':')[0]}#${b.fn}` in CENSUS),
    );
    const listed = new Set(found.map((b) => `${b.at.split(':')[0]}#${b.fn}`));
    // (1) red when a production call in any package drops the facts (a rebuild, a composeWaysAt call, a
    //     judge's lease argument) or names NO_LEASE_FACTS outside its homes, or a census entry no
    //     longer matches a call (the census is closed both ways); (2) prints each breach with its rule,
    //     file, line and function, and each stale entry.
    expect({
      files: files.length > 0,
      breaches: unlisted.map((b) => `${b.rule}: ${b.at} (${b.fn})`),
      staleCensus: [...Object.keys(CENSUS), ...Object.keys(LITERAL_CENSUS)].filter(
        (entry) => !listed.has(entry),
      ),
    }).toEqual({ files: true, breaches: [], staleCensus: [] });
  });
});
