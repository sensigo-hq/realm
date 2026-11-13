// listen-result-read-r11.test.ts — R1.1 on `realm listen`'s start and its replies to a POST: a
// workflow with `trigger.result_map` gets a read key worked out from its secret at start (two such
// workflows cannot share a read address; a short secret is warned about), its `202` says where and
// with what code to read the run, and a repeat of an event names its run (for every workflow; the
// code only for one with `result_map`). Every reply cell runs a real listen server on loopback over
// a store (`test-support/listen-read-r11.ts`) and reads the status, headers and body as sent. A
// failing cell prints those; a code is printed only as its shape or as "the same as the first".
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { abandonRun, type DedupStore } from '@sensigo/realm';
import { buildRouteTable, prepareListenWorkflows, type SpawnResult } from './listen.js';
import { purgeRuns } from './purge.js';
import { deriveReadKey } from '../lib/run-read-address.js';
import { makeTempHome } from '../test-support/temp-home.js';
import {
  ENV,
  capturingLogger,
  post,
  read,
  serve,
  sharedSecretTrigger,
  workflow,
} from '../test-support/listen-read-r11.js';
import type { loadProjectExtensions } from '../extensions/load-project-extensions.js';

const MAP = { approved: 'context.resources.review.approved' };
const optedIn = (id: string, path: string, secretFrom = 'READ_SECRET') =>
  workflow(id, sharedSecretTrigger(path, MAP, secretFrom));
const plain = (id: string, path: string, secretFrom = 'READ_SECRET') =>
  workflow(id, sharedSecretTrigger(path, undefined, secretFrom));
const json = (body: string): Record<string, unknown> => JSON.parse(body) as Record<string, unknown>;
const HEX64 = /^[0-9a-f]{64}$/;
/** A reply's body with its token replaced by its shape, so a failure never prints a code. */
const shown = (body: string, first?: string): Record<string, unknown> => {
  const b = json(body);
  if (typeof b['token'] === 'string') {
    b['token'] = b['token'] === first ? '<the first>' : HEX64.test(b['token']) ? '<64 hex>' : '<?>';
  }
  return b;
};
const noExtensions = (async () => ({
  registry: {} as never,
  manifest: { modules: [], adapters: [], handlers: [], processors: [] },
})) as unknown as typeof loadProjectExtensions;

describe('R1.1 — at start', () => {
  it('R1: two workflows with result_map whose paths differ only by a trailing slash refuse to start', () => {
    // (a) red when the read address's prefix is not normalised (then `/a` and `/a/` start and share
    //     `/a/runs/…`); (b) prints the error's message.
    expect(() =>
      buildRouteTable(
        [
          { definition: optedIn('first', '/a'), workflowDir: '/tmp/a' },
          { definition: optedIn('second', '/a/'), workflowDir: '/tmp/b' },
        ],
        { env: ENV, logger: capturingLogger() },
      ),
    ).toThrow(
      "listen: the read address '/a/runs/<run id>' is taken twice — workflow 'second' conflicts with 'first'; give each workflow with a result_map its own trigger.path",
    );
  });

  it('R1: a workflow with result_map at `/a/` beside one without it at `/a` starts', () => {
    // (a) red when a workflow without result_map is counted for the read address; (b) prints the
    //     mounted paths.
    const routes = buildRouteTable(
      [
        { definition: optedIn('first', '/a/'), workflowDir: '/tmp/a' },
        { definition: plain('second', '/a'), workflowDir: '/tmp/b' },
      ],
      { env: ENV, logger: capturingLogger() },
    );
    expect([...routes.keys()]).toEqual(['/a/', '/a']);
  });

  it('S1: a secret under 16 characters is warned about once, only on a workflow with result_map', () => {
    const logger = capturingLogger();
    buildRouteTable(
      [
        { definition: optedIn('short', '/short', 'SHORT_SECRET'), workflowDir: '/tmp/a' },
        { definition: optedIn('long', '/long', 'SIXTEEN'), workflowDir: '/tmp/b' },
        { definition: plain('unread', '/unread', 'SHORT_SECRET'), workflowDir: '/tmp/c' },
      ],
      { env: { ...ENV, SIXTEEN: 'sixteen-chars-ok' }, logger },
    );
    // (a) red when the warning is missing for 15 characters, given for 16, or given for a workflow
    //     without result_map; (b) prints every warn line (they name workflows, never a secret).
    expect(logger.lines.filter((l) => l.level === 'warn').map((l) => l.msg)).toEqual([
      "listen: the secret for workflow 'short' has fewer than 16 characters; a read code made from it can be guessed offline from one captured code. Use a longer secret.",
    ]);
    expect(ENV['SHORT_SECRET']).toHaveLength(15);
  });

  it('S2: preparing 8 workflows with result_map returns only once each has its key; one without gets none', async () => {
    const definitions = [
      ...Array.from({ length: 8 }, (_, i) => optedIn(`w${i}`, `/w${i}`)),
      plain('unread', '/unread'),
    ];
    const routes = buildRouteTable(
      definitions.map((definition) => ({ definition, workflowDir: '/tmp/w' })),
      { env: ENV, logger: capturingLogger() },
    );
    let finished = 0;
    const counting: typeof deriveReadKey = async (secret, id) => {
      const key = await deriveReadKey(secret, id);
      finished += 1;
      return key;
    };
    await prepareListenWorkflows(
      routes,
      { workflowStore: { register: async () => {}, get: vi.fn() }, logger: capturingLogger() },
      noExtensions,
      counting,
    );
    // (a) red when the derivation is started and not awaited (it takes about 100 ms each, so fewer
    //     than 8 have finished when the function returns), is done lazily, or is done for a
    //     workflow without result_map; (b) prints the count and which entries hold a key.
    expect({
      finished,
      keyed: [...routes.values()].map((e) => [e.definition.id, e.readKey?.length ?? 0]),
    }).toEqual({
      finished: 8,
      keyed: [...Array.from({ length: 8 }, (_, i) => [`w${i}`, 32]), ['unread', 0]],
    });
  });

  it('S2: the very first request after start gets a code that opens its run', async () => {
    const s = await serve([optedIn('refunds', '/refunds')]);
    const accepted = json((await post(s.port, '/refunds', { id: 'evt-1' })).body);
    const r = await read(
      s.port,
      '/refunds',
      String(accepted['run_id']),
      `Bearer ${String(accepted['token'])}`,
    );
    // (a) red when the server listens before the key exists (the first reply then has no token and
    //     the read is refused); (b) prints the read's status and body.
    expect([r.status, json(r.body)]).toEqual([
      200,
      { run_id: accepted['run_id'], run_phase: 'running' },
    ]);
  });
});

describe('R1.1 — the 202', () => {
  it.each([
    ['/refunds', '/refunds/runs/'],
    ['/refunds/', '/refunds/runs/'],
    ['/', '/runs/'],
  ])(
    'P1: a workflow with result_map at %s is answered with the run, its phase, its read address and its code',
    async (path, prefix) => {
      const s = await serve([optedIn('refunds', path)]);
      const r = await post(s.port, path, { id: 'evt-1' });
      const b = json(r.body);
      const runId = String(b['run_id']);
      // (a) red when a field is missing or extra, the address has a `//` or lacks the workflow's
      //     path, the code is not 64 hex, or `Location` / `Retry-After` are not sent; (b) prints
      //     the status, the body (the code by its shape) and the two headers.
      expect({
        status: r.status,
        body: shown(r.body),
        location: r.headers['location'],
        retryAfter: r.headers['retry-after'],
      }).toEqual({
        status: 202,
        body: {
          run_id: runId,
          status: 'accepted',
          run_phase: 'running',
          status_path: `${prefix}${runId}`,
          token: '<64 hex>',
        },
        location: `${prefix}${runId}`,
        retryAfter: '5',
      });
    },
  );

  it('P1: a workflow without result_map is answered exactly as before, headers included', async () => {
    const s = await serve([plain('refunds', '/refunds')]);
    const r = await post(s.port, '/refunds', { id: 'evt-1' });
    const runId = String(json(r.body)['run_id']);
    // (a) red when a workflow without result_map gets any new field or header; (b) prints the
    //     reply.
    expect(r).toEqual({
      status: 202,
      headers: {
        'content-type': 'application/json',
        'content-length': String(r.body.length),
        connection: 'keep-alive',
        'keep-alive': 'timeout=5',
      },
      body: `{"run_id":"${runId}","status":"accepted"}`,
    });
  });
});

describe('R1.1 — a repeat of an event', () => {
  it('P2: inside the window the repeat names the run; with result_map it carries the same code again', async () => {
    const s = await serve([optedIn('refunds', '/refunds'), plain('plain', '/plain')]);
    const first = json((await post(s.port, '/refunds', { id: 'evt-1' })).body);
    const firstPlain = json((await post(s.port, '/plain', { id: 'evt-1' })).body);
    const again = await post(s.port, '/refunds', { id: 'evt-1' });
    const againPlain = await post(s.port, '/plain', { id: 'evt-1' });
    // (a) red when the repeat inside the window is the bare reply again (before R1.1), names the
    //     wrong run, carries another code, or carries a code for a workflow without result_map;
    //     (b) prints both replies (the code as "the first" or its shape).
    expect({
      opted: [again.status, shown(again.body, String(first['token']))],
      plain: [againPlain.status, json(againPlain.body)],
    }).toEqual({
      opted: [
        200,
        {
          status: 'deduplicated',
          run_id: first['run_id'],
          run_phase: 'running',
          status_path: first['status_path'],
          token: '<the first>',
        },
      ],
      plain: [200, { status: 'deduplicated', run_id: firstPlain['run_id'], run_phase: 'running' }],
    });
  });

  it('P2: after the window (the dedup store no longer has the event) the repeat carries the read address and code too', async () => {
    const forgetting: DedupStore = {
      check: async () => false,
      record: async () => {},
      cleanup: async () => {},
    };
    const s = await serve([optedIn('refunds', '/refunds'), plain('plain', '/plain')], {
      over: { dedupStoreFor: () => forgetting },
    });
    const first = json((await post(s.port, '/refunds', { id: 'evt-1' })).body);
    const firstPlain = json((await post(s.port, '/plain', { id: 'evt-1' })).body);
    const again = await post(s.port, '/refunds', { id: 'evt-1' });
    const againPlain = await post(s.port, '/plain', { id: 'evt-1' });
    // (a) red when the run-store match's reply lacks the read address or code for a workflow with
    //     result_map, or gains them for one without; (b) prints both replies.
    expect({
      opted: [again.status, shown(again.body, String(first['token']))],
      plain: [againPlain.status, json(againPlain.body)],
    }).toEqual({
      opted: [
        200,
        {
          status: 'deduplicated',
          run_id: first['run_id'],
          run_phase: 'running',
          status_path: first['status_path'],
          token: '<the first>',
        },
      ],
      plain: [200, { status: 'deduplicated', run_id: firstPlain['run_id'], run_phase: 'running' }],
    });
  });

  it('P2: two copies arriving together get one run; the copy that did not create it carries the same code', async () => {
    // Both copies pass the dedup check before either is recorded: the check waits for both.
    const waiting: Array<() => void> = [];
    const together: DedupStore = {
      check: () =>
        new Promise<boolean>((resolve) => {
          waiting.push(() => resolve(false));
          if (waiting.length === 2) for (const go of waiting) go();
        }),
      record: async () => {},
      cleanup: async () => {},
    };
    const s = await serve([optedIn('refunds', '/refunds')], {
      over: { dedupStoreFor: () => together },
    });
    const replies = await Promise.all([
      post(s.port, '/refunds', { id: 'evt-1' }),
      post(s.port, '/refunds', { id: 'evt-1' }),
    ]);
    const created = replies.find((r) => r.status === 202);
    const matched = replies.find((r) => r.status === 200);
    const token = created === undefined ? '' : String(json(created.body)['token']);
    // (a) red when the copy matched by the run store lacks the read address or code, or both copies
    //     start a run; (b) prints the two statuses and the matched reply.
    expect({
      statuses: replies.map((r) => r.status).sort(),
      matched: matched === undefined ? undefined : shown(matched.body, token),
    }).toEqual({
      statuses: [200, 202],
      matched: {
        status: 'deduplicated',
        run_id: created === undefined ? undefined : json(created.body)['run_id'],
        run_phase: 'running',
        status_path: created === undefined ? undefined : json(created.body)['status_path'],
        token: '<the first>',
      },
    });
  });

  it('P2: inside the window, a purged run, a store that cannot resolve the event, or a run that cannot be read gets the bare reply', async () => {
    const h = await makeTempHome();
    onTestFinished(() => h.cleanup());
    const store = h.home.runStore;
    const s = await serve([optedIn('refunds', '/refunds')], { store });
    // Purged: the run ended and was purged; its event is still inside the window.
    const purgedRun = String(
      json((await post(s.port, '/refunds', { id: 'evt-purged' })).body)['run_id'],
    );
    await abandonRun(store, purgedRun);
    await purgeRuns({ runId: purgedRun, dryRun: false }, store, []);
    const purged = await post(s.port, '/refunds', { id: 'evt-purged' });
    // The store fails: once to resolve the event, once to read the run.
    await post(s.port, '/refunds', { id: 'evt-a' });
    await post(s.port, '/refunds', { id: 'evt-b' });
    vi.spyOn(store, 'resolveKey').mockRejectedValueOnce(new Error('database is locked'));
    const keyFails = await post(s.port, '/refunds', { id: 'evt-a' });
    vi.spyOn(store, 'get').mockRejectedValueOnce(new Error('database is locked'));
    const getFails = await post(s.port, '/refunds', { id: 'evt-b' });
    // (a) red when a purged run, or a failing store, gives anything but the bare reply (a 500, a
    //     stale run, a code); (b) prints the three replies.
    expect([purged, keyFails, getFails].map((r) => [r.status, r.body])).toEqual([
      [200, '{"status":"deduplicated"}'],
      [200, '{"status":"deduplicated"}'],
      [200, '{"status":"deduplicated"}'],
    ]);
  });

  it('P2: a failed start and its repeat are answered 500 spawn_failed, with no read address or code', async () => {
    const s = await serve([optedIn('refunds', '/refunds')], {
      over: {
        spawnAgent: vi.fn(async (): Promise<SpawnResult> => ({ error: new Error('ENOENT') })),
      },
    });
    const first = await post(s.port, '/refunds', { id: 'evt-1' });
    const again = await post(s.port, '/refunds', { id: 'evt-1' });
    const runId = String(json(first.body)['run_id']);
    // (a) red when a failed start's reply, or its repeat's, carries the read address or a code;
    //     (b) prints both replies.
    expect([first, again].map((r) => [r.status, r.body])).toEqual([
      [500, `{"error":"spawn_failed","run_id":"${runId}","status":"failed"}`],
      [500, `{"error":"spawn_failed","run_id":"${runId}","status":"failed"}`],
    ]);
    // Two copies that arrived together while the start failed leave the event's ID recorded: a
    // repeat inside the window then meets the dedup check. Recorded here as that race leaves it.
    await s.deps.dedupStoreFor('refunds').record('evt-1', 60 * 60_000);
    const inWindow = await post(s.port, '/refunds', { id: 'evt-1' });
    // (a) red when the repeat of a run a failed start sealed names it or carries a code (its replies
    //     are unchanged by R1.1: the bare one inside the window); (b) prints the reply.
    expect([inWindow.status, inWindow.body]).toEqual([200, '{"status":"deduplicated"}']);
  });
});
