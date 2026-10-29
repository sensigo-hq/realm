// spawn-budget-guard.test.ts — a test that starts a child process must carry a time budget of its own.
//
// vitest gives every test 5 seconds (`vitest.config.mts`, `testTimeout`). A cell that starts the built
// CLI or server needs more than that on a loaded machine, so the repository's rule (#371) is that such
// a cell carries its own budget when it is written. 31 of 478 had not, and under load they ran out of
// the 5 seconds before the child's own limit, which voided counted runs (#938 gave them budgets). This
// file is the guard the owner asked for: "add the narrow time-limit check" (session aaefd3da, uuid
// 37bb7e82-5e97-43a6-9603-74d1182addf2, 2026-10-29T19:57:47Z). It is narrow on purpose: it looks only
// at cells that start a child process, not at every test.
//
// WHAT COUNTS AS A CELL THAT STARTS A CHILD PROCESS. A cell (`it`, `test`, `it.each(...)`, `it.skip`,
// ...) whose function body calls a function imported from `node:child_process` (spawnSync,
// execFileSync, execSync, spawn, execFile, exec, fork; under any local name, or through a namespace or
// default import), or calls a function that does: one declared anywhere in the same file, or exported
// by a file the test imports by a relative path. The scan reads the code with the TypeScript parser and
// parses only the files that can matter: those whose text mentions `child_process`, and the tests that
// import them (about 90 of 900 files, a few seconds).
//
// WHAT COUNTS AS A DECLARED BUDGET (pinned by the cells below, one per form):
//   1. a number as the last argument of the cell:               it('x', () => {...}, 30_000)
//   2. a `timeout` option on the cell:                           it('x', { timeout: 30_000 }, () => {...})
//   3. a number or a `timeout` option on an enclosing `describe`: describe('x', { timeout: 30_000 }, ...)
//   4. a named constant or any expression in place of the number: it('x', () => {...}, SLOW)
//      (its VALUE is not checked: the guard asks that a budget was written, not how big it is);
//   5. `vi.setConfig({ testTimeout: ... })` anywhere in the file.
//
// WHAT IT CANNOT SEE (say it, do not hide it): a spawn made through a class method or through a
// package import (a helper in another package); a cell that is built by a loop whose title is not a
// string (it is still found, its title prints as "<dynamic title>"); a budget that is a constant with a
// small value; a file that only MOCKS `node:child_process` (it spawns nothing, so it is not flagged);
// hooks (`beforeAll`), which are not cells. The scan is by name and by import, not by running anything.
//
// Failure text: one line per cell, `<file>:<line> "<title>"`, nothing else (no source text, no
// environment).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const SPAWN_FUNCTIONS = new Set([
  'spawnSync',
  'execFileSync',
  'execSync',
  'spawn',
  'execFile',
  'exec',
  'fork',
]);
const CHILD_PROCESS_MODULES = new Set(['node:child_process', 'child_process']);

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly title: string;
}

interface ScanResult {
  readonly findings: Finding[];
  /** Cells that start a child process (with or without a budget): what the scan saw. */
  readonly spawningCells: number;
  /** Files the scan parsed. */
  readonly filesParsed: number;
}

interface FileInfo {
  readonly sf: ts.SourceFile;
  /** Local names bound to a spawn function of `node:child_process`. */
  readonly spawnNames: Set<string>;
  /** Local names bound to the whole module (`import * as cp`, `import cp`). */
  readonly moduleNames: Set<string>;
  /** Every function declared in the file at any depth, by name. */
  readonly functions: Map<string, ts.Node>;
  /** Names the file exports. */
  readonly exported: Set<string>;
  /** Relative imports: the local name, the exported name, and the file it resolves to. */
  readonly imports: { local: string; imported: string; from: string }[];
  /** Local names that start a child process (filled by the fixed point). */
  readonly spawners: Set<string>;
}

const isTestFile = (path: string): boolean => path.endsWith('.test.ts');

function resolveRelative(
  from: string,
  specifier: string,
  known: ReadonlySet<string>,
): string | undefined {
  const base = posix.join(posix.dirname(from), specifier.replace(/\.js$/, ''));
  for (const candidate of [`${base}.ts`, `${base}/index.ts`])
    if (known.has(candidate)) return candidate;
  return undefined;
}

function describeFile(path: string, text: string, known: ReadonlySet<string>): FileInfo {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const info: FileInfo = {
    sf,
    spawnNames: new Set(),
    moduleNames: new Set(),
    functions: new Map(),
    exported: new Set(),
    imports: [],
    spawners: new Set(),
  };
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (clause === undefined) continue;
      if (CHILD_PROCESS_MODULES.has(specifier)) {
        if (clause.name !== undefined) info.moduleNames.add(clause.name.text);
        const bindings = clause.namedBindings;
        if (bindings !== undefined && ts.isNamespaceImport(bindings))
          info.moduleNames.add(bindings.name.text);
        if (bindings !== undefined && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            if (SPAWN_FUNCTIONS.has((element.propertyName ?? element.name).text))
              info.spawnNames.add(element.name.text);
          }
        }
      } else if (specifier.startsWith('.')) {
        const from = resolveRelative(path, specifier, known);
        const bindings = clause.namedBindings;
        if (from !== undefined && bindings !== undefined && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            info.imports.push({
              local: element.name.text,
              imported: (element.propertyName ?? element.name).text,
              from,
            });
          }
        }
      }
    }
    const isExported = ts.canHaveModifiers(statement)
      ? ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true
      : false;
    if (isExported && ts.isFunctionDeclaration(statement) && statement.name !== undefined)
      info.exported.add(statement.name.text);
    if (isExported && ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) info.exported.add(declaration.name.text);
      }
    }
  }
  const collect = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined && node.body !== undefined) {
      info.functions.set(node.name.text, node.body);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      info.functions.set(node.name.text, node.initializer.body);
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);
  return info;
}

/** Does this code call a function that starts a child process (a spawn function or a known spawner)? */
function startsChild(info: FileInfo, node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (
        ts.isIdentifier(callee) &&
        (info.spawnNames.has(callee.text) || info.spawners.has(callee.text))
      )
        found = true;
      else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        info.moduleNames.has(callee.expression.text) &&
        SPAWN_FUNCTIONS.has(callee.name.text)
      ) {
        found = true;
      }
    }
    if (!found) ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** Is a budget written in these arguments (the ones after the title)? Forms 1, 2 and 4 above. */
function declaresBudget(args: readonly ts.Expression[]): boolean {
  for (const arg of args) {
    if (ts.isNumericLiteral(arg)) return true;
    if (ts.isIdentifier(arg) || ts.isPropertyAccessExpression(arg) || ts.isBinaryExpression(arg))
      return true;
    if (ts.isObjectLiteralExpression(arg)) {
      for (const property of arg.properties) {
        if (property.name !== undefined && property.name.getText() === 'timeout') return true;
      }
    }
  }
  return false;
}

/** `it`, `test`, and their `.skip` / `.only` / `.each(...)` / `.skipIf(...)` forms; and the same for `describe`. */
function calleeKind(callee: ts.Expression): 'cell' | 'describe' | undefined {
  let expression = callee;
  // it.each([...])(...) and it.skipIf(c)(...): the callee is itself a call.
  if (ts.isCallExpression(expression)) expression = expression.expression;
  let root = expression;
  while (ts.isPropertyAccessExpression(root)) root = root.expression;
  if (!ts.isIdentifier(root)) return undefined;
  if (root.text === 'it' || root.text === 'test') return 'cell';
  if (root.text === 'describe') return 'describe';
  return undefined;
}

function titleOf(call: ts.CallExpression): string {
  const first = call.arguments[0];
  if (first === undefined) return '<dynamic title>';
  if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) return first.text;
  if (ts.isTemplateExpression(first))
    return first.head.text === '' ? '<dynamic title>' : `${first.head.text}…`;
  return '<dynamic title>';
}

/**
 * Scans sources (repo-relative path → text). Pure: nothing is read from disk here, so the cells below
 * can feed it small programs.
 */
function scanSpawnBudgets(sources: ReadonlyMap<string, string>): ScanResult {
  const known = new Set(sources.keys());
  const mentions = [...sources]
    .filter(([, text]) => text.includes('child_process'))
    .map(([path]) => path);
  const helperFiles = new Set(mentions.filter((p) => !isTestFile(p)));
  const toParse = new Set(mentions);
  for (const [path, text] of sources) {
    if (!isTestFile(path) || toParse.has(path)) continue;
    for (const match of text.matchAll(/from '(\.[^']*)'/g)) {
      const from = resolveRelative(path, match[1] ?? '', known);
      if (from !== undefined && helperFiles.has(from)) toParse.add(path);
    }
  }
  const infos = new Map<string, FileInfo>();
  for (const path of toParse) infos.set(path, describeFile(path, sources.get(path) ?? '', known));

  // Fixed point: which functions of each file start a child process.
  let changed = true;
  while (changed) {
    changed = false;
    for (const info of infos.values()) {
      for (const imp of info.imports) {
        const target = infos.get(imp.from);
        if (
          target !== undefined &&
          target.exported.has(imp.imported) &&
          target.spawners.has(imp.imported) &&
          !info.spawners.has(imp.local)
        ) {
          info.spawners.add(imp.local);
          changed = true;
        }
      }
      for (const [name, body] of info.functions) {
        if (!info.spawners.has(name) && startsChild(info, body)) {
          info.spawners.add(name);
          changed = true;
        }
      }
    }
  }

  const findings: Finding[] = [];
  let spawningCells = 0;
  for (const [path, info] of infos) {
    if (!isTestFile(path)) continue;
    const fileBudget = /vi\.setConfig\(\s*\{[^}]*testTimeout/.test(info.sf.text);
    const visit = (node: ts.Node, described: boolean): void => {
      if (ts.isCallExpression(node)) {
        const kind = calleeKind(node.expression);
        if (kind === 'describe') {
          const declared = described || declaresBudget(node.arguments.slice(1));
          for (const arg of node.arguments) {
            if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))
              ts.forEachChild(arg, (child) => visit(child, declared));
          }
          return;
        }
        if (kind === 'cell') {
          const fn = node.arguments.find(
            (a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a),
          );
          if (fn !== undefined && startsChild(info, fn)) {
            spawningCells++;
            if (!(fileBudget || described || declaresBudget(node.arguments.slice(1)))) {
              findings.push({
                file: path,
                line: info.sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
                title: titleOf(node),
              });
            }
          }
          return;
        }
      }
      ts.forEachChild(node, (child) => visit(child, described));
    };
    visit(info.sf, false);
  }
  findings.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  return { findings, spawningCells, filesParsed: infos.size };
}

const SPAWN_IMPORT = `import { spawnSync } from 'node:child_process';\n`;
const TEST_PATH = 'packages/p/src/a.test.ts';
const scanOne = (body: string, extra: Record<string, string> = {}): ScanResult =>
  scanSpawnBudgets(new Map([[TEST_PATH, body], ...Object.entries(extra)]));
const lines = (r: ScanResult): string[] =>
  r.findings.map((f) => `${f.file}:${f.line} "${f.title}"`);

describe('spawn-budget guard: what the scan flags and what it accepts', () => {
  // Each assertion: (a) red when the scan stops flagging a spawning cell without a budget, or stops
  // accepting a declared form; (b) prints the finding lines (file, line, title) and nothing else.
  it('flags a cell that starts a child process and has no budget of its own', () => {
    const r = scanOne(`${SPAWN_IMPORT}it('no budget', () => { spawnSync('x'); });\n`);
    expect(lines(r)).toEqual([`${TEST_PATH}:2 "no budget"`]);
    expect(r.spawningCells).toBe(1);
  });

  it('accepts each declared form: a number, a timeout option, a describe, a named constant, vi.setConfig', () => {
    const declared: Record<string, string> = {
      'a number as the last argument': `it('c', () => { spawnSync('x'); }, 30_000);`,
      'a timeout option on the cell': `it('c', { timeout: 30_000 }, () => { spawnSync('x'); });`,
      'a number on an enclosing describe': `describe('d', () => { it('c', () => { spawnSync('x'); }); }, 30_000);`,
      'a timeout option on an enclosing describe': `describe('d', { timeout: 30_000 }, () => { it('c', () => { spawnSync('x'); }); });`,
      'a named constant': `const SLOW = 30_000;\nit('c', () => { spawnSync('x'); }, SLOW);`,
      'an expression': `it('c', () => { spawnSync('x'); }, 2 * 30_000);`,
      'vi.setConfig in the file': `vi.setConfig({ testTimeout: 30_000 });\nit('c', () => { spawnSync('x'); });`,
    };
    const flagged = Object.entries(declared)
      .filter(([, body]) => scanOne(`${SPAWN_IMPORT}${body}\n`).findings.length > 0)
      .map(([form]) => form);
    expect(flagged, 'declared forms the scan did not accept').toEqual([]);
  });

  it('sees a spawn through an alias, a namespace import, a same-file helper and an imported helper', () => {
    const cases: Record<string, ScanResult> = {
      alias: scanOne(
        `import { spawnSync as run } from 'node:child_process';\nit('c', () => { run('x'); });\n`,
      ),
      namespace: scanOne(
        `import * as cp from 'node:child_process';\nit('c', () => { cp.execFileSync('x'); });\n`,
      ),
      'same-file helper': scanOne(
        `${SPAWN_IMPORT}function realm() { return spawnSync('x'); }\nit('c', () => { realm(); });\n`,
      ),
      'imported helper': scanOne(
        `import { realm } from './helper.js';\nit('c', () => { realm(); });\n`,
        {
          'packages/p/src/helper.ts': `import { spawnSync } from 'node:child_process';\nexport function realm() { return spawnSync('x'); }\n`,
        },
      ),
      'table of cells': scanOne(
        `${SPAWN_IMPORT}it.each([[1]])('t %s', () => { spawnSync('x'); });\n`,
      ),
    };
    const unflagged = Object.entries(cases)
      .filter(([, r]) => r.findings.length !== 1)
      .map(([name]) => name);
    expect(unflagged, 'spawn routes the scan did not see').toEqual([]);
    // and the table of cells and the imported helper are accepted once they carry a budget
    const budgeted = scanOne(
      `import { realm } from './helper.js';\nit.each([[1]])('t %s', () => { realm(); }, 30_000);\n`,
      {
        'packages/p/src/helper.ts': `import { spawnSync } from 'node:child_process';\nexport function realm() { return spawnSync('x'); }\n`,
      },
    );
    expect(lines(budgeted)).toEqual([]);
    expect(budgeted.spawningCells).toBe(1);
  });

  it('does not flag a cell that starts nothing, or a file that only mocks child_process', () => {
    const nothing = scanOne(`${SPAWN_IMPORT}it('c', () => { expect(1).toBe(1); });\n`);
    const mocked = scanOne(
      `vi.mock('node:child_process', () => ({ spawn: vi.fn() }));\nit('c', () => { spawn('x'); });\n`,
    );
    expect([lines(nothing), lines(mocked)]).toEqual([[], []]);
    expect([nothing.spawningCells, mocked.spawningCells]).toEqual([0, 0]);
  });
});

describe('spawn-budget guard: the repository', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const PACKAGES = ['core', 'mcp-server', 'testing', 'cli'];
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      if (name === 'node_modules' || name === 'dist') return [];
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : [];
    });

  it('every cell that starts a child process carries a budget of its own', () => {
    // (a) red when a spawning cell is added without a budget, or a budget is removed; (b) prints
    // `<file>:<line> "<title>"` for each such cell, and how many spawning cells the scan saw.
    const sources = new Map<string, string>();
    for (const pkg of PACKAGES) {
      for (const file of walk(join(root, 'packages', pkg, 'src'))) {
        sources.set(relative(root, file).split(sep).join('/'), readFileSync(file, 'utf8'));
      }
    }
    const result = scanSpawnBudgets(sources);
    // The instrument must account for its input: 488 spawning cells in 90 parsed files when this was
    // written. A scan that sees a fraction of that has gone blind and must not pass for "none missing".
    expect(
      result.spawningCells,
      'spawning cells seen (the scan may have gone blind)',
    ).toBeGreaterThan(300);
    expect(result.filesParsed, 'files parsed (the scan may have gone blind)').toBeGreaterThan(50);
    expect(
      lines(result),
      'cells that start a child process with no budget of their own: add a number as the last argument (30_000 for a cold start of the built CLI), a timeout option, or a budget on the describe',
    ).toEqual([]);
  }, 120_000);
});
