// The admission rule (architecture framework v1.27 §4): every engine entry admits its call through
// ONE ordered table, first, before any read. Each cell drives the REAL entry with a store that
// throws on any use, so a check that moves below a read, or an entry that skips the table, reds.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { admitEntry, ENGINE_ENTRIES, HOST_WIRING_CHECKS, type EngineEntry } from './admission.js';
import {
  executeStep,
  executeEngineStep,
  executeChain,
  advanceRun,
  submitHumanResponse,
  drainFinalizers,
} from './engine/execution-loop.js';
import { abandonRun } from './engine/abandon-run.js';
import { reclaimStep } from './engine/reclaim-step.js';
import { getWorkflowForRun } from './workflow/registrar.js';
import { declareReleaseLine } from './release-line.js';
import { brandClass, createRealmBrand } from './brand.js';
import type { RunStore } from './store/store-interface.js';
import type { RunRecord } from './types/run-record.js';
import type { WorkflowDefinition } from './types/workflow-definition.js';
import type { ExtensionRegistry as Registry } from './extensions/registry.js';
import type { Attributed } from './engine/holder.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OTHER = createRealmBrand('@sensigo/realm', '9.9.9', 'file:///tmp/other-realm/');
const BAD_DRIVER = { by: 'a\nb', by_source: 'derived', channel: 'agent' } as unknown as Attributed;

/** A store that records every call and answers none. `declared` decides its release line. */
function trapStore(declared: boolean): { s: RunStore; calls: string[] } {
  const calls: string[] = [];
  const trap = (name: string) => () => {
    calls.push(name);
    throw new Error(`the store was read: ${name}`);
  };
  const s = {
    persistsClaims: true,
    create: trap('create'),
    get: trap('get'),
    update: trap('update'),
    // #616 PR-2c c4: the store's reads of its runs.
    scan: trap('scan'),
    resolveKey: trap('resolveKey'),
    tombstonesSince: trap('tombstonesSince'),
    claimStep: trap('claimStep'),
    settleStep: trap('settleStep'),
    // #715 (b): every store holds a clock (admission checks its functions exist; a call is a use).
    clock: { now: trap('clock.now'), at: trap('clock.at') },
  } as unknown as RunStore;
  if (declared) declareReleaseLine(s);
  return { s, calls };
}

/** A registry from another realm release, as that release builds it. */
function foreignRegistry(): Registry {
  class ExtensionRegistry {}
  brandClass(ExtensionRegistry, Symbol.for('@sensigo/realm/ExtensionRegistry'), OTHER);
  return new ExtensionRegistry() as unknown as Registry;
}

const def = {
  id: 'w',
  name: 'w',
  version: 1,
  steps: { work: { description: 'd', execution: 'agent' } },
} as unknown as WorkflowDefinition;
const dispatcher = async () => ({});

/** The optional parts, spread only when present (exactOptionalPropertyTypes). */
const opt = (registry: Registry | undefined, driver: Attributed | undefined) => ({
  ...(registry !== undefined ? { registry } : {}),
  ...(driver !== undefined ? { driver } : {}),
});

/** Each entry, called for real with whatever the cell hands it. */
const CALLS: Record<
  EngineEntry,
  (s: RunStore, registry: Registry | undefined, driver: Attributed | undefined) => Promise<unknown>
> = {
  executeStep: (s, registry, driver) =>
    executeStep(s, def, {
      runId: 'r',
      command: 'work',
      input: {},
      dispatcher,
      ...opt(registry, driver),
    }),
  executeEngineStep: (s, registry, driver) =>
    executeEngineStep(s, def, {
      runId: 'r',
      step: 'work',
      run: { id: 'r', version: 0 } as unknown as RunRecord,
      ...opt(registry, driver),
    }),
  executeChain: (s, registry, driver) =>
    executeChain(s, def, {
      runId: 'r',
      command: 'work',
      input: {},
      dispatcher,
      ...opt(registry, driver),
    }),
  advanceRun: (s, registry, driver) =>
    advanceRun(s, def, {
      runId: 'r',
      command: 'work',
      ...opt(registry, driver),
    }),
  submitHumanResponse: (s, registry, driver) =>
    submitHumanResponse(s, def, {
      runId: 'r',
      gateId: 'g',
      choice: 'approve',
      ...opt(registry, driver),
    }),
  drainFinalizers: (s, registry, driver) => drainFinalizers(s, def, registry, 'r', driver),
  abandonRun: (s) => abandonRun(s, 'r'),
  reclaimStep: (s) => reclaimStep(s, 'r', 'work'),
  getWorkflowForRun: (s) =>
    getWorkflowForRun(
      s as unknown as { get: () => Promise<WorkflowDefinition> },
      {
        id: 'r',
        workflow_id: 'w',
      } as unknown as RunRecord,
      { retryVerb: 'retry', verb: 'answer' },
    ),
};

/** The entries that take a registry and a driver; the other three take a store only (C155: executeEngineStep admits its own call). */
const FULL: readonly EngineEntry[] = [
  'executeStep',
  'executeEngineStep',
  'executeChain',
  'advanceRun',
  'submitHumanResponse',
  'drainFinalizers',
];

describe('the admission table', () => {
  it('has the host-wiring rows in the decided order', () => {
    // (a) red when a row is added, dropped or moved without this list moving; (b) prints the ids.
    expect(HOST_WIRING_CHECKS.map((c) => c.id)).toEqual([
      'store_release_line',
      'store_clock',
      'store_settle_step',
      'store_leases',
      'registry_release_line',
      'driver_shape',
      'caller',
      'required_parts',
    ]);
  });

  // #715 (b) (D-18, D6-5): a run store without a callable clock, or without `settleStep`, is refused at
  // the front door in its four clauses — never a late TypeError in the middle of a write.
  it.each(ENGINE_ENTRIES.filter((e) => e !== 'getWorkflowForRun').map((e) => [e]))(
    '%s: a run store with no clock is refused, naming store.clock, before any read',
    async (entry) => {
      const { s, calls } = trapStore(true);
      delete (s as { clock?: unknown }).clock;
      // (a) red when the row is dropped or reads the store; (b) prints the code and the option named.
      await expect(CALLS[entry](s, undefined, undefined)).rejects.toMatchObject({
        code: 'VALIDATION_OPTION_INVALID',
        details: { invalid: [{ option: 'store.clock', given_type: 'undefined' }] },
      });
      expect(calls).toEqual([]);
    },
  );

  it.each(ENGINE_ENTRIES.filter((e) => e !== 'getWorkflowForRun').map((e) => [e]))(
    '%s: a run store with no settleStep is refused, naming store.settleStep, before any read',
    async (entry) => {
      const { s, calls } = trapStore(true);
      delete (s as { settleStep?: unknown }).settleStep;
      // (a) red when the row is dropped (a cast store would reach a TypeError mid-write); (b) prints
      //     the code and the option named.
      await expect(CALLS[entry](s, undefined, undefined)).rejects.toMatchObject({
        code: 'VALIDATION_OPTION_INVALID',
        details: { invalid: [{ option: 'store.settleStep', given_type: 'undefined' }] },
      });
      expect(calls).toEqual([]);
    },
  );

  // #729, the claim window (CW-1): a run store whose `leases` is present and neither `null` nor a
  // lease port is refused at the front door, in its four clauses, naming store.leases.
  it.each(
    ENGINE_ENTRIES.filter((e) => e !== 'getWorkflowForRun').flatMap((entry) =>
      (
        [
          ['7', 7, 'number'],
          ['{}', {}, 'object'],
        ] as const
      ).map(([label, value, given]) => [entry, label, value, given] as const),
    ),
  )(
    '%s: a run store whose leases is %s is refused, naming store.leases, before any read',
    async (entry, _label, value, given) => {
      const { s, calls } = trapStore(true);
      (s as { leases: unknown }).leases = value;
      // (a) red when the row is dropped (7 is then admitted), or lets through an object without hold
      //     and probe functions; (b) prints the code, the option named and the given type.
      await expect(CALLS[entry](s, undefined, undefined)).rejects.toMatchObject({
        code: 'VALIDATION_OPTION_INVALID',
        details: { invalid: [{ option: 'store.leases', given_type: given }] },
      });
      expect(calls).toEqual([]);
    },
  );

  it('a run store without leases, or whose leases is null or a lease port, is admitted', () => {
    const port = {
      hold: async () => ({ unavailable: 'io_error' }),
      probe: async () => ({ state: 'absent', basis: 'kernel_lock' }),
    };
    const admitted = ['absent', null, port].map((leases) => {
      const { s } = trapStore(true);
      if (leases !== 'absent') (s as { leases: unknown }).leases = leases;
      try {
        admitEntry('executeStep', { store: s, storeKind: 'run store' });
        return 'admitted';
      } catch (err) {
        return (err as { code?: string }).code ?? String(err);
      }
    });
    // (a) red when the row refuses an absent leases (every store written before it), null (a store
    //     that keeps no leases) or a lease port; (b) prints the refusal's code for each.
    expect(admitted).toEqual(['admitted', 'admitted', 'admitted']);
  });

  it('two defects — no release line and no clock: the release line is named first (the table is ordered)', async () => {
    const { s } = trapStore(false);
    delete (s as { clock?: unknown }).clock;
    // (a) red when the clock row runs before the release-line row; (b) prints the code.
    await expect(CALLS.executeStep(s, undefined, undefined)).rejects.toMatchObject({
      code: 'ENGINE_RELEASE_LINE_UNDECLARED',
    });
  });

  it('two defects — no clock and no settleStep: the clock is named first', async () => {
    const { s } = trapStore(true);
    delete (s as { clock?: unknown }).clock;
    delete (s as { settleStep?: unknown }).settleStep;
    // (a) red when the two rows swap; (b) prints the option named.
    await expect(CALLS.advanceRun(s, undefined, undefined)).rejects.toMatchObject({
      details: { invalid: [{ option: 'store.clock' }] },
    });
  });

  it('a clock whose at is missing is refused too (a clock is now and at)', async () => {
    const { s } = trapStore(true);
    (s as { clock: unknown }).clock = { now: () => new Date() };
    // (a) red when the row checks `now` alone; (b) prints the given type.
    await expect(CALLS.executeStep(s, undefined, undefined)).rejects.toMatchObject({
      details: { invalid: [{ option: 'store.clock', given_type: 'object' }] },
    });
  });

  it('getWorkflowForRun admits a workflow store: no clock row runs for it', async () => {
    const { s, calls } = trapStore(true);
    delete (s as { clock?: unknown }).clock;
    delete (s as { settleStep?: unknown }).settleStep;
    // (a) red when the run-store rows refuse a workflow store; (b) prints what was thrown.
    const err = await CALLS.getWorkflowForRun(s, undefined, undefined).then(
      () => undefined,
      (e: unknown) => (e as { details?: { invalid?: Array<{ option: string }> } }).details?.invalid,
    );
    expect(JSON.stringify(err ?? [])).not.toContain('store.clock');
    expect(JSON.stringify(err ?? [])).not.toContain('store.settleStep');
    void calls;
  });

  it('passes a call with nothing wrong, and with every optional part absent', () => {
    const { s } = trapStore(true);
    expect(() => admitEntry('executeStep', { store: s, storeKind: 'run store' })).not.toThrow();
  });
});

describe('every entry admits first, in order (each cell stacks defects; the first is named)', () => {
  it.each(ENGINE_ENTRIES.map((e) => [e]))(
    '%s: an undeclared store is named first, and the store is never read',
    async (entry) => {
      const { s, calls } = trapStore(false);
      // (a) red when the entry reads before admitting, skips the table, or checks the driver or
      //     the registry before the store; (b) prints what was thrown and the store calls made.
      const kind = entry === 'getWorkflowForRun' ? 'workflow store' : 'run store';
      await expect(CALLS[entry](s, foreignRegistry(), BAD_DRIVER)).rejects.toMatchObject({
        code: 'ENGINE_RELEASE_LINE_UNDECLARED',
        message: expect.stringMatching(new RegExp(`^The ${kind} handed to ${entry} `)),
      });
      expect(calls).toEqual([]);
    },
  );

  it.each(FULL.map((e) => [e]))(
    '%s: with the store declared, a registry from another release is named before a bad driver',
    async (entry) => {
      const { s, calls } = trapStore(true);
      await expect(CALLS[entry](s, foreignRegistry(), BAD_DRIVER)).rejects.toMatchObject({
        code: 'ENGINE_RELEASE_LINE_MISMATCH',
        message: expect.stringMatching(new RegExp(`^The registry handed to ${entry} `)),
      });
      expect(calls).toEqual([]);
    },
  );

  it.each(FULL.map((e) => [e]))(
    '%s: with store and registry sound, a bad driver THROWS — never an error reply',
    async (entry) => {
      const { s, calls } = trapStore(true);
      await expect(CALLS[entry](s, undefined, BAD_DRIVER)).rejects.toMatchObject({
        code: 'VALIDATION_ACTOR_INVALID',
        message: 'Invalid driver.by: contains a control character.',
      });
      expect(calls).toEqual([]);
    },
  );
});

describe('the source-text witness: each entry admits as its first statement and checks nothing itself', () => {
  const HOME: Record<EngineEntry, string> = {
    executeStep: 'engine/execution-loop.ts',
    executeEngineStep: 'engine/execution-loop.ts',
    submitHumanResponse: 'engine/execution-loop.ts',
    drainFinalizers: 'engine/execution-loop.ts',
    advanceRun: 'engine/execution-loop.ts',
    executeChain: 'engine/execution-loop.ts',
    abandonRun: 'engine/abandon-run.ts',
    reclaimStep: 'engine/reclaim-step.ts',
    getWorkflowForRun: 'workflow/registrar.ts',
  };
  const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it.each(ENGINE_ENTRIES.map((e) => [e]))('%s', (entry) => {
    const code = strip(readFileSync(join(HERE, HOME[entry]), 'utf8'));
    const start = code.indexOf(`export async function ${entry}(`);
    expect(start, `${entry} not found in ${HOME[entry]}`).toBeGreaterThan(-1);
    // The body starts at the first `{` after the signature's closing `)` and return type.
    const sigEnd = code.indexOf('> {\n', start);
    const body = code.slice(sigEnd + 4).trimStart();
    // (a) red when anything precedes the admission call; (b) prints the body's first line.
    expect(body.split('\n')[0]).toMatch(new RegExp(`^admitEntry\\('${entry}', `));
  });

  it('no entry file calls a host-wiring check outside the admission step', () => {
    for (const file of new Set(Object.values(HOME))) {
      const code = strip(readFileSync(join(HERE, file), 'utf8'));
      // (a) red when a file re-adds its own check; (b) prints the file and the call found.
      for (const name of [
        'assertReleaseLine',
        'assertRegistryLine',
        'validateDriver',
        'validateCaller',
        'checkRequiredParts',
        // issue #719 (C4): the parts check's own collector, exported beside it — an entry that
        // called it itself would check outside the admission step.
        'invalidParts',
        'optionInvalidError',
      ]) {
        expect(code.match(new RegExp(`\\b${name}\\(`, 'g')) ?? [], `${file}: ${name}`).toEqual([]);
      }
    }
  });
});
