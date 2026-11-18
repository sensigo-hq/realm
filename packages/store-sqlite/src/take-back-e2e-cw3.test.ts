// take-back-e2e-cw3.test.ts — issue #729, the claim window, unit CW-3b (design record C5 §4.4, its E2E
// cell): the engine's automatic take-back on the SQLite store with its real kernel leases. A program in
// a child process of its own (`node --input-type=module -e CLAIMANT`, importing the built package)
// opens the home, takes a lease, claims the run's step under it through the store's `claimStep`, prints
// `{ ready, pid, token }`, and waits until it is killed. While it runs, the take-back is refused
// (`lease_held`) and writes nothing; after it is killed (SIGKILL, by its pid), the step is taken back,
// with the take-back's entry.
//
// This file runs on CI's macOS job too (it runs every store-sqlite test file).
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { takeBackStep, type Attributed, type WorkflowDefinition } from '@sensigo/realm';
import { afterEach, describe, expect, it } from 'vitest';
import { openRealmHome } from './open-realm-home.js';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const INDEX = pathToFileURL(join(PACKAGE_ROOT, 'dist', 'index.js')).href;

const DEFINITION: WorkflowDefinition = {
  id: 'wf-take-back-e2e',
  name: 'take-back e2e',
  version: 1,
  steps: { work: { description: 'w', execution: 'agent', depends_on: [] } },
};
const HOLDER: Attributed = { by: 'claimant-program', by_source: 'stated', channel: 'agent' };
const TAKER: Attributed = { by: 'taker-program', by_source: 'stated', channel: 'agent' };

/** The claimant: opens the home, takes one lease, claims the step under it, says so, then waits. */
const CLAIMANT =
  `import { openRealmHome } from ${JSON.stringify(INDEX)};` +
  'const p = JSON.parse(process.env.CW3B_CLAIMANT);' +
  'const home = await openRealmHome({ home: p.home });' +
  'const r = await home.runStore.leases.hold();' +
  'if (r.held === undefined) { console.log(JSON.stringify({ ready: false, unavailable: r.unavailable })); process.exit(3); }' +
  // A module-level binding keeps the hold referenced for the program's whole life.
  'const held = r.held;' +
  'const { record } = await home.runStore.claimStep(p.runId, "work", p.definition, p.holder, held);' +
  'console.log(JSON.stringify({ ready: true, pid: process.pid, id: held.id, token: record.claims.work.token }));' +
  'process.stdin.resume();';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Starts the claimant in a child process; resolves with its pid, lease id, claim token and exit. */
function spawnClaimant(
  home: string,
  runId: string,
): Promise<{ pid: number; id: string; token: string; exited: Promise<void> }> {
  const child = spawn(process.execPath, ['--input-type=module', '-e', CLAIMANT], {
    env: {
      ...process.env,
      CW3B_CLAIMANT: JSON.stringify({ home, runId, definition: DEFINITION, holder: HOLDER }),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 120_000,
  });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    lines.once('line', (line) => {
      const ready = JSON.parse(line) as {
        ready: boolean;
        pid?: number;
        id?: string;
        token?: string;
      };
      if (
        !ready.ready ||
        ready.pid === undefined ||
        ready.id === undefined ||
        ready.token === undefined
      ) {
        reject(new Error(`the claimant could not claim the step: ${line}`));
      } else if (ready.pid === process.pid) {
        reject(new Error('wiring: the claimant is this process'));
      } else {
        resolve({ pid: ready.pid, id: ready.id, token: ready.token, exited });
      }
    });
    void exited.then(() =>
      reject(
        new Error(`the claimant ended before it was ready; its stderr: ${stderr.slice(0, 400)}`),
      ),
    );
  });
}

describe('#729 CW-3b — the take-back on a real kernel lease, held by a program in another process', () => {
  it(
    'while the claimant runs: not taken (lease_held) and nothing written; after it is killed: taken back, with its entry',
    { timeout: 120_000 },
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'realm-cw3b-e2e-'));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      const homeDir = join(root, 'home');
      const home = await openRealmHome({ home: homeDir });
      cleanups.push(() => home.close());
      const store = home.runStore;
      const { record: run } = await store.create({
        workflowId: DEFINITION.id,
        workflowVersion: 1,
        params: {},
      });
      const claimant = await spawnClaimant(homeDir, run.id);
      const before = (await store.get(run.id)).record;
      const claim = before.claims?.['work'];

      const whileHeld = await takeBackStep(store, run.id, 'work', {
        expectToken: claimant.token,
        drivenBy: TAKER,
      });
      const afterHeld = (await store.get(run.id)).record;
      // (1) red when the take-back removes a claim whose lease its program still holds, or writes
      //     anything while refusing; (2) prints the answer, the lease the claim names and the versions.
      expect({
        answer: whileHeld.kind === 'not_taken' ? `not_taken ${whileHeld.reason}` : whileHeld.kind,
        lease: claim?.lease?.id,
        version: afterHeld.version,
        inProgress: afterHeld.in_progress_steps,
      }).toEqual({
        answer: 'not_taken lease_held',
        lease: claimant.id,
        version: before.version,
        inProgress: ['work'],
      });

      process.kill(claimant.pid, 'SIGKILL');
      await claimant.exited;
      const afterKill = await takeBackStep(store, run.id, 'work', {
        expectToken: claimant.token,
        drivenBy: TAKER,
      });
      const taken = (await store.get(run.id)).record;
      const entry = taken.evidence.filter((e) => e.step_id === 'work').at(-1);
      const { token: _token, ...withoutToken } = claim ?? {};
      // (1) red when the step is not taken back once its program is gone, or its entry differs from
      //     the take-back's (the reason, the claim as it was without its token, the taker); (2) prints
      //     the answer, the step's state and the entry.
      expect({
        answer: afterKill.kind,
        inProgress: taken.in_progress_steps,
        claim: taken.claims?.['work'],
        entry: {
          reclaimed: entry?.output_summary['reclaimed'],
          reason: entry?.output_summary['reason'],
          prior_state: entry?.output_summary['prior_state'],
          prior_claim: entry?.output_summary['prior_claim'],
          conditions_discharged: entry?.output_summary['conditions_discharged'],
          driven_by: entry?.driven_by,
        },
      }).toEqual({
        answer: 'taken_back',
        inProgress: [],
        claim: undefined,
        entry: {
          reclaimed: true,
          reason: 'lease_not_held',
          prior_state: 'claim_stale',
          prior_claim: withoutToken,
          conditions_discharged: undefined,
          driven_by: TAKER,
        },
      });
    },
  );
});
