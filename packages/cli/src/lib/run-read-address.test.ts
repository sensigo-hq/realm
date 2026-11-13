// run-read-address.test.ts — R1.1: the read address of `realm listen`, `GET`/`HEAD`
// `<path>/runs/<run id>`, as a caller meets it. A workflow with `trigger.result_map` hands its
// caller a code per run; with it, the caller reads the run's phase and, once completed, the values
// the map declares, walked by the disclosure set of that read. Every cell runs a real listen server
// on loopback over the in-memory store (`test-support/listen-read-r11.ts`), with runs the engine put
// in each phase, and reads the status, the headers and the body as sent. A failing cell prints those
// (a code only as its length or by its label), never a secret.
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { connect } from 'node:net';
import { abandonRun, executeStep } from '@sensigo/realm';
import { purgeRuns } from '../commands/purge.js';
import { makeTempHome } from '../test-support/temp-home.js';
import { InMemoryStore } from '@sensigo/realm-testing';
import {
  completedRun,
  createRun,
  ENV,
  http,
  post,
  read,
  serve,
  sharedSecretTrigger,
  workflow,
} from '../test-support/listen-read-r11.js';
import { compileDisclosure, type DisclosureSet } from '@sensigo/realm';

const READ_MAP = { approved: 'context.resources.review.approved' };
const refunds = workflow('refunds', sharedSecretTrigger('/refunds', READ_MAP));
const bearer = (code: string): string => `Bearer ${code}`;
const json = (body: string): unknown => JSON.parse(body);
const FORBIDDEN_BODY = '{"error":"forbidden"}';
/** The one 403 every refused read gets, as sent. */
const FORBIDDEN = {
  status: 403,
  headers: {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': String(FORBIDDEN_BODY.length),
    connection: 'keep-alive',
    'keep-alive': 'timeout=5',
  },
  body: FORBIDDEN_BODY,
};
const UNKNOWN_RUN = '0b6d3c39-58f5-4a7e-9d0e-6b2f1c3a9e01';

describe('R1.1 — the read address: phases', () => {
  it('G2: a run that is not completed says its phase and nothing else, in each of the five phases', async () => {
    const store = new InMemoryStore();
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
          abort_message: 'CANARY-ABORT-0729',
        },
      },
    });
    const running = await createRun(store, refunds);
    const waiting = await createRun(store, gated);
    await executeStep(store, gated, {
      runId: waiting,
      command: 'review',
      input: {},
      dispatcher: async () => ({ summary: 'CANARY-PREVIEW-0729' }),
    });
    const failed = await createRun(store, refunds);
    await executeStep(store, refunds, {
      runId: failed,
      command: 'review',
      input: {},
      dispatcher: async () => {
        throw new Error('CANARY-ERROR-0729');
      },
    }).catch(() => undefined);
    const aborted = await createRun(store, guarded);
    await executeStep(store, guarded, {
      runId: aborted,
      command: 'review',
      input: { ok: false },
      dispatcher: async (_c, input) => input,
    });
    await executeStep(store, guarded, {
      runId: aborted,
      command: 'stop',
      input: {},
      dispatcher: async () => ({}),
    }).catch(() => undefined);
    const abandoned = await createRun(store, refunds);
    await abandonRun(store, abandoned);
    const s = await serve([refunds], { store });
    const gateId = (await store.get(waiting)).record.pending_gate?.gate_id ?? 'no gate';
    const canaries = (body: string): string[] =>
      ['CANARY-ERROR-0729', 'CANARY-ABORT-0729', 'CANARY-PREVIEW-0729', gateId].filter((c) =>
        body.includes(c),
      );
    const seen = [];
    for (const [phase, runId] of [
      ['running', running],
      ['gate_waiting', waiting],
      ['failed', failed],
      ['aborted', aborted],
      ['abandoned', abandoned],
    ] as const) {
      const r = await read(s.port, '/refunds', runId, bearer(s.code('/refunds', runId)));
      seen.push({ phase, status: r.status, body: json(r.body), leaked: canaries(r.body).length });
    }
    // (a) red when a reply carries anything of the run but its phase (an error or abort text, the
    //     `terminal_reason`, the gate's id, a step's data), or derives another phase; (b) prints each
    //     phase's status, body and how many canaries leaked (the count, never which value).
    expect(seen).toEqual(
      [
        ['running', running],
        ['gate_waiting', waiting],
        ['failed', failed],
        ['aborted', aborted],
        ['abandoned', abandoned],
      ].map(([phase, runId]) => ({
        phase,
        status: 200,
        body: { run_id: runId, run_phase: phase },
        leaked: 0,
      })),
    );
  });
});

describe('R1.1 — the read address: the result', () => {
  it('G3: an empty map gives no result; a map none of whose paths resolve gives an empty one', async () => {
    const store = new InMemoryStore();
    const phaseOnly = workflow('refunds', sharedSecretTrigger('/refunds', {}));
    const nothing = workflow(
      'misses',
      sharedSecretTrigger('/misses', {
        a: 'context.resources.review.missing',
        b: 'context.resources.review.approved.deeper',
      }),
    );
    const one = await completedRun(store, phaseOnly, { approved: true });
    const two = await completedRun(store, nothing, { approved: true });
    const s = await serve([phaseOnly, nothing], { store });
    const r1 = await read(s.port, '/refunds', one, bearer(s.code('/refunds', one)));
    const r2 = await read(s.port, '/misses', two, bearer(s.code('/misses', two)));
    // (a) red when the two empties are confused (`result: {}` for the phase-only map, or no
    //     `result` when the map's paths found nothing); (b) prints both bodies.
    expect({ phaseOnly: json(r1.body), nothing: json(r2.body) }).toEqual({
      phaseOnly: { run_id: one, run_phase: 'completed' },
      nothing: {
        run_id: two,
        run_phase: 'completed',
        result: {},
        result_masked: { declared: 0, environment: 0, pattern: 0 },
      },
    });
  });

  it('G3: a found path is given, a missing one left out, a null kept as null, an array element by its index', async () => {
    const store = new InMemoryStore();
    const def = workflow(
      'refunds',
      sharedSecretTrigger('/refunds', {
        approved: 'context.resources.review.approved',
        reason: 'context.resources.review.reason',
        note: 'context.resources.review.note',
        second: 'context.resources.review.items.1',
        past_end: 'context.resources.review.items.5',
      }),
    );
    const runId = await completedRun(store, def, {
      approved: true,
      note: null,
      items: ['first', 'second'],
    });
    const s = await serve([def], { store });
    const r = await read(s.port, '/refunds', runId, bearer(s.code('/refunds', runId)));
    // (a) red when a `null` is left out as if missing, a missing field comes back as `null`, an
    //     index does not reach the array element, or the map's order changes; (b) prints the body.
    expect(r.body).toBe(
      JSON.stringify({
        run_id: runId,
        run_phase: 'completed',
        result: { approved: true, note: null, second: 'second' },
        result_masked: { declared: 0, environment: 0, pattern: 0 },
      }),
    );
  });

  it('G3: `__proto__` and `constructor` in a path find nothing, and a name `__proto__` is an own key', async () => {
    const store = new InMemoryStore();
    // JSON.parse makes `__proto__` an own key of the map, as a YAML parser would.
    const map = JSON.parse(
      '{"__proto__":"context.resources.review.approved","a":"context.resources.review.__proto__.x","b":"context.resources.review.constructor","c":"context.resources.review.items.length"}',
    ) as Record<string, string>;
    const def = workflow('refunds', sharedSecretTrigger('/refunds', map));
    const runId = await completedRun(store, def, { approved: true, items: ['x'] });
    const s = await serve([def], { store });
    const r = await read(s.port, '/refunds', runId, bearer(s.code('/refunds', runId)));
    const body = json(r.body) as { result: object };
    // (a) red when a path follows a prototype (`__proto__`, `constructor`) or an array's `length`,
    //     or when the name `__proto__` sets the result's prototype instead of being a key; (b)
    //     prints the result's own keys, its prototype being Object's, and the raw result.
    expect({
      keys: Object.keys(body.result),
      plainPrototype: Object.getPrototypeOf(body.result) === Object.prototype,
      raw: r.body.slice(r.body.indexOf('"result":'), r.body.indexOf(',"result_masked"')),
    }).toEqual({ keys: ['__proto__'], plainPrototype: true, raw: '"result":{"__proto__":true}' });
  });

  it('G5: a result of 39,999 or 40,000 characters is given; of 40,001 it is too large, and a 5 MB one never reaches the walk', async () => {
    const store = new InMemoryStore();
    const def = workflow(
      'refunds',
      sharedSecretTrigger('/refunds', { v: 'context.resources.review.v' }),
    );
    // `{"v":""}` is 8 characters.
    const sized = async (n: number) => completedRun(store, def, { v: 'x'.repeat(n - 8) });
    const runs = [await sized(39_999), await sized(40_000), await sized(40_001)];
    const big = await completedRun(store, def, { v: 'x'.repeat(5_000_000) });
    const s = await serve([def], { store });
    const shape = async (runId: string) => {
      const b = json(
        (await read(s.port, '/refunds', runId, bearer(s.code('/refunds', runId)))).body,
      ) as Record<string, unknown>;
      return Object.keys(b)
        .filter((k) => k !== 'run_id' && k !== 'run_phase')
        .map((k) => `${k}=${k === 'result' ? 'given' : JSON.stringify(b[k])}`);
    };
    const shapes = [await shape(runs[0]!), await shape(runs[1]!), await shape(runs[2]!)];
    const calls = s.provider.mock.calls.length;
    const bigShape = await shape(big);
    // (a) red when the limit moves (40,000 is the MCP door's), the comparison is `>=`, a too-large
    //     result still carries `result` or `result_masked`, or the size is checked after the walk
    //     (then the provider is called for the 5 MB one); (b) prints each reply's fields and the
    //     provider's call counts.
    expect({ shapes, bigShape, providerCallsForBig: s.provider.mock.calls.length - calls }).toEqual(
      {
        shapes: [
          ['result=given', 'result_masked={"declared":0,"environment":0,"pattern":0}'],
          ['result=given', 'result_masked={"declared":0,"environment":0,"pattern":0}'],
          ['result_error="too_large"'],
        ],
        bigShape: ['result_error="too_large"'],
        providerCallsForBig: 0,
      },
    );
  });

  it('G7: a run started under another version of the workflow is still answered, flagged', async () => {
    const store = new InMemoryStore();
    const v1 = workflow('refunds', sharedSecretTrigger('/refunds', READ_MAP));
    const v2 = { ...v1, version: 2 };
    const old = await completedRun(store, v1, { approved: true });
    const same = await completedRun(store, v2, { approved: false });
    const s = await serve([v2], { store });
    const body = async (runId: string) =>
      json((await read(s.port, '/refunds', runId, bearer(s.code('/refunds', runId)))).body);
    // (a) red when a version that differs gives an error instead of the result, or when the flag
    //     is always (or never) set; (b) prints both bodies.
    expect({ old: await body(old), same: await body(same) }).toEqual({
      old: {
        run_id: old,
        run_phase: 'completed',
        result: { approved: true },
        result_masked: { declared: 0, environment: 0, pattern: 0 },
        workflow_version_differs: true,
      },
      same: {
        run_id: same,
        run_phase: 'completed',
        result: { approved: false },
        result_masked: { declared: 0, environment: 0, pattern: 0 },
      },
    });
  });

  it('G4 (in process): a value the set holds is hidden in the result and counted; with the walk bypassed it would show', async () => {
    const store = new InMemoryStore();
    const def = workflow(
      'refunds',
      sharedSecretTrigger('/refunds', { note: 'context.resources.review.note' }),
    );
    const runId = await completedRun(store, def, { note: 'refund FAKECANDECLR11X0729 now' });
    const set = compileDisclosure([{ value: 'FAKECANDECLR11X0729', source: 'declared:D_NOTE' }], {
      declared: 'resolved',
      audience: 'agent',
      environment: 'swept',
    }).set;
    const s = await serve([def], { store, provider: async () => set });
    const r = await read(s.port, '/refunds', runId, bearer(s.code('/refunds', runId)));
    // (a) red when the result bypasses the disclosure walk (the declared value then shows) or the
    //     counts are not the walk's; (b) prints whether the canary is in the body and the counts.
    expect({
      leaked: r.body.includes('FAKECANDECLR11X0729'),
      masked: (json(r.body) as { result_masked: unknown }).result_masked,
    }).toEqual({ leaked: false, masked: { declared: 1, environment: 0, pattern: 0 } });
  });

  it.each([
    ['manifest_changed', 'declared values changed'],
    ['load_failed', 'declared values could not be read'],
  ] as const)(
    'G6 (in process): a set whose declared values are withheld (%s) gives no result and says why',
    async (cause, because) => {
      const store = new InMemoryStore();
      const runId = await completedRun(store, refunds, { approved: 'FAKECANWITHHELD0729' });
      const set: DisclosureSet = compileDisclosure([], {
        declared: cause === 'manifest_changed' ? 'partial' : 'unknown',
        cause,
        audience: 'agent',
        environment: 'swept',
      }).set;
      const s = await serve([refunds], { store, provider: async () => set });
      const r = await read(s.port, '/refunds', runId, bearer(s.code('/refunds', runId)));
      // (a) red when values are walked and shown while the set says they are withheld, or the
      //     reason is not the walk's words; (b) prints the body without the value (its presence as
      //     a boolean).
      expect({
        body: json(r.body.replace('FAKECANWITHHELD0729', '<value>')),
        leaked: r.body.includes('FAKECANWITHHELD0729'),
      }).toEqual({
        body: { run_id: runId, run_phase: 'completed', result_error: 'values_withheld', because },
        leaked: false,
      });
    },
  );
});

describe('R1.1 — the read address: who may read', () => {
  it("G8: a code worked out with one workflow's key for another workflow's run gets the same 403 as a wrong code", async () => {
    const store = new InMemoryStore();
    const a = workflow('alpha', sharedSecretTrigger('/alpha', READ_MAP, 'READ_SECRET'));
    const b = workflow('beta', sharedSecretTrigger('/beta', READ_MAP, 'OTHER_SECRET'));
    const bRun = await completedRun(store, b, { approved: true });
    const s = await serve([a, b], { store });
    const foreign = await read(s.port, '/alpha', bRun, bearer(s.code('/alpha', bRun)));
    const wrong = await read(s.port, '/alpha', bRun, bearer('0'.repeat(64)));
    const own = await read(s.port, '/beta', bRun, bearer(s.code('/beta', bRun)));
    // (a) red when the read does not check the record's workflow against the address's (then A's
    //     key opens B's run: 200); (b) prints both replies and the owner's status.
    expect({ foreign, wrong, own: own.status }).toEqual({
      foreign: FORBIDDEN,
      wrong: FORBIDDEN,
      own: 200,
    });
  });

  it('G9: every way to be refused gets the same 403, byte for byte; only the scheme is matched in any case', async () => {
    // A real home's store: purging a run needs its folder.
    const h = await makeTempHome();
    onTestFinished(() => h.cleanup());
    const store = h.home.runStore;
    const others = [
      workflow('plain', sharedSecretTrigger('/plain', undefined)),
      workflow('gh', {
        type: 'webhook',
        path: '/gh',
        auth: { mode: 'github', secret_from: 'GH_SECRET' },
      }),
      workflow('open', { type: 'webhook', path: '/open', auth: { mode: 'none' } }),
      workflow('signed', {
        type: 'webhook',
        path: '/signed',
        auth: { mode: 'hmac', header: 'X-Sig', secret_from: 'HMAC_SECRET' },
      }),
      workflow('stripe', {
        type: 'webhook',
        path: '/stripe',
        auth: { mode: 'stripe', secret_from: 'STRIPE_SECRET' },
      }),
    ];
    const runId = await completedRun(store, refunds, { approved: true });
    const sibling = await completedRun(store, refunds, { approved: false });
    const purged = await completedRun(store, refunds, { approved: true });
    const s = await serve([refunds, ...others], { store });
    const code = s.code('/refunds', runId);
    const purgedCode = s.code('/refunds', purged);
    await purgeRuns({ runId: purged, dryRun: false }, store, []);
    // The purge is real: the store no longer has the run.
    const purgedGone = await store.get(purged).then(
      () => false,
      () => true,
    );
    const cases: Array<[string, Promise<unknown>]> = [
      ['wrong code', read(s.port, '/refunds', runId, bearer('f'.repeat(64)))],
      ['no header', read(s.port, '/refunds', runId, undefined)],
      ['Basic', read(s.port, '/refunds', runId, `Basic ${code}`)],
      ['two spaces', read(s.port, '/refunds', runId, `Bearer  ${code}`)],
      ['code in upper case', read(s.port, '/refunds', runId, bearer(code.toUpperCase()))],
      ["another run's code", read(s.port, '/refunds', runId, bearer(s.code('/refunds', sibling)))],
      [
        'unknown run',
        read(s.port, '/refunds', UNKNOWN_RUN, bearer(s.code('/refunds', UNKNOWN_RUN))),
      ],
      ['purged run', read(s.port, '/refunds', purged, bearer(purgedCode))],
      ...['/plain', '/gh', '/open', '/signed', '/stripe', '/nowhere'].map(
        (path) =>
          [`at ${path}`, read(s.port, path, runId, bearer(code))] as [string, Promise<unknown>],
      ),
    ];
    const seen = [];
    for (const [name, reply] of cases) seen.push({ name, reply: await reply });
    const lower = await read(s.port, '/refunds', runId, `bearer ${code}`);
    // (a) red when any refusal differs from another (a body, a status, a closed connection, a
    //     header), or the scheme is matched case-sensitively; (b) prints each case's name and reply
    //     (the codes never: they are not in a reply).
    expect({ seen, lower: lower.status, purgedGone }).toEqual({
      seen: cases.map(([name]) => ({ name, reply: FORBIDDEN })),
      lower: 200,
      purgedGone: true,
    });
  });

  it('G10: a restart with the same secret opens the same run with the old code; with another secret it is the 403', async () => {
    const store = new InMemoryStore();
    const runId = await completedRun(store, refunds, { approved: true });
    const first = await serve([refunds], { store });
    const code = first.code('/refunds', runId);
    const same = await serve([refunds], { store });
    const other = await serve([refunds], {
      store,
      env: { ...ENV, READ_SECRET: 'rotated-secret-987654321' },
    });
    // (a) red when the key is random per process (the old code then fails after a restart), or is
    //     not worked out from the secret (it then survives a rotation); (b) prints both statuses.
    expect({
      same: (await read(same.port, '/refunds', runId, bearer(code))).status,
      rotated: await read(other.port, '/refunds', runId, bearer(code)),
    }).toEqual({ same: 200, rotated: FORBIDDEN });
  });
});

describe('R1.1 — the read address: where it sits', () => {
  it('G11: with every --max-concurrent slot held by unfinished POSTs, a read is answered and frees no slot', async () => {
    const store = new InMemoryStore();
    const runId = await completedRun(store, refunds, { approved: true });
    const s = await serve([refunds], { store, maxConcurrent: 2 });
    const held = [0, 1].map(
      () =>
        new Promise<void>((resolve) => {
          const sock = connect(s.port, '127.0.0.1', () => {
            sock.write(
              `POST /refunds HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nX-Token: ${ENV['READ_SECRET']}\r\nContent-Length: 100\r\n\r\n{"id":`,
            );
            setTimeout(resolve, 100);
          });
          sock.on('error', () => undefined);
        }),
    );
    await Promise.all(held);
    const answered = await read(s.port, '/refunds', runId, bearer(s.code('/refunds', runId)));
    const third = await post(s.port, '/refunds', { id: 'evt-busy' });
    // (a) red when the read is answered after the capacity check (then 503 busy) or takes a slot
    //     and gives it back short (then the third POST is let in); (b) prints both statuses and the
    //     third reply's body.
    expect({ read: answered.status, third: [third.status, third.body] }).toEqual({
      read: 200,
      third: [503, '{"error":"busy","status":"rejected"}'],
    });
  });

  it('G12: only GET or HEAD of `<path>/runs/<a lowercase UUID>` is a read; every other shape is answered as before', async () => {
    const store = new InMemoryStore();
    const runId = await completedRun(store, refunds, { approved: true });
    const s = await serve([refunds], { store });
    const auth = { authorization: bearer(s.code('/refunds', runId)) };
    const status = async (method: string, path: string) =>
      (await http(s.port, method, path, auth)).status;
    // (a) red when the match is lenient (an upper-case id, a trailing slash, no id, another path
    //     answered as a read), when a POST to a read-shaped path is read, when `/health` is taken
    //     over, or when a query string stops a read; (b) prints each request's status.
    expect({
      upper: await status('GET', `/refunds/runs/${runId.toUpperCase()}`),
      notUuid: await status('GET', '/refunds/runs/ABC'),
      trailingSlash: await status('GET', `/refunds/runs/${runId}/`),
      noId: await status('GET', '/refunds/runs'),
      otherPath: await status('GET', '/refunds/other'),
      post: await status('POST', `/refunds/runs/${runId}`),
      health: await status('GET', '/health'),
      query: await status('GET', `/refunds/runs/${runId}?x=1`),
      head: await status('HEAD', `/refunds/runs/${runId}`),
    }).toEqual({
      upper: 405,
      notUuid: 405,
      trailingSlash: 405,
      noId: 405,
      otherPath: 405,
      post: 403,
      health: 200,
      query: 200,
      head: 200,
    });
  });

  it('G13: a store that fails, or a disclosure set that cannot be built, is 503 with one error line; nothing is cached', async () => {
    const store = new InMemoryStore();
    const running = await createRun(store, refunds);
    const done = await completedRun(store, refunds, { approved: true });
    const failing = vi.spyOn(store, 'get').mockRejectedValueOnce(new Error('database is locked'));
    const s = await serve([refunds], {
      store,
      provider: async () => {
        throw new Error('the CLI writer is not installed');
      },
    });
    const first = await read(s.port, '/refunds', running, bearer(s.code('/refunds', running)));
    const again = await read(s.port, '/refunds', running, bearer(s.code('/refunds', running)));
    const unbuilt = await read(s.port, '/refunds', done, bearer(s.code('/refunds', done)));
    const lines = s.logger.lines.filter((l) => l.level === 'error');
    // (a) red when a failing store reads as a 403 or a 500, or its error text reaches the body,
    //     when the failure is cached (the second read then asks no store), or when a provider that
    //     throws gives anything but the 503; (b) prints the replies, the store's call count after
    //     the failure and the error lines.
    expect({
      first: [first.status, first.body],
      again: [again.status, json(again.body)],
      unbuilt: [unbuilt.status, unbuilt.body],
      lines,
    }).toEqual({
      first: [503, '{"error":"unavailable"}'],
      again: [200, { run_id: running, run_phase: 'running' }],
      unbuilt: [503, '{"error":"unavailable"}'],
      lines: [
        {
          level: 'error',
          msg: 'webhook: read failed',
          data: {
            path: `/refunds/runs/${running}`,
            run_id: running,
            error: 'Error: database is locked',
          },
        },
        {
          level: 'error',
          msg: 'webhook: read failed',
          data: {
            path: `/refunds/runs/${done}`,
            run_id: done,
            error: 'Error: the CLI writer is not installed',
          },
        },
      ],
    });
    // (a) red when the store's failure was cached; (b) prints the count of reads that reached it.
    expect(failing.mock.calls.filter(([id]) => id === running)).toHaveLength(2);
  });

  it("G14: a running run is read from the store once a second; another workflow's code for it is the 403 even from memory", async () => {
    const store = new InMemoryStore();
    const a = workflow('alpha', sharedSecretTrigger('/alpha', READ_MAP, 'READ_SECRET'));
    const b = workflow('beta', sharedSecretTrigger('/beta', READ_MAP, 'OTHER_SECRET'));
    const runId = await createRun(store, a);
    const gets = vi.spyOn(store, 'get');
    const s = await serve([a, b], { store });
    const own = () => read(s.port, '/alpha', runId, bearer(s.code('/alpha', runId)));
    await own();
    await own();
    const withinOneSecond = gets.mock.calls.length;
    const foreign = await read(s.port, '/beta', runId, bearer(s.code('/beta', runId)));
    await new Promise((r) => setTimeout(r, 1050));
    await own();
    // (a) red when the phase is not cached (two reads in a second ask the store twice), cached past
    //     its second, or when a hit skips the compare of its workflow (B's code then reads A's run:
    //     200); (b) prints the store's read counts and the foreign reply.
    expect({ withinOneSecond, afterIt: gets.mock.calls.length, foreign }).toEqual({
      withinOneSecond: 1,
      afterIt: 2,
      foreign: FORBIDDEN,
    });
  });

  it("G1 (in process): HEAD has the GET reply's status and headers and no body", async () => {
    const store = new InMemoryStore();
    const runId = await completedRun(store, refunds, { approved: true });
    const s = await serve([refunds], { store });
    const get = await read(s.port, '/refunds', runId, bearer(s.code('/refunds', runId)));
    const head = await read(s.port, '/refunds', runId, bearer(s.code('/refunds', runId)), 'HEAD');
    // (a) red when HEAD gets a body, other headers, or another status; (b) prints both replies.
    expect({ ...head, body: head.body }).toEqual({ ...get, body: '' });
  });
});
