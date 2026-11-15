// Fix 1, piece 4, check 6 — what a run does with a step whose handler the project does not provide,
// the claims the warnings' words make (prompts/ai-authoring-fix1-u4-names.md, words (a) and (c)).
// `realm workflow run` (dev mode) in-process, with the prompt mocked as run-detach.test.ts mocks it.
// The run does not change in this piece; these cells pin what the words say of it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunRecord } from '@sensigo/realm';
import { makeTempHome, type TempHome, runIds } from '../test-support/temp-home.js';

const mocks = vi.hoisted(() => ({ question: vi.fn(), close: vi.fn() }));
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({ question: mocks.question, close: mocks.close })),
}));

import { runCommand } from './run.js';
import { writerTestSeams } from '../output/writer.js';

const shown = (arg: unknown): string => writerTestSeams.visible(String(arg));

/** The project's handlers: `send_refund` returns, `explode` throws. */
const MODULE = `export function makeHandler({ id }) { return { id, execute: async () => ({ data: {} }) }; }
export function makeExplode({ id }) { return { id, execute: async () => { throw new Error('boom'); } }; }
`;
const MANIFEST = `version: 1
handlers:
  send_refund:
    use: ./mod.mjs#makeHandler
  explode:
    use: ./mod.mjs#makeExplode
`;

/** Check 1's file. */
const MISSPELT_HANDLER = `id: refunds
name: Refunds
version: 1
steps:
  refund:
    description: Send the refund.
    execution: auto
    handler: sned_refund
`;

/** Check 3's file, with the work step's handler given: `explode` ends the run `fail`. */
const finalizerFile = (workHandler: string): string => `id: fin
name: Fin
version: 1
steps:
  work:
    description: Work.
    execution: auto
    handler: ${workHandler}
  cleanup:
    description: Clean up.
    execution: finalizer
    handler: sned_refund
    on_outcome: [fail]
`;

describe('check 6 — the runs the warnings describe (fix 1, piece 4)', () => {
  let h: TempHome & { readonly root: string };
  let dir: string;
  let savedHome: string | undefined;
  let savedTTY: boolean | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    h = await makeTempHome();
    dir = mkdtempSync(join(tmpdir(), 'realm-name-check-runs-'));
    mkdirSync(join(h.root, '.realm'), { recursive: true });
    savedHome = process.env['HOME'];
    process.env['HOME'] = h.root;
    // The #426 non-TTY guard refuses before the loop otherwise.
    savedTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    writeFileSync(join(dir, 'mod.mjs'), MODULE, 'utf8');
    writeFileSync(join(dir, 'realm.yaml'), MANIFEST, 'utf8');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(async () => {
    if (savedTTY === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY;
    else process.stdin.isTTY = savedTTY;
    if (savedHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = savedHome;
    await h.cleanup();
    rmSync(dir, { recursive: true, force: true });
    mocks.question.mockReset();
    vi.restoreAllMocks();
  });

  const logged = (): string => logSpy.mock.calls.map((c: unknown[]) => shown(c[0])).join('\n');
  const errored = (): string => errSpy.mock.calls.map((c: unknown[]) => shown(c[0])).join('\n');
  const readRecord = async (): Promise<RunRecord> => {
    const store = h.home.runStore;
    return (await store.get((await runIds(store))[0]!)).record;
  };
  async function run(yaml: string): Promise<void> {
    writeFileSync(join(dir, 'workflow.yaml'), yaml, 'utf8');
    try {
      await runCommand.parseAsync([join(dir, 'workflow.yaml')], { from: 'user' });
    } catch (err) {
      if (!(err instanceof Error) || err.message !== 'process.exit') throw err;
    }
  }

  it("words (a): a run of check 1's file is blocked at the step and stays open (not failed)", async () => {
    await run(MISSPELT_HANDLER);
    const rec = await readRecord();
    // (1) red when the run fails or ends at the step, or the step runs; (2) prints the record's state.
    expect({
      phase: rec.run_phase,
      terminal: rec.terminal_state,
      failed: rec.failed_steps,
      completed: rec.completed_steps,
      asked: mocks.question.mock.calls.length,
    }).toEqual({ phase: 'running', terminal: false, failed: [], completed: [], asked: 0 });
    // (1) red when the run does not say why the step cannot run here; (2) prints the output.
    expect(errored() + '\n' + logged()).toContain(
      "'refund' cannot run here (capability): handler 'sned_refund' is not registered here",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  }, 20_000);

  it("words (c): a run of check 3's file that ends in an outcome its on_outcome selects leaves the cleanup step pending", async () => {
    mocks.question.mockImplementationOnce(async () => '{}');
    await run(finalizerFile('explode'));
    const rec = await readRecord();
    // (1) red when the cleanup step runs, fails or is not left pending; (2) prints the state.
    expect({
      phase: rec.run_phase,
      cleanup: rec.finalizer_ledger?.['cleanup']?.status,
    }).toEqual({ phase: 'failed', cleanup: 'pending' });
    expect(logged()).toContain(
      `Run complete. Phase: failed\n  Resume:    realm run resume ${rec.id} --from work\nCleanup step left pending: 'cleanup'`,
    );
  }, 20_000);

  it('words (c) twin: a run that ends in an outcome its on_outcome does not select leaves it not pending', async () => {
    mocks.question.mockImplementationOnce(async () => '{}');
    await run(finalizerFile('send_refund'));
    const rec = await readRecord();
    // (1) red when an unselected cleanup step is left pending; (2) prints the state.
    expect({
      phase: rec.run_phase,
      pending: rec.finalizer_ledger?.['cleanup']?.status === 'pending',
      line: logged().includes('Cleanup step left pending'),
    }).toEqual({ phase: 'completed', pending: false, line: false });
  }, 20_000);
});
