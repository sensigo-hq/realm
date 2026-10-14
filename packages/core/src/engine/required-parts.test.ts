// required-parts.test.ts — issue #719 (A2): admission's `required_parts` row. Each cell drives the
// REAL entry with a store that records every use, so a check that sits below a read, or an entry
// that hands no parts, turns the cell red. Failure output is the error's code and details (option
// names and type words only) and the store calls — never a value.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executeStep,
  executeEngineStep,
  executeChain,
  advanceRun,
  submitHumanResponse,
  drainFinalizers,
  type StepDispatcher,
} from './execution-loop.js';
import { abandonRun } from './abandon-run.js';
import { reclaimStep } from './reclaim-step.js';
import { getWorkflowForRun } from '../workflow/registrar.js';
import { declareReleaseLine } from '../release-line.js';
import { JsonFileStore } from '../store/json-file-store.js';
import type { EngineEntry } from '../admission.js';
import type { RunStore } from '../store/store-interface.js';
import type { RunRecord } from '../types/run-record.js';
import type { StepDefinition, WorkflowDefinition } from '../types/workflow-definition.js';

type Parts = Record<string, unknown>;

/** A store that records every call and answers none; its release line is declared. */
function trapStore(): { s: RunStore; calls: string[] } {
  const calls: string[] = [];
  const trap = (name: string) => () => {
    calls.push(name);
    throw new Error(`the store was used: ${name}`);
  };
  const s = {
    persistsClaims: true,
    create: trap('create'),
    get: trap('get'),
    update: trap('update'),
    list: trap('list'),
    claimStep: trap('claimStep'),
    settleStep: trap('settleStep'),
  } as unknown as RunStore;
  declareReleaseLine(s);
  return { s, calls };
}

/** A run record with each of the 14 required fields (issue #719, R2), every one of its type. */
function fullRunRecord(over: Record<string, unknown> = {}): RunRecord {
  return {
    id: 'r',
    workflow_id: 'w',
    workflow_version: 1,
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'running',
    version: 0,
    params: {},
    evidence: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    terminal_state: false,
    ...over,
  } as unknown as RunRecord;
}

const dispatcher: StepDispatcher = async () => ({});
const defWith = (step: StepDefinition): WorkflowDefinition =>
  ({ id: 'w', name: 'w', version: 1, steps: { work: step } }) as unknown as WorkflowDefinition;
const AGENT = defWith({ description: 'd', execution: 'agent' } as StepDefinition);
/** `executeEngineStep` runs only an `auto` step: an agent step is refused by kind before any use. */
const BARE = defWith({ description: 'd', execution: 'auto' } as StepDefinition);

/** Sound parts for each entry: every cell changes one or two of them. */
const BASE: Record<EngineEntry, () => Parts> = {
  executeStep: () => ({
    definition: AGENT,
    options: { runId: 'r', command: 'work', input: {}, dispatcher },
  }),
  executeChain: () => ({
    definition: AGENT,
    options: { runId: 'r', command: 'work', input: {}, dispatcher },
  }),
  executeEngineStep: () => ({
    definition: BARE,
    options: { runId: 'r', step: 'work', run: fullRunRecord() },
  }),
  advanceRun: () => ({ definition: AGENT, options: { runId: 'r' } }),
  submitHumanResponse: () => ({
    definition: AGENT,
    options: { runId: 'r', gateId: 'g', choice: 'approve' },
  }),
  abandonRun: () => ({ runId: 'r' }),
  drainFinalizers: () => ({ definition: AGENT, runId: 'r' }),
  getWorkflowForRun: () => ({ run: fullRunRecord(), opts: { retryVerb: 'retry', verb: 'answer' } }),
  reclaimStep: () => ({ runId: 'r', stepName: 'work' }),
};

/** Each entry, called for real with the parts as its parameters. */
const CALL: Record<EngineEntry, (s: RunStore, p: Parts) => Promise<unknown>> = {
  executeStep: (s, p) => executeStep(s, p['definition'] as never, p['options'] as never),
  executeChain: (s, p) => executeChain(s, p['definition'] as never, p['options'] as never),
  executeEngineStep: (s, p) =>
    executeEngineStep(s, p['definition'] as never, p['options'] as never),
  advanceRun: (s, p) => advanceRun(s, p['definition'] as never, p['options'] as never),
  submitHumanResponse: (s, p) =>
    submitHumanResponse(s, p['definition'] as never, p['options'] as never),
  abandonRun: (s, p) => abandonRun(s, p['runId'] as never, p['reason'] as never),
  drainFinalizers: (s, p) =>
    drainFinalizers(s, p['definition'] as never, p['registry'] as never, p['runId'] as never),
  getWorkflowForRun: (s, p) => getWorkflowForRun(s as never, p['run'] as never, p['opts'] as never),
  reclaimStep: (s, p) =>
    reclaimStep(s, p['runId'] as never, p['stepName'] as never, p['options'] as never),
};

const ABSENT = Symbol('absent');

/** `parts` with the member at `path` set to `value` (or removed), its containers copied. */
function withPart(parts: Parts, path: string, value: unknown): Parts {
  const keys = path.split('.');
  const out: Parts = { ...parts };
  let at: Record<string, unknown> = out;
  for (const key of keys.slice(0, -1)) {
    const next = { ...(at[key] as Record<string, unknown>) };
    at[key] = next;
    at = next;
  }
  const last = keys[keys.length - 1]!;
  if (value === ABSENT) delete at[last];
  else at[last] = value;
  return out;
}

/** Calls the entry; the rejection's code and the options it names, and the store calls made. */
async function outcome(entry: EngineEntry, parts: Parts) {
  const { s, calls } = trapStore();
  const err = (await CALL[entry](s, parts).then(
    () => undefined,
    (e: unknown) => e,
  )) as { code?: string; details?: { invalid?: Array<{ option: string }> } } | undefined;
  return {
    code: err?.code,
    invalid: err?.details?.invalid?.map((i) => i.option),
    calls,
  };
}

/** issue #719: each entry's required members, and one value of a wrong type for each. */
const REQUIRED: Array<[EngineEntry, string, unknown]> = [
  ['executeStep', 'definition', 'x'],
  ['executeStep', 'definition.steps', 'x'],
  ['executeStep', 'options', 'x'],
  ['executeStep', 'options.runId', 7],
  ['executeStep', 'options.command', 7],
  ['executeStep', 'options.input', ABSENT],
  ['executeStep', 'options.dispatcher', 'x'],
  ['executeChain', 'definition', 'x'],
  ['executeChain', 'definition.steps', 'x'],
  ['executeChain', 'options', 'x'],
  ['executeChain', 'options.runId', 7],
  ['executeChain', 'options.command', 7],
  ['executeChain', 'options.input', ABSENT],
  ['executeChain', 'options.dispatcher', 'x'],
  ['executeEngineStep', 'definition', 'x'],
  ['executeEngineStep', 'definition.steps', 'x'],
  ['executeEngineStep', 'options', 'x'],
  ['executeEngineStep', 'options.runId', 7],
  ['executeEngineStep', 'options.step', 7],
  ['executeEngineStep', 'options.run', 'x'],
  ['advanceRun', 'definition', 'x'],
  ['advanceRun', 'definition.steps', 'x'],
  ['advanceRun', 'options', 'x'],
  ['advanceRun', 'options.runId', 7],
  ['submitHumanResponse', 'definition', 'x'],
  ['submitHumanResponse', 'definition.steps', 'x'],
  ['submitHumanResponse', 'options', 'x'],
  ['submitHumanResponse', 'options.runId', 7],
  ['submitHumanResponse', 'options.gateId', 7],
  ['submitHumanResponse', 'options.choice', 7],
  ['abandonRun', 'runId', 7],
  ['drainFinalizers', 'definition', 'x'],
  ['drainFinalizers', 'definition.steps', 'x'],
  ['drainFinalizers', 'runId', 7],
  ['getWorkflowForRun', 'run', 'x'],
  ['getWorkflowForRun', 'opts', 'x'],
  ['getWorkflowForRun', 'opts.retryVerb', 7],
  ['getWorkflowForRun', 'opts.verb', 7],
  ['reclaimStep', 'runId', 7],
  ['reclaimStep', 'stepName', 7],
];

describe('issue #719 A2 — every required part: absent, null and a wrong type are refused before any read', () => {
  const cells = REQUIRED.flatMap(([entry, path, wrong]) => [
    [entry, path, 'absent', ABSENT],
    [entry, path, 'null', null],
    // `input` takes any value but `undefined` and `null` (a string input keeps working,
    // F719-IA-05), so it has no wrong type: its third cell is the absent one again.
    ...(wrong === ABSENT ? [] : [[entry, path, 'a wrong type', wrong]]),
  ]) as Array<[EngineEntry, string, string, unknown]>;

  it.each(cells)('%s: %s %s', async (entry, path, _label, value) => {
    // (a) red when the entry reads before refusing, refuses with another code, or does not name
    //     this member alone; (b) prints the code, the options named and the store calls.
    expect(await outcome(entry, withPart(BASE[entry](), path, value))).toEqual({
      code: 'VALIDATION_OPTION_INVALID',
      invalid: [path],
      calls: [],
    });
  });
});

/** issue #719 (R3): each entry's typed-when-present members, and one value of a wrong type. */
const TYPED: Array<[EngineEntry, string, unknown]> = [
  ...(['executeStep', 'executeChain'] as const).flatMap(
    (e): Array<[EngineEntry, string, unknown]> => [
      [e, 'options.now', '2026-01-01'],
      [e, 'options.stepMeta', 'x'],
      [e, 'options.trace', 'x'],
      [e, 'options.traceBufferStore', 'x'],
      [e, 'options.writerNonce', 7],
    ],
  ),
  ['executeStep', 'options.outputSource', 'nope'],
  ['executeEngineStep', 'options.now', 12345],
  ['executeEngineStep', 'options.traceBufferStore', 'x'],
  ['advanceRun', 'options.now', new Date(Number.NaN)],
  ['advanceRun', 'options.traceBufferStore', 'x'],
  ['advanceRun', 'options.command', 7],
  ['advanceRun', 'options.onStep', 'x'],
  ['advanceRun', 'options.onTaken', 'x'],
  ['advanceRun', 'options.onNotRecorded', 'x'],
  ['advanceRun', 'options.onGuard', 'x'],
  ['advanceRun', 'options.onExpiry', 'x'],
  ['submitHumanResponse', 'options.now', '2026-01-01'],
  ['submitHumanResponse', 'options.respondedBy', 7],
  ['submitHumanResponse', 'options.claimToken', 7],
  ['abandonRun', 'reason', 7],
  ['getWorkflowForRun', 'opts.terminalOk', 'yes'],
  ['reclaimStep', 'options', 'x'],
  ['reclaimStep', 'options.now', '2026-01-01'],
  ['reclaimStep', 'options.traceBufferStore', 'x'],
];

describe('issue #719 A2 (R3) — every typed optional member: a wrong type is refused before any read', () => {
  it.each(TYPED)('%s: %s', async (entry, path, value) => {
    // (a) red when such a value reaches the entry (a bare TypeError, a store failure, or a call that
    //     runs); (b) prints the code, the options named and the store calls.
    expect(await outcome(entry, withPart(BASE[entry](), path, value))).toEqual({
      code: 'VALIDATION_OPTION_INVALID',
      invalid: [path],
      calls: [],
    });
  });
});

/** issue #719: two defects of the row, per entry — both are named, in table order. */
const TWO: Array<[EngineEntry, [string, unknown], [string, unknown]]> = [
  ['executeStep', ['options.runId', ABSENT], ['options.now', '2026-01-01']],
  ['executeChain', ['options.command', 7], ['options.trace', 'x']],
  ['executeEngineStep', ['options.step', ABSENT], ['options.run', null]],
  ['advanceRun', ['options.runId', 7], ['options.onStep', 'x']],
  ['submitHumanResponse', ['options.gateId', 7], ['options.choice', null]],
  ['abandonRun', ['runId', ABSENT], ['reason', 7]],
  ['drainFinalizers', ['definition', 'x'], ['runId', 7]],
  ['getWorkflowForRun', ['run', null], ['opts.verb', 7]],
  ['reclaimStep', ['runId', 7], ['stepName', null]],
];

describe('issue #719 A2 — every defect of the parts at once', () => {
  it.each(TWO)('%s: two defects, both named', async (entry, [p1, v1], [p2, v2]) => {
    const parts = withPart(withPart(BASE[entry](), p1, v1), p2, v2);
    const { s, calls } = trapStore();
    const err = (await CALL[entry](s, parts).then(
      () => undefined,
      (e: unknown) => e,
    )) as { code?: string; message?: string; details?: { invalid?: Array<{ option: string }> } };
    // (a) red when only the first defect is named, in the message or in the details; (b) prints
    //     the code, the options named, whether the message names each, and the store calls.
    expect({
      code: err?.code,
      invalid: err?.details?.invalid?.map((i) => i.option),
      messageNamesBoth: [p1, p2].map((p) => err?.message?.includes(`${p} must be`)),
      count: err?.message?.includes(`${entry} was called with 2 invalid option(s): `),
      calls,
    }).toEqual({
      code: 'VALIDATION_OPTION_INVALID',
      invalid: [p1, p2],
      messageNamesBoth: [true, true],
      count: true,
      calls: [],
    });
  });

  it('a missing options object is named alone, without its members', async () => {
    // (a) red when the members of a missing container are named too; (b) prints the outcome.
    expect(await outcome('executeStep', withPart(BASE.executeStep(), 'options', ABSENT))).toEqual({
      code: 'VALIDATION_OPTION_INVALID',
      invalid: ['options'],
      calls: [],
    });
  });

  it('the message, for one option and for several, as text', async () => {
    const { s } = trapStore();
    const one = (await abandonRun(s, 7 as never).catch((e: unknown) => e)) as Error;
    const several = (await executeStep(s, AGENT, {
      command: 'work',
      input: {},
      dispatcher,
      now: '2026-01-01',
    } as never).catch((e: unknown) => e)) as Error;
    const run = (await executeEngineStep(s, BARE, {
      runId: 'r',
      step: 'work',
      run: { id: 'r', version: '0' } as never,
    }).catch((e: unknown) => e)) as Error;
    // (a) red when the message drops a clause, a type word or the closing sentence, or prints a
    //     value; (b) prints the three messages (type words only — no value is in them).
    expect([one.message, several.message, run.message]).toEqual([
      'abandonRun was called with 1 invalid option(s): runId must be a string (got number). Nothing was read or written.',
      'executeStep was called with 2 invalid option(s): options.runId must be a string (got undefined); options.now must be a valid Date (got string). Nothing was read or written.',
      'executeEngineStep was called with 1 invalid option(s): options.run must be a run record (got object) (workflow_id is missing; workflow_version is missing; completed_steps is missing; in_progress_steps is missing; failed_steps is missing; skipped_steps is missing; run_phase is missing; version is not a number; params is missing; evidence is missing; created_at is missing; updated_at is missing; terminal_state is missing). Nothing was read or written.',
    ]);
  });

  it('guard: a caller defect AND a required-part defect — the caller row wins', async () => {
    const parts = withPart(
      withPart(BASE.executeStep(), 'options.caller', 'nightly'),
      'options.runId',
      ABSENT,
    );
    // (b) prints the outcome.
    expect((await outcome('executeStep', parts)).code).toBe('VALIDATION_CALLER_INVALID');
  });
});

describe('issue #719 A2 (R1) — the dispatcher is required exactly for the steps Realm calls it for', () => {
  const NEEDS: Array<[string, StepDefinition]> = [
    ['an agent step', { description: 'd', execution: 'agent' } as StepDefinition],
    ['a bare auto step', { description: 'd', execution: 'auto' } as StepDefinition],
    ['a step with no execution', { description: 'd' } as StepDefinition],
    [
      "a step with execution 'bogus'",
      { description: 'd', execution: 'bogus' } as unknown as StepDefinition,
    ],
  ];
  it.each(
    NEEDS.flatMap(([label, step]) =>
      (['executeStep', 'executeChain'] as const).map((e) => [e, label, step] as const),
    ),
  )('%s: %s without a dispatcher is refused before any read', async (entry, _label, step) => {
    const parts = withPart(
      { ...BASE[entry](), definition: defWith(step) },
      'options.dispatcher',
      ABSENT,
    );
    // (a) red when such a step is admitted without a dispatcher; (b) prints the outcome.
    expect(await outcome(entry, parts)).toEqual({
      code: 'VALIDATION_OPTION_INVALID',
      invalid: ['options.dispatcher'],
      calls: [],
    });
  });

  it.each([
    [
      'a uses_service step',
      { description: 'd', execution: 'auto', uses_service: 's', operation: 'o' } as StepDefinition,
    ],
    ['a handler step', { description: 'd', execution: 'auto', handler: 'h' } as StepDefinition],
  ])('guard: %s without a dispatcher is admitted', async (_label, step) => {
    const parts = withPart(
      { ...BASE.executeStep(), definition: defWith(step) },
      'options.dispatcher',
      ABSENT,
    );
    const o = await outcome('executeStep', parts);
    // (b) prints the outcome: admitted means the call went on to read the store.
    expect({ refused: o.code === 'VALIDATION_OPTION_INVALID', read: o.calls.length > 0 }).toEqual({
      refused: false,
      read: true,
    });
  });

  describe('guard: a command that names no step is left to the unknown-step reply', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'realm-719-parts-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    it('blocked, as before', async () => {
      const store = new JsonFileStore(dir);
      const { run } = await store.create({ workflowId: 'w', workflowVersion: 1, params: {} });
      const reply = await executeStep(store, AGENT, { runId: run.id, command: 'nope', input: {} });
      // (b) prints the reply's status and code.
      expect([reply.status, reply.error_code]).toEqual(['blocked', undefined]);
    });
  });
});

describe('issue #719 A2 (R2) — `run` must be a run record', () => {
  const FIELDS: Array<[string, unknown]> = [
    ['id', 7],
    ['workflow_id', 7],
    ['workflow_version', 'x'],
    ['completed_steps', 'x'],
    ['in_progress_steps', 'x'],
    ['failed_steps', 'x'],
    ['skipped_steps', 'x'],
    ['run_phase', 7],
    ['version', 'x'],
    ['params', undefined],
    ['evidence', 'x'],
    ['created_at', 7],
    ['updated_at', 7],
    ['terminal_state', 'x'],
  ];
  const at = (entry: 'executeEngineStep' | 'getWorkflowForRun') =>
    entry === 'executeEngineStep' ? 'options.run' : 'run';

  const missing = (['executeEngineStep', 'getWorkflowForRun'] as const).flatMap((entry) =>
    FIELDS.map(([field]) => [entry, field] as const),
  );
  it.each(missing)('%s: a run without %s is refused, the field named', async (entry, field) => {
    const run = fullRunRecord() as unknown as Record<string, unknown>;
    delete run[field];
    const { s, calls } = trapStore();
    const err = (await CALL[entry](s, withPart(BASE[entry](), at(entry), run)).catch(
      (e: unknown) => e,
    )) as { code?: string; details?: { invalid?: Array<{ option: string; fields?: unknown }> } };
    // (a) red when the run is admitted without the field; (b) prints the code, the details and the
    //     store calls (field names only).
    expect({ code: err?.code, invalid: err?.details?.invalid, calls }).toEqual({
      code: 'VALIDATION_OPTION_INVALID',
      invalid: [
        {
          option: at(entry),
          expected: 'a run record',
          given_type: 'object',
          fields: [{ field, problem: 'missing' }],
        },
      ],
      calls: [],
    });
  });

  const wrong = (['executeEngineStep', 'getWorkflowForRun'] as const).flatMap((entry) =>
    FIELDS.filter(([, v]) => v !== undefined).map(([field, v]) => [entry, field, v] as const),
  );
  it.each(wrong)(
    '%s: a run whose %s has the wrong type is refused, the field named',
    async (entry, field, v) => {
      const run = fullRunRecord({ [field]: v });
      const { s, calls } = trapStore();
      const err = (await CALL[entry](s, withPart(BASE[entry](), at(entry), run)).catch(
        (e: unknown) => e,
      )) as { code?: string; details?: { invalid?: Array<{ fields?: unknown }> } };
      // (a) red when the wrong type is admitted; (b) prints the code, the fields and the calls.
      expect({ code: err?.code, fields: err?.details?.invalid?.[0]?.fields, calls }).toEqual({
        code: 'VALIDATION_OPTION_INVALID',
        fields: [{ field, problem: 'wrong_type' }],
        calls: [],
      });
    },
  );

  it.each(
    (['executeEngineStep', 'getWorkflowForRun'] as const).flatMap((entry) =>
      (
        [
          ['an object', {}],
          ['null', null],
          ['an array', [1]],
          ['a string', 's'],
          ['a number', 3],
        ] as const
      ).map(([label, params]) => [entry, label, params] as const),
    ),
  )(
    'guard: %s admits a full record whose params is %s (Realm stores such params)',
    async (entry, _label, params) => {
      const o = await outcome(entry, withPart(BASE[entry](), at(entry), fullRunRecord({ params })));
      // (b) prints the outcome: admitted means the call went on to use its store.
      expect({ refused: o.code === 'VALIDATION_OPTION_INVALID', used: o.calls.length > 0 }).toEqual(
        {
          refused: false,
          used: true,
        },
      );
    },
  );
});

describe('issue #719 C4 — a wrong registry is refused where it was handed in, before any read', () => {
  const REGISTRY_AT: Array<[EngineEntry, string]> = [
    ['executeStep', 'options.registry'],
    ['executeChain', 'options.registry'],
    ['executeEngineStep', 'options.registry'],
    ['advanceRun', 'options.registry'],
    ['submitHumanResponse', 'options.registry'],
    ['drainFinalizers', 'registry'],
  ];
  const WRONG: Array<[string, unknown]> = [
    ['a string', 'x'],
    ['a number', 7],
    ['an empty object', {}],
    ['null', null],
  ];
  it.each(REGISTRY_AT.flatMap(([e, at]) => WRONG.map(([label, v]) => [e, at, label, v] as const)))(
    '%s: %s as %s',
    async (entry, at, _label, value) => {
      // (a) red when a registry the engine cannot call is admitted (it then claims the step and
      //     fails it with a bare TypeError, walk S1); (b) prints the outcome.
      expect(await outcome(entry, withPart(BASE[entry](), at, value))).toEqual({
        code: 'VALIDATION_OPTION_INVALID',
        invalid: [at],
        calls: [],
      });
    },
  );

  it("the details name it 'an extension registry', by its type word only", async () => {
    const { s } = trapStore();
    const err = (await advanceRun(s, AGENT, { runId: 'r', registry: 'SECRETVALUE' } as never).catch(
      (e: unknown) => e,
    )) as { details?: { invalid?: unknown }; message?: string };
    // (a) red when the expected phrase or the type word changes, or the value is echoed; (b)
    //     prints the details and whether the message holds the value.
    expect({
      invalid: err.details?.invalid,
      echoed: String(err.message).includes('SECRETVALUE'),
    }).toEqual({
      invalid: [
        { option: 'options.registry', expected: 'an extension registry', given_type: 'string' },
      ],
      echoed: false,
    });
  });
});

describe('issue #719 C4 — a member that is not an option of the entry is refused, not ignored', () => {
  const UNKNOWN_AT: Array<[EngineEntry, string]> = [
    ['executeStep', 'options.bogusOption'],
    ['executeChain', 'options.bogusOption'],
    ['executeEngineStep', 'options.bogusOption'],
    ['advanceRun', 'options.bogusOption'],
    ['submitHumanResponse', 'options.bogusOption'],
    ['getWorkflowForRun', 'opts.bogusOption'],
    ['reclaimStep', 'options.bogusOption'],
  ];
  it.each(UNKNOWN_AT)('%s: %s', async (entry, at) => {
    const parts = entry === 'reclaimStep' ? { ...BASE[entry](), options: {} } : BASE[entry]();
    // (a) red when an unknown member is silently ignored; (b) prints the outcome.
    expect(await outcome(entry, withPart(parts, at, true))).toEqual({
      code: 'VALIDATION_OPTION_INVALID',
      invalid: [at],
      calls: [],
    });
  });

  it("0.46.0's advanceRun options (a dispatcher and an input) are refused, both named, as text", async () => {
    const { s, calls } = trapStore();
    const err = (await advanceRun(s, AGENT, {
      runId: 'r',
      dispatcher,
      input: { a: 1 },
    } as never).catch((e: unknown) => e)) as {
      code?: string;
      message?: string;
      details?: { invalid?: unknown };
    };
    // (a) red when an upgraded host's dispatcher is dropped without a word (walk S2); (b) prints
    //     the code, the details, the message (type words only) and the store calls.
    expect({ code: err.code, invalid: err.details?.invalid, message: err.message, calls }).toEqual({
      code: 'VALIDATION_OPTION_INVALID',
      invalid: [
        {
          option: 'options.dispatcher',
          expected: 'not an option of advanceRun',
          given_type: 'function',
        },
        { option: 'options.input', expected: 'not an option of advanceRun', given_type: 'object' },
      ],
      message:
        'advanceRun was called with 2 invalid option(s): options.dispatcher is not an option of ' +
        'advanceRun (got function); options.input is not an option of advanceRun (got object). ' +
        'Nothing was read or written.',
      calls: [],
    });
  });
});

describe('issue #719 C2 — "at once" has one stated limit: the dispatcher is judged once the definition and command are sound', () => {
  it.each([
    ['definition.steps', 'x'],
    ['options.command', 7],
  ])(
    'executeStep with %s defective and no dispatcher for an agent step: only that part is named',
    async (path, value) => {
      const parts = withPart(
        withPart(BASE.executeStep(), 'options.dispatcher', ABSENT),
        path,
        value,
      );
      // (a) red when the docs' limit stops being true (the dispatcher named while the step it is
      //     for cannot be known); (b) prints the outcome.
      expect(await outcome('executeStep', parts)).toEqual({
        code: 'VALIDATION_OPTION_INVALID',
        invalid: [path],
        calls: [],
      });
    },
  );
});

describe('issue #719 C4 — the dispatcher is type-checked whenever it is given', () => {
  it.each([
    [
      'a uses_service step',
      { description: 'd', execution: 'auto', uses_service: 's', operation: 'o' } as StepDefinition,
    ],
    ['a handler step', { description: 'd', execution: 'auto', handler: 'h' } as StepDefinition],
  ])('%s with a dispatcher that is not a function: refused', async (_label, step) => {
    const parts = withPart(
      { ...BASE.executeStep(), definition: defWith(step) },
      'options.dispatcher',
      'x',
    );
    // (a) red when a dispatcher is checked only when the step needs one; (b) prints the outcome.
    expect(await outcome('executeStep', parts)).toEqual({
      code: 'VALIDATION_OPTION_INVALID',
      invalid: ['options.dispatcher'],
      calls: [],
    });
  });
});

describe('issue #719 C4 — null, one rule: undefined is absent, null is refused for every typed member', () => {
  it.each(TYPED.map(([entry, path]) => [entry, path] as const))(
    '%s: %s as null',
    async (entry, path) => {
      // (a) red when a null optional member is taken for absent (a default) instead of refused;
      //     (b) prints the outcome.
      expect(await outcome(entry, withPart(BASE[entry](), path, null))).toEqual({
        code: 'VALIDATION_OPTION_INVALID',
        invalid: [path],
        calls: [],
      });
    },
  );

  it.each([
    ['options.driver', 'VALIDATION_ACTOR_INVALID'],
    ['options.caller', 'VALIDATION_CALLER_INVALID'],
  ])(
    'guard: executeStep with %s null is refused by its own row, before any read',
    async (path, code) => {
      // (b) prints the code and the store calls.
      const o = await outcome('executeStep', withPart(BASE.executeStep(), path, null));
      expect({ code: o.code, calls: o.calls }).toEqual({ code, calls: [] });
    },
  );
});

describe('issue #719 C4 — a step that is not an object, and a missing store', () => {
  it.each(['executeStep', 'executeChain'] as const)(
    '%s: a command naming a null step — admission does not throw; the call goes on',
    async (entry) => {
      const parts = {
        ...BASE[entry](),
        definition: { id: 'w', name: 'w', version: 1, steps: { work: null } },
      };
      const { s, calls } = trapStore();
      const err = await CALL[entry](s, parts).then(
        () => undefined,
        (e: unknown) => e,
      );
      // (a) red when admission throws a bare TypeError reading the null step; (b) prints whether
      //     the error is a TypeError and whether the store was reached.
      expect({ typeError: err instanceof TypeError, reachedStore: calls.length > 0 }).toEqual({
        typeError: false,
        reachedStore: true,
      });
    },
  );

  const STORE_KIND: Record<EngineEntry, string> = {
    executeStep: 'a run store',
    executeChain: 'a run store',
    executeEngineStep: 'a run store',
    advanceRun: 'a run store',
    submitHumanResponse: 'a run store',
    abandonRun: 'a run store',
    drainFinalizers: 'a run store',
    reclaimStep: 'a run store',
    getWorkflowForRun: 'a workflow store',
  };
  it.each(
    (Object.keys(STORE_KIND) as EngineEntry[]).flatMap((e) => [
      [e, 'null', null] as const,
      [e, 'undefined', undefined] as const,
    ]),
  )(
    '%s: a %s store is the missing part, named — not release-line advice',
    async (entry, label, store) => {
      const err = (await CALL[entry](store as never, BASE[entry]()).catch((e: unknown) => e)) as {
        code?: string;
        details?: { invalid?: unknown };
        message?: string;
      };
      // (a) red when an absent store gets ENGINE_RELEASE_LINE_UNDECLARED ("declare it once"); (b)
      //     prints the code, the details and the message.
      expect({ code: err.code, invalid: err.details?.invalid, message: err.message }).toEqual({
        code: 'VALIDATION_OPTION_INVALID',
        invalid: [{ option: 'store', expected: STORE_KIND[entry], given_type: label }],
        message: `${entry} was called with 1 invalid option(s): store must be ${STORE_KIND[entry]} (got ${label}). Nothing was read or written.`,
      });
    },
  );
});

describe('issue #719 C4 — the Date check is a brand check', () => {
  it('a Date from another realm is accepted: the call goes on to its store', async () => {
    const foreign = runInNewContext('new Date(0)') as unknown;
    const o = await outcome('advanceRun', withPart(BASE.advanceRun(), 'options.now', foreign));
    // (a) red when a valid Date of another realm is refused (`instanceof`); (b) prints the outcome.
    expect({ refused: o.code === 'VALIDATION_OPTION_INVALID', used: o.calls.length > 0 }).toEqual({
      refused: false,
      used: true,
    });
  });

  it('an object that only inherits Date.prototype is refused as not a valid Date, never a TypeError', async () => {
    const fake = Object.create(Date.prototype) as unknown;
    const { s, calls } = trapStore();
    const err = (await advanceRun(s, AGENT, { runId: 'r', now: fake } as never).catch(
      (e: unknown) => e,
    )) as { code?: string; details?: { invalid?: unknown } };
    // (a) red when `getTime()` throws inside admission ("this is not a Date object."); (b) prints
    //     the code, the details and the store calls.
    expect({ code: err.code, invalid: err.details?.invalid, calls }).toEqual({
      code: 'VALIDATION_OPTION_INVALID',
      invalid: [{ option: 'options.now', expected: 'a valid Date', given_type: 'object' }],
      calls: [],
    });
  });
});
