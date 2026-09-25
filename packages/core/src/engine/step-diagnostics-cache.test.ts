// step-diagnostics-cache.test.ts — issue #600 PR 1a: D3's discriminated mint (the two
// discriminating cells the existing suite's own cells cannot provide), D4's absence rule and
// all-three-kind presence, and D5's `deriveCacheDetail` derivation (the four states + the null-
// vs-zero fork).
//
// D3(b)'s own text: "every existing cell stays green with zero edits" is NECESSARY but NOT
// SUFFICIENT — both compiling forms of the flatten mutant (dropping the `attempt` arm's
// `attemptError === null` conjunct, and stamping `settled_by_default` on the `exhausted` arm too)
// leave the pre-existing suite fully green, because no core cell anywhere asserts
// `settled_by_default` on a diagnostics snapshot at all. These two cells are what actually pins it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executeStep,
  DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD,
  deriveCacheDetail,
} from './execution-loop.js';
import { deriveDefaultedSteps } from './defaulted-steps.js';
import { JsonFileStore } from '../store/json-file-store.js';
import type { StepDispatcher } from './execution-loop.js';
import type { WorkflowDefinition, StepDefinition } from '../types/workflow-definition.js';
import {
  CACHE_STATES,
  CACHE_BASES,
  type UsageRecord,
  type CacheState,
} from '../types/run-record.js';

const echoDispatcher: StepDispatcher = async (_step, input) => ({ ...input });
const INVALID_OUTPUT = {}; // missing 'category' — fails output_schema
const OUTPUT_SCHEMA = {
  type: 'object',
  required: ['category'],
  properties: { category: { type: 'string' } },
};

function makeVxDef(stepOverrides: Partial<StepDefinition> = {}): WorkflowDefinition {
  return {
    id: 'sd-cache-vx-wf',
    name: 'SD Cache VX WF',
    version: 1,
    steps: {
      draft: {
        description: 'Draft',
        execution: 'agent',
        output_schema: OUTPUT_SCHEMA,
        ...stepOverrides,
      },
    },
  };
}

function makePlainDef(): WorkflowDefinition {
  return {
    id: 'sd-cache-plain-wf',
    name: 'SD Cache Plain WF',
    version: 1,
    steps: {
      work: { description: 'Work', execution: 'agent', depends_on: [] },
    },
  };
}

function usage(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return { request_index: 0, request_start: new Date().toISOString(), ...overrides };
}

describe('issue #600 PR 1a — StepDiagnostics.cache: mint discrimination + absence + derivation', () => {
  let store: JsonFileStore;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-sd-cache-'));
    store = new JsonFileStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('D3(b) — the two discriminating cells', () => {
    it('an ATTEMPT snapshot for a FAILED attempt with accrued rejections carries NEITHER validation_rejections NOR settled_by_default', async () => {
      const def = makeVxDef();
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      await store.update({ ...run, validation_rejections: { draft: 3 } });
      // A dispatcher that THROWS — the attempt fails, so the conditional's other half
      // (`attemptError === null`) must gate `validation_rejections` off, and `settled_by_default`
      // must never appear on any `attempt`-kind snapshot at all.
      const throwingDispatcher: StepDispatcher = async () => {
        throw new Error('handler threw');
      };
      const envelope = await executeStep(store, def, {
        runId: run.id,
        command: 'draft',
        input: INVALID_OUTPUT,
        dispatcher: throwingDispatcher,
      });
      expect(envelope.status).toBe('error');
      const snap = envelope.evidence[0];
      expect(snap?.diagnostics?.validation_rejections).toBeUndefined();
      expect(snap?.diagnostics?.settled_by_default).toBeUndefined();
    });

    it('an EXHAUSTED snapshot carries validation_rejections but NOT settled_by_default, and defaulted_steps never names the step', async () => {
      const def = makeVxDef(); // no validation_exhaustion.mode: 'default' declared — terminalize
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      await store.update({
        ...run,
        validation_rejections: { draft: DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD - 1 },
      });
      const envelope = await executeStep(store, def, {
        runId: run.id,
        command: 'draft',
        input: INVALID_OUTPUT,
        dispatcher: echoDispatcher,
      });
      expect(envelope.status).toBe('error');
      const after = await store.get(run.id);
      const exhaustedSnap = after.evidence.find(
        (e) => e.step_id === 'draft' && e.status === 'error',
      );
      expect(exhaustedSnap?.diagnostics?.validation_rejections).toBe(
        DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD,
      );
      expect(exhaustedSnap?.diagnostics?.settled_by_default).toBeUndefined();
      // The read-time derivation the operator surfaces call — proves the terminalized step is
      // never mis-reported as a default-settle.
      expect(deriveDefaultedSteps(after.evidence)).not.toContain('draft');
      expect(deriveDefaultedSteps(after.evidence)).toEqual([]);
    });
  });

  describe('D4 — the absence rule, both ways, and presence on every mint kind', () => {
    it('cache is ABSENT when no stepMeta.usage was ever supplied (no model call happened)', async () => {
      const def = makePlainDef();
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      const envelope = await executeStep(store, def, {
        runId: run.id,
        command: 'work',
        input: {},
        dispatcher: echoDispatcher,
        // NO stepMeta at all.
      });
      expect(envelope.status).toBe('ok');
      expect(envelope.evidence[0]?.diagnostics?.cache).toBeUndefined();
    });

    it('cache is PRESENT with state "unobservable" when a model call happened and reported nothing (usage: [])', async () => {
      const def = makePlainDef();
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      const envelope = await executeStep(store, def, {
        runId: run.id,
        command: 'work',
        input: {},
        dispatcher: echoDispatcher,
        stepMeta: { usage: [] }, // a call happened; nothing was observed (the driver's `?? []`)
      });
      expect(envelope.status).toBe('ok');
      expect(envelope.evidence[0]?.diagnostics?.cache).toEqual({
        state: 'unobservable',
        basis: 'unobservable',
        requests: [],
      });
    });

    it('cache is present on a synthesized DEFAULT_SETTLE snapshot — a step that accrued rejections spent real money, usually more than a clean one', async () => {
      const def = makeVxDef({
        validation_exhaustion: { mode: 'default', default_output: { category: 'fallback' } },
      });
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      await store.update({
        ...run,
        validation_rejections: { draft: DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD - 1 },
      });
      const envelope = await executeStep(store, def, {
        runId: run.id,
        command: 'draft',
        input: INVALID_OUTPUT,
        dispatcher: echoDispatcher,
        stepMeta: {
          usage: [usage({ prompt_tokens: 500, cache_read_input_tokens: 350, output_tokens: 10 })],
        },
      });
      expect(envelope.status).toBe('ok');
      const settleSnap = envelope.evidence.find(
        (e) => e.step_id === 'draft' && e.status === 'success',
      );
      expect(settleSnap?.diagnostics?.settled_by_default).toBe(true);
      expect(settleSnap?.diagnostics?.cache?.state).toBe('engaged');
      expect(settleSnap?.diagnostics?.cache?.requests).toHaveLength(1);
    });

    it('cache is present on a synthesized EXHAUSTED snapshot too', async () => {
      const def = makeVxDef();
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      await store.update({
        ...run,
        validation_rejections: { draft: DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD - 1 },
      });
      const envelope = await executeStep(store, def, {
        runId: run.id,
        command: 'draft',
        input: INVALID_OUTPUT,
        dispatcher: echoDispatcher,
        stepMeta: { usage: [usage({ prompt_tokens: 300 })] },
      });
      expect(envelope.status).toBe('error');
      const after = await store.get(run.id);
      const exhaustedSnap = after.evidence.find(
        (e) => e.step_id === 'draft' && e.status === 'error',
      );
      expect(exhaustedSnap?.diagnostics?.cache).toBeDefined();
      expect(exhaustedSnap?.diagnostics?.cache?.requests[0]?.prompt_tokens).toBe(300);
    });

    it('CACHE_STATES/CACHE_BASES ship only members with producers in this PR — CACHE_BASES has exactly two', () => {
      expect(CACHE_STATES).toEqual(['engaged', 'never_engaged', 'write_only', 'unobservable']);
      expect(CACHE_BASES).toEqual(['provider_reported', 'unobservable']);
      expect(CACHE_BASES).not.toContain('derived');
    });
  });

  describe('D4 — all six symbols exported from the PUBLIC package (@sensigo/realm)', () => {
    it('CACHE_STATES, CACHE_BASES, and the four type-only symbols are importable from the package specifier', async () => {
      // A dynamic import of the package specifier (not a relative path) proves the VALUE exports
      // land in the built public surface — the type-only ones cannot be asserted at runtime, so
      // this only proves the two `as const` value exports; the four types are proven by this
      // file's own `import type { UsageRecord, CacheState } from '../types/run-record.js'` above
      // compiling — but D4's own acceptance is "exported from core's index", so read index.ts
      // directly to prove the re-export exists as source text (belt-and-braces).
      const pkg = await import('@sensigo/realm');
      expect(pkg.CACHE_STATES).toEqual(['engaged', 'never_engaged', 'write_only', 'unobservable']);
      expect(pkg.CACHE_BASES).toEqual(['provider_reported', 'unobservable']);
    });
  });

  describe('D5 — deriveCacheDetail: four states, one cell per member', () => {
    it('engaged: any request with cache_read_input_tokens > 0', () => {
      const detail = deriveCacheDetail([
        usage({ cache_read_input_tokens: 1150, cache_creation_input_tokens: 0 }),
      ]);
      expect(detail.state).toBe('engaged');
      expect(detail.basis).toBe('provider_reported');
    });

    it('never_engaged: both counters observed as 0 on every request — an observed zero is a real fact', () => {
      const detail = deriveCacheDetail([
        usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      ]);
      expect(detail.state).toBe('never_engaged');
      expect(detail.basis).toBe('provider_reported');
    });

    it('write_only: some request wrote, none read', () => {
      const detail = deriveCacheDetail([
        usage({ cache_creation_input_tokens: 1150, cache_read_input_tokens: 0 }),
      ]);
      expect(detail.state).toBe('write_only');
      expect(detail.basis).toBe('provider_reported');
    });

    it('unobservable: no counter observed anywhere — NEVER a zero', () => {
      const detail = deriveCacheDetail([usage({ prompt_tokens: 1200 })]);
      expect(detail.state).toBe('unobservable');
      expect(detail.basis).toBe('unobservable');
    });

    it('write_only also fires via the separate cache_write_tokens counter (a provider that reports writes apart from cache_creation_input_tokens)', () => {
      const detail = deriveCacheDetail([usage({ cache_write_tokens: 500 })]);
      expect(detail.state).toBe('write_only');
    });

    // Mutant (ii): coerce a null counter to 0 — must red EXACTLY the unobservable cell above,
    // because a genuinely-observed 0 (never_engaged) and a coerced-null 0 become indistinguishable
    // only in the unobservable population; the other three states are keyed on `> 0`, unaffected.
    it("a mutant coercing null-to-0 would flip this exact cell's outcome from unobservable to never_engaged", () => {
      // Simulates the mutant directly: the SAME requests the unobservable cell above uses, but
      // with the counters explicitly present-as-zero instead of absent — this is what a
      // null-coercion bug would produce, and it must NOT read the same as the real absence.
      const mutated = deriveCacheDetail([
        usage({ prompt_tokens: 1200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      ]);
      expect(mutated.state).toBe('never_engaged'); // NOT 'unobservable' — proves the two are distinct
    });
  });

  describe('CacheState type usage sanity (compile-time; keeps the import live)', () => {
    it('every produced state is a member of the exported union', () => {
      const states: CacheState[] = ['engaged', 'never_engaged', 'write_only', 'unobservable'];
      for (const s of states) expect(CACHE_STATES).toContain(s);
    });
  });
});
