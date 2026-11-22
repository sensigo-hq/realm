// deadline-cause-592f2.test.ts — Q1 (#592) unit f2 (prompt q1-f2-claim-deadline-cause.md) through the
// BUILT CLI and the MCP server: what a claim with no time limit says on each surface (check 3). The
// built `realm run inspect`'s Run Health line, one cell per producing branch of its parenthesis
// (`step_not_auto`, `finalizer_bearing`, `step_unknown`, `not_recorded`, a word another store wrote)
// and the lines that keep today's words (a stale claim; a deadline with a cause beside it);
// `get_run_state`'s `run_health[].evidence.deadline_absent`; and `realm run export`, which carries the
// record as stored. The helper, the writers and the readers are core's and testing's cells.
//
// Every cell runs on a TEST HOME (`createTestHome`): the clock is a file in the home, so the built
// `realm` child and the in-process store read the same instant. Every command is stopped after 60 s.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type ClaimRecord,
  type RunRecord,
  type StepDefinition,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { createRealmMcpServer } from '@sensigo/realm-mcp';
import { createTestHome, type TestHome } from '@sensigo/realm-testing';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const T0 = '2031-03-04T05:06:07.000Z';
const ago = (ms: number): string => new Date(Date.parse(T0) - ms).toISOString();
const HOUR = 3_600_000;

const step = (execution: StepDefinition['execution']): StepDefinition => ({
  description: 'S.',
  execution,
  depends_on: [],
});
const def = (id: string, steps: Record<string, StepDefinition>): WorkflowDefinition => ({
  id,
  name: id,
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps,
});
const AGENT = def('f2-agent', { work: step('agent') });
const FINALIZED = def('f2-finalized', { work: step('auto'), tidy: step('finalizer') });

let scratch: string;
let testHome: TestHome;
let h: TempHome;

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'realm-q1f2-'));
  testHome = await createTestHome({ start: T0, root: join(scratch, '.realm') });
  h = await makeTempHome({ home: testHome.root });
  for (const d of [AGENT, FINALIZED]) await h.home.workflowStore.register(d);
});

afterEach(async () => {
  await h.cleanup();
  await testHome.remove();
  rmSync(scratch, { recursive: true, force: true });
});

/** A `running` run of `d` with `stepName` in progress under `claim`. Returns its ID. */
async function plant(
  d: WorkflowDefinition,
  claim: Record<string, unknown>,
  stepName = 'work',
): Promise<string> {
  const id = randomUUID();
  await h.home.runStore.save({
    id,
    workflow_id: d.id,
    workflow_version: 1,
    run_phase: 'running',
    completed_steps: [],
    in_progress_steps: [stepName],
    failed_steps: [],
    skipped_steps: [],
    version: 1,
    params: {},
    evidence: [],
    claims: { [stepName]: claim as unknown as ClaimRecord },
    created_at: ago(2 * HOUR),
    updated_at: ago(HOUR),
    terminal_state: false,
  } as RunRecord);
  return id;
}

/** The built `realm` as a child process on the test home, with no colour. */
function realm(args: string[]): { code: number | null; out: string[]; err: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: scratch,
    env: { PATH: process.env['PATH'] ?? '', HOME: scratch, NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: r.status, out: r.stdout.split('\n').filter((l) => l !== ''), err: r.stderr };
}

/** `realm run inspect <id>`'s Run Health line for the claim on `stepName`. */
function claimLine(id: string, stepName = 'work'): string | undefined {
  return realm(['run', 'inspect', id]).out.find(
    (l) => /^ {2}(stale_claim|wedged_gate_sibling) \[/.test(l) && l.includes(`[${stepName}]`),
  );
}

interface Finding {
  kind: string;
  step?: string;
  evidence?: Record<string, unknown>;
}

/** `get_run_state`'s claim finding's evidence, through the MCP server on the same home. */
async function evidence(id: string): Promise<Record<string, unknown> | undefined> {
  const server = createRealmMcpServer({
    runStore: h.home.runStore,
    traceBufferStore: h.home.traceBufferStore,
    failedAttemptStore: h.home.failedAttemptStore,
    workflowStore: h.home.workflowStore,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'q1f2', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const raw = (await client.callTool({ name: 'get_run_state', arguments: { run_id: id } })) as {
      content: Array<{ text: string }>;
    };
    const reply = JSON.parse(raw.content[0]!.text) as { run_health?: Finding[] };
    return reply.run_health?.find((f) => f.kind === 'stale_claim')?.evidence;
  } finally {
    await client.close();
  }
}

describe('Q1 (#592) unit f2 — check 3: realm run inspect says why (the built realm)', () => {
  it('the five parentheses, one per producing branch', async () => {
    const agent = await plant(AGENT, { deadline: null, deadline_absent: 'step_not_auto' });
    const fin = await plant(FINALIZED, { deadline: null, deadline_absent: 'finalizer_bearing' });
    const ghost = await plant(AGENT, { deadline: null, deadline_absent: 'step_unknown' }, 'ghost');
    const preF2 = await plant(AGENT, { deadline: null });
    const foreign = await plant(AGENT, { deadline: null, deadline_absent: 'whatever' });
    // (a) red when a parenthesis is absent, a word reads as another's, the reader guesses a cause for
    //     a claim without one, or a word another store wrote is replaced; (b) prints each line.
    expect({
      agent: claimLine(agent),
      fin: claimLine(fin),
      ghost: claimLine(ghost, 'ghost'),
      preF2: claimLine(preF2),
      foreign: claimLine(foreign),
    }).toEqual({
      agent: '  stale_claim [work]: claim_unknown_age (no time limit: the step is an agent step)',
      fin: '  stale_claim [work]: claim_unknown_age (no time limit: the workflow has finalizers)',
      ghost:
        '  stale_claim [ghost]: claim_unknown_age (no time limit: the step is not in the workflow)',
      preF2: '  stale_claim [work]: claim_unknown_age (no time limit; the cause was not recorded)',
      foreign:
        "  stale_claim [work]: claim_unknown_age (no time limit: the cause 'whatever' is not one Realm knows)",
    });
  }, 180_000);

  it('a stale claim keeps today’s line; a past deadline with a cause beside it is judged by the deadline and says no cause; a stored word with a control character is escaped', async () => {
    const stale = await plant(AGENT, { deadline: ago(60_000) });
    const both = await plant(AGENT, { deadline: ago(60_000), deadline_absent: 'step_not_auto' });
    const escaped = await plant(AGENT, { deadline: null, deadline_absent: 'bad\u001b[2Jword' });
    // (a) red when the claim_stale line changes, a cause is read beside a deadline, or a control
    //     character in a stored word reaches the terminal raw; (b) prints each line.
    expect({
      stale: claimLine(stale),
      both: claimLine(both),
      escaped: claimLine(escaped),
    }).toEqual({
      stale: '  stale_claim [work]: claim_stale',
      both: '  stale_claim [work]: claim_stale',
      escaped:
        "  stale_claim [work]: claim_unknown_age (no time limit: the cause 'bad\\u001b[2Jword' is not one Realm knows)",
    });
  }, 180_000);
});

describe('Q1 (#592) unit f2 — check 3: get_run_state and realm run export', () => {
  it('get_run_state’s evidence: the recorded word, not_recorded for a claim without one, a foreign word as written, no cause beside a deadline', async () => {
    const recorded = await plant(AGENT, { deadline: null, deadline_absent: 'step_not_auto' });
    const preF2 = await plant(AGENT, { deadline: null });
    const foreign = await plant(AGENT, { deadline: null, deadline_absent: 'whatever' });
    const both = await plant(AGENT, { deadline: ago(60_000), deadline_absent: 'step_not_auto' });
    // (a) red when the reply drops the cause, guesses one, replaces a foreign word, or carries a cause
    //     beside a deadline; (b) prints each evidence.
    expect({
      recorded: await evidence(recorded),
      preF2: await evidence(preF2),
      foreign: await evidence(foreign),
      both: await evidence(both),
    }).toEqual({
      recorded: { state: 'claim_unknown_age', deadline: null, deadline_absent: 'step_not_auto' },
      preF2: { state: 'claim_unknown_age', deadline: null, deadline_absent: 'not_recorded' },
      foreign: { state: 'claim_unknown_age', deadline: null, deadline_absent: 'whatever' },
      both: { state: 'claim_stale', deadline: ago(60_000) },
    });
  }, 60_000);

  it('realm run export carries the claim as stored: the cause, and a deadline with a cause beside it both kept', async () => {
    const recorded = await plant(AGENT, { deadline: null, deadline_absent: 'step_not_auto' });
    const both = await plant(AGENT, { deadline: ago(60_000), deadline_absent: 'step_not_auto' });
    const exported = (id: string) => {
      const out = join(scratch, `${id}.realm.json`);
      // The planted run has no project, so its masking is partial: the flag says to write it anyway.
      const r = realm(['run', 'export', id, '--out', out, '--accept-partial-disclosure']);
      if (r.code !== 0) throw new Error(`export failed: ${r.err}`);
      const bundle = JSON.parse(readFileSync(out, 'utf8')) as { run: RunRecord };
      const claim = bundle.run.claims?.['work'];
      return { deadline: claim?.deadline, deadline_absent: claim?.deadline_absent };
    };
    // (a) red when the export drops the field or "corrects" a stored pair; (b) prints both claims.
    expect({ recorded: exported(recorded), both: exported(both) }).toEqual({
      recorded: { deadline: null, deadline_absent: 'step_not_auto' },
      both: { deadline: ago(60_000), deadline_absent: 'step_not_auto' },
    });
  }, 180_000);
});

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const RECORD = 'docs/reference/run-record-and-export.md';
const HEALTH = 'docs/reference/mcp/run-state-and-health.md';
const TESTING = 'docs/reference/testing-package.md';
const CHANGELOG = 'CHANGELOG.md';
const flat = (t: string): string => t.replace(/\s+/g, ' ');
/** (a) red when the page no longer holds the text word for word; (b) prints the text. */
function claim(page: string, text: string): void {
  expect(flat(readFileSync(join(ROOT, page), 'utf8')), `${page} no longer says: ${text}`).toContain(
    flat(text),
  );
}

describe('Q1 (#592) unit f2 — check 6: the words, each held to its page', () => {
  it('6. the deadline row', () => {
    // (a) red when a word of it changes on the page; (b) prints the text.
    claim(
      RECORD,
      "| `deadline` | When the claim's time runs out, or `null` when Realm set no time limit for the step; `deadline_absent` then says why. See [`realm run reclaim`](cli/realm-run-acting.md#reclaim). |",
    );
  });
  it('6. the deadline_absent row', () => {
    // (a) red when a word of it changes on the page; (b) prints the text.
    claim(
      RECORD,
      "| `deadline_absent` | Why there is no time limit, written when the claim was taken: `step_not_auto` (the step is an agent step, whose time Realm cannot bound; guards and finalizers are never claimed) or `finalizer_bearing` (the workflow has finalizer steps, so the claim may be held through the run's ending). Present only when `deadline` is `null`. A claim written before this field was added (after version 0.50.0), or by a store that does not write it, has no such field, and Realm reads it as `not_recorded`, never as a guessed cause; a word another store wrote is kept as written. Added after version 0.50.0. |",
    );
  });
  it('6. the evidence sentence', () => {
    // (a) red when a word of it changes on the page; (b) prints the text.
    claim(
      HEALTH,
      '`evidence.deadline_absent` then says why there is no time limit — `step_not_auto`, `finalizer_bearing`, `not_recorded` for a claim written before this field was added or by a store that does not write it, or the word another store wrote (added after version 0.50.0).',
    );
  });
  it('6. the law row', () => {
    // (a) red when a word of it changes on the page; (b) prints the text.
    claim(
      TESTING,
      '| `CLAIM_KEEPS_DEADLINE_CAUSE` | On a store that keeps claims, a claim on a step Realm cannot time-box reads back with `deadline: null` and why, `deadline_absent`: `step_not_auto` for an agent step, `finalizer_bearing` for an `auto` step of a workflow with finalizer steps; a claim with a string deadline reads back with no `deadline_absent`. The law makes its own three workflows, and is skipped for a store that keeps no claims. Added after version 0.50.0. |',
    );
  });
  it('6. the CHANGELOG line', () => {
    // (a) red when a word of it changes on the page; (b) prints the text.
    claim(
      CHANGELOG,
      "- **A claim with no time limit now says why.** When Realm takes a claim on a step it cannot time-box — an agent step, or an `auto` step of a workflow with finalizers — it writes the reason on the claim (`ClaimRecord` gains `deadline_absent`: `step_not_auto` or `finalizer_bearing`); `get_run_state`'s health evidence, `realm run inspect` and the exported record carry it, and a claim written before this release reads as `not_recorded`. Library: `claimDeadlineOf` returns the deadline with its cause (`ClaimDeadlineAbsent`, `CLAIM_DEADLINE_ABSENT_CAUSES`) and, as `computeClaimDeadline` does, takes the time as a parameter `now`; `computeClaimDeadline` is unchanged. Stores: the new fidelity law `CLAIM_KEEPS_DEADLINE_CAUSE`.",
    );
  });
});
