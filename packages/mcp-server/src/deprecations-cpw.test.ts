// deprecations-cpw.test.ts — CP-W (d): the MCP server's deprecation door. A server built with
// `deprecationNotifications` declares `logging` and is the door's sink: a raised (test) id prints its
// line once on stderr and reaches a connected client as `notifications/message` (level `warning`,
// logger `realm`) — dropped below the client's level; raised before `connect`, or through a transport
// whose send rejects, it never throws and never leaves an unhandled rejection. Built without the
// option, nothing is sent. Every id is a test id, through the door's seam. Each assertion names (a)
// the change that turns it red and (b) what it prints: counts and fixture text.
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { InMemoryTraceBufferStore, type DeprecationEntry } from '@sensigo/realm';
import { InMemoryStore } from '@sensigo/realm-testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createRealmMcpServer } from './server.js';
import { setDeprecationSink, setDeprecationTableForTests, warnDeprecated } from './deprecations.js';
import { makeTempHome, type TempHome } from './test-support/temp-home.js';

const entry = (id: string): DeprecationEntry => ({
  id,
  since: '0.49.0',
  removal: 'not scheduled',
  used: 'You used the old switch.',
  means: 'It means nothing now.',
  instead: 'Write nothing instead.',
  when: 'It goes away in a later release.',
});
const IDS = ['REALM-D931', 'REALM-D932', 'REALM-D933', 'REALM-D934', 'REALM-D935'];
const lineOf = (id: string): string =>
  `Warning: [${id}] You used the old switch. It means nothing now. Write nothing instead. It goes away in a later release.`;

const handles: TempHome[] = [];
afterEach(async () => {
  setDeprecationSink(undefined);
  vi.restoreAllMocks();
  for (const h of handles.splice(0).reverse()) await h.cleanup();
});

async function build(deprecationNotifications: boolean) {
  const runStore = new InMemoryStore();
  const h = await makeTempHome();
  handles.push(h);
  return createRealmMcpServer({
    runStore,
    workflowStore: h.stores.workflowStore,
    traceBufferStore: new InMemoryTraceBufferStore(runStore),
    failedAttemptStore: h.stores.failedAttemptStore,
    ...(deprecationNotifications ? { deprecationNotifications } : {}),
  });
}
async function connect(server: Awaited<ReturnType<typeof build>>) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cpw-d', version: '0' });
  const received: Array<Record<string, unknown>> = [];
  client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
    received.push(n.params as Record<string, unknown>);
  });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, st, received };
}
const settle = () => new Promise((r) => setTimeout(r, 50));

describe('CP-W (d) — the MCP door', () => {
  it('with the option: the line once on stderr; the notification received with no level set, dropped after setLevel(error); before connect and through a failing send, no throw and no unhandled rejection', async () => {
    onTestFinished(setDeprecationTableForTests(IDS.map(entry)));
    const stderr: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as never);
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    onTestFinished(() => void process.off('unhandledRejection', onRejection));

    const server = await build(true);
    // Before connect: the sink is this server, and no transport is attached.
    let threwBefore = false;
    try {
      warnDeprecated('REALM-D931');
    } catch {
      threwBefore = true;
    }
    await settle();
    const { client, st, received } = await connect(server);
    warnDeprecated('REALM-D932');
    warnDeprecated('REALM-D932');
    await settle();
    const afterConnect = received.length;
    await client.setLoggingLevel('error');
    warnDeprecated('REALM-D933');
    await settle();
    const afterSetLevel = received.length;
    // A transport whose send rejects: the door catches the promise.
    st.send = () => Promise.reject(new Error('the transport is gone'));
    warnDeprecated('REALM-D934');
    await settle();
    const lines = (id: string) =>
      stderr
        .join('')
        .split('\n')
        .filter((l) => l === lineOf(id)).length;
    // (a) red without `logging` declared (nothing received); red when the door neither checks the
    //     transport nor catches the promise (an unhandled rejection before connect, or through the
    //     failing send); red when the line is said twice; (b) prints the counts and what arrived.
    expect({
      threwBefore,
      rejections: rejections.length,
      stderrLines: IDS.slice(0, 4).map(lines),
      afterConnect,
      afterSetLevel,
      notification: received[0],
    }).toEqual({
      threwBefore: false,
      rejections: 0,
      stderrLines: [1, 1, 1, 1],
      afterConnect: 1,
      afterSetLevel: 1,
      notification: { level: 'warning', logger: 'realm', data: lineOf('REALM-D932') },
    });
  });

  it('without the option: the line on stderr, nothing received', async () => {
    onTestFinished(setDeprecationTableForTests(IDS.map(entry)));
    const stderr: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as never);
    const { received } = await connect(await build(false));
    warnDeprecated('REALM-D935');
    await settle();
    // (a) red when a server built without the option sends the notification; (b) prints the counts.
    expect({
      received: received.length,
      stderrLines: stderr
        .join('')
        .split('\n')
        .filter((l) => l === lineOf('REALM-D935')).length,
    }).toEqual({ received: 0, stderrLines: 1 });
  });

  it('an id not in the table throws, naming it', () => {
    onTestFinished(setDeprecationTableForTests(IDS.map(entry)));
    // (a) red when an unknown id is said or dropped silently; (b) prints the message.
    expect(() => warnDeprecated('REALM-D999')).toThrow(
      "warnDeprecated: REALM-D999 is not in Realm's deprecation table",
    );
  });
});
