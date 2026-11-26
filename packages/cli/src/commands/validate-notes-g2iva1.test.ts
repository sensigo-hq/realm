// validate-notes-g2iva1.test.ts — gap 2, unit (iv-a1), check 8: `realm workflow validate`'s note
// when a prompt or a gated step's instructions puts a step's failure message into its text.
//
// The note rides the loader's result as the not-checked list does, so file mode, registered mode
// and `--json` show it alike; it is never a warning and never counts toward `--strict`. In-process
// via commander's parseAsync, on a temporary home. Every assertion carries (a) the break that turns
// it red and (b) what it prints.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import { validateCommand } from './validate.js';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

/** Three placements that carry `classify`'s failure message, each with `| default` or a found path. */
const YAML = `id: notes
name: Notes
version: 1
steps:
  classify:
    description: Classify the ticket
    execution: agent
  explain:
    description: Explain the failure
    execution: agent
    depends_on: [classify]
    trigger_rule: one_failed
    prompt: "Why: {{ context.resources.$settlement.classify.message | default: \\"none\\" }}"
  dump:
    description: Show everything
    execution: agent
    depends_on: [classify]
    trigger_rule: one_failed
    prompt: "All: {{ context.resources.$settlement.classify }}"
  ask:
    description: Ask a person
    execution: agent
    depends_on: [classify]
    trigger_rule: one_failed
    trust: human_confirmed
    gate:
      choices: [ok]
      message: "Go on?"
    instructions: "Why: {{ context.resources.$settlement.classify.message | default: \\"none\\" }}"
`;
const NOTE = (step: string, reads: string, placement: string): string =>
  `Step '${step}' puts a failure message (\`${reads}\`) into its ${placement}: the text is the failure's own (a provider's, a handler's, an adapter's or Realm's own), so it can carry anything the failed request echoed back.`;
const FIELD = 'context.resources.$settlement.classify.message';
const NOTES = [
  { step: 'explain', placement: 'prompt', reads: FIELD },
  { step: 'dump', placement: 'prompt', reads: 'context.resources.$settlement.classify' },
  { step: 'ask', placement: 'instructions', reads: FIELD },
].map((n) => ({ ...n, message: NOTE(n.step, n.reads, n.placement) }));

describe('gap 2 (iv-a1), check 8 — validate prints the note', () => {
  let h: TempHome & { readonly root: string };
  let originalHome: string | undefined;
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    h = await makeTempHome();
    originalHome = process.env['HOME'];
    process.env['HOME'] = h.root;
    dir = mkdtempSync(join(tmpdir(), 'realm-validate-notes-'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((): never => {
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

  const file = (): string => {
    const path = join(dir, 'workflow.yaml');
    writeFileSync(path, YAML, 'utf8');
    return path;
  };
  const lines = (): string[] => logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
  const register = async (): Promise<void> => {
    const { loadWorkflowFromString } = await import('@sensigo/realm');
    await h.home.workflowStore.register({
      ...loadWorkflowFromString(YAML),
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    } as never);
  };

  it('file mode: Valid, then one ℹ line per placement', async () => {
    await validateCommand.parseAsync([file()], { from: 'user' });
    // (a) red when the loader returns no notes, or validate does not print them; (b) prints the
    //     lines.
    expect(lines().filter((l) => l.startsWith('Valid:') || l.startsWith('ℹ'))).toEqual([
      'Valid: notes v1 (4 steps)',
      ...NOTES.map((n) => `ℹ ${n.message}`),
    ]);
  });

  it('registered mode: the same lines', async () => {
    await register();
    await validateCommand.parseAsync(['--registered', 'notes'], { from: 'user' });
    // (a) red when the note is printed from the file path only (registered mode loses it); (b)
    //     prints the lines.
    expect(lines().filter((l) => l.startsWith('ℹ ') && l.includes('failure message'))).toEqual(
      NOTES.map((n) => `ℹ ${n.message}`),
    );
  });

  it.each(['file', 'registered'] as const)(
    '--json (%s mode): the notes under `notes`',
    async (mode) => {
      if (mode === 'registered') await register();
      await validateCommand.parseAsync(
        mode === 'file' ? [file(), '--json'] : ['--registered', 'notes', '--json'],
        { from: 'user' },
      );
      const out = JSON.parse(lines().join('\n')) as { notes: unknown; warning_count: number };
      // (a) red when --json loses the notes; (b) prints them.
      expect({ notes: out.notes, warnings: out.warning_count }).toEqual({
        notes: NOTES,
        warnings: 0,
      });
    },
  );

  it('--strict passes on a file whose only finding is the note', async () => {
    await validateCommand.parseAsync([file(), '--strict'], { from: 'user' });
    // (a) red when a note counts toward --strict (validate exits 1); (b) prints the result line.
    expect(lines().filter((l) => l.startsWith('Valid:'))).toEqual(['Valid: notes v1 (4 steps)']);
  });
});
