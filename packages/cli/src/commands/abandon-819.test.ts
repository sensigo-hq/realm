// abandon-819.test.ts — #819 (03) on the CLI door. U1: `realm run abandon <run> --gate <gate>` ends
// a run whose open question can never be answered — an agent's copy that is gone, or a copy that
// cannot be read whose recorded source folder is gone — reading the copy once before the seal;
// without `--gate` it refuses and names the flag; every repairable cause keeps the refusal with its
// repair. U2: a registered copy with no `steps` is named, with its repair, by `realm run inspect` and
// `realm workflow list`. U5: the gate-named abandon is the CLI's command for its way.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: run
// and gate ids, file names, printed lines — never a token or an environment.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { abandonCommand } from './abandon.js';
import { cliCommandOf } from './ways-renderer.js';

/** An id the registrar reads as an agent's (`create_workflow`'s `<slug>-<16 hex>`). */
const AGENT_ID = 'triage-0123456789abcdef';
const GATE = {
  gate_id: 'g-1',
  step_name: 'approve',
  preview: {},
  choices: ['approve', 'reject'],
  opened_at: '2026-01-01T00:00:00.000Z',
};

describe('#819 U1 — realm run abandon --gate', () => {
  let home: string;
  let wfDir: string;
  let originalHome: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'realm-abandon-819-'));
    wfDir = join(home, '.realm', 'workflows');
    await mkdir(join(home, '.realm', 'runs'), { recursive: true });
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

  /** A run of `workflowId` waiting at gate `g-1`. */
  async function atGate(workflowId: string) {
    const { JsonFileStore } = await import('@sensigo/realm');
    const store = new JsonFileStore();
    const { run } = await store.create({ workflowId, workflowVersion: 1, params: {} });
    await store.update({ ...run, pending_gate: { ...GATE } });
    return { store, id: run.id };
  }
  /** The command's outcome: what it printed, whether it exited 1, and the stored run. */
  async function abandon(
    args: string[],
    store: { get: (id: string) => Promise<unknown> },
    id: string,
  ) {
    const failed = await abandonCommand.parseAsync(args, { from: 'user' }).then(
      () => false,
      () => true,
    );
    const run = (await store.get(id)) as {
      run_phase: string;
      terminal_reason?: string;
      pending_gate?: unknown;
    };
    return {
      failed,
      err: errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n'),
      phase: run.run_phase,
      reason: run.terminal_reason,
      gate: run.pending_gate !== undefined,
    };
  }

  it("(a) an agent's copy that is gone: --gate ends the run, the record names why, its question is cleared", async () => {
    const { store, id } = await atGate(AGENT_ID);
    const out = await abandon([id, '--gate', 'g-1', '--reason', 'triage retired'], store, id);
    // (a) red when the refusal still stands (W's walk 2: neither answered nor ended), the reason
    //     loses its cause, or the terminal record keeps its open question; (b) prints the outcome.
    expect(out).toEqual({
      failed: false,
      err: '',
      phase: 'abandoned',
      reason: `triage retired (its question could not be answered: workflow '${AGENT_ID}' was created by an agent (create_workflow) and its stored copy is gone; there is no source file to register)`,
      gate: false,
    });
  });

  it('(b) a copy that cannot be read whose recorded source folder is gone: --gate ends the run', async () => {
    // A copy at the current format with no `steps` (U2's fault), registered from a folder since
    // removed (`source_dir`, as every file-registered copy records it).
    const gone = join(home, 'deleted-source');
    await writeFile(
      join(wfDir, 'flow.json'),
      JSON.stringify({ id: 'flow', name: 'flow', version: 1, schema_version: 1, source_dir: gone }),
    );
    const { store, id } = await atGate('flow');
    const out = await abandon([id, '--gate', 'g-1'], store, id);
    // (a) red when the copy's recorded source is not read, or a gone one does not count; (b)
    //     prints the outcome.
    expect(out).toEqual({
      failed: false,
      err: '',
      phase: 'abandoned',
      reason: `Abandoned via realm run abandon (its question could not be answered: the stored copy of workflow 'flow' (${join(wfDir, 'flow.json')}) is not a valid workflow, and the folder it was registered from (${gone}) no longer exists)`,
      gate: false,
    });
  });

  it('without --gate, a question that can never be answered is refused, naming the flag', async () => {
    const { store, id } = await atGate(AGENT_ID);
    const out = await abandon([id], store, id);
    // (a) red when the run is ended unnamed, or the refusal names the answer (which can never be
    //     given) instead of the flag; (b) prints the outcome.
    expect(out).toEqual({
      failed: true,
      err: `Run '${id}' is waiting on human gate 'approve' (gate 'g-1'), whose question can never be answered: workflow '${AGENT_ID}' was created by an agent (create_workflow) and its stored copy is gone; there is no source file to register. To end it: realm run abandon ${id} --gate g-1`,
      phase: 'gate_waiting',
      reason: undefined,
      gate: true,
    });
  });

  it('each repairable cause keeps the refusal, --gate or not, with its repair: a copy whose source is still there, a newer copy, a copy that is not JSON, a workflow not registered', async () => {
    const source = join(home, 'flow-src');
    await mkdir(source, { recursive: true });
    const refused = async (workflowId: string, copy?: string) => {
      if (copy !== undefined) await writeFile(join(wfDir, `${workflowId}.json`), copy);
      const { store, id } = await atGate(workflowId);
      errSpy.mockClear();
      const out = await abandon([id, '--gate', 'g-1'], store, id);
      return {
        failed: out.failed,
        phase: out.phase,
        tail: out.err.slice(out.err.indexOf(' Repair it: ')),
      };
    };
    const NOT_FOUND = { failed: true, phase: 'gate_waiting' };
    // (a) red when the exception reaches a cause that can still be repaired (LAW-g: abandon never
    //     destroys a repairable run), or its refusal names no repair; (b) prints each outcome.
    expect({
      sourceThere: await refused(
        'there',
        JSON.stringify({
          id: 'there',
          name: 't',
          version: 1,
          schema_version: 1,
          source_dir: source,
        }),
      ),
      newer: await refused(
        'later',
        JSON.stringify({
          id: 'later',
          name: 'l',
          version: 1,
          schema_version: 99,
          source_dir: join(home, 'gone'),
        }),
      ),
      notJson: await refused('broken', '{"id": "broken", "sou'),
      notRegistered: await refused('nowhere'),
    }).toEqual({
      sourceThere: { ...NOT_FOUND, tail: ' Repair it: realm workflow validate --registered there' },
      newer: { ...NOT_FOUND, tail: ' Repair it: realm workflow validate --registered later' },
      notJson: { ...NOT_FOUND, tail: ' Repair it: realm workflow validate --registered broken' },
      notRegistered: { ...NOT_FOUND, tail: ' Repair it: realm workflow register <file>' },
    });
  });
});

describe('#819 U5 — the gate-named abandon is a CLI command', () => {
  it('the abandon way that names a gate renders `--gate`; one that names none renders the plain command', () => {
    // (a) red when the renderer drops the gate (the listing's way then reads as the plain kill,
    //     which refuses); (b) prints both commands.
    expect({
      named: cliCommandOf({ verb: 'abandon', conditions: [], run_id: 'r-1', gate_id: 'g-1' }),
      plain: cliCommandOf({ verb: 'abandon', conditions: [], run_id: 'r-1' }),
    }).toEqual({ named: 'realm run abandon r-1 --gate g-1', plain: 'realm run abandon r-1' });
  });
});
