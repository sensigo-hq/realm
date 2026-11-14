// lease-facts-witness-cw1b.test.ts — issue #729, the claim window, unit CW-1b part 1 (design record C5
// §4.1's witness, CW-AU1B-20): a lease fact is never invented, so a lease port is asked only by core's
// `leaseFactsOf`. Read with the TypeScript parser (a comment is never code): every call of a member
// named `probe` in production source (`x.probe(…)`, `x?.probe(…)`, `x['probe'](…)`), whatever the
// receiver is called, sits in one of three files:
//   - core's `store/lease-facts.ts`, `leaseFactsOf`'s module;
//   - realm-testing's `store/lease-port-contract.ts`, the laws of a lease port, which probe it;
//   - core's `workflow/registrar.ts`, whose `this.probe(…)` is its own, unrelated method.
//
// WHAT IT SEES: every `.ts` file under `packages/*/src` but tests (`*.test.ts`), declarations and the
// `test-support` folders (CW-1's witness's reach). WHAT IT CANNOT SEE: a call through a computed name
// (`port[name]()`), a `probe` taken off its object first (`const { probe } = port`), a call in a test.
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

/** The files a `probe(` call may sit in. */
const ALLOWED = [
  'core/src/store/lease-facts.ts',
  'core/src/workflow/registrar.ts',
  'testing/src/store/lease-port-contract.ts',
];

function productionFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== 'node_modules' && name !== 'test-support') walk(path);
      } else if (name.endsWith('.ts') && !/\.(test|d)\.ts$/.test(name)) out.push(path);
    }
  };
  for (const pkg of readdirSync(PACKAGES).sort()) {
    const src = join(PACKAGES, pkg, 'src');
    if (statSync(src, { throwIfNoEntry: false })?.isDirectory() === true) walk(src);
  }
  return out;
}

const rel = (path: string): string => relative(PACKAGES, path).split(sep).join('/');

/** The lines of every call of a member named `probe` in `text`. */
function probeCalls(path: string, text: string): number[] {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const out: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const named =
        (ts.isPropertyAccessExpression(callee) && callee.name.text === 'probe') ||
        (ts.isElementAccessExpression(callee) &&
          ts.isStringLiteralLike(callee.argumentExpression) &&
          callee.argumentExpression.text === 'probe');
      if (named) out.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe('#729 CW-1b — a lease port is asked only by leaseFactsOf (the probe witness)', () => {
  it('the instrument: it finds every spelling of a member call named probe, and no other call', () => {
    const must = [
      'port.probe(id);',
      'store.leases.probe(id);',
      'store.leases?.probe(id);',
      "port['probe'](id);",
      'const p = store.leases; await p.probe(id);',
    ];
    const mustNot = [
      'probe(id);',
      'port.probeAll(id);',
      'const port = { probe(id) { return id; } };',
      'typeof port.probe === "function";',
      '// port.probe(id)',
    ];
    // (1) red when the reader stops finding a spelling (an alias of the port is a receiver like any
    //     other) or starts counting a definition, a read or a comment; (2) prints which fixture.
    expect({
      found: must.filter((t) => probeCalls('x.ts', t).length === 1),
      wrongly: mustNot.filter((t) => probeCalls('x.ts', t).length > 0),
    }).toEqual({ found: must, wrongly: [] });
  });

  it('every member call named probe in production source is in an allowed file', () => {
    const files = productionFiles();
    const calls = files.flatMap((path) =>
      probeCalls(path, readFileSync(path, 'utf8')).map((line) => ({ file: rel(path), line })),
    );
    const inFile = (file: string) => calls.filter((c) => c.file === file).length > 0;
    // (1) red when production code outside the three files calls `probe(` on anything (a lease fact
    //     could then be made without `leaseFactsOf`), or an allowed file no longer calls it (the scan
    //     is then blind to the module it guards); (2) prints each file and line, and each allowed file
    //     with whether it was seen.
    expect({
      files: files.length > 0,
      outside: calls.filter((c) => !ALLOWED.includes(c.file)).map((c) => `${c.file}:${c.line}`),
      seen: Object.fromEntries(ALLOWED.map((file) => [file, inFile(file)])),
    }).toEqual({
      files: true,
      outside: [],
      seen: Object.fromEntries(ALLOWED.map((file) => [file, true])),
    });
  });
});
