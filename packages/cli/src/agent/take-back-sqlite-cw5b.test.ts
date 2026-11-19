// take-back-sqlite-cw5b.test.ts — #729 CW-5b, check 9: on a real SQLite home, a drive killed mid-step
// leaves a claim whose kernel lease no program holds, and the built `realm agent` takes the step back
// once and runs it.
//
// The killed drive is a child process (`node --input-type=module -e HOLDER`, the built packages): it
// opens the home, takes the step through `claimStepForDrive` under the home's real lease, says so, and
// waits until it is SIGKILLed by its PID, so its lease file stays with no program holding it. The
// built `realm agent --run-id <run>`, named through REALM_OPERATOR, then drives the run with a provider
// module whose model answers `{ ok: true }`.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it: (1) the
// change that turns it red; (2) what it prints when it fails.
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  leaseFactOf,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../../..');
const CLI = join(HERE, '../../dist/index.js');
const LLM_PROVIDER = join(HERE, '../../dist/agent/providers/llm-provider.js');
const CORE = pathToFileURL(join(ROOT, 'packages/core/dist/index.js')).href;
const SQLITE = pathToFileURL(join(ROOT, 'packages/store-sqlite/dist/index.js')).href;

/** `s`, an agent step not declared idempotent. */
const DEF: WorkflowDefinition = {
  id: 'take-back-sqlite-cw5b',
  name: 'take-back-sqlite-cw5b',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: { s: { description: 'Answer this step.', execution: 'agent', depends_on: [] } },
} as WorkflowDefinition;
const KILLED = { by: 'killed-drive', by_source: 'stated', channel: 'agent' } as const;
const OPERATOR = 'cw5b-operator';

/** The killed drive: takes `s` under the home's lease, says so, then waits to be killed. */
const HOLDER =
  `import { claimStepForDrive, createDefaultRegistry } from ${JSON.stringify(CORE)};` +
  `import { openRealmHome } from ${JSON.stringify(SQLITE)};` +
  'const p = JSON.parse(process.env.CW5B_HOLDER);' +
  'const home = await openRealmHome({ home: p.home });' +
  "const answer = await claimStepForDrive(home.runStore, p.runId, 's', { definition: p.definition, registry: createDefaultRegistry(), driver: p.driver });" +
  "if (answer.kind !== 'claimed') { console.log(JSON.stringify({ ready: false, answer })); process.exit(3); }" +
  // A module-level binding keeps the hold referenced for the program's whole life.
  'const hold = answer.hold;' +
  'console.log(JSON.stringify({ ready: true, pid: process.pid, lease: hold.id }));' +
  'process.stdin.resume();';

let h: TempHome & { readonly root: string };
let project: string;
afterEach(async () => {
  await h.cleanup();
  rmSync(project, { recursive: true, force: true });
});

/** Starts the holder on the home; resolves once it holds the step, with its pid and its exit. */
function spawnHolder(runId: string): Promise<{ pid: number; exited: Promise<void> }> {
  const child = spawn(process.execPath, ['--input-type=module', '-e', HOLDER], {
    env: {
      ...process.env,
      CW5B_HOLDER: JSON.stringify({ home: h.path, runId, definition: DEF, driver: KILLED }),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 120_000,
  });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
  return new Promise((resolve, reject) => {
    createInterface({ input: child.stdout }).once('line', (line) => {
      const ready = JSON.parse(line) as { ready: boolean; pid?: number };
      if (!ready.ready || ready.pid === undefined || ready.pid === process.pid) {
        child.kill('SIGKILL');
        reject(new Error(`fixture: the holder did not take the step: ${line}`));
      } else resolve({ pid: ready.pid, exited });
    });
    void exited.then(() =>
      reject(new Error(`fixture: the holder ended before it was ready: ${stderr.slice(0, 400)}`)),
    );
  });
}

describe('#729 CW-5b check 9 — a real kernel lease, its drive killed', () => {
  it('the built realm agent prints line (i) and no waiting line, runs the step and completes it; the take-back entry names it', async () => {
    h = await makeTempHome();
    project = realpathSync(mkdtempSync(join(tmpdir(), 'realm-cw5b-project-')));
    await h.home.workflowStore.register(DEF);
    const { record } = await h.home.runStore.create({
      workflowId: DEF.id,
      workflowVersion: 1,
      params: {},
    });
    const holder = await spawnHolder(record.id);
    const read = async () => {
      const snap = await h.home.runStore.get(record.id);
      return {
        claim: snap.record.claims?.['s'],
        lease: leaseFactOf(snap, snap.record.claims?.['s']),
      };
    };
    const live = await read();
    process.kill(holder.pid, 'SIGKILL');
    await holder.exited;
    const killed = await read();
    // Grounding, not acceptance: the child held the claim's lease, and after its kill no program does.
    expect({ live: live.lease, killed: killed.lease, token: killed.claim?.token }).toEqual({
      live: { state: 'held', basis: 'kernel_lock' },
      killed: { state: 'not_held', basis: 'kernel_lock' },
      token: live.claim?.token,
    });
    writeFileSync(
      join(project, 'p.mjs'),
      `import { LlmProvider } from ${JSON.stringify(pathToFileURL(LLM_PROVIDER).href)};\n` +
        'export default new (class extends LlmProvider { async callStep() { return { ok: true }; } })();\n',
    );
    const r = spawnSync(
      process.execPath,
      [CLI, 'agent', '--run-id', record.id, '--provider-module', './p.mjs'],
      {
        cwd: project,
        env: {
          PATH: process.env['PATH'] ?? '',
          HOME: h.root,
          NO_COLOR: '1',
          REALM_NO_NUDGE: '1',
          REALM_OPERATOR: OPERATOR,
        },
        encoding: 'utf8',
        timeout: 90_000,
      },
    );
    const out = r.stdout.split('\n');
    const after = (await h.home.runStore.get(record.id)).record;
    const entries = after.evidence.filter((e) => e.output_summary?.['reason'] === 'lease_not_held');
    const back = out.findIndex((l) => l.startsWith("• Step 's' was taken by killed-drive"));
    // (1) red when the watch checks the lease only after an unchanged watch (a waiting line first,
    //     and the take-back after 60 s), or takes nothing back; (2) prints the exit, the output and
    //     the take-back entries.
    expect(
      {
        code: r.status,
        line: out[back],
        waitingBefore: out.slice(0, Math.max(back, 0)).filter((l) => l.includes('Waiting up to')),
        ranHere: out.slice(back).some((l) => l.includes('→ [agent] s')),
        entries: entries.map((e) => e.driven_by),
        completed: after.completed_steps,
      },
      `${r.stdout}\n${r.stderr}`,
    ).toEqual({
      code: 0,
      line: `• Step 's' was taken by killed-drive (as stated, via agent) at ${killed.claim?.since}; no program held the claim's lease when it was checked, so this drive took it back (this step's one automatic take-back until a person reclaims it). Its model and tools run here, so any side effects of the first program's calls may repeat.`,
      waitingBefore: [],
      ranHere: true,
      entries: [{ by: OPERATOR, by_source: 'ambient', channel: 'agent' }],
      completed: ['s'],
    });
  }, 150_000);
});
