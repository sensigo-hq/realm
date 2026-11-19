// take-back-cw3b.test.ts — issue #729, the claim window, unit CW-3b (check 1): core's cells for the
// conditions of `takeBackStep` that the published take-back laws (@sensigo/realm-testing's
// `takeBackContract`) do not hold — a claim with another token or none, a run that ended, a step not in
// progress — on `InMemoryStore` with the lease double, each claim's lease not held, so that each
// condition alone stops the take-back. And the source witness behind the CHANGELOG's "`realm agent`'s
// watch uses it" (#729 CW-5b): its one caller in Realm's commands.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { InMemoryStore, createLeaseDouble, type LeaseDouble } from '@sensigo/realm-testing';
import { takeBackStep } from './reclaim-step.js';
import type { RunStore } from '../store/store-interface.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { Attributed } from './holder.js';

const DEF: WorkflowDefinition = {
  id: 'w-take-back',
  name: 'w',
  version: 1,
  steps: { a: { description: 'a', execution: 'agent', depends_on: [] } },
};
const TAKER: Attributed = { by: 'taker', by_source: 'stated', channel: 'agent' };

/** A run with step `a` claimed under a lease no program holds; the store, the run and the token. */
async function notHeld(): Promise<{
  store: RunStore;
  leases: LeaseDouble;
  runId: string;
  token: string;
}> {
  const leases = createLeaseDouble();
  const store = new InMemoryStore({ leases });
  const { record: run } = await store.create({
    workflowId: DEF.id,
    workflowVersion: 1,
    params: {},
  });
  const made = await leases.hold();
  if (!('held' in made)) throw new Error('fixture: the double made no lease');
  const { record } = await store.claimStep(run.id, 'a', DEF, undefined, made.held);
  leases.set(made.held.id, 'dead');
  return { store, leases, runId: run.id, token: record.claims!['a']!.token! };
}

/** What the take-back answered, and whether the run's version moved. */
async function answered(store: RunStore, runId: string, token: string) {
  const before = (await store.get(runId)).record.version;
  const answer = await takeBackStep(store, runId, 'a', { expectToken: token, drivenBy: TAKER });
  return {
    answer: answer.kind === 'not_taken' ? `not_taken ${answer.reason}` : answer.kind,
    moved: (await store.get(runId)).record.version !== before,
  };
}

describe('#729 CW-3b — check 1: the conditions the take-back laws do not hold', () => {
  it('a claim with another token: changed, nothing removed', async () => {
    const { store, runId } = await notHeld();
    // (1) red when the token is not compared (the claim the caller did not read is taken back);
    //     (2) prints the answer and whether the run moved.
    expect(await answered(store, runId, 'another-token')).toEqual({
      answer: 'changed',
      moved: false,
    });
  });

  it('a claim with no token: changed, nothing removed', async () => {
    const { store, runId, token } = await notHeld();
    const { record } = await store.get(runId);
    const { token: _token, ...noToken } = record.claims!['a']!;
    await store.update({ ...record, claims: { a: noToken } });
    // (1) red when a claim with no token passes the token check; (2) prints the answer and whether
    //     the run moved.
    expect(await answered(store, runId, token)).toEqual({ answer: 'changed', moved: false });
  });

  it('a run that ended with the step still in progress under its leased claim: run_ended', async () => {
    const { store, runId, token } = await notHeld();
    const { record } = await store.get(runId);
    // A terminal record that still lists the step in progress with its claim (a guard's abort while
    // the step was held), not an abandoned run, whose claims are cleared.
    await store.update({
      ...record,
      terminal_state: true,
      terminal_reason: 'Not approved.',
      aborted_at: { step_id: 'g' },
      sealed_by: { arm: 'guard_abort', step: 'g' },
    });
    // (1) red when an ended run's claim is taken back; (2) prints the answer and whether the run
    //     moved.
    expect(await answered(store, runId, token)).toEqual({
      answer: 'not_taken run_ended',
      moved: false,
    });
  });

  it('a step not in progress: not_in_progress', async () => {
    const leases = createLeaseDouble();
    const store = new InMemoryStore({ leases });
    const { record: run } = await store.create({
      workflowId: DEF.id,
      workflowVersion: 1,
      params: {},
    });
    // (1) red when a step with no claim is not answered not_in_progress (a removal, or a changed);
    //     (2) prints the answer and whether the run moved.
    expect(await answered(store, run.id, 'any-token')).toEqual({
      answer: 'not_taken not_in_progress',
      moved: false,
    });
  });
});

describe('#729 CW-3b — item 3: a second write race is thrown', () => {
  it('another write before each of the take-back’s writes: STATE_SNAPSHOT_MISMATCH is thrown, and the claim stays', async () => {
    const { store, runId, token } = await notHeld();
    // Every `update` the take-back makes meets another write first (the run's own record written
    // again, which moves its version).
    const racing = new Proxy(store, {
      get(target, prop) {
        if (prop === 'update') {
          return async (record: Parameters<RunStore['update']>[0]) => {
            await target.update((await target.get(runId)).record);
            return target.update(record);
          };
        }
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    const thrown = await takeBackStep(racing, runId, 'a', {
      expectToken: token,
      drivenBy: TAKER,
    }).then(
      () => 'nothing',
      (err: { code?: string }) => err.code,
    );
    const read = (await store.get(runId)).record;
    // (1) red when the take-back retries again after its re-read (a loop), or answers instead of
    //     throwing; (2) prints what was thrown and the step's claim.
    expect({
      thrown,
      inProgress: read.in_progress_steps,
      token: read.claims?.['a']?.token,
    }).toEqual({
      thrown: 'STATE_SNAPSHOT_MISMATCH',
      inProgress: ['a'],
      token,
    });
  });
});

describe('#729 CW-3b, CW-5b — the CHANGELOG’s "`realm agent`’s watch uses it"', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const PACKAGES = join(HERE, '..', '..', '..');
  const productionFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory())
        return e.name === 'node_modules' || e.name === 'dist' ? [] : productionFiles(p);
      return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
    });

  it('the production files outside the function’s own file that call takeBackStep: realm agent’s watch and the published law family', () => {
    const callers = readdirSync(PACKAGES)
      .flatMap((pkg) => {
        const src = join(PACKAGES, pkg, 'src');
        try {
          return productionFiles(src);
        } catch {
          return [];
        }
      })
      .filter((f) => {
        const code = readFileSync(f, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '')
          .replace(/export async function takeBackStep\(/g, '');
        return /\btakeBackStep\(/.test(code);
      })
      .map((f) => relative(PACKAGES, f).split(sep).join('/'))
      .filter((f) => f !== 'core/src/engine/reclaim-step.ts');
    // (1) red when a command, a door or any other production file starts calling the take-back, or
    //     `realm agent`'s watch stops calling it (the CHANGELOG then says something false); the
    //     testing package's law family is the other caller, the laws a store keeps. (2) prints the
    //     callers.
    expect(callers.sort()).toEqual([
      'cli/src/agent/run-agent.ts',
      'testing/src/store/take-back-contract.ts',
    ]);
  });
});
