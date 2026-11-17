// Gap 1, unit A0 — every command that lists runs reads them without their model calls' texts: each of
// the eight callers of the `'record'` scan (`list`, `cleanup`, `drain --all`, the listen sweep, the
// listen reminders, `purge --older-than`, `reclaim --all`, `run migrate`) only reads what it lists, so
// it calls the store's `scanListed`. A store double records which method each caller called: the
// home's SQLite store class, spied on its prototype, so a command that opens its own home through the
// CLI's door is recorded too. And `realm run list` prints the same for runs with texts as without.
//
// Each cell names the break that turns it red (prompts/gap1-a0-listed-scan.md, check 5).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryStore, settableClock } from '@sensigo/realm-testing';
import type { EvidenceSnapshot, RunRecord } from '@sensigo/realm';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';
import { cleanupRuns } from './cleanup.js';
import { drainCommand } from './drain.js';
import { listRuns } from './list.js';
import { readWaitingGates } from './listen.js';
import { makeReminderPass } from './listen-reminders.js';
import { purgeCommand } from './purge.js';
import { reclaimCommand } from './reclaim.js';
import { migrateStampSeals } from './run-migrate.js';

describe('gap 1, unit A0 — the eight callers list runs through scanListed', () => {
  let h: TempHome;
  let originalHome: string | undefined;

  beforeEach(async () => {
    h = await makeTempHome();
    originalHome = process.env['HOME'];
    process.env['HOME'] = h.root!;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
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
  });

  it('check 5: each caller calls scanListed and never a record scan', async () => {
    const store = h.home.runStore;
    // One run in the home, so every listing has a page to read.
    await store.create({ workflowId: 'a0-callers', workflowVersion: 1, params: {} });
    const proto = Object.getPrototypeOf(store) as Record<string, (...a: unknown[]) => unknown>;
    const listed = vi.spyOn(proto, 'scanListed');
    const scanned = vi.spyOn(proto, 'scan');
    const silent = { info: () => {}, warn: () => {}, error: () => {} };
    const run = async (call: () => Promise<unknown>): Promise<unknown> => {
      try {
        return await call();
      } catch (err) {
        if (!(err instanceof Error) || err.message !== 'process.exit') throw err;
        return undefined;
      }
    };
    const callers: Record<string, () => Promise<unknown>> = {
      list: () => listRuns(undefined, store),
      cleanup: () => cleanupRuns({ olderThan: '1h', dryRun: true }, store),
      drain: () => drainCommand.parseAsync(['--all'], { from: 'user' }),
      'listen sweep': () => readWaitingGates(store),
      'listen reminders': () =>
        makeReminderPass({
          runStore: store,
          outbound: store.outbound!,
          home: h.path,
          workflows: new Map(),
          logger: silent,
        })(() => true),
      purge: () => purgeCommand.parseAsync(['--older-than', '1h'], { from: 'user' }),
      reclaim: () => reclaimCommand.parseAsync(['--all'], { from: 'user' }),
      'run migrate': () => migrateStampSeals(store, {}),
    };
    const calls: Record<string, { listed: number; recordScans: number }> = {};
    for (const [name, call] of Object.entries(callers)) {
      listed.mockClear();
      scanned.mockClear();
      await run(call);
      calls[name] = {
        listed: listed.mock.calls.length,
        recordScans: scanned.mock.calls.filter(
          (args) => (args[1] as { projection?: string } | undefined)?.projection !== 'row',
        ).length,
      };
    }
    // (1) red when a caller goes back to the `'record'` scan (`list` back on it: its row reads
    //     `{ listed: 0, recordScans: 1 }`); (2) prints every caller's two counts.
    expect(calls).toEqual(
      Object.fromEntries(Object.keys(callers).map((name) => [name, { listed: 1, recordScans: 0 }])),
    );
  });
});

describe('gap 1, unit A0 — what a listing prints does not depend on the texts', () => {
  it('check 5: realm run list prints the same for a store holding model texts as for the same store without them', async () => {
    const at = '2026-03-04T05:06:07.000Z';
    const maker = new InMemoryStore({ clock: settableClock(at) });
    const { record: run } = await maker.create({
      workflowId: 'a0-list',
      workflowVersion: 1,
      params: {},
    });
    const entry = {
      step_id: 'work',
      started_at: at,
      completed_at: at,
      duration_ms: 0,
      input_summary: {},
      output_summary: { answer: 'kept' },
      status: 'success',
      evidence_hash: 'a0-list',
    } as unknown as EvidenceSnapshot;
    const { record: plain } = await maker.update({ ...run, evidence: [entry] });
    const withText: RunRecord = {
      ...plain,
      evidence: [{ ...entry, model_text: { recorded: true } } as unknown as EvidenceSnapshot],
    };
    const outputOf = async (record: RunRecord, stuck: boolean): Promise<string> => {
      const store = new InMemoryStore({ clock: settableClock(at) });
      store.seed(record);
      return listRuns(undefined, store, undefined, stuck);
    };
    // GROUNDING (no break of this change turns it red): `list` prints no evidence, so the texts
    // cannot reach its lines; it holds because the listing leaves them out before `list` reads.
    // (2) prints both outputs.
    expect({
      plain: await outputOf(withText, false),
      stuck: await outputOf(withText, true),
    }).toEqual({ plain: await outputOf(plain, false), stuck: await outputOf(plain, true) });
  });
});

describe('gap 1, unit A0 — the words (check 9)', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const flat = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8').replace(/\s+/g, ' ');

  it('the CHANGELOG lines, the store-interface row and the law row', () => {
    const log = flat('CHANGELOG.md');
    const unreleased = log.slice(log.indexOf('## [Unreleased]'), log.indexOf('## [0.'));
    const changed = unreleased.slice(unreleased.indexOf('### Changed'));
    // (1) red when a line or row is missing or reworded; (2) prints each check.
    expect({
      changelog: changed.includes(
        "- `RunStore` gains an optional `scanListed`, a listing of runs that leaves each model call's text out; a store without it keeps working, and Realm lists through `scan` instead.",
      ),
      rows: changed.includes(
        "- In the library, a listing's run has its own types, `ListedSnapshot`, `ListedRecord`, `ListedScanPage` and `ListedScanItem`, and `update` does not accept a `ListedRecord`; `RunStore`'s `scanListed` returns them, and `classifyRunHealth`, `findEligibleSteps` and `getWorkflowForRun` take a listed run as well as a full one.",
      ),
      member: flat('docs/reference/core-library.md').includes(
        "| `scanListed(filter, { pageSize, after? })` | No | The runs a `'record'` scan gives, each without its model calls' texts (each evidence entry's and each failed drive's entry's `model_text`), with the same pages, readings and lease facts. Without it, Realm lists through `scan` and leaves the texts out itself. |",
      ),
      law: flat('docs/reference/testing-package.md').includes(
        "| `LISTING_LEAVES_MODEL_TEXT` | On a store with `scanListed`, a listing gives a run without its model calls' texts (the `model_text` of each evidence entry and of each failed drive's entry), with every other value as `get` reads it; an `update` with that listed record, on a run that holds an evidence text, is refused, and the stored texts stay. Its cases are registered as skipped for a store without `scanListed`, which Realm lists through `scan`. Added after version 0.50.0. |",
      ),
    }).toEqual({ changelog: true, rows: true, member: true, law: true });
  });
});
