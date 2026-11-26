// validate-notes-g2iva3.test.ts — gap 2, unit (iv-a3), on the built command: `realm workflow
// validate`'s note when a step's `input_map` hands it a step's failure message. Whatever the step
// copies of it into its output is shown to assistants even under `--failure-text hidden`, and the
// note tells the author so.
//
// The note rides the loader's result as the prompt note does (validate-notes-g2iva1.test.ts): it is
// printed after `ℹ `, listed in `--json`'s `notes`, and never a warning, so it moves no exit code and
// never counts toward `--strict`. The loader-level cells are core's
// workflow/input-map-note-g2iva3.test.ts. In-process via commander's parseAsync, on a temporary home;
// the project provides its handlers (`realm.yaml`), so the file has no other finding. Every
// assertion carries (a) the break that turns it red and (b) what it prints.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCommand } from './validate.js';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

/** The project in `folder` provides each handler in `names` (a `realm.yaml` entry each). */
function provide(folder: string, names: readonly string[]): void {
  writeFileSync(
    join(folder, 'handlers.mjs'),
    'export function makeHandler({ id }) { return { id, execute: async () => ({ data: {} }) }; }\n',
    'utf8',
  );
  writeFileSync(
    join(folder, 'realm.yaml'),
    [
      'version: 1',
      'handlers:',
      ...names.flatMap((n) => [`  ${n}:`, '    use: ./handlers.mjs#makeHandler']),
    ].join('\n') + '\n',
    'utf8',
  );
}

/** `explain` runs only after `fetch` failed and is handed its failure message three ways. */
const YAML = (leaves: string[]): string => `id: handed
name: Handed
version: 1
steps:
  fetch:
    description: Fetch the order
    execution: auto
    handler: fetch_order
  explain:
    description: Keep why the fetch failed
    execution: auto
    handler: save_note
    depends_on: [fetch]
    trigger_rule: one_failed
    input_map:
${leaves.map((l) => `      ${l}`).join('\n')}
`;
const FIELD = 'context.resources.$settlement.fetch.message';
const LEAVES = [
  `why: ${FIELD}`,
  'entry: context.resources.$settlement.fetch',
  'everything: context.resources',
];
/** Words 1. */
const NOTE = (reads: string, key: string): string =>
  `Step 'explain' is handed a failure message (\`${reads}\`) in its input_map at '${key}': the text is the failure's own, and whatever the step copies of it into its output is shown to assistants even under --failure-text hidden.`;
const NOTES = [
  { reads: FIELD, key: 'why' },
  { reads: 'context.resources.$settlement.fetch', key: 'entry' },
  { reads: 'context.resources', key: 'everything' },
].map((n) => ({
  step: 'explain',
  placement: 'input_map',
  reads: n.reads,
  message: NOTE(n.reads, n.key),
}));

describe('gap 2 (iv-a3) — validate prints the input_map note', () => {
  let h: TempHome & { readonly root: string };
  let originalHome: string | undefined;
  let dir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    h = await makeTempHome();
    originalHome = process.env['HOME'];
    process.env['HOME'] = h.root;
    dir = mkdtempSync(join(tmpdir(), 'realm-validate-notes-g2iva3-'));
    provide(dir, ['fetch_order', 'save_note']);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    vi.restoreAllMocks();
    await h.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  const file = (leaves: string[]): string => {
    const path = join(dir, 'workflow.yaml');
    writeFileSync(path, YAML(leaves), 'utf8');
    return path;
  };
  const lines = (spy: ReturnType<typeof vi.spyOn>): string[] =>
    spy.mock.calls.map((c: unknown[]) => String(c[0]));

  it('check 1, text: Valid, then one ℹ line per leaf, in the map’s order', async () => {
    await validateCommand.parseAsync([file(LEAVES)], { from: 'user' });
    // (a) red when the note is not built for input_map leaves, or validate does not print it; (b)
    //     prints the lines.
    expect(lines(logSpy).filter((l) => l.startsWith('Valid:') || l.startsWith('ℹ'))).toEqual([
      'Valid: handed v1 (2 steps)',
      ...NOTES.map((n) => `ℹ ${n.message}`),
    ]);
  });

  it('check 1, --json: the notes under `notes`, no warning', async () => {
    await validateCommand.parseAsync([file(LEAVES), '--json'], { from: 'user' });
    const out = JSON.parse(lines(logSpy).join('\n')) as { notes: unknown; warning_count: number };
    // (a) red when --json loses the notes, or a note is counted as a warning; (b) prints them.
    expect({ notes: out.notes, warnings: out.warning_count }).toEqual({
      notes: NOTES,
      warnings: 0,
    });
  });

  it('check 2, --json on a refused file: the refused leaf has no note, the other leaf keeps its own', async () => {
    await expect(
      validateCommand.parseAsync(
        [
          file([
            'why: context.resources.$settlement.nostep.message',
            'entry: context.resources.$settlement.fetch',
          ]),
          '--json',
        ],
        { from: 'user' },
      ),
    ).rejects.toThrow('process.exit');
    const out = JSON.parse(lines(logSpy).join('\n')) as { valid: boolean; notes: unknown };
    // (a) red when the refusal condition is removed (the refused leaf gets a note); (b) prints the
    //     result and the notes.
    expect({ valid: out.valid, notes: out.notes }).toEqual({ valid: false, notes: [NOTES[1]] });
  });

  it('the ride-along: REALM_NO_NUDGE=1 does not silence the note', async () => {
    const before = process.env['REALM_NO_NUDGE'];
    process.env['REALM_NO_NUDGE'] = '1';
    try {
      await validateCommand.parseAsync([file(LEAVES)], { from: 'user' });
    } finally {
      if (before === undefined) delete process.env['REALM_NO_NUDGE'];
      else process.env['REALM_NO_NUDGE'] = before;
    }
    // (a) red when the loader's notes are printed only without REALM_NO_NUDGE; (b) prints the lines.
    expect(lines(logSpy).filter((l) => l.startsWith('ℹ'))).toEqual(
      NOTES.map((n) => `ℹ ${n.message}`),
    );
  });

  it('check 6: --strict passes and the exit code is 0 when the notes are the only findings', async () => {
    await validateCommand.parseAsync([file(LEAVES), '--strict'], { from: 'user' });
    // (a) red when the note goes through the warnings channel (a ⚠ line, and --strict exits 1);
    //     (b) prints the result line, the warnings and the exit calls.
    expect({
      valid: lines(logSpy).filter((l) => l.startsWith('Valid:')),
      warnings: lines(warnSpy),
      exits: exitSpy.mock.calls.filter((c: unknown[]) => c[0] !== 0),
    }).toEqual({ valid: ['Valid: handed v1 (2 steps)'], warnings: [], exits: [] });
  });
});
