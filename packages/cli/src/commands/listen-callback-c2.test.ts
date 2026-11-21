// listen-callback-c2.test.ts — R1.3 callback C2 (the door; the owner's yes 81e85411, the key 896326ed,
// the delta d4671d42): a POST to `realm listen` that names a callback address in `realm-callback-url`
// is refused with a closed word before anything is made, or registered with its run in one step. Every
// cell runs a real listen server on loopback (`test-support/listen-read-r11.ts`), over the in-memory
// store or a real SQLite home with a test sealer, and reads the status and body as a caller sees them,
// and the lines the server logged. The URLs carry a canary in their path and query: no reply or log
// line may hold it (the instrument is proven on the URL itself).
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import { abandonRun, type RunStore } from '@sensigo/realm';
import { createCallbackKeySealer } from '@sensigo/realm-store-sqlite';
import { parseCallbackEntry, type CallbackLists } from '../lib/callback/allow-list.js';
import { CALLBACK_REFUSAL_WORDS } from '../lib/callback/door.js';
import { InMemoryDedupStore } from '../lib/dedup-store.js';
import { makeTempHome, runCount } from '../test-support/temp-home.js';
import {
  ENV,
  http,
  serve,
  sharedSecretTrigger,
  workflow,
  type Line,
  type Seen,
} from '../test-support/listen-read-r11.js';
import { purgeRuns } from './purge.js';
import type { ListenDeps, SpawnResult } from './listen.js';

const W = 'refunds';
const PATH = '/refunds';
const MAP = { approved: 'context.resources.review.approved' };
const OPTED = workflow(W, sharedSecretTrigger(PATH, MAP));
const PLAIN = workflow('plain', sharedSecretTrigger('/plain', undefined));
const HOOK = 'hooks.example.com';
const LABEL = 'hooks.example.com:443';
const CANARY = 'CANARYc2path';
const QUERY = 'CANARYc2query';
const URL_ = `https://${HOOK}/cb/${CANARY}?q=${QUERY}`;
const KEY = 'ab'.repeat(32);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const entry = (text: string) => {
  const parsed = parseCallbackEntry(text);
  if (!parsed.ok) throw new Error(`a test entry is refused: ${text}`);
  return parsed.entry;
};
/** The lists: `pub` allow public addresses, `priv` private ones too. */
const lists = (pub: string[], priv: string[] = []): CallbackLists => ({
  public: pub.map(entry),
  private: priv.map(entry),
});
const ALLOWED = lists([HOOK, 'nokey.example.com', 'hooks.example.com:8443'], ['169.254.169.254']);

const json = (body: string): Record<string, unknown> => JSON.parse(body) as Record<string, unknown>;
/** A POST of `event`, with `url` in the callback header when given (an array sends the header twice). */
function post(
  port: number,
  event: unknown,
  url?: string | string[],
  more: Record<string, string> = {},
  path = PATH,
): Promise<Seen> {
  return http(
    port,
    'POST',
    path,
    {
      'content-type': 'application/json',
      'x-token': ENV['READ_SECRET']!,
      ...(url !== undefined ? { 'realm-callback-url': url as string } : {}),
      ...more,
    },
    JSON.stringify(event),
  );
}
/** Whether a text holds a canary of the URL (proven below on the URL itself). */
const leaks = (text: string): boolean => text.includes(CANARY) || text.includes(QUERY);
const logged = (lines: Line[]): string => JSON.stringify(lines);
/** The lines at `level` whose message begins `prefix`, as message and data. */
const linesOf = (lines: Line[], prefix: string) =>
  lines
    .filter((l) => l.msg.startsWith(prefix))
    .map((l) => ({ level: l.level, msg: l.msg, data: l.data }));

/** A server over `store` with the allowed lists, unless the cell gives others. */
function serveDoor(store: RunStore, over: Partial<ListenDeps> = {}, definitions = [OPTED, PLAIN]) {
  return serve(definitions, { store, over: { callbackLists: ALLOWED, ...over } });
}
/** An in-memory store with a readable key for (refunds, hooks.example.com:443). */
async function keyedStore(host = LABEL): Promise<InMemoryStore> {
  const store = new InMemoryStore();
  await store.callbacks!.keys.make(W, host, KEY);
  return store;
}

describe('C2 — the instrument', () => {
  it('the canary search finds the canary in the URL it is planted in', () => {
    // (1) red when the search cannot find the canary at all (every "no leak" below would then be
    //     vacuous); (2) prints the URL's result.
    expect({ url: leaks(URL_), plain: leaks('https://hooks.example.com/x') }).toEqual({
      url: true,
      plain: false,
    });
  });
});

describe('C2 — a request without the header', () => {
  it('its create options carry no callback key, and its 202 no callback field', async () => {
    const store = await keyedStore();
    const create = vi.spyOn(store, 'create');
    const s = await serveDoor(store);
    const r = await post(s.port, { id: 'evt-plain' });
    // (1) red when the door adds a `callback` key to every create (even `undefined`), or the 202
    //     changes without the header; (2) prints the option keys and the reply.
    expect({
      status: r.status,
      keys: Object.keys(create.mock.calls[0]![0]).sort(),
      fields: Object.keys(json(r.body)).sort(),
    }).toEqual({
      status: 202,
      keys: ['idempotencyKey', 'params', 'workflowId', 'workflowVersion'],
      fields: ['run_id', 'run_phase', 'status', 'status_path', 'token'],
    });
  });
});

describe('C2 — not enabled, four ways (each with the other three conditions met)', () => {
  const NOT_ENABLED = '{"error":"callback_not_enabled"}';
  it.each([
    ['a workflow without result_map', 'plain'],
    ['empty lists', 'lists'],
    ['a store with no callback store', 'store'],
    ['an opted-in workflow without its read key', 'readKey'],
  ] as const)('%s: 400 callback_not_enabled, nothing made', async (_name, way) => {
    const store = way === 'store' ? new InMemoryStore({ callbacks: null }) : new InMemoryStore();
    if (way !== 'store') {
      await store.callbacks!.keys.make(W, LABEL, KEY);
      await store.callbacks!.keys.make('plain', LABEL, KEY);
    }
    const s = await serveDoor(store, way === 'lists' ? { callbackLists: lists([]) } : {});
    if (way === 'readKey') delete s.routes.get(PATH)!.readKey;
    const path = way === 'plain' ? '/plain' : PATH;
    const r = await post(s.port, { id: 'evt-1' }, URL_, {}, path);
    // (1) red when the header is ignored (a 202 and a run), or the named condition is not checked;
    //     (2) prints the reply, the run count and the line.
    expect({
      status: r.status,
      body: r.body,
      runs: await runCount(store),
      lines: linesOf(s.logger.lines, 'webhook: callback'),
    }).toEqual({
      status: 400,
      body: NOT_ENABLED,
      runs: 0,
      lines: [
        {
          level: 'warn',
          msg: 'webhook: callback not enabled',
          data: { path, workflow: path === '/plain' ? 'plain' : W },
        },
      ],
    });
  });
});

describe('C2 — each refusal word', () => {
  it('one input each: the exact body, no run, a warn line with the word and the host only', async () => {
    const store = await keyedStore();
    const s = await serveDoor(store);
    const long = `https://${HOOK}/${'a'.repeat(2049 - `https://${HOOK}/`.length)}`;
    const cases: [string, string | string[], string][] = [
      ['empty', '', 'malformed'],
      ['a space inside', `https://${HOOK}/a b`, 'malformed'],
      ['a tab inside', `https://${HOOK}/a\tb`, 'malformed'],
      ['a fragment', `https://${HOOK}/x#frag`, 'malformed'],
      ['the header sent twice', [URL_, URL_], 'malformed'],
      ['2,049 characters', long, 'too_long'],
      ['ftp', `ftp://${HOOK}/x`, 'scheme'],
      ['http to an https-only :443 entry', `http://${HOOK}:443/x`, 'scheme'],
      ['userinfo', `https://user:pw@${HOOK}/x`, 'userinfo'],
      ['the right host, a wrong port', `https://${HOOK}:9443/x`, 'not_allowed'],
      ['a wrong host', 'https://evil.example.com/x', 'not_allowed'],
      [
        'the metadata address, listed verbatim in the private list (no key)',
        'https://169.254.169.254/x',
        'address',
      ],
      ['an allowed host with no key', 'https://nokey.example.com/x', 'no_key'],
    ];
    const got: Record<string, unknown> = {};
    for (const [name, url, word] of cases) {
      const r = await post(s.port, { id: `evt-${name}` }, url);
      got[name] = { status: r.status, body: r.body, word };
    }
    const refusals = s.logger.lines.filter((l) => l.msg.startsWith('webhook: callback refused ('));
    // (1) red when a word is another's, the address check and the key check are swapped (the
    //     metadata case has no key), a refusal makes a run, or a line carries the URL; (2) prints
    //     each reply, the run count and the words logged.
    expect({
      got,
      runs: await runCount(store),
      words: refusals.map((l) => /\(([a-z_]+)\)/.exec(l.msg)![1]),
      leaked: leaks(logged(s.logger.lines)),
      length: long.length,
    }).toEqual({
      got: Object.fromEntries(
        cases.map(([name, , word]) => [
          name,
          { status: 400, body: `{"error":"callback_refused","reason":"${word}"}`, word },
        ]),
      ),
      runs: 0,
      words: cases.map(([, , word]) => word),
      leaked: false,
      length: 2049,
    });
    // (1) red when a word is added or dropped, or one of the seven is never produced; (2) prints
    //     both lists.
    expect([...new Set(cases.map(([, , w]) => w))]).toEqual([...CALLBACK_REFUSAL_WORDS]);
    // (1) red when a refusal's line loses the host label where the address has one, or names more;
    //     (2) prints the data of three lines.
    expect(
      [refusals[9], refusals[11], refusals[12]].map((l) => (l === undefined ? undefined : l.data)),
    ).toEqual([
      { path: PATH, workflow: W, host: 'hooks.example.com:9443' },
      { path: PATH, workflow: W, host: '169.254.169.254:443' },
      { path: PATH, workflow: W, host: 'nokey.example.com:443' },
    ]);
  });

  it('a key that cannot be read: sealed under another master, under this one (damaged), or a previous alone', async () => {
    const store = await keyedStore();
    await store.callbacks!.keys.make(W, 'hooks.example.com:8443', KEY);
    store.callbacks!.keys.makeUnreadable(W, LABEL, 'current', 'feedf00d');
    store.callbacks!.keys.makeUnreadable(W, 'hooks.example.com:8443', 'current', 'c0ffee01');
    const s = await serveDoor(store, { callbackMasterFp: 'c0ffee01' });
    const other = await post(s.port, { id: 'evt-other' }, URL_);
    const damaged = await post(s.port, { id: 'evt-damaged' }, `https://${HOOK}:8443/x`);
    vi.spyOn(store.callbacks!.keys, 'read').mockImplementationOnce(async () => ({
      previous: {
        slot: 'previous',
        state: 'readable',
        key: KEY,
        key_fp: '12345678',
        created_at: '2026-11-21T00:00:00.000Z',
        expires_at: '2099-01-01T00:00:00.000Z',
      },
    }));
    const previousOnly = await post(s.port, { id: 'evt-previous' }, 'https://nokey.example.com/x');
    const cmd = (host: string) => `realm callback key /tmp/r11-wf --host ${host}`;
    // (1) red when an unreadable current is taken as a key, a previous alone counts as one, the
    //     equal fingerprint gets the other-master text, or a fix ends in punctuation; (2) prints
    //     the replies and the three lines.
    expect({
      bodies: [other, damaged, previousOnly].map((r) => [r.status, json(r.body)['reason']]),
      runs: await runCount(store),
      lines: s.logger.lines
        .filter((l) => l.msg.startsWith('webhook: callback refused'))
        .map((l) => l.msg),
    }).toEqual({
      bodies: [
        [400, 'no_key'],
        [400, 'no_key'],
        [400, 'no_key'],
      ],
      runs: 0,
      lines: [
        `webhook: callback refused (no_key) — its key was sealed with encryption key feedf00d; this process has c0ffee01; start realm listen with that encryption key, or make a new key with: ${cmd(LABEL)} --replace`,
        `webhook: callback refused (no_key) — the stored key cannot be read; make a new key with: ${cmd('hooks.example.com:8443')} --replace`,
        `webhook: callback refused (no_key) — make a key with: ${cmd('nokey.example.com:443')}`,
      ],
    });
  });

  it('the fix is said once per state of the pair: no key twice, then a key that cannot be read; an absent fingerprint is left out', async () => {
    const store = new InMemoryStore();
    const s = await serveDoor(store);
    await post(s.port, { id: 'evt-1' }, URL_);
    await post(s.port, { id: 'evt-2' }, URL_);
    await store.callbacks!.keys.make(W, LABEL, KEY);
    store.callbacks!.keys.makeUnreadable(W, LABEL, 'current', 'feedf00d');
    await post(s.port, { id: 'evt-3' }, URL_);
    await post(s.port, { id: 'evt-4' }, URL_);
    const cmd = `realm callback key /tmp/r11-wf --host ${LABEL}`;
    // (1) red when the once-only memory is keyed by the pair alone (the unreadable text is then
    //     never said), the fix is said every time, or an absent fingerprint prints "none"; (2) prints
    //     the four messages.
    expect(
      s.logger.lines.filter((l) => l.msg.startsWith('webhook: callback refused')).map((l) => l.msg),
    ).toEqual([
      `webhook: callback refused (no_key) — make a key with: ${cmd}`,
      'webhook: callback refused (no_key)',
      `webhook: callback refused (no_key) — its key was sealed with encryption key feedf00d; start realm listen with that encryption key, or make a new key with: ${cmd} --replace`,
      'webhook: callback refused (no_key)',
    ]);
  });

  it('a key read that throws: 500 store_error, nothing made, an error line with no address', async () => {
    const store = await keyedStore();
    vi.spyOn(store.callbacks!.keys, 'read').mockRejectedValue(new Error('database is locked'));
    const s = await serveDoor(store);
    const r = await post(s.port, { id: 'evt-1' }, URL_);
    // (1) red when the throw escapes (a hung or broken reply), becomes a refusal word, or makes a
    //     run; (2) prints the reply, the run count and the line.
    expect({
      status: r.status,
      body: r.body,
      runs: await runCount(store),
      lines: linesOf(s.logger.lines, 'webhook: callback key'),
      leaked: leaks(logged(s.logger.lines)),
    }).toEqual({
      status: 500,
      body: '{"error":"store_error","status":"failed"}',
      runs: 0,
      lines: [
        {
          level: 'error',
          msg: 'webhook: callback key could not be read',
          data: { path: PATH, workflow: W, host: LABEL, error: 'Error: database is locked' },
        },
      ],
      leaked: false,
    });
  });

  it('SQLite: a key planted under a master key, the home reopened with none: unreadable, and the fix says so', async () => {
    const master = new Uint8Array(32).fill(0xa1);
    const sealer = createCallbackKeySealer(master);
    const planted = await makeTempHome({ sealer });
    await planted.home.runStore.callbacks!.keys.make(W, LABEL, KEY);
    await planted.home.close();
    const h = await makeTempHome({ home: planted.path });
    onTestFinished(async () => {
      await h.cleanup();
      await planted.cleanup();
    });
    const s = await serveDoor(h.home.runStore, { callbackMasterFp: null });
    const r = await post(s.port, { id: 'evt-1' }, URL_);
    // (1) red when the home reads the key without a sealer, or the unreadable state gets the
    //     no-row text; (2) prints the reply and the line.
    expect({
      body: r.body,
      runs: await runCount(h.home.runStore),
      line: s.logger.lines.find((l) => l.msg.startsWith('webhook: callback refused'))?.msg,
    }).toEqual({
      body: '{"error":"callback_refused","reason":"no_key"}',
      runs: 0,
      line: `webhook: callback refused (no_key) — its key was sealed with encryption key ${sealer.masterFp}; this process has none; start realm listen with that encryption key, or make a new key with: realm callback key /tmp/r11-wf --host ${LABEL} --replace`,
    });
  });
});

describe('C2 — registered', () => {
  it('in memory: 202 with callback registered, the row pending, create given the address as received, nothing shown', async () => {
    const store = await keyedStore();
    const create = vi.spyOn(store, 'create');
    const s = await serveDoor(store);
    const r = await post(s.port, { id: 'evt-1' }, `  ${URL_}  `);
    const body = json(r.body);
    const runId = String(body['run_id']);
    const option = create.mock.calls[0]![0].callback;
    const view = await store.callbacks!.read(runId);
    // (1) red when the row is not written, the 202 lacks the field, create gets another address or
    //     host, the webhook id is not a fresh uuid, or a reply or line shows the address; (2) prints
    //     the reply's fields, the option (address by its canary only) and the view.
    expect({
      status: r.status,
      fields: Object.keys(body).sort(),
      callback: body['callback'],
      option: {
        url: option?.url === URL_,
        host: option?.host,
        uuid: UUID.test(option?.webhook_id ?? ''),
      },
      view: { status: view?.status, host: view?.host, workflow_id: view?.workflow_id },
      registered: linesOf(s.logger.lines, 'webhook: callback registered'),
      leaked: leaks(r.body + logged(s.logger.lines)),
      webhookIdShown: (r.body + logged(s.logger.lines)).includes(option?.webhook_id ?? '?'),
    }).toEqual({
      status: 202,
      fields: ['callback', 'run_id', 'run_phase', 'status', 'status_path', 'token'],
      callback: 'registered',
      option: { url: true, host: LABEL, uuid: true },
      view: { status: 'pending', host: LABEL, workflow_id: W },
      registered: [
        {
          level: 'info',
          msg: 'webhook: callback registered',
          data: { path: PATH, workflow: W, host: LABEL },
        },
      ],
      leaked: false,
      webhookIdShown: false,
    });
  });

  it('SQLite with a sealer: the key reads, the run and its row are written together', async () => {
    const sealer = createCallbackKeySealer(new Uint8Array(32).fill(0xb2));
    const h = await makeTempHome({ sealer });
    onTestFinished(() => h.cleanup());
    const store = h.home.runStore;
    await store.callbacks!.keys.make(W, LABEL, KEY);
    const s = await serveDoor(store, { callbackMasterFp: sealer.masterFp });
    const r = await post(s.port, { id: 'evt-1' }, URL_);
    const runId = String(json(r.body)['run_id']);
    // (1) red when the SQLite home does not read the key with its sealer, or the row is not there
    //     with the run; (2) prints the reply's field and the view.
    expect({
      status: r.status,
      callback: json(r.body)['callback'],
      view: (await store.callbacks!.read(runId))?.status,
      runs: await runCount(store),
    }).toEqual({ status: 202, callback: 'registered', view: 'pending', runs: 1 });
  });

  it('the label is K1’s: Hooks.Example.COM finds the key made for hooks.example.com:443', async () => {
    const store = await keyedStore();
    const s = await serveDoor(store);
    const r = await post(s.port, { id: 'evt-1' }, `https://Hooks.Example.COM/${CANARY}`);
    // (1) red when the host is compared raw (no key is then found: no_key); (2) prints the reply.
    expect([r.status, json(r.body)['callback']]).toEqual([202, 'registered']);
  });
});

describe('C2 — repeats: a duplicate inside the window (step 8) and an idempotent match (step 10b)', () => {
  it('step 8: ignored_duplicate when the first run has a row (one row, unchanged); none when it has none; no field without the header', async () => {
    const store = await keyedStore();
    const s = await serveDoor(store);
    const first = json((await post(s.port, { id: 'evt-row' }, URL_)).body);
    const before = await store.callbacks!.read(String(first['run_id']));
    const again = json((await post(s.port, { id: 'evt-row' }, URL_)).body);
    const after = await store.callbacks!.read(String(first['run_id']));
    const noRow = json((await post(s.port, { id: 'evt-norow' })).body);
    const noRowAgain = json((await post(s.port, { id: 'evt-norow' }, URL_)).body);
    const withoutHeader = json((await post(s.port, { id: 'evt-row' })).body);
    // (1) red when a repeat writes a second row or changes the first, says none while a row exists,
    //     or a repeat without the header gets a field; (2) prints the three fields and the counts.
    expect({
      again: [again['status'], again['run_id'] === first['run_id'], again['callback']],
      unchanged: JSON.stringify(after) === JSON.stringify(before),
      pending: await store.callbacks!.countPending(),
      noRowAgain: [noRowAgain['run_id'] === noRow['run_id'], noRowAgain['callback']],
      withoutHeader: 'callback' in withoutHeader,
    }).toEqual({
      again: ['deduplicated', true, 'ignored_duplicate'],
      unchanged: true,
      pending: 1,
      noRowAgain: [true, 'none'],
      withoutHeader: false,
    });
  });

  it('step 8, the run gone (purged): the bare reply says none', async () => {
    const h = await makeTempHome({
      sealer: createCallbackKeySealer(new Uint8Array(32).fill(0xc3)),
    });
    onTestFinished(() => h.cleanup());
    const store = h.home.runStore;
    await store.callbacks!.keys.make(W, LABEL, KEY);
    const s = await serveDoor(store);
    const runId = String(json((await post(s.port, { id: 'evt-gone' }, URL_)).body)['run_id']);
    await abandonRun(store, runId);
    await purgeRuns({ runId, dryRun: false }, store, []);
    const gone = await post(s.port, { id: 'evt-gone' }, URL_);
    // (1) red when the bare reply gets no field, or another; (2) prints the reply.
    expect([gone.status, gone.body]).toEqual([200, '{"status":"deduplicated","callback":"none"}']);
  });

  it('step 10b (past the window): ignored_duplicate when the run has a row, none when not, no field without the header', async () => {
    const store = await keyedStore();
    const s = await serveDoor(store, { dedupStoreFor: () => new InMemoryDedupStore() });
    const first = json((await post(s.port, { id: 'evt-a' }, URL_)).body);
    const matched = json((await post(s.port, { id: 'evt-a' }, URL_)).body);
    const plainFirst = json((await post(s.port, { id: 'evt-b' })).body);
    const plainMatched = json((await post(s.port, { id: 'evt-b' }, URL_)).body);
    const without = json((await post(s.port, { id: 'evt-a' })).body);
    // (1) red when step 10b's reply gets no field, says none while a row exists, a second row is
    //     written, or a repeat without the header gets a field; (2) prints the fields.
    expect({
      matched: [matched['status'], matched['run_id'] === first['run_id'], matched['callback']],
      plainMatched: [plainMatched['run_id'] === plainFirst['run_id'], plainMatched['callback']],
      without: 'callback' in without,
      pending: await store.callbacks!.countPending(),
    }).toEqual({
      matched: ['deduplicated', true, 'ignored_duplicate'],
      plainMatched: [true, 'none'],
      without: false,
      pending: 1,
    });
  });

  it('a row read that throws on a repeat: the field is left out, and a warn line says why', async () => {
    const store = await keyedStore();
    const s = await serveDoor(store);
    await post(s.port, { id: 'evt-1' }, URL_);
    vi.spyOn(store.callbacks!, 'read').mockRejectedValueOnce(new Error('database is locked'));
    const r = json((await post(s.port, { id: 'evt-1' }, URL_)).body);
    const line = s.logger.lines.find((l) =>
      l.msg.startsWith('webhook: the callback of a repeated'),
    );
    // (1) red when a failing read answers none (false while a row exists) or the throw escapes;
    //     (2) prints the reply's fields and the line.
    expect({
      callback: 'callback' in r,
      line: { level: line?.level, msg: line?.msg, keys: Object.keys(line?.data ?? {}).sort() },
      leaked: leaks(logged(s.logger.lines)),
    }).toEqual({
      callback: false,
      line: {
        level: 'warn',
        msg: 'webhook: the callback of a repeated event could not be read',
        keys: ['error', 'path', 'run_id', 'workflow'],
      },
      leaked: false,
    });
  });
});

describe('C2 — Prefer: wait', { timeout: 30_000 }, () => {
  it('the wait’s 202 carries registered; its 200 (the run ended in the wait) does not', async () => {
    const store = await keyedStore();
    // The agent "ends" the run 100 ms after it starts, and then exits.
    const ends = vi.fn(async (runId: string): Promise<SpawnResult> => ({
      pid: 4242,
      exited: new Promise<void>((resolve) => {
        setTimeout(() => void abandonRun(store, runId).then(() => resolve()), 100);
      }),
    }));
    const s = await serveDoor(store);
    const capped = await post(s.port, { id: 'evt-1' }, URL_, { prefer: 'wait=1' });
    const e = await serveDoor(store, { spawnAgent: ends });
    const ended = await post(e.port, { id: 'evt-2' }, URL_, { prefer: 'wait=10' });
    // (1) red when the field is added outside the one `accepted` closure (the wait's 202 then lacks
    //     it) or to the wait's 200; (2) prints both replies' status and field.
    expect({
      capped: [capped.status, json(capped.body)['callback']],
      ended: [ended.status, 'callback' in json(ended.body)],
    }).toEqual({ capped: [202, 'registered'], ended: [200, false] });
  });
});

describe('C2 — the agent fails to start after the row was written', () => {
  it('the row is removed FIRST, then the run is sealed; the reply is 500 spawn_failed', async () => {
    const store = await keyedStore();
    const order: string[] = [];
    const del = store.callbacks!.deleteAllForRun.bind(store.callbacks!);
    vi.spyOn(store.callbacks!, 'deleteAllForRun').mockImplementation(async (...a) => {
      order.push('delete');
      return del(...a);
    });
    const seal = store.settleStep.bind(store);
    vi.spyOn(store, 'settleStep').mockImplementation(async (...a) => {
      order.push('seal');
      return seal(...a);
    });
    const s = await serveDoor(store, {
      spawnAgent: vi.fn(async (): Promise<SpawnResult> => ({ error: new Error('ENOENT') })),
    });
    const r = await post(s.port, { id: 'evt-1' }, URL_);
    const runId = String(json(r.body)['run_id']);
    // (1) red when the row is left, or the run is sealed before it goes (a sender could claim it in
    //     between); (2) prints the reply, the order and what is left.
    expect({
      reply: [r.status, json(r.body)['error']],
      order,
      row: await store.callbacks!.read(runId),
      sealed: (await store.get(runId)).record.sealed_by?.arm,
    }).toEqual({
      reply: [500, 'spawn_failed'],
      order: ['delete', 'seal'],
      row: undefined,
      sealed: 'spawn_failure',
    });
  });

  it('a delete that fails is logged and the reply is unchanged; with no row nothing is deleted', async () => {
    const store = await keyedStore();
    const deleting = vi
      .spyOn(store.callbacks!, 'deleteAllForRun')
      .mockRejectedValueOnce(new Error('database is locked'));
    const s = await serveDoor(store, {
      spawnAgent: vi.fn(async (): Promise<SpawnResult> => ({ error: new Error('ENOENT') })),
    });
    const r = await post(s.port, { id: 'evt-1' }, URL_);
    const calls = deleting.mock.calls.length;
    const bare = await post(s.port, { id: 'evt-2' });
    // (1) red when a failing delete changes the reply or is silent, or a run with no row is
    //     deleted from; (2) prints the replies, the line and the call counts.
    expect({
      reply: [r.status, json(r.body)['error']],
      line: linesOf(s.logger.lines, 'webhook: failed to remove').map((l) => [l.level, l.msg]),
      calls,
      bare: [bare.status, json(bare.body)['error']],
      callsAfter: deleting.mock.calls.length,
    }).toEqual({
      reply: [500, 'spawn_failed'],
      line: [['error', 'webhook: failed to remove the callback of a run that did not start']],
      calls: 1,
      bare: [500, 'spawn_failed'],
      callsAfter: 1,
    });
  });
});
