// listen-wait-r12.test.ts — R1.2: a caller of `realm listen` sends `Prefer: wait=N` on the POST that
// starts a run of a workflow with `trigger.result_map`, and the reply waits for the run: the read
// address's `200` once the run has ended, R1.1's `202` with the phase reached at a gate, when the
// agent's process exits, at N seconds or at the first signal; nothing to a caller who hangs up.
// Every cell runs a real server on loopback over the in-memory store
// (`test-support/listen-wait-r12.ts`) with a spawn double that does, on the run, what `realm agent`
// would (the engine's own `executeStep`, `abandonRun`), and reads what the caller sees. A failing
// cell prints the status, the headers and the body (a code only by its shape) and the wait's log
// line; never a secret.
import { describe, expect, it, vi } from 'vitest';
import { spawn as nodeSpawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { request, type IncomingHttpHeaders } from 'node:http';
import { connect } from 'node:net';
import { abandonRun, compileDisclosure, executeStep, type RunStore } from '@sensigo/realm';
import { InMemoryStore } from '@sensigo/realm-testing';
import { listenCommand, makeAgentSpawner, parseMaxWaiting, type SpawnResult } from './listen.js';
import {
  ENV,
  capturingLogger,
  emptySet,
  sharedSecretTrigger,
  workflow,
} from '../test-support/listen-read-r11.js';
import { serveHandler, serveListen, sleep, timers } from '../test-support/listen-wait-r12.js';

// The client: one request on its own connection (`Connection: close`), so no keep-alive timer
// outlives a request; it can hang up at a chosen moment.

/** What a caller saw (headers but `date` and the connection's), when, or that it hung up. */
interface Answer {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** Milliseconds from the request to the reply's end. */
  ms: number;
}

/**
 * One request on its own connection (`Connection: close`). With `hangUpAtMs`, the client destroys
 * the connection then and resolves `'hung up'` (a reply that comes first is returned instead).
 */
function ask(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string | string[]> = {},
  body?: string,
  hangUpAtMs?: number,
): Promise<Answer | 'hung up'> {
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        agent: false,
        headers: { connection: 'close', ...headers },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d: string) => (text += d));
        res.on('end', () => {
          clearTimeout(hangUp);
          const kept: IncomingHttpHeaders = { ...res.headers };
          delete kept['date'];
          delete kept['connection'];
          resolve({
            status: res.statusCode ?? 0,
            headers: Object.fromEntries(Object.entries(kept).map(([k, v]) => [k, String(v)])),
            body: text,
            ms: Math.round(performance.now() - t0),
          });
        });
      },
    );
    const hangUp =
      hangUpAtMs === undefined
        ? undefined
        : setTimeout(() => {
            req.destroy();
            resolve('hung up');
          }, hangUpAtMs);
    req.on('error', (err) => {
      if (hangUpAtMs === undefined) reject(err);
    });
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

/** A POST of `event` to `path` with the shared secret, and `Prefer` when given (a list: one line each). */
function postWait(
  port: number,
  path: string,
  event: unknown,
  prefer?: string | string[],
  hangUpAtMs?: number,
): Promise<Answer | 'hung up'> {
  return ask(
    port,
    'POST',
    path,
    {
      'content-type': 'application/json',
      'x-token': ENV['READ_SECRET']!,
      ...(prefer !== undefined ? { prefer } : {}),
    },
    JSON.stringify(event),
    hangUpAtMs,
  );
}

/**
 * A POST on a raw connection whose sender closes its side of it right after the body, as `nc -N`
 * does, then keeps reading: what it got back is the answer, nothing at all a hang-up.
 */
function halfClosedPost(port: number, path: string, event: unknown, prefer: string) {
  return new Promise<Answer | 'hung up'>((resolve) => {
    const body = JSON.stringify(event);
    const t0 = performance.now();
    let got = '';
    const socket = connect(port, '127.0.0.1', () => {
      socket.end(
        `POST ${path} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nX-Token: ${ENV['READ_SECRET']!}\r\nPrefer: ${prefer}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      );
    });
    socket.on('data', (d: Buffer) => (got += d.toString('latin1')));
    socket.on('error', () => {});
    socket.on('close', () =>
      resolve(
        got === ''
          ? 'hung up'
          : {
              status: Number(got.split(' ')[1]),
              headers: {},
              body: got,
              ms: Math.round(performance.now() - t0),
            },
      ),
    );
  });
}

/** An answer, or a test failure naming the hang-up. */
function answered(a: Answer | 'hung up'): Answer {
  if (a === 'hung up') throw new Error('expected an answer; the client hung up');
  return a;
}

const READ_MAP = { approved: 'context.resources.review.approved' };
const refunds = workflow('refunds', sharedSecretTrigger('/refunds', READ_MAP));
const plain = workflow('plain', sharedSecretTrigger('/plain', undefined));
const gated = workflow('refunds', sharedSecretTrigger('/refunds', READ_MAP), {
  steps: {
    review: {
      description: 'Review.',
      execution: 'auto',
      trust: 'human_confirmed',
      depends_on: [],
      gate: { choices: ['approve', 'reject'], message: 'Refund?' },
    },
  },
});
const guarded = workflow('refunds', sharedSecretTrigger('/refunds', READ_MAP), {
  steps: {
    review: { description: 'Review.', execution: 'agent', depends_on: [] },
    stop: {
      description: 'Stop.',
      execution: 'guard',
      depends_on: ['review'],
      abort_unless: ['review.ok == true'],
      abort_message: 'stopped',
    },
  },
});
const json = (body: string): Record<string, unknown> => JSON.parse(body) as Record<string, unknown>;
const HEX64 = /^[0-9a-f]{64}$/;
/** An answer with its code shown by its shape, so a failure never prints one. */
const shown = (a: Answer | 'hung up') => {
  if (a === 'hung up') return a;
  const b = json(a.body);
  if (typeof b['token'] === 'string') b['token'] = HEX64.test(b['token']) ? '<64 hex>' : '<?>';
  return { status: a.status, headers: a.headers, body: b };
};

/** The step `review` of `def` done with `output`, as `realm agent` would record it. */
const review = (store: RunStore, def: typeof refunds, runId: string, output: unknown) =>
  executeStep(store, def, {
    runId,
    command: 'review',
    input: output as Record<string, unknown>,
    dispatcher: async (_c, input) => input,
  });

/**
 * A spawn double: `work` is done on the run 50 ms after the start (after the handler's own writes);
 * with `exits`, the agent's process "exits" once it is done, else no `exited` is handed back. Later
 * starts (a following request) exit at once.
 */
const agent = (work: (runId: string) => Promise<unknown>, exits = true) => {
  let first = true;
  return vi.fn(async (runId: string): Promise<SpawnResult> => {
    if (!first) return { pid: 4243, exited: Promise.resolve() };
    first = false;
    const done = sleep(50)
      .then(() => work(runId))
      .then(
        () => undefined,
        () => undefined,
      );
    return exits ? { pid: 4242, exited: done } : { pid: 4242 };
  });
};
/** A spawn double whose agent never touches the run and never exits; later starts exit at once. */
const idle = () => agent(async () => undefined, false);
/** A spawn double whose agent exits at once, the run left running. */
const exitsAtOnce = () =>
  vi.fn(async (): Promise<SpawnResult> => ({ pid: 4242, exited: Promise.resolve() }));

describe('R1.2 — when the preference is not honoured, the reply is as before', () => {
  it('C1: no Prefer gets R1.1’s 202 at once; Prefer on a workflow without result_map gets the same bytes as without it', async () => {
    const s = await serveListen([refunds, plain], { over: { spawnAgent: idle() } });
    const none = answered(await postWait(s.port, '/refunds', { id: 'evt-1' }));
    const plainWith = answered(await postWait(s.port, '/plain', { id: 'evt-2' }, 'wait=20'));
    const plainWithout = answered(await postWait(s.port, '/plain', { id: 'evt-3' }));
    const runId = String(json(none.body)['run_id']);
    const bare = (a: Answer) => ({
      status: a.status,
      headers: a.headers,
      body: a.body.replace(String(json(a.body)['run_id']), '<run>'),
    });
    // (a) red when the wait runs without the header (the reply then comes at a check or the cap,
    //     with `Preference-Applied`) or on a workflow without result_map; (b) prints the replies
    //     (codes by shape), their times and the wait lines.
    expect({
      none: shown(none),
      fast: none.ms < 1500,
      plainSame: bare(plainWith),
      waits: s.waits(),
    }).toEqual({
      none: {
        status: 202,
        headers: {
          'content-type': 'application/json',
          'content-length': String(none.body.length),
          location: `/refunds/runs/${runId}`,
          'retry-after': '5',
        },
        body: {
          run_id: runId,
          status: 'accepted',
          run_phase: 'running',
          status_path: `/refunds/runs/${runId}`,
          token: '<64 hex>',
        },
      },
      fast: true,
      plainSame: bare(plainWithout),
      waits: [],
    });
  });
});

describe('R1.2 — reading the header', () => {
  it.each([
    ['wait=10', 10],
    ['wait=30', 25],
    ['wait=99999999999999999999999', 25],
    ['respond-async, wait=20', 20],
    ['WAIT=20', 20],
    ['wait = 20', 20],
    ['wait=020', 20],
    ['wait=20;', 20],
    [['wait=7', 'wait=20'], 7],
  ] as const)(
    'C2: `Prefer: %s` is honoured with Preference-Applied: wait=%i (--max-wait 25)',
    async (prefer, applied) => {
      const s = await serveListen([refunds], {
        maxWaitSeconds: 25,
        over: { spawnAgent: exitsAtOnce() },
      });
      const a = answered(
        await postWait(s.port, '/refunds', { id: 'evt-1' }, prefer as string | string[]),
      );
      // (a) red when the value is read last-wins (two lines), the name by case, the list not split
      //     at commas, the blanks around `=` refused, or N not capped by --max-wait; (b) prints the
      //     status, the header and the wait lines.
      expect({
        status: a.status,
        applied: a.headers['preference-applied'],
        ended: s.waits().map((w) => w['ended_by']),
      }).toEqual({ status: 202, applied: `wait=${applied}`, ended: ['exit'] });
    },
  );

  it.each([
    'wait=0',
    'wait=-5',
    'wait=1.5',
    'wait=20s',
    'wait=1e2',
    'wait=',
    'wait="20"',
    'wait=abc',
    'wait=20; foo=bar',
    'wait=abc, wait=20',
  ])(
    'C2: `Prefer: %s` is ignored: the plain 202, no Preference-Applied, no wait',
    async (prefer) => {
      const s = await serveListen([refunds], { over: { spawnAgent: exitsAtOnce() } });
      const a = answered(await postWait(s.port, '/refunds', { id: 'evt-1' }, prefer));
      // (a) red when an ignored value is answered `400` or honoured (then `Preference-Applied` and a
      //     wait line appear), or when a first `wait` that is ignored lets a later one count; (b)
      //     prints the status, the header and the wait lines.
      expect({
        status: a.status,
        applied: a.headers['preference-applied'],
        phase: json(a.body)['run_phase'],
        waits: s.waits(),
      }).toEqual({ status: 202, applied: undefined, phase: 'running', waits: [] });
    },
  );
});

describe('R1.2 — a run that ends inside N gets the read’s 200', () => {
  type Branch = {
    name: string;
    def: typeof refunds;
    provider?: NonNullable<Parameters<typeof serveListen>[1]>['provider'];
    work: (store: RunStore, runId: string) => Promise<unknown>;
    expected: (runId: string) => Record<string, unknown>;
  };
  const canary = 'refund FAKECANDECLR12X0729 now';
  const declaredSet = compileDisclosure(
    [{ value: 'FAKECANDECLR12X0729', source: 'declared:D_NOTE' }],
    { declared: 'resolved', audience: 'agent', environment: 'swept' },
  ).set;
  const noteMap = workflow(
    'refunds',
    sharedSecretTrigger('/refunds', { note: 'context.resources.review.note' }),
  );
  const vMap = workflow(
    'refunds',
    sharedSecretTrigger('/refunds', { v: 'context.resources.review.v' }),
  );
  const branches: Branch[] = [
    {
      name: 'completed with a result',
      def: refunds,
      work: (st, id) => review(st, refunds, id, { approved: true }),
      expected: (id) => ({
        run_id: id,
        run_phase: 'completed',
        result: { approved: true },
        result_masked: { declared: 0, environment: 0, pattern: 0 },
      }),
    },
    {
      name: 'a declared secret under a harmless name, masked',
      def: noteMap,
      provider: async () => declaredSet,
      work: (st, id) => review(st, noteMap, id, { note: canary }),
      expected: (id) => ({
        run_id: id,
        run_phase: 'completed',
        result: { note: 'refund [REDACTED] now' },
        result_masked: { declared: 1, environment: 0, pattern: 0 },
      }),
    },
    {
      name: 'a result too large',
      def: vMap,
      work: (st, id) => review(st, vMap, id, { v: 'x'.repeat(40_001 - 8) }),
      expected: (id) => ({ run_id: id, run_phase: 'completed', result_error: 'too_large' }),
    },
    {
      name: 'values withheld',
      def: refunds,
      provider: async () =>
        compileDisclosure([], {
          declared: 'partial',
          cause: 'manifest_changed',
          audience: 'agent',
          environment: 'swept',
        }).set,
      work: (st, id) => review(st, refunds, id, { approved: true }),
      expected: (id) => ({
        run_id: id,
        run_phase: 'completed',
        result_error: 'values_withheld',
        because: 'declared values changed',
      }),
    },
    {
      name: 'failed',
      def: refunds,
      work: (st, id) =>
        executeStep(st, refunds, {
          runId: id,
          command: 'review',
          input: {},
          dispatcher: async () => {
            throw new Error('the model went away');
          },
        }),
      expected: (id) => ({ run_id: id, run_phase: 'failed' }),
    },
    {
      name: 'aborted',
      def: guarded,
      work: async (st, id) => {
        await review(st, guarded, id, { ok: false });
        await executeStep(st, guarded, {
          runId: id,
          command: 'stop',
          input: {},
          dispatcher: async () => ({}),
        }).catch(() => undefined);
      },
      expected: (id) => ({ run_id: id, run_phase: 'aborted' }),
    },
    {
      name: 'abandoned',
      def: refunds,
      work: (st, id) => abandonRun(st, id),
      expected: (id) => ({ run_id: id, run_phase: 'abandoned' }),
    },
  ];

  it.each(branches.map((b) => [b.name, b] as const))(
    'C3: %s — the wait’s 200 is the GET’s body, its headers the read’s plus Preference-Applied',
    async (_name, b) => {
      const store = new InMemoryStore();
      const s = await serveListen([b.def], {
        store,
        ...(b.provider !== undefined ? { provider: b.provider } : {}),
        over: { spawnAgent: agent((id) => b.work(store, id)) },
      });
      const waited = answered(await postWait(s.port, '/refunds', { id: 'evt-1' }, 'wait=20'));
      const runId = String(json(waited.body)['run_id']);
      const got = answered(
        await ask(s.port, 'GET', `/refunds/runs/${runId}`, {
          authorization: `Bearer ${s.code('/refunds', runId)}`,
        }),
      );
      // (a) red when a terminal run is answered `202`, when the wait builds its own body (a second
      //     producer: then it can differ from the GET's in any branch, and with an empty disclosure
      //     set the declared canary shows), or when its headers are not the read's; (b) prints both
      //     replies (the canary only as whether it leaked) and the wait line.
      expect({
        status: waited.status,
        body: json(waited.body),
        leaked: waited.body.includes('FAKECANDECLR12X0729'),
        sameBody: waited.body === got.body,
        headers: waited.headers,
        ended: s.waits().map((w) => w['ended_by']),
      }).toEqual({
        status: 200,
        body: b.expected(runId),
        leaked: false,
        sameBody: true,
        headers: { ...got.headers, 'preference-applied': 'wait=20' },
        ended: ['terminal'],
      });
    },
  );

  it('C3: a run that ends after the last check but before N is answered 200 at N (N = 1, the check every 2 s)', async () => {
    const store = new InMemoryStore();
    const s = await serveListen([refunds], {
      store,
      over: {
        spawnAgent: agent(async (id) => {
          await sleep(400);
          return review(store, refunds, id, { approved: true });
        }, false),
      },
    });
    const a = answered(await postWait(s.port, '/refunds', { id: 'evt-1' }, 'wait=1'));
    // (a) red when the read at N sends a finished run as the `202` (`run_phase: "completed"`, no
    //     result); (b) prints the status, the phase, the time and the wait line.
    expect({
      status: a.status,
      phase: json(a.body)['run_phase'],
      atN: a.ms >= 900 && a.ms < 1900,
      ended: s.waits().map((w) => w['ended_by']),
    }).toEqual({ status: 200, phase: 'completed', atN: true, ended: ['terminal'] });
  });

  it('C3: a run that ends just before the first signal is answered 200 at the signal', async () => {
    const store = new InMemoryStore();
    const s = await serveHandler([refunds], {
      store,
      over: { spawnAgent: agent((id) => review(store, refunds, id, { approved: true }), false) },
    });
    const pending = postWait(s.port, '/refunds', { id: 'evt-1' }, 'wait=60');
    await sleep(500);
    s.stop.abort();
    const a = answered(await pending);
    // (a) red when the read at the signal sends a finished run as the `202`; (b) prints the
    //     status, the phase and the wait line.
    expect({
      status: a.status,
      phase: json(a.body)['run_phase'],
      ended: s.waits().map((w) => w['ended_by']),
    }).toEqual({ status: 200, phase: 'completed', ended: ['terminal'] });
  });
});

describe('R1.2 — a wait that ends before the run does', () => {
  it('C4: a run at a person’s gate is answered 202 gate_waiting within one check; the run stays at its gate', async () => {
    const store = new InMemoryStore();
    const s = await serveHandler([gated], {
      store,
      maxConcurrent: 2,
      over: {
        // No `exited`: only the check can end this wait.
        spawnAgent: agent(
          (id) =>
            executeStep(store, gated, {
              runId: id,
              command: 'review',
              input: {},
              dispatcher: async () => ({ summary: 'refund 12 EUR' }),
            }),
          false,
        ),
      },
    });
    const a = answered(await postWait(s.port, '/refunds', { id: 'evt-1' }, 'wait=8'));
    const runId = String(json(a.body)['run_id']);
    await s.settled();
    const after = (await store.get(runId)).record.pending_gate !== undefined;
    const next = answered(await postWait(s.port, '/refunds', { id: 'evt-2' }, 'wait=8'));
    // (a) red when a gate does not end the wait (the reply then comes at N, 8 s), when it ends as
    //     anything but `gate`, when the wait touches the run, or when the waiting place is kept
    //     (with --max-concurrent 2 the next request then gets no `Preference-Applied`); (b) prints
    //     the reply (code by shape), its time, the run's gate, the next reply's header and the lines.
    expect({
      reply: shown(a),
      withinOneCheck: a.ms < 3500,
      stillAtGate: after,
      next: next.headers['preference-applied'],
      ended: s.waits().map((w) => w['ended_by']),
    }).toEqual({
      reply: {
        status: 202,
        headers: {
          'content-type': 'application/json',
          'content-length': String(a.body.length),
          location: `/refunds/runs/${runId}`,
          'retry-after': '5',
          'preference-applied': 'wait=8',
        },
        body: {
          run_id: runId,
          status: 'accepted',
          run_phase: 'gate_waiting',
          status_path: `/refunds/runs/${runId}`,
          token: '<64 hex>',
        },
      },
      withinOneCheck: true,
      stillAtGate: true,
      next: 'wait=8',
      ended: ['gate', 'exit'],
    });
  });

  it('C5: a real agent process that exits 1 before the wait begins ends the wait at once: the 202 with the phase read after the exit', async () => {
    const store = new InMemoryStore();
    // The child: a real Node process that exits 1 in about 40 ms, started the way listen starts an
    // agent (detached, `stdio: 'inherit'`, unref'd), through the command's own spawner.
    const exitOne = ((_cmd: string, _args: readonly string[], o: Parameters<typeof nodeSpawn>[2]) =>
      nodeSpawn(process.execPath, ['-e', 'process.exit(1)'], o)) as unknown as typeof nodeSpawn;
    const s = await serveListen([refunds], {
      store,
      workflowDir: tmpdir(),
      over: {
        spawnAgent: makeAgentSpawner({ model: 'm-r12' }, capturingLogger(), exitOne),
        // The handler's write before the wait takes 300 ms: the child has exited by then.
        dedupStoreFor: () => ({
          check: async () => false,
          record: () => sleep(300),
          cleanup: async () => {},
        }),
      },
    });
    const a = answered(await postWait(s.port, '/refunds', { id: 'evt-1' }, 'wait=5'));
    // (a) red when the exit is listened for only once the wait begins (the exit is then missed and
    //     the reply comes at N, 5 s, as `cap`), or when the phase is not read after it; (b) prints
    //     the status, the phase, the time and the wait line.
    expect({
      status: a.status,
      phase: json(a.body)['run_phase'],
      applied: a.headers['preference-applied'],
      beforeAnyCheck: a.ms < 1800,
      ended: s.waits().map((w) => w['ended_by']),
    }).toEqual({
      status: 202,
      phase: 'running',
      applied: 'wait=5',
      beforeAnyCheck: true,
      ended: ['exit'],
    });
  }, 60_000);

  it('C5: a run that does not finish is answered 202 at N (N = 1, the shortest)', async () => {
    const s = await serveListen([refunds], { over: { spawnAgent: idle() } });
    const a = answered(await postWait(s.port, '/refunds', { id: 'evt-1' }, 'wait=1'));
    // (a) red when the cap does not end the wait, or ends it before N; (b) prints the status, the
    //     phase, the time (ms) and the wait line.
    expect(
      {
        status: a.status,
        phase: json(a.body)['run_phase'],
        atN: a.ms >= 950 && a.ms < 2000,
        ended: s.waits().map((w) => [w['ended_by'], typeof w['waited_ms']]),
      },
      `ms=${a.ms}`,
    ).toEqual({ status: 202, phase: 'running', atN: true, ended: [['cap', 'number']] });
  });
});

describe('R1.2 — the first signal', () => {
  it('C6: with --shutdown-drain 60 a waiter is answered within a moment of the stop; a POST during the drain does not wait', async () => {
    const s = await serveListen([refunds], {
      shutdownDrainSeconds: 60,
      over: { spawnAgent: idle() },
    });
    const pending = postWait(s.port, '/refunds', { id: 'evt-1' }, 'wait=60');
    await sleep(300);
    const t0 = performance.now();
    void s.handle.shutdown('test');
    const a = answered(await pending);
    const atStop = Math.round(performance.now() - t0);
    const during = answered(await postWait(s.port, '/refunds', { id: 'evt-2' }, 'wait=60'));
    // (a) red when the stop does not answer the waiter until the drain ends (60 s) or the grace,
    //     when it is aborted after the drain wait, or when a POST during the drain waits; (b)
    //     prints both replies' status, phase and header, the time from the stop and the lines.
    expect({
      waiter: [a.status, json(a.body)['run_phase'], a.headers['preference-applied']],
      promptly: atStop < 1000,
      during: [during.status, json(during.body)['run_phase'], during.headers['preference-applied']],
      ended: s.waits().map((w) => w['ended_by']),
    }).toEqual({
      waiter: [202, 'running', 'wait=25'],
      promptly: true,
      during: [202, 'running', undefined],
      ended: ['signal'],
    });
  });
});

describe('R1.2 — every ending releases what the wait held', () => {
  type Ending = {
    name: string;
    def: typeof refunds;
    prefer: string;
    spawn: (store: RunStore) => ReturnType<typeof agent>;
    /** Store doubles the cell needs (a slow write, a slow or failing read). */
    rig?: (store: InMemoryStore, s: { stop: AbortController }) => void;
    abortAtMs?: number;
    hangUpAtMs?: number;
    expected: { reply: 'answered' | 'hung up'; status?: number; ended: string[] };
  };
  const slowGet = (store: InMemoryStore) => {
    const get = store.get.bind(store);
    vi.spyOn(store, 'get').mockImplementation(async (id) => {
      await sleep(600);
      return get(id);
    });
  };
  const endings: Ending[] = [
    {
      name: 'terminal',
      def: refunds,
      prefer: 'wait=20',
      spawn: (st) => agent((id) => review(st, refunds, id, { approved: true })),
      expected: { reply: 'answered', status: 200, ended: ['terminal', 'exit'] },
    },
    {
      name: 'gate',
      def: gated,
      prefer: 'wait=20',
      spawn: (st) =>
        agent(
          (id) =>
            executeStep(st, gated, {
              runId: id,
              command: 'review',
              input: {},
              dispatcher: async () => ({ summary: 'x' }),
            }),
          false,
        ),
      expected: { reply: 'answered', status: 202, ended: ['gate', 'exit'] },
    },
    {
      name: 'exit',
      def: refunds,
      prefer: 'wait=20',
      spawn: () => agent(async () => undefined, true),
      expected: { reply: 'answered', status: 202, ended: ['exit', 'exit'] },
    },
    {
      name: 'cap',
      def: refunds,
      prefer: 'wait=1',
      spawn: () => idle(),
      expected: { reply: 'answered', status: 202, ended: ['cap', 'exit'] },
    },
    {
      name: 'signal',
      def: refunds,
      prefer: 'wait=60',
      spawn: () => idle(),
      abortAtMs: 300,
      expected: { reply: 'answered', status: 202, ended: ['signal'] },
    },
    {
      name: 'a hang-up before the wait begins (the write before it takes 300 ms)',
      def: refunds,
      prefer: 'wait=60',
      spawn: () => idle(),
      rig: (st) => {
        const update = st.update.bind(st);
        vi.spyOn(st, 'update').mockImplementationOnce(async (r) => {
          await sleep(300);
          return update(r);
        });
      },
      hangUpAtMs: 100,
      expected: { reply: 'hung up', ended: ['exit'] },
    },
    {
      name: 'a hang-up while a check reads the run',
      def: refunds,
      prefer: 'wait=60',
      spawn: () => idle(),
      rig: (st) => slowGet(st),
      hangUpAtMs: 2300,
      expected: { reply: 'hung up', ended: ['hangup', 'exit'] },
    },
    {
      name: 'a hang-up after the exit, while the read after it runs',
      def: refunds,
      prefer: 'wait=60',
      spawn: () => agent(async () => undefined, true),
      rig: (st) => slowGet(st),
      hangUpAtMs: 300,
      expected: { reply: 'hung up', ended: ['hangup', 'exit'] },
    },
    {
      name: 'a failed read',
      def: refunds,
      prefer: 'wait=20',
      spawn: () => agent(async () => undefined, true),
      rig: (st) => {
        vi.spyOn(st, 'get').mockRejectedValueOnce(new Error('database is locked'));
      },
      expected: { reply: 'answered', status: 202, ended: ['failed', 'exit'] },
    },
  ];

  it.each(endings.map((e) => [e.name, e] as const))(
    'C7: %s — no timer and no stop listener outlive the request; the next request may wait',
    async (_name, e) => {
      const store = new InMemoryStore();
      const s = await serveHandler([e.def], {
        store,
        maxConcurrent: 2,
        over: { spawnAgent: e.spawn(store) },
      });
      e.rig?.(store, s);
      // The test runner's own short timer at a cell's start ends first.
      await sleep(200);
      const before = timers();
      const beforeInfo = process.getActiveResourcesInfo().join(',');
      const pending = postWait(s.port, '/refunds', { id: 'evt-1' }, e.prefer, e.hangUpAtMs);
      if (e.abortAtMs !== undefined) {
        await sleep(e.abortAtMs);
        s.stop.abort();
      }
      const first = await pending;
      await s.settled();
      // A store double's own sleep (a read still under way when the caller hung up) ends first.
      await sleep(700);
      const left = { timers: timers() - before, stopListeners: s.abortListeners() };
      const afterInfo = process.getActiveResourcesInfo().join(',');
      vi.restoreAllMocks();
      // The next request may wait (the waiting place is free; with --max-concurrent 2 it is the
      // only one): its agent exits at once, so it ends as `exit`, with `Preference-Applied`.
      const next =
        e.abortAtMs === undefined
          ? answered(await postWait(s.port, '/refunds', { id: 'evt-2' }, 'wait=20'))
          : undefined;
      await s.settled();
      // (a) red when an ending leaves the cap or the check timer running, or the listener on the
      //     stop signal attached (`once` alone keeps it after every ending but the signal), when a
      //     hang-up is answered or held to N, or when an ending keeps its waiting place; (b) prints
      //     the reply's status, what was left, the next reply's header and the wait lines.
      expect(
        {
          reply: first === 'hung up' ? 'hung up' : 'answered',
          status: first === 'hung up' ? undefined : first.status,
          left,
          next: next?.headers['preference-applied'],
          ended: s.waits().map((w) => w['ended_by']),
        },
        `before: ${beforeInfo}; after: ${afterInfo}`,
      ).toEqual({
        reply: e.expected.reply,
        status: e.expected.status,
        left: { timers: 0, stopListeners: 0 },
        next: e.abortAtMs === undefined ? 'wait=20' : undefined,
        ended: e.expected.ended,
      });
    },
  );
});

describe('R1.2 — a caller that closes its side after sending', () => {
  it('C7: a caller that closes its side right after the body (as `nc -N` does) gets nothing; the run starts; the wait ends at once as a hang-up', async () => {
    const s = await serveHandler([refunds], { over: { spawnAgent: idle() } });
    const t0 = performance.now();
    const got = await halfClosedPost(s.port, '/refunds', { id: 'evt-1' }, 'wait=10');
    await s.settled();
    const settledMs = Math.round(performance.now() - t0);
    // (a) red when the wait does not end on the response's close (it then holds the request to N,
    //     10 s), when the closed caller is answered, or when no run is started; (b) prints what the
    //     caller got, the time the handling took, the runs dispatched and the wait lines.
    expect({
      got,
      promptly: settledMs < 2000,
      dispatched: s.logger.lines.filter((l) => l.msg === 'webhook: dispatched').length,
      ended: s.waits().map((w) => w['ended_by']),
    }).toEqual({ got: 'hung up', promptly: true, dispatched: 1, ended: ['hangup'] });
  });
});

describe('R1.2 — the waiting budget', () => {
  it('C8: --max-concurrent 3 --max-waiting 2: two wait; a third that asks is answered at once; a plain event is accepted', async () => {
    const s = await serveListen([refunds], {
      maxConcurrent: 3,
      maxWaiting: 2,
      over: { spawnAgent: vi.fn(async (): Promise<SpawnResult> => ({ pid: 4242 })) },
    });
    const w1 = postWait(s.port, '/refunds', { id: 'evt-1' }, 'wait=60');
    const w2 = postWait(s.port, '/refunds', { id: 'evt-2' }, 'wait=60');
    await sleep(300);
    const third = answered(await postWait(s.port, '/refunds', { id: 'evt-3' }, 'wait=60'));
    const event = answered(await postWait(s.port, '/refunds', { id: 'evt-4' }));
    void s.handle.shutdown('test');
    const held = [answered(await w1), answered(await w2)];
    // (a) red when waiters can take every place (the third then waits too, or the plain event gets
    //     `503`), or the budget is not --max-waiting; (b) prints each reply's status, header and
    //     time.
    expect({
      third: [third.status, third.headers['preference-applied'], third.ms < 1500],
      event: [event.status, event.headers['preference-applied']],
      held: held.map((h) => [h.status, h.headers['preference-applied']]),
    }).toEqual({
      third: [202, undefined, true],
      event: [202, undefined],
      held: [
        [202, 'wait=25'],
        [202, 'wait=25'],
      ],
    });
  });

  it('C8: a handler given more waiting places than --max-concurrent − 1 lets only that many wait', async () => {
    const s = await serveHandler([refunds], {
      maxConcurrent: 2,
      maxWaiting: 5,
      over: { spawnAgent: vi.fn(async (): Promise<SpawnResult> => ({ pid: 4242 })) },
    });
    const w1 = postWait(s.port, '/refunds', { id: 'evt-1' }, 'wait=60');
    await sleep(300);
    const second = answered(await postWait(s.port, '/refunds', { id: 'evt-2' }, 'wait=60'));
    s.stop.abort();
    const first = answered(await w1);
    // (a) red when the handler trusts its `maxWaiting` without the clamp (the second then waits,
    //     and both places are taken); (b) prints both replies' header and the second's time.
    expect({
      first: first.headers['preference-applied'],
      second: [second.headers['preference-applied'], second.ms < 1500],
    }).toEqual({ first: 'wait=25', second: [undefined, true] });
  });
});

describe('R1.2 — requests that never wait', () => {
  it('C9: a repeat of an event with Prefer gets the deduplicated reply, byte for byte, and never waits', async () => {
    const s = await serveListen([refunds], { over: { spawnAgent: exitsAtOnce() } });
    await postWait(s.port, '/refunds', { id: 'evt-1' }, 'wait=20');
    const withPrefer = answered(await postWait(s.port, '/refunds', { id: 'evt-1' }, 'wait=20'));
    const without = answered(await postWait(s.port, '/refunds', { id: 'evt-1' }));
    // (a) red when a repeat waits or its reply changes with the header; (b) prints both replies
    //     (codes by shape) and the wait lines (one: the first request's).
    expect({
      same: withPrefer.body === without.body,
      sameHeaders: JSON.stringify(withPrefer.headers) === JSON.stringify(without.headers),
      reply: shown(withPrefer),
      waits: s.waits().length,
    }).toMatchObject({
      same: true,
      sameHeaders: true,
      reply: { status: 200, body: { status: 'deduplicated', run_phase: 'running' } },
      waits: 1,
    });
  });

  it('C9: a failed start with Prefer gets the failure reply and no wait', async () => {
    const s = await serveListen([refunds], {
      over: {
        spawnAgent: vi.fn(async (): Promise<SpawnResult> => ({ error: new Error('ENOENT') })),
      },
    });
    const a = answered(await postWait(s.port, '/refunds', { id: 'evt-1' }, 'wait=20'));
    const runId = String(json(a.body)['run_id']);
    // (a) red when a failed start waits or its reply changes; (b) prints the reply and the lines.
    expect({
      status: a.status,
      body: a.body,
      applied: a.headers['preference-applied'],
      waits: s.waits(),
    }).toEqual({
      status: 500,
      body: `{"error":"spawn_failed","run_id":"${runId}","status":"failed"}`,
      applied: undefined,
      waits: [],
    });
  });
});

describe('R1.2 — a read that fails inside the wait', () => {
  it('C10: a check whose read fails is tried again at the next check; one `read failed` line', async () => {
    const store = new InMemoryStore();
    const s = await serveListen([refunds], {
      store,
      over: { spawnAgent: agent((id) => review(store, refunds, id, { approved: true }), false) },
    });
    const pending = postWait(s.port, '/refunds', { id: 'evt-1' }, 'wait=20');
    // After the agent's work (which reads the run too), before the first check at 2 s.
    await sleep(600);
    vi.spyOn(store, 'get').mockRejectedValueOnce(new Error('database is locked'));
    const a = answered(await pending);
    const failed = s.logger.lines.filter((l) => l.msg === 'webhook: read failed');
    // (a) red when a failed check ends the wait, answers `500`, or is not logged; (b) prints the
    //     status, the time, the failure lines and the wait line.
    expect({
      status: a.status,
      atSecondCheck: a.ms >= 3500 && a.ms < 6000,
      failed: failed.map((l) => [l.level, (l.data as Record<string, unknown>)['error']]),
      ended: s.waits().map((w) => w['ended_by']),
    }).toEqual({
      status: 200,
      atSecondCheck: true,
      failed: [['error', 'Error: database is locked']],
      ended: ['terminal'],
    });
  });

  it.each([
    ['the read after the exit', 'get'],
    ['the disclosure set at a finished run', 'provider'],
  ] as const)(
    'C10: when %s fails, the reply is the one without Prefer; one `read failed` line; the wait says `failed`',
    async (_what, which) => {
      const store = new InMemoryStore();
      const s = await serveListen([refunds], {
        store,
        provider: async () => {
          if (which === 'provider') throw new Error('the manifest cannot be read');
          return emptySet();
        },
        over: {
          spawnAgent: agent((id) =>
            which === 'get' ? Promise.resolve() : review(store, refunds, id, { approved: true }),
          ),
        },
      });
      if (which === 'get') {
        vi.spyOn(store, 'get').mockRejectedValue(new Error('database is locked'));
      }
      const a = answered(await postWait(s.port, '/refunds', { id: 'evt-1' }, 'wait=20'));
      // (a) red when a failed read answers `500`, hangs the request, keeps `Preference-Applied`,
      //     or is not logged; (b) prints the reply (code by shape), the failure lines and the line.
      expect({
        reply: shown(a),
        failed: s.logger.lines.filter((l) => l.msg === 'webhook: read failed').length,
        ended: s.waits().map((w) => w['ended_by']),
      }).toMatchObject({
        reply: {
          status: 202,
          headers: { 'retry-after': '5' },
          body: { status: 'accepted', run_phase: 'running', token: '<64 hex>' },
        },
        failed: 1,
        ended: ['failed'],
      });
      expect(a.headers['preference-applied']).toBeUndefined();
    },
  );
});

describe('R1.2 — the options', () => {
  it('C11: --max-wait 0 turns waiting off: Prefer is ignored', async () => {
    const s = await serveListen([refunds], {
      maxWaitSeconds: 0,
      over: { spawnAgent: exitsAtOnce() },
    });
    const a = answered(await postWait(s.port, '/refunds', { id: 'evt-1' }, 'wait=20'));
    // (a) red when --max-wait 0 still waits (then `Preference-Applied` and a wait line); (b) prints
    //     the header and the lines.
    expect({ applied: a.headers['preference-applied'], waits: s.waits() }).toEqual({
      applied: undefined,
      waits: [],
    });
  });

  it('C11: --max-concurrent 1 leaves no waiting place: Prefer is answered at once', async () => {
    const s = await serveListen([refunds], { maxConcurrent: 1, over: { spawnAgent: idle() } });
    const a = answered(await postWait(s.port, '/refunds', { id: 'evt-1' }, 'wait=20'));
    // (a) red when the one place can be held by a waiter; (b) prints the header, time and lines.
    expect({
      applied: a.headers['preference-applied'],
      fast: a.ms < 1500,
      waits: s.waits(),
    }).toEqual({
      applied: undefined,
      fast: true,
      waits: [],
    });
  });

  it('C11: the two options’ help, defaults and parsers', () => {
    const opt = (long: string) => listenCommand.options.find((o) => o.long === long);
    const refusal = (f: () => unknown): string => {
      try {
        f();
        return 'accepted';
      } catch (err) {
        return (err as Error).message;
      }
    };
    // (a) red when a help text differs from the prompt's words, `--max-wait`'s default is not 25 or
    //     `--max-waiting` gains a Commander default (a derived one must never be refused), or a
    //     parser takes a word it must refuse; (b) prints each text, default and verdict.
    expect({
      waitHelp: opt('--max-wait')?.description,
      waitingHelp: opt('--max-waiting')?.description,
      defaults: [opt('--max-wait')?.defaultValue, opt('--max-waiting')?.defaultValue],
      maxWait: ['0', '300', '301', '-1', 'abc'].map((v) =>
        refusal(() => opt('--max-wait')!.parseArg!(v, undefined)),
      ),
      maxWaiting: ['1', '2147483646', '0', '2147483647', '-1', 'abc'].map((v) =>
        refusal(() => parseMaxWaiting(v)),
      ),
    }).toEqual({
      waitHelp:
        'Longest a request that sends Prefer: wait=N is held before it is answered, in seconds, a whole number from 0 to 300; 0 turns waiting off. A workflow without result_map ignores the header.',
      waitingHelp:
        'How many requests may be held waiting at once, a whole number from 1 to one less than --max-concurrent; the default is 5, or one less than --max-concurrent if that is smaller. A waiting request keeps its place among --max-concurrent.',
      defaults: [25, undefined],
      maxWait: [
        'accepted',
        'accepted',
        '--max-wait must be a whole number from 0 to 300.',
        '--max-wait must be a whole number from 0 to 300.',
        '--max-wait must be a whole number from 0 to 300.',
      ],
      maxWaiting: [
        'accepted',
        'accepted',
        '--max-waiting must be a whole number from 1 to one less than --max-concurrent.',
        '--max-waiting must be a whole number from 1 to one less than --max-concurrent.',
        '--max-waiting must be a whole number from 1 to one less than --max-concurrent.',
        '--max-waiting must be a whole number from 1 to one less than --max-concurrent.',
      ],
    });
  });
});

describe('R1.2 — the log line', () => {
  it('C12: one `webhook: wait ended` at info per wait, with the run, the ending and the time, and nothing of the run’s', async () => {
    const store = new InMemoryStore();
    const s = await serveListen([refunds], {
      store,
      over: {
        spawnAgent: agent((id) => review(store, refunds, id, { approved: 'FAKECANLOGR12X0729' })),
      },
    });
    await postWait(s.port, '/refunds', { id: 'evt-1' }, 'wait=20');
    const lines = s.logger.lines.filter((l) => l.msg === 'webhook: wait ended');
    // (a) red when the line is missing, repeated, at another level, or carries anything but the
    //     three fields (a value of the run's would show); (b) prints the lines' levels and keys and
    //     whether the canary is in any line.
    expect({
      levels: lines.map((l) => l.level),
      keys: lines.map((l) => Object.keys(l.data as object)),
      leaked: JSON.stringify(s.logger.lines).includes('FAKECANLOGR12X0729'),
    }).toEqual({ levels: ['info'], keys: [['run_id', 'ended_by', 'waited_ms']], leaked: false });
  });
});
