// clock-census-715b.test.ts — issue #715 (b) 04 §A.1–A.2 (B1″; D5 §5.1, D6-15, D6-23, D6-26,
// D6-32): the census of every clock read in the production source, each by file, enclosing
// function and kind, with its CLASS and its reason. Fail-closed in both directions: a read not in
// the list fails, and a list entry no longer in the source fails (a read that disappears silently is
// how a census rots). Then the class law: no `outside` read sits in a function that reads a run
// record's instants — two clock DOMAINS never meet in one decision.
//
// WHAT IT SEES: the TypeScript AST of `packages/{core,cli,mcp-server,testing,store-sqlite}/src/**/*.ts` (not
// `*.test.ts`, not `*.d.ts`): `new Date()` with no argument, `Date()`, `Date.now()`,
// `performance.now()`, `process.hrtime()`, a by-name capture (`const now = Date.now`,
// `const { now } = Date`, `performance.now` passed as a value), and every `<…>.clock.now()` /
// `clock.now()` call. WHAT IT CANNOT SEE, in words: a clock read inside a third-party library (the
// lock library's own staleness test reads the wall clock — `proper-lockfile`; 04 §C), a read
// spelled through `Reflect`/`globalThis['Date']` or an alias the walk cannot follow, SQL `'now'` (no
// SQL store exists yet: #616 adds its rows here), and timer-driven expiry inside the runtime (a
// `setTimeout` is a duration wait: `Clock.at` serves the stored instants, 03 §A).
//
// HOME: the cli package (as `terminal-writer-census.test.ts`): cli's test task depends on every
// package's build, so an edit in any package's src re-hashes it.
//
// Each cell carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { CLOCK_READ_CLASSES } from '@sensigo/realm';
import { CENSUS } from '../test-support/clock-census.js';

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCANNED = ['core', 'cli', 'mcp-server', 'testing', 'store-sqlite'];

/** The instant fields of a run record a decision may read (D6-15's property-access check). */
const INSTANT_FIELDS = new Set([
  'created_at',
  'updated_at',
  'opened_at',
  'expires_at',
  'since',
  'deadline',
  'completed_at',
  'started_at',
  'first_failed_at',
  'lease_deadline',
  'agent_started_at',
]);

interface Read {
  /** `<package path>#<enclosing function>#<kind>` */
  key: string;
  count: number;
  readsInstant: boolean;
}

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

function enclosing(node: ts.Node): { name: string; fn: ts.Node | undefined } {
  for (let n = node.parent; n !== undefined; n = n.parent) {
    if (
      ts.isFunctionDeclaration(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n) ||
      ts.isConstructorDeclaration(n) ||
      ts.isGetAccessor(n)
    ) {
      let name: string | undefined =
        'name' in n && n.name !== undefined ? (n.name as ts.Node).getText() : undefined;
      if (name === undefined && ts.isVariableDeclaration(n.parent)) name = n.parent.name.getText();
      if (name === undefined && ts.isPropertyAssignment(n.parent)) name = n.parent.name.getText();
      if (name === undefined && ts.isConstructorDeclaration(n)) name = 'constructor';
      if (name === undefined) continue;
      let c: ts.Node | undefined = n.parent;
      while (c !== undefined && !ts.isClassDeclaration(c)) c = c.parent;
      if (
        c !== undefined &&
        ts.isClassDeclaration(c) &&
        c.name !== undefined &&
        (ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessor(n))
      ) {
        name = `${c.name.getText()}.${name}`;
      }
      return { name, fn: n };
    }
  }
  return { name: '<module>', fn: undefined };
}

function readsAnInstant(fn: ts.Node | undefined): boolean {
  let found = false;
  const visit = (x: ts.Node): void => {
    if (ts.isPropertyAccessExpression(x) && INSTANT_FIELDS.has(x.name.getText())) found = true;
    if (!found) ts.forEachChild(x, visit);
  };
  if (fn !== undefined) visit(fn);
  return found;
}

/** The census, scanned now. */
function scan(): Map<string, Read> {
  const reads = new Map<string, Read>();
  for (const pkg of SCANNED) {
    for (const file of sourceFiles(join(PACKAGES, pkg, 'src'))) {
      const text = readFileSync(file, 'utf8');
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const rel = relative(PACKAGES, file).split(sep).join('/');
      const add = (node: ts.Node, kind: string): void => {
        const { name, fn } = enclosing(node);
        const key = `${rel}#${name}#${kind}`;
        const prior = reads.get(key);
        if (prior !== undefined) prior.count += 1;
        else reads.set(key, { key, count: 1, readsInstant: readsAnInstant(fn) });
      };
      const visit = (node: ts.Node): void => {
        if (
          ts.isNewExpression(node) &&
          node.expression.getText() === 'Date' &&
          (node.arguments === undefined || node.arguments.length === 0)
        ) {
          add(node, 'new Date()');
        }
        if (ts.isCallExpression(node)) {
          const callee = node.expression.getText();
          if (callee === 'Date.now') add(node, 'Date.now()');
          else if (callee === 'performance.now') add(node, 'performance.now()');
          else if (callee === 'Date') add(node, 'Date()');
          else if (/^process\.hrtime(\.bigint)?$/.test(callee)) add(node, 'process.hrtime()');
          else if (/(^|\.)clock\.now$/.test(callee)) add(node, 'clock.now()');
        }
        if (
          ts.isPropertyAccessExpression(node) &&
          ['Date.now', 'performance.now'].includes(node.getText()) &&
          !(ts.isCallExpression(node.parent) && node.parent.expression === node)
        ) {
          add(node, `${node.getText()} (by name)`);
        }
        if (
          ts.isVariableDeclaration(node) &&
          node.initializer !== undefined &&
          ['Date', 'performance'].includes(node.initializer.getText()) &&
          ts.isObjectBindingPattern(node.name)
        ) {
          add(node, `${node.initializer.getText()} (destructured)`);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  }
  return reads;
}

/**
 * The class law's allow-list: an `outside` read whose enclosing function also reads a run record's
 * instants, each with why the two never meet in one decision. Empty: none today.
 */
const OUTSIDE_BESIDE_AN_INSTANT: Record<string, string> = {};

describe('#715 (b) 04 §A.1 — the census of every clock read', () => {
  const found = scan();

  it('every read in the source is in the list, with its count; every list entry is in the source', () => {
    // (a) red when a read is added, moved to another function, or removed without its row; (b)
    //     prints only the differences.
    const extra = [...found.values()]
      .filter((r) => CENSUS[r.key] === undefined)
      .map((r) => `${r.key} ×${r.count}`);
    const gone = Object.keys(CENSUS).filter((k) => !found.has(k));
    const recounted = Object.entries(CENSUS)
      .filter(([k, [n]]) => found.has(k) && found.get(k)!.count !== n)
      .map(([k, [n]]) => `${k}: listed ${n}, found ${found.get(k)!.count}`);
    expect({ extra, gone, recounted }).toEqual({ extra: [], gone: [], recounted: [] });
  });

  it('every row has one of the five classes, and every class but `outside` reads no system clock', () => {
    // (a) red when a row names a class core does not have, or a system-clock read is classed write,
    //     read or event; (b) prints the rows.
    const classes = Object.keys(CLOCK_READ_CLASSES);
    const wrong = Object.entries(CENSUS)
      .filter(
        ([k, [, cls]]) =>
          !classes.includes(cls) ||
          (/#(new Date\(\)|Date\.now\(\)|Date\(\))$/.test(k) && cls !== 'outside') ||
          (/#performance\.now\(\)$/.test(k) && cls !== 'duration') ||
          (/#clock\.now\(\)$/.test(k) && !['write', 'read', 'event'].includes(cls)),
      )
      .map(([k, [, cls]]) => `${k}: ${cls}`);
    expect(wrong).toEqual([]);
  });
});

describe('#715 (b) 04 §A.2 — the class law (D6-15)', () => {
  it('no `outside` read sits in a function that reads a run record’s instants (two clock domains never meet)', () => {
    // (a) red when an outside read and a RunRecord instant share a function — e.g. a
    //     `Date.now() - Date.parse(run.updated_at)` added to an outside function; (b) prints them.
    const found = scan();
    const met = Object.entries(CENSUS)
      .filter(([k, [, cls]]) => cls === 'outside' && found.get(k)?.readsInstant === true)
      .map(([k]) => k)
      .filter((k) => OUTSIDE_BESIDE_AN_INSTANT[k] === undefined);
    expect(met).toEqual([]);
  });
});
