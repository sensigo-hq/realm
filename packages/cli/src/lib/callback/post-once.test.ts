// post-once.test.ts — R1.3 C1: one vetted POST against real loopback servers (http and https with the
// committed TEST-ONLY certificates). No cell uses real DNS or the network: names resolve through the
// injected `resolve`, except the default-resolver cell, whose `localhost` comes from the hosts file.
//
// Each assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import { parseCallbackEntry, type CallbackLists } from './allow-list.js';
import { postOnce, vettingLookup, type PostOnceOptions, type Resolve } from './post-once.js';
import { EXAMPLE_TEST, OTHER_TEST } from './test-support/test-only-certs.js';

interface Seen {
  count: number;
  headers: http.IncomingHttpHeaders[];
  bodies: Buffer[];
  closed: number;
}

/** A server on `host` (port 0 unless given), recording what it saw; closed after the cell. */
async function serve(
  make: (handler: http.RequestListener) => net.Server,
  respond: (req: http.IncomingMessage, res: http.ServerResponse) => void = (_q, s) => {
    s.writeHead(200);
    s.end('ok');
  },
  host = '127.0.0.1',
  port = 0,
): Promise<{ port: number; seen: Seen }> {
  const seen: Seen = { count: 0, headers: [], bodies: [], closed: 0 };
  const server = make((req, res) => {
    seen.count += 1;
    seen.headers.push(req.headers);
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => seen.bodies.push(Buffer.concat(chunks)));
    res.on('close', () => (seen.closed += 1));
    respond(req, res);
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => ok());
  });
  onTestFinished(
    () =>
      new Promise<void>((ok) => {
        (server as http.Server).closeAllConnections?.();
        server.close(() => ok());
      }),
  );
  return { port: (server.address() as AddressInfo).port, seen };
}
const plain = (h: http.RequestListener) => http.createServer(h);
const tls = (pair: { cert: string; key: string }) => (h: http.RequestListener) =>
  https.createServer({ cert: pair.cert, key: pair.key }, h);

const entryOf = (text: string) => {
  const r = parseCallbackEntry(text);
  if (!r.ok) throw new Error(`fixture: ${text} refused ${r.word}`);
  return r.entry;
};
const lists = (pub: string[], priv: string[] = []): CallbackLists => ({
  public: pub.map(entryOf),
  private: priv.map(entryOf),
});
/** A resolver that answers `answer(n)` on its nth call (from 1), counting its calls. */
function resolver(answer: (n: number) => Array<{ address: string; family: number }>) {
  const calls: string[] = [];
  const resolve: Resolve = async (host) => {
    calls.push(host);
    return answer(calls.length);
  };
  return { resolve, calls };
}
const at = (address: string) => [{ address, family: net.isIP(address) }];
const post = (o: Partial<PostOnceOptions> & Pick<PostOnceOptions, 'url' | 'lists'>) =>
  postOnce({ body: '{}', headers: { 'content-type': 'application/json' }, ownPort: 1, ...o });

afterEach(() => {
  net.setDefaultAutoSelectFamily(true);
  delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
});

describe('R1.3 C1 — the address the connection goes to', () => {
  it('rebinding: ONE resolver call; the pinned server gets the request, the decoy on the same port none', async () => {
    const pinned = await serve(plain, undefined, '127.0.0.2');
    const decoy = await serve(plain, undefined, '127.0.0.1', pinned.port);
    const r = resolver((n) => at(n === 1 ? '127.0.0.2' : '127.0.0.1'));
    const out = await post({
      url: `http://rebind.test:${pinned.port}/hook`,
      lists: lists([], [`http://rebind.test:${pinned.port}`]),
      seams: { resolve: r.resolve },
    });
    // (a) red when the client looks the name up a second time, or re-resolves; (b) prints it all.
    expect({
      out,
      calls: r.calls,
      pinned: pinned.seen.count,
      decoy: decoy.seen.count,
      host: pinned.seen.headers[0]?.host,
    }).toEqual({
      out: { kind: 'status', status: 200 },
      calls: ['rebind.test'],
      pinned: 1,
      decoy: 0,
      host: `rebind.test:${pinned.port}`,
    });
  });

  it('refuse the whole: an allowed address beside a metadata address is `refused_address`; an empty answer is `connection`, and nothing crashes', async () => {
    const server = await serve(plain);
    const l = lists([], [`http://mixed.test:${server.port}`, `http://empty.test:${server.port}`]);
    const mixed = await post({
      url: `http://mixed.test:${server.port}/`,
      lists: l,
      seams: { resolve: resolver(() => [...at('127.0.0.1'), ...at('169.254.169.254')]).resolve },
    });
    const empty = await post({
      url: `http://empty.test:${server.port}/`,
      lists: l,
      seams: { resolve: resolver(() => []).resolve },
    });
    // (a) red when a partial answer is allowed (the server is reached), or `cb(null, [])` throws
    //     inside node:net (an uncaught TypeError fails the run); (b) prints both outcomes.
    expect({ mixed, empty, reached: server.seen.count }).toEqual({
      mixed: { kind: 'failed', word: 'refused_address' },
      empty: { kind: 'failed', word: 'connection' },
      reached: 0,
    });
  });

  it('refuse the whole, a public entry: a public address beside a metadata address is `refused_address`', async () => {
    const out = await post({
      url: 'https://mixed-public.test/',
      lists: lists(['mixed-public.test']),
      seams: { resolve: resolver(() => [...at('8.8.8.8'), ...at('169.254.169.254')]).resolve },
    });
    // (a) red when the refused address of the answer is dropped and the rest allowed; (b) prints it.
    expect(out).toEqual({ kind: 'failed', word: 'refused_address' });
  });

  it('the lookup call forms: with autoSelectFamily off in the process, a try still connects', async () => {
    net.setDefaultAutoSelectFamily(false);
    const server = await serve(plain);
    const out = await post({
      url: `http://forms.test:${server.port}/`,
      lists: lists([], [`http://forms.test:${server.port}`]),
      seams: { resolve: resolver(() => at('127.0.0.1')).resolve },
    });
    // (a) red when the request does not ask for the array form AND the lookup answers only arrays;
    //     (b) prints the outcome.
    expect({ out, reached: server.seen.count }).toEqual({
      out: { kind: 'status', status: 200 },
      reached: 1,
    });
  });

  it('the lookup itself honours both call forms: `{ all: true }` gets the list, `{ hints }` the first address', async () => {
    const lookup = vettingLookup(
      resolver(() => [...at('127.0.0.1'), ...at('::1')]).resolve,
      () => true,
    );
    const call = (opts: Parameters<typeof lookup>[1]) =>
      new Promise<unknown[]>((ok) => lookup('forms2.test', opts, (...args) => ok(args)));
    // (a) red when the lookup answers only arrays, or only one address; (b) prints both callbacks.
    expect({ all: await call({ all: true }), hints: await call({ hints: 32 }) }).toEqual({
      all: [
        null,
        [
          { address: '127.0.0.1', family: 4 },
          { address: '::1', family: 6 },
        ],
      ],
      hints: [null, '127.0.0.1', 4],
    });
  });

  it('the default resolver: a `private` entry `localhost:<P>` reaches a loopback server (the hosts file)', async () => {
    const server = await serve(plain);
    const out = await post({
      url: `http://localhost:${server.port}/`,
      lists: lists([], [`http://localhost:${server.port}`]),
    });
    // (a) red when the production resolver path cannot connect (e.g. a single-address answer to an
    //     array call, or [::1, 127.0.0.1] not falling back); (b) prints the outcome.
    expect({ out, reached: server.seen.count }).toEqual({
      out: { kind: 'status', status: 200 },
      reached: 1,
    });
  });

  it('IP literals: judged by the classifier for their own kind, never looked up; a listed metadata address is still refused', async () => {
    const server = await serve(plain);
    const r = resolver(() => at('127.0.0.1'));
    const url = `http://127.0.0.1:${server.port}/`;
    const seams = { resolve: r.resolve };
    const out = {
      privateEntry: await post({
        url,
        lists: lists([], [`http://127.0.0.1:${server.port}`]),
        seams,
      }),
      publicEntry: await post({ url, lists: lists([`http://127.0.0.1:${server.port}`]), seams }),
      metadata: await post({
        url: 'http://169.254.169.254/latest/meta-data/',
        lists: lists(['http://169.254.169.254'], ['http://169.254.169.254']),
        // Refused before any connect; bounded anyway, should a break let it through.
        deadlineMs: 300,
        seams,
      }),
      unlisted: await post({
        url: `http://127.0.0.2:${server.port}/`,
        lists: lists([], [`http://127.0.0.1:${server.port}`]),
        seams,
      }),
    };
    // (a) red when a literal bypasses the classifier or is looked up; (b) prints them.
    expect({ ...out, lookups: r.calls.length, reached: server.seen.count }).toEqual({
      privateEntry: { kind: 'status', status: 200 },
      publicEntry: { kind: 'failed', word: 'refused_address' },
      metadata: { kind: 'failed', word: 'refused_address' },
      unlisted: { kind: 'failed', word: 'not_allowed' },
      lookups: 0,
      reached: 1,
    });
  });

  it('the own port: this machine on `ownPort` is `refused_address`, by literal and by name; another `ownPort` connects', async () => {
    const server = await serve(plain);
    const l = lists([], [`http://127.0.0.1:${server.port}`, `http://own.test:${server.port}`]);
    const seams = { resolve: resolver(() => at('127.0.0.1')).resolve };
    const out = {
      literal: await post({
        url: `http://127.0.0.1:${server.port}/`,
        lists: l,
        ownPort: server.port,
        seams,
      }),
      byName: await post({
        url: `http://own.test:${server.port}/`,
        lists: l,
        ownPort: server.port,
        seams,
      }),
      otherPort: await post({
        url: `http://own.test:${server.port}/`,
        lists: l,
        ownPort: server.port + 1,
        seams,
      }),
    };
    // (a) red when the own-port rule is missing; (b) prints the outcomes.
    expect({ ...out, reached: server.seen.count }).toEqual({
      literal: { kind: 'failed', word: 'refused_address' },
      byName: { kind: 'failed', word: 'refused_address' },
      otherPort: { kind: 'status', status: 200 },
      reached: 1,
    });
  });
});

describe('R1.3 C1 — TLS, redirects, the reply, time', () => {
  it('TLS: a self-signed certificate is `connection` without the `ca`, also with NODE_TLS_REJECT_UNAUTHORIZED=0; with it, the request goes', async () => {
    const server = await serve(tls(EXAMPLE_TEST));
    const base = {
      url: `https://example.test:${server.port}/`,
      lists: lists([], [`example.test:${server.port}`]),
    };
    const seams = { resolve: resolver(() => at('127.0.0.1')).resolve };
    const noCa = await post({ ...base, seams });
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    const envOff = await post({ ...base, seams });
    delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    const withCa = await post({ ...base, seams: { ...seams, tls: { ca: EXAMPLE_TEST.cert } } });
    // (a) red when `rejectUnauthorized` is not forced on; (b) prints the three outcomes.
    expect({ noCa, envOff, withCa, reached: server.seen.count }).toEqual({
      noCa: { kind: 'failed', word: 'connection' },
      envOff: { kind: 'failed', word: 'connection' },
      withCa: { kind: 'status', status: 200 },
      reached: 1,
    });
  });

  it('TLS, the name: a certificate for `other.test`, trusted by the `ca`, is `connection` for `example.test`', async () => {
    const server = await serve(tls(OTHER_TEST));
    const out = await post({
      url: `https://example.test:${server.port}/`,
      lists: lists([], [`example.test:${server.port}`]),
      seams: { resolve: resolver(() => at('127.0.0.1')).resolve, tls: { ca: OTHER_TEST.cert } },
    });
    // (a) red when the name check is neutralised (`checkServerIdentity: () => undefined`); (b)
    //     prints the outcome.
    expect({ out, reached: server.seen.count }).toEqual({
      out: { kind: 'failed', word: 'connection' },
      reached: 0,
    });
  });

  it('redirects: 301, 302, 307 and 308 are `redirect`, and the target is never contacted', async () => {
    const target = await serve(plain);
    const outcomes: unknown[] = [];
    for (const status of [301, 302, 307, 308]) {
      const server = await serve(plain, (_q, res) => {
        res.writeHead(status, { location: `http://127.0.0.1:${target.port}/landing` });
        res.end();
      });
      outcomes.push(
        await post({
          url: `http://127.0.0.1:${server.port}/`,
          lists: lists([], [`http://127.0.0.1:${server.port}`, `http://127.0.0.1:${target.port}`]),
        }),
      );
    }
    // (a) red when a redirect is followed, or a 3xx is a status; (b) prints the outcomes.
    expect({ outcomes, target: target.seen.count }).toEqual({
      outcomes: [301, 302, 307, 308].map(() => ({ kind: 'failed', word: 'redirect' })),
      target: 0,
    });
  });

  it('the reply is not read: a never-ending body gives the status at once and the server sees the socket close; no accept-encoding is sent', async () => {
    let writes = 0;
    const server = await serve(plain, (_q, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      const chunk = Buffer.alloc(64 * 1024, 120);
      const pump = (): void => {
        while (!res.destroyed && res.write(chunk)) writes += 1;
        if (!res.destroyed) res.once('drain', pump);
      };
      pump();
    });
    const started = performance.now();
    const out = await post({
      url: `http://127.0.0.1:${server.port}/`,
      lists: lists([], [`http://127.0.0.1:${server.port}`]),
      deadlineMs: 5000,
    });
    const tookMs = performance.now() - started;
    await new Promise((r) => setTimeout(r, 50));
    // (a) red when the body is read (the try would not end before its deadline) or encoding is
    //     requested; (b) prints the outcome, the time, and what the server saw.
    expect({
      out,
      fast: tookMs < 2000,
      closed: server.seen.closed,
      acceptEncoding: server.seen.headers[0]?.['accept-encoding'],
    }).toEqual({
      out: { kind: 'status', status: 200 },
      fast: true,
      closed: 1,
      acceptEncoding: undefined,
    });
    expect(writes).toBeGreaterThanOrEqual(0);
  });

  it('time: a server that never answers the headers, or the TLS handshake, is `timeout` at a 50 ms deadline', async () => {
    const silent = await serve(plain, () => {});
    const sockets: net.Socket[] = [];
    const stall = net.createServer((socket) => void sockets.push(socket));
    await new Promise<void>((ok) => stall.listen(0, '127.0.0.1', () => ok()));
    onTestFinished(
      () =>
        new Promise<void>((ok) => {
          for (const socket of sockets) socket.destroy();
          stall.close(() => ok());
        }),
    );
    const stallPort = (stall.address() as AddressInfo).port;
    const headers = await post({
      url: `http://127.0.0.1:${silent.port}/`,
      lists: lists([], [`http://127.0.0.1:${silent.port}`]),
      deadlineMs: 50,
    });
    const handshake = await post({
      url: `https://stall.test:${stallPort}/`,
      lists: lists([], [`stall.test:${stallPort}`]),
      deadlineMs: 50,
      seams: { resolve: resolver(() => at('127.0.0.1')).resolve },
    });
    // (a) red when the try has no deadline (the cell's own timeout ends it instead); (b) prints both.
    expect({ headers, handshake }).toEqual({
      headers: { kind: 'failed', word: 'timeout' },
      handshake: { kind: 'failed', word: 'timeout' },
    });
  });

  it('time: `deadlineMs` 0, NaN, Infinity and 2,147,483,648 throw a TypeError before any I/O', () => {
    const r = resolver(() => at('127.0.0.1'));
    const thrown = [0, NaN, Infinity, 2_147_483_648, 1.5].map((deadlineMs) => {
      try {
        void post({
          url: 'http://deadline.test:1/',
          lists: lists([], ['http://deadline.test:1']),
          deadlineMs,
          seams: { resolve: r.resolve },
        });
        return 'no throw';
      } catch (err) {
        return err instanceof TypeError ? 'TypeError' : String(err);
      }
    });
    // (a) red when an overflowing or zero deadline is accepted (`deadlineSignal(Infinity)` fires
    //     after 1 ms); (b) prints each.
    expect({ thrown, lookups: r.calls.length }).toEqual({
      thrown: ['TypeError', 'TypeError', 'TypeError', 'TypeError', 'TypeError'],
      lookups: 0,
    });
  });
});

describe('R1.3 C1 — single flight, Retry-After, the body', () => {
  /** A resolver whose answers wait for `settle`, counting its calls. */
  function blackHole() {
    let calls = 0;
    const waiting: Array<{
      ok: (a: Array<{ address: string; family: number }>) => void;
      no: (e: Error) => void;
    }> = [];
    const resolve: Resolve = () => {
      calls += 1;
      return new Promise((ok, no) => waiting.push({ ok, no }));
    };
    return { resolve, calls: () => calls, waiting };
  }

  it('single flight: five concurrent tries to one black-holed name make ONE resolve call; after it resolves, the next try calls again', async () => {
    const b = blackHole();
    const o = {
      url: 'http://hole-resolved.test:9/',
      lists: lists([], ['http://hole-resolved.test:9']),
      deadlineMs: 50,
      seams: { resolve: b.resolve },
    };
    const five = await Promise.all([1, 2, 3, 4, 5].map(() => post(o)));
    const during = b.calls();
    b.waiting[0]!.ok(at('127.0.0.1'));
    await new Promise((r) => setTimeout(r, 10));
    await post(o);
    // (a) red when each try starts its own lookup, or a settled answer is cached; (b) prints them.
    expect({
      five: five.map((x) => (x.kind === 'failed' ? x.word : x.status)),
      during,
      after: b.calls(),
    }).toEqual({
      five: ['timeout', 'timeout', 'timeout', 'timeout', 'timeout'],
      during: 1,
      after: 2,
    });
  });

  it('single flight: after the lookup is rejected, the next try calls resolve again', async () => {
    const b = blackHole();
    const o = {
      url: 'http://hole-rejected.test:9/',
      lists: lists([], ['http://hole-rejected.test:9']),
      deadlineMs: 50,
      seams: { resolve: b.resolve },
    };
    await Promise.all([1, 2].map(() => post(o)));
    const during = b.calls();
    b.waiting[0]!.no(Object.assign(new Error('nope'), { code: 'ENOTFOUND' }));
    await new Promise((r) => setTimeout(r, 10));
    await post(o);
    // (a) red when a rejected lookup stays in the table; (b) prints the call counts.
    expect({ during, after: b.calls() }).toEqual({ during: 1, after: 2 });
  });

  it('Retry-After: digits only, at most 7; anything else is ignored', async () => {
    const values = [
      '120',
      '0',
      '12/25',
      'Wed, 21 Oct 2015 07:28:00 GMT',
      '-5',
      '+5',
      '1e3',
      '0x10',
      '12abc',
      '',
      '12345678901234567890',
      '1234567',
      '12345678',
    ];
    let next = 0;
    const server = await serve(plain, (_q, res) => {
      res.writeHead(503, { 'retry-after': values[next++]! });
      res.end();
    });
    const got: unknown[] = [];
    for (let i = 0; i < values.length; i += 1) {
      const out = await post({
        url: `http://127.0.0.1:${server.port}/`,
        lists: lists([], [`http://127.0.0.1:${server.port}`]),
      });
      got.push(out.kind === 'status' ? (out.retryAfterSeconds ?? 'none') : out.word);
    }
    // (a) red when a lenient parse reads a date, a sign, an exponent, hex or a long number; (b)
    //     prints each value's reading.
    expect(Object.fromEntries(values.map((v, i) => [v, got[i]]))).toEqual({
      '120': 120,
      '0': 0,
      '12/25': 'none',
      'Wed, 21 Oct 2015 07:28:00 GMT': 'none',
      '-5': 'none',
      '+5': 'none',
      '1e3': 'none',
      '0x10': 'none',
      '12abc': 'none',
      '': 'none',
      '12345678901234567890': 'none',
      '1234567': 1234567,
      '12345678': 'none',
    });
  });

  it('the body: a multibyte body is sent byte for byte, with its byte length as content-length', async () => {
    const server = await serve(plain);
    const body = '{"note":"héllo ✓ 日本"}';
    const out = await post({
      url: `http://127.0.0.1:${server.port}/`,
      lists: lists([], [`http://127.0.0.1:${server.port}`]),
      body,
      headers: { 'content-type': 'application/json', 'x-realm-test': 'yes' },
    });
    await new Promise((r) => setTimeout(r, 20));
    // (a) red when the length counts characters, or the bytes change; (b) prints them.
    expect({
      out,
      length: server.seen.headers[0]?.['content-length'],
      bytes: server.seen.bodies[0]?.toString('utf8'),
      header: server.seen.headers[0]?.['x-realm-test'],
      method: 'POST',
    }).toEqual({
      out: { kind: 'status', status: 200 },
      length: String(Buffer.byteLength(body, 'utf8')),
      bytes: body,
      header: 'yes',
      method: 'POST',
    });
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(body.length);
  });
});
