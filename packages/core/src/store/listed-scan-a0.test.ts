// Gap 1, unit A0 — listing runs reads no model call's text. The listing goes through the store's
// `scanListed` when it has one, and otherwise through its `'record'` scan with the texts left out of
// copies (`scanListedRuns`). A listing's record is refused by `update` at compile time, and by the
// in-memory store at run time; a store written before `scanListed` still compiles. The SQLite store's
// own cells are in store-sqlite's run-store-listed-a0.test.ts, its callers' in the CLI's
// listed-callers-a0.test.ts.
//
// Each cell names the break that turns it red (prompts/gap1-a0-listed-scan.md, checks 2, 3, 4, 6, 7).
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { InMemoryStore, createLeaseDouble } from '@sensigo/realm-testing';
import { classifyInProgressClaims } from '../engine/claim-liveness.js';
import type { ListedSnapshot, Snapshot } from '../engine/snapshot.js';
import type { DriveFailureRecord, EvidenceSnapshot, RunRecord } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import { scanListedRuns } from './listed-scan.js';
import type { RunStore } from './store-interface.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE = join(HERE, '..', '..');
const PACKAGES = join(CORE, '..');

/** A stand-in for a model call's text. */
const TEXT = { recorded: true, sent: [{ role: 'user', content: 'a prompt' }] };

/** How many `"model_text"` keys the JSON of `value` holds. */
const texts = (value: unknown): number => JSON.stringify(value).split('"model_text"').length - 1;

/** An in-memory run whose evidence entry and failed drive's entry each carry `model_text`. */
async function runWithTexts(store: InMemoryStore, workflowId: string): Promise<RunRecord> {
  const { record: run } = await store.create({ workflowId, workflowVersion: 1, params: {} });
  const entry = {
    step_id: 'work',
    started_at: '2026-01-01T00:00:00.000Z',
    completed_at: '2026-01-01T00:00:01.000Z',
    duration_ms: 1,
    input_summary: {},
    output_summary: { answer: 'kept' },
    status: 'success',
    evidence_hash: 'a0',
    model_text: TEXT,
  } as unknown as EvidenceSnapshot;
  const failure = {
    at: '2026-01-01T00:00:02.000Z',
    step: 'work',
    provider: 'a0',
    error_class: 'other',
    message: 'a0',
    elapsed_ms: 1,
    model_text: TEXT,
  } as unknown as DriveFailureRecord;
  const { record } = await store.update({
    ...run,
    evidence: [entry],
    drive_failures: { first_failed_at: failure.at, total: 1, entries: [failure] },
  });
  return record;
}

/** Every run `scanListedRuns` gives of `workflow`. */
async function listedRuns(
  store: Pick<RunStore, 'scan' | 'scanListed'>,
  workflow: string,
): Promise<ListedSnapshot[]> {
  const runs: ListedSnapshot[] = [];
  for await (const page of scanListedRuns(store, { workflow }, { pageSize: 1000 })) {
    for (const item of page.items) if (item.kind === 'run') runs.push(item.run);
  }
  return runs;
}

/** A store double with only today's `scan`: no `scanListed`, as a store written before it. */
const withoutScanListed = (store: InMemoryStore): Pick<RunStore, 'scan'> => ({
  scan: store.scan.bind(store) as RunStore['scan'],
});

describe('gap 1, unit A0 — listing runs reads no model call’s text', () => {
  it('check 2: a store with no scanListed is listed through scan, with model_text left out in memory', async () => {
    const store = new InMemoryStore();
    const run = await runWithTexts(store, 'a0-fallback');
    const [viaScan] = await listedRuns(withoutScanListed(store), 'a0-fallback');
    const [viaListed] = await listedRuns(store, 'a0-fallback');
    // (1) red when the callers require scanListed (the double has none, so the listing throws), or
    //     the fallback keeps a text; (2) prints the texts counted and both records.
    expect({
      id: viaScan?.record.id,
      texts: texts(viaScan?.record),
      same: JSON.stringify(viaScan?.record) === JSON.stringify(viaListed?.record),
    }).toEqual({ id: run.id, texts: 0, same: true });
  });

  it('check 7: a listing through the fallback changes nothing in place — the stored entries keep their texts', async () => {
    const store = new InMemoryStore();
    const run = await runWithTexts(store, 'a0-in-place');
    await listedRuns(withoutScanListed(store), 'a0-in-place');
    await listedRuns(store, 'a0-in-place');
    // (1) red when the fallback deletes the key in place (the in-memory store's scan hands out its
    //     stored objects); (2) prints the texts counted on the stored record.
    expect(texts((await store.get(run.id)).record)).toBe(2);
  });

  it('check 4: InMemoryStore.update refuses a write that drops a stored model_text; one that keeps it is written', async () => {
    const store = new InMemoryStore();
    const run = await runWithTexts(store, 'a0-refuse');
    const [listed] = await listedRuns(store, 'a0-refuse');
    const refused = await store
      .update(listed!.record as unknown as RunRecord)
      .then(() => 'written')
      .catch((err: { code?: string }) => err.code);
    const kept = await store
      .update((await store.get(run.id)).record)
      .then(() => 'written')
      .catch((err: { code?: string }) => err.code);
    // (1) red when the in-memory check is removed (the listed record is written), or it refuses a
    //     write that keeps the texts; (2) prints both outcomes and the texts left.
    expect({ refused, kept, texts: texts((await store.get(run.id)).record) }).toEqual({
      refused: 'STATE_EVIDENCE_REWRITTEN',
      kept: 'written',
      texts: 2,
    });
  });

  it('check 6: a run whose claim names a lease is judged to the same claim state through the in-memory scanListed as through scan', async () => {
    const leases = createLeaseDouble();
    const store = new InMemoryStore({ leases });
    const definition: WorkflowDefinition = {
      id: 'a0-leased',
      name: 'A0 leased',
      version: 1,
      steps: { work: { description: 'Work.', execution: 'agent', depends_on: [] } },
    };
    const { record: run } = await store.create({
      workflowId: definition.id,
      workflowVersion: 1,
      params: {},
    });
    const made = await leases.hold();
    if (!('held' in made)) throw new Error(`no lease: ${JSON.stringify(made)}`);
    await store.claimStep(run.id, 'work', definition, undefined, made.held);
    const scanned: Snapshot[] = [];
    for await (const page of store.scan({ workflow: definition.id }, { pageSize: 1000 })) {
      for (const item of page.items) if (item.kind === 'run') scanned.push(item.run);
    }
    const [viaListing] = await listedRuns(store, definition.id);
    // (1) red when scanListed skips the lease-fact step (the claim reads `not_checked`); (2) prints
    //     both judgements.
    expect(classifyInProgressClaims(viaListing!)).toEqual(classifyInProgressClaims(scanned[0]!));
    // The instrument: the claim names a lease the double holds, so a missing fact would show.
    expect(classifyInProgressClaims(scanned[0]!)[0]?.lease).toBeDefined();
    made.held.close();
  });

  it('checks 3 and 4: a store written today compiles against RunStore; update refuses a ListedRecord; a Snapshot fits a ListedSnapshot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'realm-a0-tsc-'));
    try {
      const index = JSON.stringify(join(CORE, 'dist', 'index.js'));
      const file = join(dir, 'a0.ts');
      writeFileSync(
        file,
        [
          `import type { ListedRecord, ListedSnapshot, RunStore, Snapshot } from ${index};`,
          // A store written before scanListed: every member a RunStore had, today's three scan
          // overloads among them, and no scanListed.
          "declare const today: Omit<RunStore, 'scanListed'>;",
          'export const compatible: RunStore = today;',
          'declare const listed: ListedRecord;',
          'declare const store: RunStore;',
          '// @ts-expect-error a listing record is refused by update',
          'export const refused = store.update(listed);',
          'declare const snapshot: Snapshot;',
          'export const fits: ListedSnapshot = snapshot;',
        ].join('\n'),
      );
      const program = ts.createProgram([file], {
        noEmit: true,
        strict: true,
        exactOptionalPropertyTypes: true,
        skipLibCheck: true,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        target: ts.ScriptTarget.ES2022,
      });
      const problems = ts
        .getPreEmitDiagnostics(program)
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
      // (1) red when scanListed is made required (the store written today no longer compiles), or a
      //     ListedRecord becomes assignable to RunRecord (the @ts-expect-error is then unused), or a
      //     Snapshot stops fitting a ListedSnapshot; (2) prints the compiler's messages.
      expect(problems).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the witness: recordToJudge has exactly one caller, classifyRunHealth’s probe, and is not exported', () => {
    const files = ['core', 'cli', 'mcp-server', 'testing', 'store-sqlite'].flatMap((pkg) =>
      sources(join(PACKAGES, pkg, 'src')),
    );
    const calls = files.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, i) =>
          /\brecordToJudge\(/.test(line) && !/function recordToJudge\(/.test(line)
            ? [`${relative(PACKAGES, file)}:${i + 1}`]
            : [],
        ),
    );
    const exported = ['internal.ts', 'index.ts'].filter((name) =>
      readFileSync(join(CORE, 'src', name), 'utf8').includes('recordToJudge'),
    );
    // (1) red when a second caller appears, the one caller moves, or an entry exports it; (2) prints
    //     the call sites and the entries naming it.
    expect({ calls: calls.map((c) => c.replace(/:\d+$/, '')), exported }).toEqual({
      calls: [join('core', 'src', 'engine', 'run-health.ts')],
      exported: [],
    });
  });
});

/** Every non-test TypeScript source under `dir`. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts') && !name.endsWith('.test.ts'))
      out.push(path);
  }
  return out;
}
