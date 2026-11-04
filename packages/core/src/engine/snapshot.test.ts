// snapshot.test.ts — issue #729 PR-0 (D3 A-9, §D premortem 3; Amendment 13 Q2; #715 D6-16, D6-17)
// and #715 (b) (D-15, D-17): one record and the reading it is judged at, built in ONE module.
//
// - The witness: no CONSTRUCTING `{ record, at }` literal exists outside `snapshot.ts`, which holds
//   exactly ONE constructor — `writtenSnapshot` (#715 (b): the store takes the reading; `loadSnapshot`
//   is `store.get`). A binding pattern — `const { record, at } = …`, a parameter, a `for…of` head, the
//   left side of a destructuring assignment — builds nothing and is allowed. The instrument is a
//   TypeScript AST check (an object literal whose keys are exactly `record` and `at`), exercised on
//   text that must and must not match before it is trusted: a line regex mis-reads an untyped
//   parameter and a Prettier-wrapped multi-line literal.
// - Q2: a post-write reply's `basis.as_of` is the write's reading, and its `run_version` the record's.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: file
// paths, counts and instants — never a record's content.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSnapshot, stampOf, writtenSnapshot, type Snapshot } from './snapshot.js';
import { executeStep } from './execution-loop.js';
import { JsonFileStore } from '../store/json-file-store.js';
import { writeTestClockFile } from '../store/test-clock-file.js';
import type { RunRecord } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = join(HERE, '..', '..', '..');
const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');

/** Whether `node` is the target of a destructuring — it binds, it does not build. */
function isAssignmentTarget(node: import('typescript').Node): boolean {
  const parent = node.parent;
  if (parent === undefined) return false;
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === node &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  )
    return true;
  if ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === node)
    return true;
  if (ts.isParenthesizedExpression(parent)) return isAssignmentTarget(parent);
  return false;
}

/** The 1-based lines of every CONSTRUCTING `{ record, at }` object literal in `text`. */
function constructingLiterals(text: string, fileName = 'x.ts'): number[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const visit = (node: import('typescript').Node): void => {
    if (ts.isObjectLiteralExpression(node) && !isAssignmentTarget(node)) {
      const keys = node.properties.map((p) =>
        (ts.isShorthandPropertyAssignment(p) || ts.isPropertyAssignment(p)) &&
        ts.isIdentifier(p.name)
          ? p.name.text
          : '?',
      );
      if (keys.length === 2 && keys.includes('record') && keys.includes('at')) {
        lines.push(source.getLineAndCharacterOfPosition(node.getStart()).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
}

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

describe('#729 PR-0 / #715 (b) — the Snapshot is built in one module', () => {
  it('the instrument: it finds every constructing spelling, and no binding or neighbour', () => {
    // (a) red when the check stops finding a spelling the witness relies on, or starts flagging a
    //     binding pattern; (b) prints which fixture.
    const must = [
      'const s = { record, at };',
      'const s = { record: run, at: now };',
      'const s = { at, record };',
      'const s = {record:r,at:a};',
      'function f() { return { record: r, at: a }; }',
      'const s = {\n  record: someLongName,\n  at: anotherLongName,\n};',
    ];
    const mustNot = [
      'const { record, at } = await store.get(id);',
      'const { record: run, at } = x;',
      'function f({ record, at }: Snapshot) {}',
      'const g = ({ record, at }) => record;',
      'for (const { record, at } of xs) {}',
      '({ record, at } = x);',
      'const s = { record, at, extra };',
      'const s = { records, at };',
      'const s = { record };',
      "const s = '{ record, at }';",
    ];
    expect({
      found: must.filter((t) => constructingLiterals(t).length === 1),
      wrongly: mustNot.filter((t) => constructingLiterals(t).length > 0),
    }).toEqual({ found: must, wrongly: [] });
  });

  it(
    'no constructing `{ record, at }` literal outside snapshot.ts; snapshot.ts holds exactly one constructor',
    { timeout: 25_000 },
    () => {
      // A heavy cell (#371's class rule): it parses every source file of every package with the
      // TypeScript parser — about 6 s on the dev machine under load — so it carries its own budget.
      const files = ['core', 'cli', 'mcp-server', 'testing', 'store-sqlite'].flatMap((pkg) =>
        sources(join(PACKAGES, pkg, 'src')),
      );
      const outside = files
        .filter((file) => !file.endsWith(join('engine', 'snapshot.ts')))
        .filter((file) => !file.endsWith(join('engine', 'snapshot.test.ts')))
        .flatMap((file) =>
          constructingLiterals(readFileSync(file, 'utf8'), file).map(
            (line) => `${relative(PACKAGES, file)}:${line}`,
          ),
        );
      const own = constructingLiterals(readFileSync(join(HERE, 'snapshot.ts'), 'utf8')).length;
      // (a) red when a Snapshot is built anywhere else (a store method building a `{ record, at }`
      //     literal instead of calling writtenSnapshot), or snapshot.ts gains a second constructor;
      //     (b) prints the file:lines and the count. The denominator: the files read.
      expect({ outside, constructors: own, read: files.length > 600 }).toEqual({
        outside: [],
        constructors: 1,
        read: true,
      });
    },
  );

  it('loadSnapshot is store.get: the store’s Snapshot, its reading untouched', async () => {
    const T0 = new Date('2026-10-16T12:00:00.000Z');
    const record = { id: 'r', version: 4 } as unknown as RunRecord;
    const fromStore: Snapshot = writtenSnapshot(record, T0);
    const store = { get: async (): Promise<Snapshot> => fromStore };
    const got = await loadSnapshot(store, 'r');
    // (a) red when loadSnapshot reads a clock of its own or re-wraps the record; (b) prints the
    //     instant and whether the record is the store's.
    expect({ at: got.at.toISOString(), same: got.record === record }).toEqual({
      at: T0.toISOString(),
      same: true,
    });
    expect(stampOf(writtenSnapshot(record, T0))).toEqual({
      as_of: T0.toISOString(),
      run_version: 4,
    });
  });

  it('Q2: a post-write reply’s basis.as_of is the write’s reading; its run_version the record as written', async () => {
    // #715 (b) (01 §C.4): the store's clock decides — a test location's clock file fixes it.
    const root = await mkdtemp(join(tmpdir(), 'realm-snapshot-729-'));
    const now = new Date('2026-10-16T12:34:56.000Z');
    await writeTestClockFile(root, now);
    const store = new JsonFileStore(join(root, 'runs'));
    const d: WorkflowDefinition = {
      id: 'snap',
      name: 'snap',
      version: 1,
      steps: {
        a: { description: 'a', execution: 'agent', depends_on: [] },
        b: { description: 'b', execution: 'agent', depends_on: ['a'] },
      },
    };
    const { record: run } = await store.create({
      workflowId: d.id,
      workflowVersion: 1,
      params: {},
    });
    const reply = await executeStep(store, d, {
      runId: run.id,
      command: 'a',
      input: {},
      dispatcher: async () => ({}),
    });
    const { record: written } = await store.get(run.id);
    // (a) red when the reply's ways are judged at another reading (a fresh clock, a re-read); (b)
    //     prints the stamp.
    expect(reply.basis).toMatchObject({ as_of: now.toISOString(), run_version: written.version });
  });
});
