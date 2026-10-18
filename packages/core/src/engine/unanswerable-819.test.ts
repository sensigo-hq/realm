// unanswerable-819.test.ts — #819 (03): a run whose registered workflow cannot be read. U1: an open
// question that can NEVER be answered is ended by naming its gate (the CLI's `realm run abandon
// --gate`); every question that can still be answered keeps the refusal, with its answer or its
// copy's repair. U5: an agent's copy that is gone has no `register` way. U2, U3: the copy check's two
// new faults, each named with its repair.
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
import { abandonRun } from './abandon-run.js';
import {
  DEFINITION_ABSENCES,
  DOOR_SERVES,
  composeWaysOn,
  narrowForDoor,
  questionNeverAnswerable,
  type DefinitionAbsent,
  type WaysContext,
} from './ways.js';
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

describe('#819 U1 — the copies whose open question can never be answered', () => {
  it('per member: an agent copy that is gone; an unreadable, invalid or legacy copy whose recorded source is gone — never not registered, newer or not read', () => {
    const verdict = (source: boolean) =>
      Object.fromEntries(
        DEFINITION_ABSENCES.map((absent) => [
          absent,
          questionNeverAnswerable({
            absent,
            workflow_id: 'flow',
            ...(source ? { source_gone: '/srv/flow' } : {}),
          }),
        ]),
      );
    // (a) red per member when its mechanism is dropped — `agent_copy_gone` read as repairable; a
    //     copy that cannot be read read as never answerable with its source still there; and the
    //     exception applied to a repairable cause (`newer`, `not_registered`, `not_read`); (b)
    //     prints each member's verdict with and without the source gone.
    expect({ withSource: verdict(false), sourceGone: verdict(true) }).toEqual({
      withSource: {
        agent_copy_gone: true,
        not_registered: false,
        unreadable: false,
        format_invalid: false,
        legacy: false,
        not_read: false,
        newer: false,
      },
      sourceGone: {
        agent_copy_gone: true,
        not_registered: false,
        unreadable: true,
        format_invalid: true,
        legacy: true,
        not_read: false,
        newer: false,
      },
    });
  });
});

describe('#819 U1 — abandonRun ends a question that can never be answered, by its gate', () => {
  const GONE: DefinitionAbsent = { absent: 'agent_copy_gone', workflow_id: AGENT_ID };
  const SOURCE_GONE: DefinitionAbsent = {
    absent: 'format_invalid',
    workflow_id: 'flow',
    path: '/home/ops/.realm/workflows/flow.json',
    source_gone: '/srv/flow',
  };

  it('(a) and (b): `gate` naming the open gate ends the run — the reason names the cause, and `pending_gate` is gone', async () => {
    const a = await atGate();
    const b = await atGate('flow');
    const endedA = await abandonRun(runs, a.id, 'ops cleanup', { gate: 'g-1', absence: GONE });
    const endedB = await abandonRun(runs, b.id, 'ops cleanup', {
      gate: 'g-1',
      absence: SOURCE_GONE,
    });
    // (a) red when the refusal still stands for a question that can never be answered (W's walk
    //     2), the reason loses its cause, or the terminal record keeps its open question (the #282
    //     class); (b) prints the phase, the reason and whether the gate is still there.
    const view = (r: RunRecord) => ({
      phase: r.run_phase,
      reason: r.terminal_reason,
      gate: r.pending_gate !== undefined,
    });
    expect({ a: view(endedA), b: view(endedB), stored: view(await runs.get(a.id)) }).toEqual({
      a: {
        phase: 'abandoned',
        reason: `ops cleanup (its question could not be answered: workflow '${AGENT_ID}' was created by an agent (create_workflow) and its stored copy is gone; there is no source file to register)`,
        gate: false,
      },
      b: {
        phase: 'abandoned',
        reason:
          "ops cleanup (its question could not be answered: the stored copy of workflow 'flow' (/home/ops/.realm/workflows/flow.json) is not a valid workflow, and the folder it was registered from (/srv/flow) no longer exists)",
        gate: false,
      },
      stored: {
        phase: 'abandoned',
        reason: `ops cleanup (its question could not be answered: workflow '${AGENT_ID}' was created by an agent (create_workflow) and its stored copy is gone; there is no source file to register)`,
        gate: false,
      },
    });
  });

  it('without `gate`, or naming another gate: refused — the gate-named abandon is its way on', async () => {
    const run = await atGate();
    const none = (await thrown(abandonRun(runs, run.id, 'x', { absence: GONE }))) as WorkflowError;
    const other = (await thrown(
      abandonRun(runs, run.id, 'x', { gate: 'g-2', absence: GONE }),
    )) as WorkflowError;
    // (a) red when an unnamed gate is ended (the CLI only, by name), or the refusal names the
    //     answer for a question that can never be answered; (b) prints codes, messages, remedies.
    const view = (e: WorkflowError) => ({ code: e.code, message: e.message, remedy: e.remedy });
    const refusal = {
      code: 'STATE_TRANSITION_DENIED',
      message: `Run '${run.id}' is waiting on human gate 'approve' (gate 'g-1'), whose question can never be answered: workflow '${AGENT_ID}' was created by an agent (create_workflow) and its stored copy is gone; there is no source file to register.`,
      remedy: [{ verb: 'abandon', conditions: [], run_id: run.id, gate_id: 'g-1' }],
    };
    expect({
      none: view(none),
      other: view(other),
      still: (await runs.get(run.id)).run_phase,
    }).toEqual({ none: refusal, other: refusal, still: 'gate_waiting' });
  });

  it('a question that can still be answered keeps the refusal, even with its gate named — the repair, or the answer, as its way on', async () => {
    const run = await atGate('flow');
    const refuse = async (absence?: DefinitionAbsent) => {
      const e = (await thrown(
        abandonRun(runs, run.id, 'x', {
          gate: 'g-1',
          ...(absence !== undefined ? { absence } : {}),
        }),
      )) as WorkflowError;
      return { code: e.code, way: e.remedy?.[0]?.verb, message: e.message };
    };
    // (a) red when the exception reaches a cause that can be repaired — a newer copy (its Realm
    //     answers it) even with its source gone, a copy whose source is still there, a workflow not
    //     registered — or a readable definition (no absence: MCP's abandon_run); (b) prints each.
    const NOT_OPEN = `Run '${run.id}' is waiting on human gate 'approve' (gate 'g-1'); it cannot be abandoned while its question is open.`;
    expect({
      newer: await refuse({ absent: 'newer', workflow_id: 'flow', source_gone: '/srv/flow' }),
      sourceThere: await refuse({ absent: 'format_invalid', workflow_id: 'flow' }),
      notRegistered: await refuse({ absent: 'not_registered', workflow_id: 'flow' }),
      readable: await refuse(),
      still: (await runs.get(run.id)).run_phase,
    }).toEqual({
      newer: {
        code: 'STATE_TRANSITION_DENIED',
        way: 'register',
        message: `${NOT_OPEN} It can be answered once its workflow can be read: workflow 'flow' was registered by a later version of Realm, so this version would ignore requirements it cannot read, and the folder it was registered from (/srv/flow) no longer exists.`,
      },
      sourceThere: {
        code: 'STATE_TRANSITION_DENIED',
        way: 'register',
        message: `${NOT_OPEN} It can be answered once its workflow can be read: the stored copy of workflow 'flow' is not a valid workflow.`,
      },
      notRegistered: {
        code: 'STATE_TRANSITION_DENIED',
        way: 'register',
        message: `${NOT_OPEN} It can be answered once its workflow can be read: workflow 'flow' is not registered in this workflow store, and the store does not know the file it came from, so no path to it is recorded.`,
      },
      readable: { code: 'STATE_TRANSITION_DENIED', way: 'respond', message: NOT_OPEN },
      still: 'gate_waiting',
    });
  });
});

describe('#819 U1, U5 — the listing at a live gate whose definition is absent', () => {
  const ctx = (definition: DefinitionAbsent): WaysContext => ({
    definition,
    enactor: { kind: 'observer' },
    store: {},
  });
  const listing = async (definition: DefinitionAbsent) => {
    const run = await atGate(definition.workflow_id);
    const composed = composeWaysOn(writtenSnapshot(run, new Date()), ctx(definition));
    const policy = (door: 'cli' | 'mcp') => ({
      door,
      serves: DOOR_SERVES[door],
      route: door,
      source: { kind: 'default' as const, ref: `the ${door} door` },
    });
    const cli = narrowForDoor(composed, policy('cli'));
    const mcp = narrowForDoor(composed, policy('mcp'));
    const way = (ws: readonly { verb: string; gate_id?: string; for?: readonly string[] }[]) =>
      ws
        .filter((w) => w.verb === 'abandon' || w.verb === 'register')
        .map(
          (w) =>
            `${w.verb}${w.gate_id !== undefined ? ` --gate ${w.gate_id}` : ''} for ${(w.for ?? []).join(',')}`,
        );
    return {
      cli: way(cli.ways),
      mcp: way(mcp.ways),
      mcpListed: mcp.unavailable.filter((u) => u.verb === 'abandon').map((u) => u.code),
      respondRemedy: composed.unavailable
        .filter((u) => u.verb === 'respond')
        .flatMap((u) => u.remedy.map((r) => r.verb)),
    };
  };

  it("an agent copy that is gone: the gate-named abandon, the operator's alone; no register way anywhere (U5)", async () => {
    // (a) red when `register` is offered for a copy that never had a file (U5), the abandon way
    //     does not name the gate (U1), or it reaches the agent's door; (b) prints each door's ways.
    expect(await listing({ absent: 'agent_copy_gone', workflow_id: AGENT_ID })).toEqual({
      cli: ['abandon --gate g-1 for operator'],
      mcp: [],
      mcpListed: ['door_cannot_enact'],
      respondRemedy: ['abandon'],
    });
  });

  it('a copy that cannot be read whose recorded source is gone: the gate-named abandon beside the register way; one whose source is there: abandon still waits on the answer', async () => {
    // (a) red when the listing and the verb disagree — (b)'s abandon not offered, or a repairable
    //     copy's abandon offered; (b) prints each door's ways.
    expect({
      gone: await listing({
        absent: 'format_invalid',
        workflow_id: 'flow',
        path: '/x/flow.json',
        source_gone: '/srv/flow',
      }),
      there: await listing({ absent: 'format_invalid', workflow_id: 'flow', path: '/x/flow.json' }),
    }).toEqual({
      gone: {
        cli: ['register for operator', 'abandon --gate g-1 for operator'],
        mcp: [],
        mcpListed: ['door_cannot_enact'],
        respondRemedy: ['register'],
      },
      there: {
        cli: ['register for operator'],
        mcp: [],
        mcpListed: ['question_open'],
        respondRemedy: ['register'],
      },
    });
  });
});

describe('#819 U5 — getWorkflowForRun at a live gate: no register for a copy that never had a file', () => {
  it('an agent-created id with no copy → the gate-named abandon, never `register`', async () => {
    const workflows = new JsonWorkflowStore(join(dir, 'workflows'));
    const run = await atGate();
    const err = (await thrown(
      getWorkflowForRun(workflows, run, { retryVerb: 'respond again', verb: 'respond' }),
    )) as WorkflowError;
    // (a) red when `register` comes back beside "there is no source file to register"; (b) prints
    //     the remedy and the message.
    expect({ remedy: err.remedy, message: err.message }).toEqual({
      remedy: [{ verb: 'abandon', conditions: [], run_id: run.id, gate_id: 'g-1' }],
      message: `Workflow '${AGENT_ID}' not found — this run's workflow was created by an agent (create_workflow) and its stored copy is gone; there is no source file to register. This run is waiting on human gate 'approve', whose question can never be answered; end it by naming the gate: realm run abandon ${run.id} --gate g-1.`,
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
