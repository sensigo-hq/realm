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
  /** #819 follow-up 2 (R2; reader B's M1): the gate fork's words, from core's one composer. */
  const UNANSWERABLE = 'Its question cannot be answered until its workflow can be read.';
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
    const REREGISTER =
      're-register the workflow from its source (realm workflow register <path-to-workflow>)';
    const refused = (tail: string) => ({
      failed: true,
      unchanged: true,
      tail: `${UNANSWERABLE} ${tail}`,
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
      // #819 follow-up 2 re-pins (R2, the audit's B1): each copy's own repair, never `validate
      // --registered` (whose text offers `rm`) — was "Its workflow cannot be read, so the question
      // cannot be answered until it is repaired. Repair it: realm workflow validate --registered <id>"
      A4f: refused(`Repair it: ${REREGISTER}`),
      A6b: refused('Re-register it with: realm workflow register <path-to-workflow>'),
      A6c: refused(`Repair it: ${REREGISTER}`),
      B1: refused('Repair it: realm workflow register <file>'),
      newer: refused(
        "Use the Realm version that registered it, or register the workflow's source again with this version.",
      ),
      notJson: refused(`Repair it: ${REREGISTER}`),
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

  // #819 follow-up 2 re-pin (R1): was "02 C2: an empty or blank --reason is refused with its four
  // clauses; the run is not abandoned" — its words promised what a gate refuses (walk BLOCKING 2).
  it('#819 follow-up 2 (R2): walk A4b, A5b and A6c at a gate, their sources gone — the copy’s repair act, with no `rm` and no `validate` anywhere in the refusal', async () => {
    const out = async (workflowId: string, copy: string) => {
      const { id } = await atGate(workflowId, copy);
      const r = await abandon(id);
      return {
        tail: r.err.slice(NOT_OPEN(id).length + 1),
        rm: /\brm\b/.test(r.err),
        validate: r.err.includes('validate'),
        answer: r.err.includes('Answer it'),
        unchanged: r.unchanged,
      };
    };
    const act = {
      tail: `${UNANSWERABLE} Repair it: re-register the workflow from its source (realm workflow register <path-to-workflow>)`,
      rm: false,
      validate: false,
      answer: false,
      unchanged: true,
    };
    // (a) red when the refusal names `validate --registered` again (whose text offers `rm`), the
    //     act's alternative is printed (`rm`), or the answer line comes back; (b) prints each.
    expect({
      // walk A4b: the copy cut at 200 bytes, its source folder gone
      A4b: await out('a4b', copyOf('a4b', {}).slice(0, 60)),
      // walk A5b: valid JSON with no steps, its source folder gone
      A5b: await out('a5b', copyOf('a5b', {}, ['steps'])),
      // walk A6c: schema_version "1", a string
      A6c: await out('a6c', copyOf('a6c', { schema_version: '1' })),
    }).toEqual({ A4b: act, A5b: act, A6c: act });
  });

  it('#819 follow-up 2 (R2, the audit’s B1): walk A6a and A6b (an older Realm’s copy) and reader B’s newer shape, at a gate — the class’s own remedy, and no "Answer it"', async () => {
    const out = async (workflowId: string, copy: string) => {
      const { id } = await atGate(workflowId, copy);
      const r = await abandon(id);
      return { tail: r.err.slice(NOT_OPEN(id).length + 1), unchanged: r.unchanged };
    };
    const legacy = {
      tail: `${UNANSWERABLE} Re-register it with: realm workflow register <path-to-workflow>`,
      unchanged: true,
    };
    // (a) red when legacy or newer reads no repair (the answer line, which the run cannot take), or
    //     the newer copy is told it must be repaired; (b) prints each tail.
    expect({
      // walk A6a: schema_version removed, its source kept
      A6a: await out('a6a', copyOf('a6a', { source_dir: home }, ['schema_version'])),
      // walk A6b: schema_version removed, its source gone
      A6b: await out('a6b', copyOf('a6b', {}, ['schema_version'])),
      // reader B's newer shape: a copy a later Realm wrote (W-829-C1-B-15)
      newer: await out('later', copyOf('later', { schema_version: 99 })),
    }).toEqual({
      A6a: legacy,
      A6b: legacy,
      newer: {
        tail: `${UNANSWERABLE} Use the Realm version that registered it, or register the workflow's source again with this version.`,
        unchanged: true,
      },
    });
  });

  it('#819 follow-up 2 (R2, R13): a registry folder at mode 000 — abandon’s refusal and respond name the same act', async () => {
    const { id } = await atGate('plain-gate', copyOf('plain-gate', { source_dir: home }));
    const { chmod } = await import('node:fs/promises');
    await chmod(wfDir, 0o000);
    try {
      const refusal = (await abandon(id)).err;
      errSpy.mockClear();
      await respondCommand
        .parseAsync([id, '--gate', 'g-1', '--choice', 'ship'], { from: 'user' })
        .catch(() => undefined);
      const responded = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
      const ACT = `make the registry directory ${wfDir} readable and searchable (chmod u+rx ${wfDir})`;
      // (a) red when the two surfaces name different repairs for one state (abandon's `validate
      //     --registered` beside respond's act — R13); (b) prints whether each names the act.
      expect({
        abandon: refusal.endsWith(`${UNANSWERABLE} Repair it: ${ACT}`),
        respond: responded.includes(ACT),
      }).toEqual({ abandon: true, respond: true });
    } finally {
      await chmod(wfDir, 0o755);
    }
  });

  it('#819 follow-up 2 (R1, the audit’s S5): an empty or blank --reason is refused in respond --by’s words — nothing is recorded, with no claim about the run', async () => {
    const { id } = await atGate('plain-gate', copyOf('plain-gate', { source_dir: home }));
    const { store, id: runningId } = await (async () => {
      const { JsonFileStore } = await import('@sensigo/realm');
      const store = new JsonFileStore();
      const { run } = await store.create({
        workflowId: 'plain-gate',
        workflowVersion: 1,
        params: {},
      });
      return { store, id: run.id };
    })();
    const ended = await (async () => {
      const { JsonFileStore, abandonRun } = await import('@sensigo/realm');
      const s = new JsonFileStore();
      const { run } = await s.create({ workflowId: 'plain-gate', workflowVersion: 1, params: {} });
      await abandonRun(s, run.id, 'ended before');
      return run.id;
    })();
    const missing = async () => {
      errSpy.mockClear();
      const failed = await abandonCommand
        .parseAsync(['00000000-0000-4000-8000-000000000000', '--reason', ''], { from: 'user' })
        .then(
          () => false,
          () => true,
        );
      return { failed, err: errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n') };
    };
    const REFUSED = emptyReasonRefusal();
    // (a) red when an empty reason is recorded, a blank one is taken as given, or the refusal says
    //     anything about the run (at a gate, for a missing run and for one already abandoned, a
    //     reason alone changes nothing); (b) prints each refusal and the running run's phase.
    expect({
      empty: await abandon(runningId, '--reason', ''),
      blank: await abandon(runningId, '--reason', '   '),
      phase: (await store.get(runningId)).run_phase,
      gated: (await abandon(id, '--reason', '')).err,
      abandoned: await abandon(ended, '--reason', ''),
      missing: await missing(),
    }).toEqual({
      empty: { failed: true, err: REFUSED, unchanged: true },
      blank: { failed: true, err: REFUSED, unchanged: true },
      phase: 'running',
      gated: REFUSED,
      abandoned: { failed: true, err: REFUSED, unchanged: true },
      missing: { failed: true, err: REFUSED },
    });
    // (a) red when the words change, or a claim about the run comes back; (b) prints the refusal.
    expect(REFUSED).toBe(
      "--reason: empty; nothing was recorded. Give a reason, or leave it out: the default reason is 'Abandoned via realm run abandon'.",
    );
  });
});
