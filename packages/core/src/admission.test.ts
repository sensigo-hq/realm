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
    list: trap('list'),
    claimStep: trap('claimStep'),
    settleStep: trap('settleStep'),
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

/** The entries that take a registry and a driver; the other three take a store only. */
const FULL: readonly EngineEntry[] = [
  'executeStep',
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
      'registry_release_line',
      'driver_shape',
      'advance_caller',
    ]);
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
        'validateAdvanceCaller',
      ]) {
        expect(code.match(new RegExp(`\\b${name}\\(`, 'g')) ?? [], `${file}: ${name}`).toEqual([]);
      }
    }
  });
});
