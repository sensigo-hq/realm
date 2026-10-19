// abandon-819.test.ts — #819 correction 1 (01) on the CLI door. The stuck-run command (U1) is out:
// `realm run abandon` refuses every run waiting at a question, as before #819. When the run's
// workflow cannot be read, the refusal names that copy's repair — read once, after core refused —
// in place of the answer it cannot take yet; the record is not touched. A run at a gate whose
// hex-suffixed workflow has no copy reads `not_registered` on every CLI surface (abandon, respond,
// inspect's Run Health), never "created by an agent". 02 C2: an empty or blank `--reason` is
// refused, as an empty flag is at the MCP door's start.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: run
// and gate ids, file names, printed lines — never a token or an environment.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { abandonCommand, emptyReasonRefusal } from './abandon.js';
import { respondCommand } from './respond.js';
import { inspectRun } from './inspect.js';

/** An id the registrar's shape test reads as an agent's (`<slug>-<16 hex>`): here a person's. */
const HEX_ID = 'ops-review-0123456789abcdef';
const GATE = {
  gate_id: 'g-1',
  step_name: 'approve',
  preview: {},
  choices: ['ship', 'hold'],
  opened_at: '2026-01-01T00:00:00.000Z',
};
const AGENT_WORDS = 'created by an agent';

describe('#819 correction 1 (01) — realm run abandon at an open question', () => {
  let home: string;
  let wfDir: string;
  let runsDir: string;
  let originalHome: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'realm-abandon-819c1-'));
    wfDir = join(home, '.realm', 'workflows');
    runsDir = join(home, '.realm', 'runs');
    await mkdir(runsDir, { recursive: true });
    await mkdir(wfDir, { recursive: true });
    originalHome = process.env['HOME'];
    process.env['HOME'] = home;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
    await rm(home, { recursive: true, force: true });
  });

  /** A run of `workflowId` waiting at gate `g-1`; its registered copy written as `copy`, if given. */
  async function atGate(workflowId: string, copy?: string) {
    if (copy !== undefined) await writeFile(join(wfDir, `${workflowId}.json`), copy);
    const { JsonFileStore } = await import('@sensigo/realm');
    const store = new JsonFileStore();
    const { run } = await store.create({ workflowId, workflowVersion: 1, params: {} });
    await store.update({ ...run, pending_gate: { ...GATE } });
    return { store, id: run.id };
  }
  /** `realm run abandon <args>`: whether it exited 1, what it printed, and whether the run's file
   *  is byte for byte what it was. */
  async function abandon(id: string, ...args: string[]) {
    const file = join(runsDir, `${id}.json`);
    const before = await readFile(file);
    errSpy.mockClear();
    const failed = await abandonCommand.parseAsync([id, ...args], { from: 'user' }).then(
      () => false,
      () => true,
    );
    return {
      failed,
      err: errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n'),
      unchanged: before.equals(await readFile(file)),
    };
  }
  const NOT_OPEN = (id: string) =>
    `Run '${id}' is waiting on human gate 'approve' (gate 'g-1'); it cannot be abandoned while its question is open.`;
  const REPAIR =
    'Its workflow cannot be read, so the question cannot be answered until it is repaired. Repair it:';
  /** A copy at the current format, as a file registration writes it, with `over` changed. */
  const copyOf = (id: string, over: Record<string, unknown>, drop: string[] = []) => {
    const base: Record<string, unknown> = {
      id,
      name: id,
      version: 1,
      schema_version: 1,
      steps: { approve: { execution: 'auto', trust: 'human_confirmed' } },
      source_dir: join(home, 'gone'),
      ...over,
    };
    for (const k of drop) delete base[k];
    return JSON.stringify(base);
  };

  it('A1: a gate whose workflow can be read is refused with its answer line, as before #819', async () => {
    // a readable copy: the captured shape of a registered gate workflow, its source kept
    const { id } = await atGate('plain-gate', copyOf('plain-gate', { source_dir: home }));
    // (a) red when a readable workflow's refusal names a repair, or the record changes; (b) prints
    //     the outcome.
    expect(await abandon(id)).toEqual({
      failed: true,
      err: `${NOT_OPEN(id)} Answer it: realm run respond ${id} --gate g-1 --choice <one of: ship, hold>`,
      unchanged: true,
    });
  });

  it('the walk cases whose workflow cannot be read — A4f, A6b, A6c, B1, and the repairable causes — are each refused with their repair; the record is unchanged', async () => {
    const run = async (workflowId: string, copy?: string) => {
      const { id } = await atGate(workflowId, copy);
      const out = await abandon(id);
      return {
        failed: out.failed,
        unchanged: out.unchanged,
        tail: out.err.startsWith(NOT_OPEN(id)) ? out.err.slice(NOT_OPEN(id).length + 1) : out.err,
      };
    };
    const refused = (tail: string) => ({
      failed: true,
      unchanged: true,
      tail: `${REPAIR} ${tail}`,
    });
    // (a) red when the catch arm's read is removed (each prints the answer line, which cannot be
    //     taken until the copy reads), the run is ended, or the record is touched; (b) prints each.
    expect({
      // walk A4f: valid JSON with no steps, the folder it was registered from gone
      A4f: await run('a4f', copyOf('a4f', {}, ['steps'])),
      // walk A6b: the copy's schema_version removed, its source folder gone
      A6b: await run('a6b', copyOf('a6b', {}, ['schema_version'])),
      // walk A6c: schema_version "1", a string
      A6c: await run('a6c', copyOf('a6c', { schema_version: '1' })),
      // walk B1: a person-registered hex-suffixed id, its copy removed (the source kept elsewhere)
      B1: await run(HEX_ID),
      newer: await run('later', copyOf('later', { schema_version: 99 })),
      notJson: await run('broken', '{"id": "broken", "sou'),
    }).toEqual({
      A4f: refused('realm workflow validate --registered a4f'),
      A6b: refused('realm workflow validate --registered a6b'),
      A6c: refused('realm workflow validate --registered a6c'),
      B1: refused('realm workflow register <file>'),
      newer: refused('realm workflow validate --registered later'),
      notJson: refused('realm workflow validate --registered broken'),
    });
  });

  it('B1: a hex-suffixed workflow with no copy, at a live question — no CLI surface says it was created by an agent', async () => {
    const { JsonFileStore, JsonWorkflowStore } = await import('@sensigo/realm');
    const { id } = await atGate(HEX_ID);
    const refusal = (await abandon(id)).err;
    errSpy.mockClear();
    await respondCommand
      .parseAsync([id, '--gate', 'g-1', '--choice', 'ship'], { from: 'user' })
      .catch(() => undefined);
    const responded = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    const inspected = await inspectRun(id, new JsonFileStore(), new JsonWorkflowStore());
    const health = inspected
      .split('\n')
      .filter((l) => l.includes(HEX_ID))
      .join('\n');
    // (a) red when the id's shape decides at a live question (each surface then says the workflow
    //     was created by an agent, a guess no gate allows); (b) prints, per surface, whether it
    //     says so and whether it names the not-registered repair.
    const said = (text: string) => ({
      agent: text.includes(AGENT_WORDS),
      notRegistered: text.includes(`Workflow '${HEX_ID}' is not registered in this workflow store`),
    });
    expect({
      abandon: {
        ...said(refusal),
        repair: refusal.endsWith('Repair it: realm workflow register <file>'),
      },
      respond: said(responded),
      inspect: said(health),
    }).toEqual({
      abandon: { agent: false, notRegistered: false, repair: true },
      respond: { agent: false, notRegistered: true },
      inspect: { agent: false, notRegistered: true },
    });
  });

  it('02 C2: an empty or blank --reason is refused with its four clauses; the run is not abandoned', async () => {
    const { id } = await atGate('plain-gate', copyOf('plain-gate', { source_dir: home }));
    const { store: running, id: runningId } = await (async () => {
      const { JsonFileStore } = await import('@sensigo/realm');
      const store = new JsonFileStore();
      const { run } = await store.create({
        workflowId: 'plain-gate',
        workflowVersion: 1,
        params: {},
      });
      return { store, id: run.id };
    })();
    // (a) red when an empty reason is recorded ("Reason: ." — the walk's minor) or a blank one is
    //     taken as given; (b) prints each refusal and the running run's phase.
    expect({
      empty: await abandon(runningId, '--reason', ''),
      blank: await abandon(runningId, '--reason', '   '),
      phase: (await running.get(runningId)).run_phase,
      gated: (await abandon(id, '--reason', '')).err,
    }).toEqual({
      empty: { failed: true, err: emptyReasonRefusal(''), unchanged: true },
      blank: { failed: true, err: emptyReasonRefusal('   '), unchanged: true },
      phase: 'running',
      gated: emptyReasonRefusal(''),
    });
    // (a) red when the refusal loses a clause; (b) prints it.
    expect(emptyReasonRefusal('')).toBe(
      "realm run abandon: invalid --reason value '': expected text that says why the run ends — refused: the run is not abandoned while the reason is empty, because an empty reason records nothing about why it ended. Give a reason, or leave --reason out (the record then says it was abandoned via realm run abandon). The run can be abandoned as soon as the reason is not empty.",
    );
  });
});
