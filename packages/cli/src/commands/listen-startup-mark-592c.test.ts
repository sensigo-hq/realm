// listen-startup-mark-592c.test.ts — Q1 (#592) unit c, checks 5 and 6 (prompt
// q1-c-startup-death-mark.md): `realm listen` marks the `realm agent` it started ONLY when the child
// died by a SIGNAL and the run has not moved since listen's own last write (the pid write). One
// compare-and-set write; an exit code, any code, is never marked; a stop awaits a mark being written.
//
// Every cell runs `startListen` itself on loopback over the in-memory store (`serveListen`), with the
// command's own spawner (`makeAgentSpawner`) starting REAL `node -e` children the way listen starts an
// agent (detached, `stdio: 'inherit'`, unref'd), as listen-wait-r12's C5 does.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { classifyRunHealth, type RunRecord, type Snapshot } from '@sensigo/realm';
import { InMemoryStore } from '@sensigo/realm-testing';
import { markSignalDeath, type ChildExit } from '../agent/startup-failure.js';
import { makeAgentSpawner, type SpawnResult } from './listen.js';
import {
  capturingLogger,
  post,
  sharedSecretTrigger,
  workflow,
} from '../test-support/listen-read-r11.js';
import { serveListen, sleep } from '../test-support/listen-wait-r12.js';

const refunds = workflow('refunds', sharedSecretTrigger('/refunds', undefined));
const KILLED = 'realm agent was killed by SIGTERM before it wrote anything to the run';

/** A spawn function that starts `node -e <script>` in place of `realm agent`, and keeps each child. */
function children(script: string): { spawnFn: typeof nodeSpawn; started: ChildProcess[] } {
  const started: ChildProcess[] = [];
  const spawnFn = ((_cmd: string, _args: readonly string[], o: Parameters<typeof nodeSpawn>[2]) => {
    const child = nodeSpawn(process.execPath, ['-e', script], o);
    started.push(child);
    return child;
  }) as unknown as typeof nodeSpawn;
  return { spawnFn, started };
}

/** Polls `done` every 25 ms until it holds or `ms` pass; returns whether it held. */
async function until(done: () => boolean | Promise<boolean>, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() >= deadline) return false;
    await sleep(25);
  }
  return true;
}

/** Starts listen with `script` as the agent and posts one event; the run's id and the child. */
async function deliver(script: string, store: InMemoryStore = new InMemoryStore()) {
  const { spawnFn, started } = children(script);
  const s = await serveListen([refunds], {
    store,
    workflowDir: tmpdir(),
    over: { spawnAgent: makeAgentSpawner({ model: 'm-592c' }, capturingLogger(), spawnFn) },
  });
  const res = await post(s.port, '/refunds', { id: 'evt-592c' });
  const runId = String((JSON.parse(res.body) as { run_id: unknown }).run_id);
  await until(() => started.length === 1);
  return { s, store, runId, child: started[0]!, status: res.status };
}

/** The listen lines about a startup mark (level and message). */
const markLines = (lines: ReturnType<typeof capturingLogger>['lines']) =>
  lines.filter((l) => l.msg.includes('startup failure')).map((l) => [l.level, l.msg]);

describe('Q1 (#592) unit c — check 5: listen marks a signal death and nothing else', () => {
  it('a child killed by SIGTERM before any write: one startup_failure entry on top of the pid write, evidence_count stamped, drive_failing without a basis', async () => {
    const { s, store, runId, status } = await deliver("process.kill(process.pid, 'SIGTERM')");
    const marked = await until(async () => {
      const r = (await store.get(runId)).record;
      return (r.drive_failures?.entries.length ?? 0) > 0;
    });
    const snapshot: Snapshot = await store.get(runId);
    const run: RunRecord = snapshot.record;
    const [entry] = run.drive_failures?.entries ?? [];
    const finding = classifyRunHealth(snapshot).find((f) => f.kind === 'drive_failing');
    // (a) red when listen does not mark a signal death, marks against the created run's version
    //     (the pid write then makes the compare-and-set refuse: no entry), appends without the shared
    //     bookkeeping (no evidence_count: the finding's basis becomes legacy_stamp_order), or writes
    //     another shape; (b) prints the entry, the pid, the finding and listen's lines.
    expect({
      status,
      marked,
      pidWritten: typeof run.agent_pid,
      entry: entry && {
        ...entry,
        at: typeof entry.at,
        elapsed_ms: typeof entry.elapsed_ms,
      },
      total: run.drive_failures?.total,
      finding: finding && {
        step: finding.step,
        basis: (finding.evidence as { basis?: unknown }).basis,
      },
      lines: markLines(s.logger.lines),
    }).toEqual({
      status: 202,
      marked: true,
      pidWritten: 'number',
      entry: {
        at: 'string',
        step: '',
        provider: 'unknown',
        error_class: 'startup_failure',
        message: KILLED,
        elapsed_ms: 'number',
        evidence_count: 0,
        model_text: { recorded: true, messages: [], tools: [], requests: [] },
      },
      total: 1,
      finding: { step: '', basis: undefined },
      lines: [['warn', 'listen: recorded a startup failure']],
    });
  }, 30_000);

  it('a child that exits 1 (every result of realm agent but completed) is not marked; nor one that exits 0', async () => {
    for (const code of [1, 0]) {
      const { s, store, runId, child } = await deliver(`process.exit(${code})`);
      if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
      await sleep(300);
      const run = (await store.get(runId)).record;
      // (a) red when listen marks an exit code; (b) prints the code, the ring and listen's lines.
      expect({ code, ring: run.drive_failures, lines: markLines(s.logger.lines) }).toEqual({
        code,
        ring: undefined,
        lines: [],
      });
    }
  }, 30_000);

  it('a child killed by a signal AFTER the run moved: the compare-and-set refuses, nothing is written, the outcome is logged', async () => {
    const { s, store, runId, child } = await deliver('setTimeout(() => {}, 30000)');
    // The pid write has landed (it bumps the version); then the run moves, as a drive's first write.
    await until(async () => (await store.get(runId)).record.agent_pid !== undefined);
    await sleep(100);
    const { record } = await store.get(runId);
    await store.update({ ...record, params: { moved: true } });
    child.kill('SIGTERM');
    const logged = await until(() => markLines(s.logger.lines).length > 0);
    const run = (await store.get(runId)).record;
    // (a) red when listen marks a run that moved (no version conjunct, or a retry that re-reads);
    //     (b) prints the ring and listen's lines.
    expect({ logged, ring: run.drive_failures, lines: markLines(s.logger.lines) }).toEqual({
      logged: true,
      ring: undefined,
      lines: [
        ['warn', 'listen: the run moved before the agent was killed; no startup failure recorded'],
      ],
    });
  }, 30_000);

  it('`exited` resolves how the child ended: { code, signal }', async () => {
    const results = [];
    for (const script of ['process.exit(1)', "process.kill(process.pid, 'SIGTERM')"]) {
      const { spawnFn } = children(script);
      const spawned = await makeAgentSpawner(
        { model: 'm-592c' },
        capturingLogger(),
        spawnFn,
      )('run-592c', tmpdir());
      results.push(await spawned.exited);
    }
    // (a) red when `exited` resolves nothing, or one of the pair; (b) prints both results.
    expect(results).toEqual([
      { code: 1, signal: null },
      { code: null, signal: 'SIGTERM' },
    ]);
  }, 30_000);
});

describe('Q1 (#592) unit c — check 6: a stop awaits a mark being written', () => {
  it('listen is stopped while a signal death is being recorded: the mark is written before the stop resolves', async () => {
    const inner = new InMemoryStore();
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    // The store's write of a drive failure takes 500 ms, so the stop begins while it is under way.
    const store = new Proxy(inner, {
      get(target, key) {
        if (key === 'update') {
          return async (record: RunRecord) => {
            if (record.drive_failures !== undefined) {
              markStarted();
              await sleep(500);
            }
            return target.update(record);
          };
        }
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });
    const { s, runId } = await deliver("process.kill(process.pid, 'SIGTERM')", store);
    await started;
    await s.handle.shutdown('test');
    const run = (await inner.get(runId)).record;
    // (a) red when the mark's write is not in the set the stop awaits (the stop then resolves while
    //     the write is still waiting); (b) prints the ring.
    expect(run.drive_failures?.entries.map((e) => [e.error_class, e.message])).toEqual([
      ['startup_failure', KILLED],
    ]);
  }, 30_000);
});

const MALFORMED =
  "listen: the agent's exit arrived without a code or signal; no startup failure recorded";
const UNLEARNED = "listen: the agent's exit could not be learned; no startup failure recorded";

/**
 * A process-level `unhandledRejection` listener for this cell, recording into `seen`, removed when
 * the cell ends. While it is there, vitest's own listener steps aside (vitest 4: it reports only
 * when it is the one listener), so the cell must assert on `seen` itself.
 */
function armNet(): string[] {
  const seen: string[] = [];
  const net = (reason: unknown): void => {
    seen.push(String(reason));
  };
  process.on('unhandledRejection', net);
  onTestFinished(() => {
    process.off('unhandledRejection', net);
  });
  return seen;
}

/** Listen with a spawn double whose `exited` is `exited()`, and one event posted to it. */
async function deliverDouble(exited: () => Promise<ChildExit>) {
  const store = new InMemoryStore();
  const settled: Promise<unknown>[] = [];
  const spawnAgent = vi.fn(async (): Promise<SpawnResult> => {
    const e = exited();
    settled.push(
      e.then(
        () => undefined,
        () => undefined,
      ),
    );
    return { pid: 4242, exited: e };
  });
  const s = await serveListen([refunds], { store, workflowDir: tmpdir(), over: { spawnAgent } });
  const res = await post(s.port, '/refunds', { id: 'evt-592c2' });
  const runId = String((JSON.parse(res.body) as { run_id: unknown }).run_id);
  await until(() => settled.length === 1);
  await settled[0];
  await until(() => markLines(s.logger.lines).length > 0, 5_000);
  // One macrotask past the settle: an unhandled rejection has been reported by now.
  await sleep(50);
  const lines = s.logger.lines.filter((l) => l.msg.includes('startup failure'));
  return { store, runId, status: res.status, lines };
}

describe('Q1 (#592) c2: the startup mark never throws', () => {
  it('check 1: a spawner whose `exited` resolves nothing (the C3b1 double): no unhandled rejection, nothing written, one warn line with the run id', async () => {
    const seen = armNet();
    const { store, runId, status, lines } = await deliverDouble(
      () => sleep(50).then(() => undefined) as unknown as Promise<ChildExit>,
    );
    const run = (await store.get(runId)).record;
    // (a) red when the guard is gone (the mark reads `.code` of nothing: an error line, or with
    //     the body's `try` gone too, an unhandled rejection in `seen`), or the exit is marked;
    //     (b) prints the rejections seen, the ring and listen's lines.
    expect({ status, seen, ring: run.drive_failures, lines }).toEqual({
      status: 202,
      seen: [],
      ring: undefined,
      lines: [{ level: 'warn', msg: MALFORMED, data: { run_id: runId } }],
    });
  }, 30_000);

  it('check 2: a spawner whose `exited` rejects: the chain logs it at warn with the error, nothing written, no unhandled rejection', async () => {
    const seen = armNet();
    const { store, runId, status, lines } = await deliverDouble(() =>
      sleep(50).then(() => {
        throw new Error('the spawner lost the child');
      }),
    );
    const run = (await store.get(runId)).record;
    // (a) red when the chain's `.catch` is gone (an unhandled rejection in `seen`, no line);
    //     (b) prints the rejections seen, the ring and listen's lines.
    expect({ status, seen, ring: run.drive_failures, lines }).toEqual({
      status: 202,
      seen: [],
      ring: undefined,
      lines: [
        {
          level: 'warn',
          msg: UNLEARNED,
          data: { run_id: runId, error: 'Error: the spawner lost the child' },
        },
      ],
    });
  }, 30_000);

  it('the mark judges each exit by its values: a code is silent, a signal marks, every other shape warns; an exit that cannot be read is an error line; the promise never rejects', async () => {
    const unreadable = Object.defineProperty({}, 'code', {
      get() {
        throw new Error('unreadable exit');
      },
    });
    const shapes: [string, unknown][] = [
      ['undefined', undefined],
      ['null', null],
      ['a number', 1],
      ['a string', 'SIGTERM'],
      ['{}', {}],
      ['{ code: null } (no signal)', { code: null }],
      ['{ signal: SIGTERM } (no code)', { signal: 'SIGTERM' }],
      ['{ code: null, signal: null }', { code: null, signal: null }],
      ['{ code: 1, signal: null }', { code: 1, signal: null }],
      ['{ code: 0 } (no signal)', { code: 0 }],
      ['{ code: null, signal: SIGTERM }', { code: null, signal: 'SIGTERM' }],
      ['an exit whose code cannot be read', unreadable],
    ];
    const got: Record<string, unknown> = {};
    for (const [name, shape] of shapes) {
      const store = new InMemoryStore();
      const { record } = await store.create({
        workflowId: 'refunds',
        workflowVersion: 1,
        params: {},
      });
      const logger = capturingLogger();
      const settled = await markSignalDeath(
        store,
        logger,
        record,
        shape as ChildExit,
        performance.now(),
      ).then(
        () => 'resolved',
        (err: unknown) => `rejected: ${String(err)}`,
      );
      const entries = (await store.get(record.id)).record.drive_failures?.entries ?? [];
      got[name] = {
        settled,
        entries: entries.map((e) => e.message),
        // The run id shown as `<this run>` when it is this shape's run.
        lines: logger.lines.map((l) => {
          const data = l.data as Record<string, unknown>;
          return [
            l.level,
            l.msg,
            { ...data, run_id: data['run_id'] === record.id ? '<this run>' : data['run_id'] },
          ];
        }),
      };
    }
    const run = '<this run>';
    const warned = {
      settled: 'resolved',
      entries: [],
      lines: [['warn', MALFORMED, { run_id: run }]],
    };
    const silent = { settled: 'resolved', entries: [], lines: [] };
    // (a) red when one conjunct of the guard is gone (`code !== null`: `{ signal }` marks; the
    //     signal's type: `{ code: null }` writes "killed by undefined"; the object check: null and
    //     undefined throw), the outer `try` is gone (the unreadable exit rejects), or its line
    //     loses its words; (b) prints every shape's outcome.
    expect(got).toEqual({
      undefined: warned,
      null: warned,
      'a number': warned,
      'a string': warned,
      '{}': warned,
      '{ code: null } (no signal)': warned,
      '{ signal: SIGTERM } (no code)': warned,
      '{ code: null, signal: null }': warned,
      '{ code: 1, signal: null }': silent,
      '{ code: 0 } (no signal)': silent,
      '{ code: null, signal: SIGTERM }': {
        settled: 'resolved',
        entries: [KILLED],
        lines: [['warn', 'listen: recorded a startup failure', { run_id: run, signal: 'SIGTERM' }]],
      },
      'an exit whose code cannot be read': {
        settled: 'resolved',
        entries: [],
        lines: [
          [
            'error',
            'listen: failed to record a startup failure',
            { run_id: run, error: 'Error: unreadable exit' },
          ],
        ],
      },
    });
  });
});
