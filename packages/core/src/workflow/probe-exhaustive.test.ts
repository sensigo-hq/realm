// issue #558 PR-T — the sixth-class compile cell. `probeClassToError` is an EXHAUSTIVE switch on
// `ProbeFailureClass` with NO `default`, so a new class does not fall through to a generic
// sentence: it fails to COMPILE. Pinned by running `tsc` on a scratch copy of the module with a
// sixth member added to the union — the diagnostic is recorded verbatim below.
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('probeClassToError is exhaustive by CONSTRUCTION (issue #558 PR-T)', () => {
  it('X1 the switch has no `default:` arm — the missing return IS the diagnostic', () => {
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), 'registrar.ts'),
      'utf8',
    );
    const fn = src.slice(
      src.indexOf('export function probeClassToError('),
      src.indexOf('export function parseFailureError('),
    );
    expect(fn).toContain('switch (result.class) {');
    // The INSTRUMENT check first (round-1's lesson: prettier collapsed the union onto one line
    // and a replace silently matched nothing, so `tsc` came back clean twice on a no-op).
    expect(fn.match(/case '/g)).toHaveLength(5);
    expect(fn).not.toContain('default:');
  });

  it('X2 the two conjuncts that MAKE a sixth class a compile error are both present on the real function', () => {
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), 'registrar.ts'),
      'utf8',
    );
    // (1) a NON-optional return type: `undefined` in it would make the missing return legal.
    expect(src).toContain('): WorkflowError {\n  switch (result.class) {');
    // (2) no `default:` in that switch (X1). Together these two are what produce TS2366.
  });

  it('X3 a sixth class fails tsc with TS2366 pointing at the function HEAD — the diagnostic, verbatim', () => {
    // The mechanism, reproduced on a SELF-CONTAINED file rather than on `registrar.ts` itself:
    // the real module imports six siblings, and a scratch copy of it compiled alone drowns the
    // TS2366 in TS2307/TS18046 noise from the unresolved imports (executed — the noise arrived,
    // the real diagnostic did not). What is pinned here is the SHAPE the real function has, and
    // X1/X2 pin that the real function still has it.
    const scratch = mkdtempSync(join(tmpdir(), 'realm-exhaustive-'));
    try {
      const file = join(scratch, 'shape.ts');
      writeFileSync(
        file,
        [
          'type ProbeFailureClass =',
          "  | 'missing'",
          "  | 'unreadable'",
          "  | 'not_a_file'",
          "  | 'empty'",
          "  | 'registry_broken'",
          "  | 'sixth';",
          'export function probeClassToError(result: { class: ProbeFailureClass }): string {',
          '  switch (result.class) {',
          "    case 'missing':",
          "      return 'a';",
          "    case 'unreadable':",
          "      return 'b';",
          "    case 'not_a_file':",
          "      return 'c';",
          "    case 'empty':",
          "      return 'd';",
          "    case 'registry_broken':",
          "      return 'e';",
          '  }',
          '}',
          '',
        ].join('\n'),
        'utf8',
      );
      // The INSTRUMENT check first (round-1's lesson: a silent no-op replace made tsc come back
      // clean twice and the cell looked green for the wrong reason).
      expect(readFileSync(file, 'utf8')).toContain("| 'sixth'");

      let output = '';
      try {
        execFileSync(
          process.execPath,
          [
            resolve(process.cwd(), 'node_modules/typescript/bin/tsc'),
            '--noEmit',
            '--strict',
            '--target',
            'es2022',
            file,
          ],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        );
      } catch (err) {
        output = String((err as { stdout?: string }).stdout ?? '');
      }
      expect(output).toContain('error TS2366');
      expect(output).toContain(
        "Function lacks ending return statement and return type does not include 'undefined'",
      );
      // It points at the function HEAD (line 8, the `export function` line), not at the switch.
      expect(output).toMatch(/shape\.ts\(8,\d+\): error TS2366/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);
});
