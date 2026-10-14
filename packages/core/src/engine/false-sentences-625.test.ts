// false-sentences-625.test.ts — issue #625 PR-2a, the last prompt's F17 in core (review G5-3, G5-13):
// two sentences of `core-library.md` made true as the build behaves. A `now` that is not a `Date`
// throws only at an open question that declares `on_expiry` (the engine reads the clock only to
// judge such a question); at any other question the call runs as given. `submitHumanResponse`
// decides a guard the answer makes ready in the same write only on a store with `settleStep`; on a
// store without it the guard is owed, and `advanceRun` decides it.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { advanceRun, executeStep, submitHumanResponse } from './execution-loop.js';
import { JsonFileStore } from '../store/json-file-store.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { RunStore } from '../store/store-interface.js';

const PAGE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/reference/core-library.md',
);

/** (a) red when the page no longer holds the sentence word for word; (b) prints it. */
function claim(sentence: string): void {
  const flat = (t: string) => t.replace(/\s+/g, ' ');
  expect(flat(readFileSync(PAGE, 'utf8')), `core-library.md no longer says: ${sentence}`).toContain(
    flat(sentence),
  );
}

async function store(): Promise<JsonFileStore> {
  return new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-f17-core-')));
}

/** `q` opens a question (60 s, with or without `on_expiry`); `g`, a guard on its answer. */
function asked(onExpiry: 'abort' | undefined): WorkflowDefinition {
  return {
    id: `f17-${onExpiry ?? 'plain'}`,
    name: 'f17',
    version: 1,
    steps: {
      q: {
        description: 'Ask.',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: [],
        gate: {
          choices: ['approve', 'reject'],
          timeout_seconds: 60,
          ...(onExpiry !== undefined ? { on_expiry: onExpiry } : {}),
        },
      },
      g: {
        description: 'Decide.',
        execution: 'guard',
        depends_on: ['q'],
        abort_unless: ['q.ok == true'],
      },
    },
  };
}

/** A run of `d` at its open question; returns the run id and the question's id. */
async function atQuestion(s: RunStore, d: WorkflowDefinition): Promise<[string, string]> {
  const { run } = await s.create({ workflowId: d.id, workflowVersion: 1, params: {} });
  const opened = await executeStep(s, d, {
    runId: run.id,
    command: 'q',
    input: {},
    dispatcher: async () => ({ ok: true }),
  });
  if (opened.status !== 'confirm_required') throw new Error(`fixture: ${opened.status}`);
  return [run.id, (await s.get(run.id)).pending_gate!.gate_id];
}

describe('#625 PR-2a, F17 — core-library.md says what the build does', () => {
  it('G5-3: a `now` that is not a valid Date — rejected VALIDATION_OPTION_INVALID before anything is read or written, at a question with no on_expiry and at one that declares it', async () => {
    claim(
      'Given anything else (a number, a string, or a `Date` that is not a valid time), the call rejects with `VALIDATION_OPTION_INVALID` before anything is read or written.',
    );
    const s = await store();
    const plain = asked(undefined);
    const [plainId] = await atQuestion(s, plain);
    const timed = asked('abort');
    const [timedId] = await atQuestion(s, timed);
    const before = [JSON.stringify(await s.get(plainId)), JSON.stringify(await s.get(timedId))];
    const outcomes: string[] = [];
    for (const [def, id] of [
      [plain, plainId],
      [timed, timedId],
    ] as const) {
      for (const now of ['2026-01-01', 12345]) {
        try {
          await advanceRun(s, def, { runId: id, now: now as never });
          outcomes.push('no rejection');
        } catch (e) {
          outcomes.push(`${(e as { code?: string }).code ?? (e as Error).constructor.name}`);
        }
      }
    }
    // (a) red when a call runs on such a `now` (G5-3: it used to, at a question with no on_expiry)
    //     or rejects with anything else; (b) prints the outcomes.
    expect(outcomes).toEqual([
      'VALIDATION_OPTION_INVALID',
      'VALIDATION_OPTION_INVALID',
      'VALIDATION_OPTION_INVALID',
      'VALIDATION_OPTION_INVALID',
    ]);
    expect([JSON.stringify(await s.get(plainId)), JSON.stringify(await s.get(timedId))]).toEqual(
      before,
    );
  });

  it.each([
    ['with settleStep', false],
    ['without settleStep', true],
  ] as const)(
    'G5-13: submitHumanResponse on a store %s — the guard the answer makes ready',
    async (_label, legacy) => {
      claim(
        "Answers a gate. On a store with `settleStep`, a guard step the answer makes ready is decided in the same write, and the reply's `guards` names it; on a store without it, the guard is owed, and `advanceRun` decides it.",
      );
      const base = await store();
      // A store without `settleStep` (the page says such a store still works).
      const s: RunStore = legacy
        ? (new Proxy(base, {
            get(target, prop) {
              if (prop === 'settleStep') return undefined;
              const v = Reflect.get(target, prop, target) as unknown;
              return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
            },
          }) as RunStore)
        : base;
      const d = asked(undefined);
      const [id, gateId] = await atQuestion(s, d);
      const answered = await submitHumanResponse(s, d, { runId: id, gateId, choice: 'approve' });
      const afterAnswer = [...(await s.get(id)).completed_steps];
      const advanced = await advanceRun(s, d, { runId: id });
      // (a) red when the store without settleStep decides the guard in the answer's write, or the
      //     one with it does not (G5-13); (b) prints the answer's guards and hint, and what advance ran.
      expect({
        guards: answered.guards,
        hint: answered.context_hint,
        afterAnswer,
        advance: (advanced.chained_auto_steps ?? []).map((c) => c.step),
        phase: (await s.get(id)).run_phase,
      }).toEqual(
        legacy
          ? {
              guards: undefined,
              hint: "Gate 'q' resolved with choice 'approve'. Owed to the engine: 'g' — call advance_run.",
              afterAnswer: ['q'],
              advance: ['g'],
              phase: 'completed',
            }
          : {
              guards: [{ step: 'g', outcome: 'pass' }],
              hint: "Guard step 'g' passed and completed the run.",
              afterAnswer: ['q', 'g'],
              advance: [],
              phase: 'completed',
            },
      );
    },
  );
});
