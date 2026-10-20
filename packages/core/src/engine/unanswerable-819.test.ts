// unanswerable-819.test.ts — #819 (03): a run whose registered workflow cannot be read. #819
// correction 1 (01): the stuck-run command (U1) is out — the plain kill refuses every open question,
// as before #819; at a live question a copy that is gone reads `not_registered` whatever its id's
// shape, so its repair is `register` and no "created by an agent" is said (an agent's workflow has no
// gate). U5: outside a question, an agent's copy that is gone has no `register` way. U2, U3: the copy
// check's two new faults, each named with its repair.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: run
// and gate ids, causes and words — never a token or an environment.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '../store/json-file-store.js';
import { JsonWorkflowStore, getWorkflowForRun } from '../workflow/registrar.js';
import { WorkflowError } from '../types/workflow-error.js';
import type { RunRecord } from '../types/run-record.js';
import { DOOR_SERVES, composeWaysOn, narrowForDoor, type WaysContext } from './ways.js';
import { writtenSnapshot } from './snapshot.js';

/** An id the registrar reads as an agent's (`create_workflow`'s `<slug>-<16 hex>`). */
const AGENT_ID = 'triage-0123456789abcdef';
const GATE = {
  gate_id: 'g-1',
  step_name: 'approve',
  preview: {},
  choices: ['approve', 'reject'],
  opened_at: '2026-01-01T00:00:00.000Z',
};

let dir: string;
let runs: JsonFileStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'realm-819-'));
  runs = new JsonFileStore(join(dir, 'runs'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A run waiting at gate `g-1` of `workflowId`. */
async function atGate(workflowId = AGENT_ID): Promise<RunRecord> {
  const { run } = await runs.create({ workflowId, workflowVersion: 1, params: {} });
  return runs.update({ ...run, pending_gate: { ...GATE } });
}

const thrown = (p: Promise<unknown>) => p.then(() => undefined).catch((e: unknown) => e);

describe('#819 correction 1 (01) — at a live question, the repair is register, whatever the id', () => {
  const ctx = (definition: WaysContext['definition']): WaysContext => ({
    definition,
    enactor: { kind: 'observer' },
    store: {},
  });
  /** The ways each door lists for `run` with `definition` absent — the abandon and register ways,
   *  the respond way's remedy, and what keeps abandon back. */
  const listing = (run: RunRecord, definition: WaysContext['definition']) => {
    const composed = composeWaysOn(writtenSnapshot(run, new Date()), ctx(definition));
    const policy = (door: 'cli' | 'mcp') => ({
      door,
      serves: DOOR_SERVES[door],
      route: door,
      source: { kind: 'default' as const, ref: `the ${door} door` },
    });
    const cli = narrowForDoor(composed, policy('cli'));
    const way = (ws: readonly { verb: string; for?: readonly string[] }[]) =>
      ws
        .filter((w) => w.verb === 'abandon' || w.verb === 'register')
        .map((w) => `${w.verb} for ${(w.for ?? []).join(',')}`);
    return {
      cli: way(cli.ways),
      abandonHeld: composed.unavailable.filter((u) => u.verb === 'abandon').map((u) => u.code),
      remedies: composed.unavailable
        .filter((u) => u.verb === 'respond' || u.verb === 'advance')
        .map((u) => `${u.verb}: ${u.remedy.map((r) => r.verb).join(',')}`),
    };
  };

  it('getWorkflowForRun: a run at gate g-1 whose hex-suffixed workflow has no copy → not registered, the register way, never "created by an agent"', async () => {
    const workflows = new JsonWorkflowStore(join(dir, 'workflows'));
    const run = await atGate();
    const err = (await thrown(
      getWorkflowForRun(workflows, run, { retryVerb: 'answer the gate', verb: 'respond' }),
    )) as WorkflowError;
    // (a) red when the id's shape decides at a live question (the message then says the workflow
    //     was created by an agent, which no gate can be); (b) prints the remedy and the message.
    expect({ remedy: err.remedy, message: err.message }).toEqual({
      remedy: [{ verb: 'register', conditions: [], workflow_id: AGENT_ID, run_id: run.id }],
      message: `Workflow '${AGENT_ID}' is not registered in this workflow store, and the store does not know the file it came from, so no path to it is recorded. Register the workflow (realm workflow register <file>) and answer the gate.`,
    });
  });

  it("the listing: an agent's copy that is gone, at a live question → the register way, and abandon held by the open question; outside one (U5) → no register, the remedy is ending the run", async () => {
    const gated = await atGate();
    const { run: running } = await runs.create({
      workflowId: AGENT_ID,
      workflowVersion: 1,
      params: {},
    });
    const gone = { absent: 'agent_copy_gone' as const, workflow_id: AGENT_ID };
    // (a) red: `gated` when U5's live-gate arm comes back (no register way; the remedies end the
    //     run); `running` when U5 is reverted outside a question; (b) prints both listings.
    expect({ gated: listing(gated, gone), running: listing(running, gone) }).toEqual({
      gated: {
        cli: ['register for operator'],
        abandonHeld: ['question_open'],
        remedies: ['advance: register', 'respond: register'],
      },
      running: { cli: ['abandon for operator'], abandonHeld: [], remedies: ['advance: abandon'] },
    });
  });
});

describe('#819 U2, U3 — the copy check: no `steps` at the current format; no older shape without a schema_version', () => {
  let workflows: JsonWorkflowStore;
  let wfDir: string;
  beforeEach(() => {
    wfDir = join(dir, 'workflows');
    workflows = new JsonWorkflowStore(wfDir);
  });
  const plant = (id: string, copy: unknown) =>
    writeFile(join(wfDir, `${id}.json`), JSON.stringify(copy));
  const read = async (id: string) => {
    const e = (await thrown(workflows.get(id))) as WorkflowError | undefined;
    return e === undefined ? 'read' : `${e.code}: ${e.message}`;
  };

  it('U2: a current-format copy whose steps is not an object is damaged (`no_steps`), at get and in the listing — named with its repair; a newer one without steps reads newer', async () => {
    await plant('nosteps', { id: 'nosteps', name: 'nosteps', version: 1, schema_version: 1 });
    await plant('arraysteps', {
      id: 'arraysteps',
      name: 'a',
      version: 1,
      schema_version: 1,
      steps: [],
    });
    await plant('later', { id: 'later', name: 'later', version: 1, schema_version: 99 });
    const listed = (await workflows.listWithDiagnostics()).unreadable.find(
      (u) => u.file === 'nosteps.json',
    );
    // (a) red when the copy passes the check (every surface then hits a raw internal error, W's
    //     walk 1), the listing names no repair, or a newer copy is called damaged; (b) prints each.
    expect({
      nosteps: await read('nosteps'),
      arraysteps: await read('arraysteps'),
      later: (await read('later')).split(':')[0],
      listed: { class: listed?.class, reason: listed?.reason, repair: listed?.repair },
    }).toEqual({
      nosteps: `RESOURCE_FORMAT_INVALID: the registered copy of 'nosteps' is JSON but not a workflow object (its steps is not an object)`,
      arraysteps: `RESOURCE_FORMAT_INVALID: the registered copy of 'arraysteps' is JSON but not a workflow object (its steps is not an object)`,
      later: 'STATE_NEWER_FORMAT',
      listed: {
        class: 'parse',
        reason: `the registered copy of 'nosteps' is JSON but not a workflow object (its steps is not an object)`,
        repair: `re-register the workflow from its source (realm workflow register <path-to-workflow>); if it was never registered from a source, remove the file (rm ${join(wfDir, 'nosteps.json')}) instead`,
      },
    });
  });

  it("U3: a copy with no schema_version is the older cohort's only in its shape (a string name, a number version) — an id-only file is not a workflow", async () => {
    await plant('junk', { id: 'junk', a: 1 });
    await plant('cohort', { id: 'cohort', name: 'cohort', version: 3 });
    // (a) red when the shape is not read (the junk file reads "an older version of Realm"); (b)
    //     prints both.
    expect({ junk: await read('junk'), cohort: (await read('cohort')).split(':')[0] }).toEqual({
      junk: `RESOURCE_FORMAT_INVALID: the registered copy of 'junk' is JSON but not a workflow object (it has no schema_version, and is not the shape older versions of Realm wrote (a string name and a number version))`,
      cohort: 'STATE_LEGACY_FORMAT',
    });
  });
});
