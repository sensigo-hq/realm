// validate-head-3b.test.ts — caching 3-B, F2 (MA1-3B-01; MA 2's rulings MA2-3B-IA1-02, -10, -11):
// `realm workflow validate` sizes each agent step's prompt head by its disclosed SIZE, and two steps
// share a whole fixed part only when their raw heads are identical AND their disclosed sizes are equal.
// Run on the built realm with hand-written workflows. Each cell names (a) the change that turns it red
// and (b) what it prints: the step's cache line.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const DIST_CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'index.js');
let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'realm-3b-head-'));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** The cache line of step `step` from `realm workflow validate` on a workflow with these prompts. */
function lineOf(prompts: Record<string, string>, step: string, extra: string[] = []): string {
  const steps = Object.entries(prompts)
    .map(
      ([name, prompt]) =>
        `  ${name}:\n    description: ${name}.\n    execution: agent\n    prompt: ${JSON.stringify(prompt)}\n` +
        '    output_schema: { type: object, properties: { q: { type: string } }, required: [q] }\n',
    )
    .join('');
  const file = join(base, 'workflow.yaml');
  writeFileSync(file, `id: head-3b\nname: head-3b\nversion: 1\nsteps:\n${steps}`, 'utf8');
  const r = spawnSync(
    process.execPath,
    [DIST_CLI, 'workflow', 'validate', file, '--provider', 'anthropic', ...extra],
    {
      cwd: base,
      env: { PATH: process.env['PATH'] ?? '', HOME: base, REALM_NO_NUDGE: '1' },
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
  return (
    r.stdout.split('\n').find((l) => l.startsWith(`cache: ${step} `)) ?? `(no line: ${r.stderr})`
  );
}

const SAME = 'Classify the ticket below into one queue.\nTicket: {{ run.params.t }}';

describe(
  'caching 3-B F2 — the head in validate’s cache lines, and who shares it',
  { timeout: 60_000 },
  () => {
    it('(a) identical heads: the whole fixed part is shared — with no floor and above it, and dropped below it (F-4’s filter)', () => {
      const prompts = { a: SAME, b: SAME };
      const lines = [
        lineOf(prompts, 'a'),
        lineOf(prompts, 'a', ['--floor', '1']),
        lineOf(prompts, 'a', ['--floor', '100000']),
      ];
      // (a) red when equal heads are not matched (the group is not interned), or the below filter is
      //     lost; (b) prints the three lines.
      expect(
        lines.map((l) => l.endsWith(' — shares its whole fixed part with b')),
        lines.join('\n'),
      ).toEqual([true, true, false]);
    });

    it('(b) different heads: no whole-share clause', () => {
      // The two heads have the SAME size (`queue`, `group`): only their text differs.
      const line = lineOf(
        { a: SAME, b: 'Classify the ticket below into one group.\nTicket: {{ run.params.t }}' },
        'a',
      );
      // (a) red when size blocks are compared by size alone (the clause would name b); (b) prints
      //     the line.
      expect(line.includes('shares its whole fixed part'), line).toBe(false);
    });

    it('(c) identical raw heads, a mask crossing the cut in one step only: not whole', () => {
      // In `a` the credential value runs on into the next placeholder's output (`zz`), so the cut moves
      // back to the value's start; in `b` it stops at a space. The raw heads are equal, the sizes not.
      const line = lineOf(
        {
          a: "Key: password=abc{{ run.params.x | default: 'zz' }} end",
          b: "Key: password=abc{{ run.params.x | default: ' ' }} end",
        },
        'a',
      );
      // (a) red when the sizes are left out of the describer's equality AND core compares two size
      //     blocks by group alone: each check alone keeps these steps apart (equal raw heads differ
      //     in disclosed size only through a moved cut, which changes the length core compares);
      //     (b) prints the line.
      expect(line.includes('shares its whole fixed part'), line).toBe(false);
    });
  },
);
