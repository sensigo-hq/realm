// docs-callback-c3c2.test.ts — R1.3 callback C3c-2: the reference pages say what the program now does
// (realm-listen.md, realm-callback.md, core-library.md, and two CHANGELOG sentences). The words this unit
// moved in place (the flag rows and sections, step 7, the no-key bullet, the read address, the page's
// opening line, the callbacks row) are pinned where they were pinned before: docs-callback-c2c,
// docs-callback-k2c and docs-result-read-r11. Here:
//   1. every paragraph and row this unit added, word for word (spaces folded, as a table's padding moves),
//      each with the cell or record that executes what it says;
//   2. the log rows are real: the door's `webhook: …callback…` rows against their log calls, both ways;
//      the twelve pass rows against the lines `makeCallbackPass` says when each is triggered, through the
//      page's own rows; `pass failed` through `makePollRunner`;
//   3. the false sentences are gone from docs/ and the CHANGELOG;
//   4. the laws: the Log lines table's cell count, the markers, the anchors the new links name;
//   5. the callers the callbacks row and the CHANGELOG now name are the code's.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeStep } from '@sensigo/realm';
import { InMemoryStore, settableClock } from '@sensigo/realm-testing';
import { describe, expect, it, onTestFinished } from 'vitest';
import { parseCallbackEntry, type CallbackLists } from '../lib/callback/allow-list.js';
import { makeCallbackPass, type CallbackPassDeps } from '../lib/callback/delivery-pass.js';
import type { PostFailureWord } from '../lib/callback/post-once.js';
import { deriveReadKey, type ReadEntry } from '../lib/run-read-address.js';
import {
  capturingLogger,
  emptySet,
  ENV,
  sharedSecretTrigger,
  workflow,
} from '../test-support/listen-read-r11.js';
import { makePollRunner } from './listen-reminders.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');
const LISTEN = 'docs/reference/cli/realm-listen.md';
const CALLBACK = 'docs/reference/cli/realm-callback.md';
const GUIDE = 'docs/guides/webhooks.md';
const CHANGELOG = 'CHANGELOG.md';
const MARK = 'Added after version 0.50.0.';
const flat = (t: string): string => t.replace(/\s+/g, ' ');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const src = (path: string): string => read(join('packages/cli/src', path));
/** (1) red when the page no longer holds the text word for word; (2) prints the text. */
function claim(page: string, text: string): void {
  expect(flat(read(page)), `${page} no longer says: ${text}`).toContain(flat(text));
}

// ---------------------------------------------------------------------------------------------
// The Log lines table of realm-listen.md, read from the page.
// ---------------------------------------------------------------------------------------------

/** The section of a page from its `## title` heading to the next `## ` heading. */
function sectionOf(page: string, title: string): string {
  const text = read(page);
  const start = text.indexOf(`\n## ${title}\n`);
  if (start < 0) throw new Error(`${page} has no "## ${title}"`);
  const end = text.indexOf('\n## ', start + 1);
  return text.slice(start, end < 0 ? undefined : end);
}
/** A table row's parts, split on every `|` that is not escaped (the GFM rule, code spans included). */
const partsOf = (row: string): string[] => row.split(/(?<!\\)\|/);
interface Row {
  readonly level: string;
  /** The Line cell's code spans, each with `\|` read as `|`. */
  readonly spans: string[];
  readonly when: string;
}
function logRows(): Row[] {
  return sectionOf(LISTEN, 'Log lines')
    .split('\n')
    .filter((l) => l.startsWith('| `'))
    .map((l) => {
      const p = partsOf(l).map((c) => c.trim());
      return {
        level: p[1]!.replace(/`/g, ''),
        spans: [...p[2]!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.replace(/\\\|/g, '|')),
        when: p[3]!,
      };
    });
}
/** A pass row's line as a pattern: its placeholders read as the values the code puts there. */
function patternOf(template: string): RegExp {
  const holes: Array<[string, string]> = [
    [
      '(none | sealed with encryption key <fingerprint>)',
      '\\((?:none|sealed with encryption key [0-9a-f]+)\\)',
    ],
    ['<status or word>', '(?:\\d{3}|redirect|refused_address|timeout|connection)'],
    ['<workflow>', '[a-z0-9_-]+'],
    ['<host>', '[a-z0-9.:-]+'],
    ['<n>', '\\d+'],
    ['<run id>', '[0-9a-f-]{36}'],
    ['<class>', '[A-Za-z]+'],
  ];
  let out = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [hole, pattern] of holes) {
    out = out.split(hole.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(pattern);
  }
  return new RegExp(`^${out}$`);
}
/** C3d-A: the sweep's count line, whose Line cell also names the singular (`callback`, `<n>`). */
const MORE = 'listen: callbacks: and <n> more callbacks ended the same way';
/** A `listen: callbacks: <workflow> …` row the pass says, or the sweep's count line: not a start line (those are C2c's, in
 * `lib/callback/start-lines.ts`, pinned by docs-callback-c2c), which the page marks "At startup". */
const isPassRow = (r: Row): boolean =>
  ((r.spans.length === 1 && r.spans[0]!.startsWith('listen: callbacks: <workflow> ')) ||
    r.spans[0] === MORE) &&
  !r.when.startsWith('At startup');
/** The pass rows of the page: each one's level and line. */
const passRows = (): Array<{ level: string; template: string }> =>
  logRows()
    .filter(isPassRow)
    .map((r) => ({ level: r.level, template: r.spans[0]! }));
/** The page's pass row a said line belongs to (the runner adds `listen: `), or what it found. */
function rowOf(level: string, msg: string): string {
  const said = `listen: ${msg}`;
  const hits = passRows().filter((r) => patternOf(r.template).test(said));
  if (hits.length !== 1) return `${hits.length} rows match ${level} ${said}`;
  return `${hits[0]!.level} ${hits[0]!.template}`;
}

// ---------------------------------------------------------------------------------------------
// The pass, on the in-memory store and its settable clock, against loopback receivers (C3a's seams).
// ---------------------------------------------------------------------------------------------

const W = 'refunds';
const KEY = '1a'.repeat(32);
const DAY = 86_400_000;
const live = (): boolean => true;
const entry = (text: string) => {
  const r = parseCallbackEntry(text);
  if (!r.ok) throw new Error(`fixture: ${text} refused ${r.word}`);
  return r.entry;
};
const privateList = (...texts: string[]): CallbackLists => ({
  public: [],
  private: texts.map(entry),
});

/** A receiver on 127.0.0.1 answering every POST with `status`; closed after the cell. */
async function receiver(status: number): Promise<number> {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(status);
      res.end();
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  onTestFinished(
    () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  );
  return (server.address() as AddressInfo).port;
}
/** A port nothing listens on: a server bound, read and closed. */
async function closedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((ok) => server.close(() => ok()));
  return port;
}

async function world() {
  const clock = settableClock('2026-11-20T12:00:00.000Z');
  const store = new InMemoryStore({ clock });
  const callbacks = store.callbacks!;
  const definition = workflow(
    W,
    sharedSecretTrigger('/refunds', { approved: 'context.resources.review.approved' }),
  );
  const mounted: ReadEntry = {
    path: '/refunds',
    definition,
    readKey: await deriveReadKey(ENV['READ_SECRET']!, W),
  };
  const logger = capturingLogger();
  /** A completed run with a callback to `http://127.0.0.1:<port>/cb` (or of another workflow). */
  const run = async (port: number, workflowId = W): Promise<{ id: string; host: string }> => {
    const host = `127.0.0.1:${port}`;
    const { record } = await store.create({
      workflowId,
      workflowVersion: 1,
      params: {},
      callback: { url: `http://${host}/cb`, host, webhook_id: randomUUID() },
    });
    await executeStep(store, definition, {
      runId: record.id,
      command: 'review',
      input: { approved: true },
      dispatcher: async (_c, input) => input,
    });
    return { id: record.id, host };
  };
  const getRun = async (id: string) => {
    try {
      return (await store.get(id)).record;
    } catch {
      return undefined;
    }
  };
  const pass = (port: number, over: Partial<CallbackPassDeps> = {}) =>
    makeCallbackPass({
      callbacks,
      getRun,
      entryOf: (id) => (id === W ? mounted : undefined),
      disclosureProvider: async () => emptySet(),
      lists: privateList(`http://127.0.0.1:${port}`),
      ownPort: 1,
      logger,
      random: () => 0.5,
      ...over,
    });
  /** Each line said, as `<level> <the page's row it belongs to>`. */
  const rows = () => logger.lines.map((l) => rowOf(l.level, l.msg));
  return { clock, store, callbacks, logger, run, pass, rows };
}
const row = (level: string, template: string) => `${level} listen: callbacks: ${template}`;

// ---------------------------------------------------------------------------------------------
// Cell 1: the words this unit added, each held to its page.
// ---------------------------------------------------------------------------------------------

describe('C3c-2 — cell 1: the words, each held to its page', () => {
  it('5. ### Sending callbacks: the pass, its first time, what it sends for, what it says', () => {
    // Pinned by: listen-callback-c3b2 'the wake: an agent this process started exits, and its run’s callback goes out at once (the period is 30 s), signed, ending delivered', 'the period: a run another process finished goes out at the 30-second tick, not at 29,999 ms', 'no wake at the bind: a row due when the server starts is not sent, and no line is said, until an agent exits', 'off means off: …'; delivery-pass-c3a 'a row of a workflow this process does not mount is neither claimed nor written, with one line however many passes', 'a row whose host is no longer on the lists ends not_allowed, with no POST', 'no leak: …'; delivery-pass-sqlite-c3a 'keys this process cannot read — …: nothing claimed, nothing sent, one line per pair and master key'; the restart cases CB-C3C2-AU (a flag for another entry ends the rows not_allowed, one line each; no flag sends nothing and says nothing); the lines, this file's cell 2.
    claim(
      LISTEN,
      "### Sending callbacks With `--callback-allow` or `--callback-allow-private`, `realm listen` sends the callbacks that are due. It looks for them in a pass, which it makes when an agent it started exits and every 30 seconds, for whatever is then due: a run another process finished or a try made again. The first pass is at the first of these, never at the start, so a callback left by an earlier process that is already due is sent at the first agent exit or, at the latest, about 30 seconds after the start lines. It sends only for a workflow it has mounted and a key it can read; when it cannot, it says so once (`listen: callbacks: <workflow> is not mounted by this realm listen, so its callbacks wait`; `listen: callbacks: <workflow> → <host>: no signing key this process can read (…), so its callbacks wait`) and the callback waits. An address with no entry in this `realm listen`'s flags is not sent to: the callback ends `not_allowed`, with one line `listen: callbacks: <workflow> → <host>: not sent: its address is no longer allowed by this realm listen` for each. A `realm listen` started with neither flag sends nothing and says nothing about the callbacks left waiting. Its lines begin `listen: callbacks:` and show the workflow, the host, the attempt and the answer, never the address, a key or a body. What is sent, when a try is made again and when a callback is given up are in [Receive a callback](../../guides/webhooks.md#receive-a-callback). Added after version 0.50.0.",
    );
  });

  // Item 6: each row, word for word. Pinned by: this file's cell 2 (each row against the code).
  const ROWS = [
    '| `info` | `listen: callbacks: <workflow> → <host>: delivered (attempt <n>)` | A callback was delivered (a `2xx` answer). Added after version 0.50.0. |',
    '| `warn` | `listen: callbacks: <workflow> → <host>: attempt <n> failed (last answer <status or word>); it will try again` | Once for each run and each answer, in each `realm listen` process: the first time a try of a callback ends in that answer; the word is `redirect`, `refused_address`, `timeout` or `connection`. Added after version 0.50.0. |',
    '| `warn` | `listen: callbacks: <workflow> → <host>: the receiver answered 410, so it will not be tried again` | A receiver answered `410`. Added after version 0.50.0. |',
    '| `warn` | `listen: callbacks: <workflow> → <host>: not sent: its address is no longer allowed by this realm listen` | No entry of this `realm listen` allows the address any more. The callback is ended and is not sent, even if the entry is added back. Added after version 0.50.0. |',
    '| `warn` | `listen: callbacks: <workflow> → <host>: stopped at attempt <n>: not delivered within its time limit` | A callback was given up: 3 days after its run ended, or 1 hour after its first try when the last answer was a `4xx` other than `408`, `425` or `429`, or a callback that was due and ended by this pass. Added after version 0.50.0. |',
    // C3d-A: the sweep's two lines. Pinned by: this file's cell 2d (each against the code), and
    // delivery-pass-c3d (the three states a never-sent row comes from; 25 and 11 rows ended).
    '| `warn` | `listen: callbacks: <workflow> → <host>: never sent: its time limit passed before a try could be made` | A callback that no `realm listen` sent within 3 days of its run ending: its workflow was not mounted by any, its key could not be read, or none was running. Added after version 0.50.0. |',
    '| `warn` | `listen: callbacks: and <n> more callbacks ended the same way` (`callback` when `<n>` is 1) | More than 10 callbacks ended in one pass. Added after version 0.50.0. |',
    '| `warn` | `listen: callbacks: <workflow> is not mounted by this realm listen, so its callbacks wait` | Once for a workflow whose callbacks are due and which this `realm listen` has not mounted. Start a `realm listen` that mounts it: the callback is sent at its next pass. Added after version 0.50.0. |',
    '| `warn` | `listen: callbacks: <workflow> → <host>: no signing key this process can read (none \\| sealed with encryption key <fingerprint>), so its callbacks wait` | Once for each workflow, host and key state when the key cannot be read, and once more each time a try found the key readable and it was then lost again. For `none`, make the key with `realm callback key <workflow folder> --host <host>`: a `realm listen` that started with the master key uses it at the next pass, and any other must be restarted. For `sealed with …`, start `realm listen` with that encryption key, or make the key again with `--replace`. Added after version 0.50.0. |',
    '| `warn` | `listen: callbacks: <workflow> → <host>: could not build the body for run <run id>; it will try again` | Once for each run. Added after version 0.50.0. |',
    '| `warn` | `listen: callbacks: <workflow> → <host>: run <run id> was not found; it will try again` | Once for each run. Added after version 0.50.0. |',
    '| `error` | `listen: callbacks: <workflow> → <host>: unexpected error (<class>) for run <run id>` | Any other failure with one callback, once for each run and each error class in a process; the next one goes on. Added after version 0.50.0. |',
    '| `error` | `listen: callbacks: pass failed {"error"}` | A whole pass for due callbacks failed, for example the store could not be read. Added after version 0.50.0. |',
    // C3d-B: the stop's two lines. Pinned by: listen-reminders-d3b 'C3d-B — the stop says what it waits for and what it cuts' (each line on a real startListen, its count, said once).
    '| `info` | `listen: callbacks: waiting for <n> callback(s) to be sent` | `realm listen` was stopped while a try was in flight and the stop waits for it (a grace or a drain above 0). Added after version 0.50.0. |',
    '| `warn` | `listen: callbacks: <n> callback(s) were cut by the stop; they are sent again after the next start, with the same id` | The grace ran out, or a second signal came, with that many tries in flight. Added after version 0.50.0. |',
    '| `warn` | `webhook: callback not enabled {"path","workflow"}` | A request named a callback address and the workflow or this `realm listen` takes none. Added after version 0.50.0. |',
    '| `warn` | `webhook: callback refused (<reason>) {"path","workflow"[,"host"]}` | A request\'s callback address was refused with `400`; for `no_key`, the first time for each workflow, host and key state in this process, the message says what to do: the `realm callback key` command (for a key sealed under another master key, start `realm listen` with that key or make the key again with `--replace`). Added after version 0.50.0. |',
    '| `info` | `webhook: callback registered {"path","workflow","host"}` | A new run took a callback address. Added after version 0.50.0. |',
    '| `warn` | `webhook: callback backlog full {"path","workflow","host","waiting"}` | The `503`: 1,000 callbacks are waiting. Added after version 0.50.0. |',
    '| `error` | `webhook: callback key could not be read {"path","workflow","host","error"}`, `webhook: callback backlog could not be counted {"path","workflow","host","error"}` | The store failed; the reply is `500`. Added after version 0.50.0. |',
    '| `warn` | `webhook: the callback of a repeated event could not be read {…,"run_id","error"}` | A repeat\'s reply could not say `ignored_duplicate` or `none`. Added after version 0.50.0. |',
    '| `error` | `webhook: failed to remove the callback of a run that did not start {"run_id","error"}` | A spawn failed and the run\'s callback row could not be removed. Added after version 0.50.0. |',
    '| `error` | `webhook: callback view could not be read {"path","run_id","error"}` | A read of a run could not read its callback state; the reply is `200` without `callback`. Added after version 0.50.0. |',
  ];
  for (const [i, text] of ROWS.entries()) {
    it(`6.${i + 1} Log lines: ${text.slice(4, 70)}`, () => claim(LISTEN, text));
  }

  it('7. How it stops: a callback being sent finishes within the grace; a cut try is made again; exit 0', () => {
    // Pinned by: CB-C3C2-AU (executed: `--shutdown-grace 3` with a 12 s try, exit 0 at 3.02 s, no line, the row pending for its next try; `--shutdown-drain 3 --shutdown-grace 3`, 6.03 s; a cut request, exit 1 and the cut line; a second signal ends the wait); CB-C3C1-RV (a cut try repeats ~62–73 s later with the same id); listen-callback-c3b2 (the runner's stop). C3d-B: the sentence on what the stop says, listen-reminders-d3b 'C3d-B — the stop says what it waits for and what it cuts'.
    claim(
      LISTEN,
      'A callback being sent when `realm listen` is stopped finishes the one it is on, within the same grace and no longer, and starts no other. A try that the grace cuts is made again about a minute after the next start, with the same `webhook-id`, and the exit code stays 0: only a request that is cut makes it 1. The stop says so: `waiting for <n> callback(s) to be sent` when it begins, and `<n> callback(s) were cut by the stop` if the grace or a second signal cuts a try. A second Ctrl+C or `SIGTERM` ends the wait at once. Added after version 0.50.0.',
    );
  });

  it('10. realm-callback.md: during a rotation two signatures, the new first; each try reads the keys afresh', () => {
    // Pinned by: delivery-pass-c3a 'a rotation: inside the overlap a try carries two tokens, current first; past the previous key’s end, one — the same pass function, no restart', 'the keys are read fresh for every try: a rotation made during the first POST is seen by the second row of the same pair in the same pass'; delivery-pass-sqlite-c3a 'a rotation made by another process (`realm callback key --rotate`) is seen by the next try of the same pass function, with no restart'.
    claim(
      CALLBACK,
      "While the old key is kept after `--rotate`, `realm listen` signs each callback with both keys, the new key's signature first, so a receiver that has not yet been given the new key still checks it. Each try reads the keys afresh: a key made, rotated or ended here takes effect at the next try, with no restart, provided the master key that seals the keys was there when `realm listen` started; a `realm listen` that started without it, or with another one, must be restarted, and its start lines say so.",
    );
  });

  it('11. realm-callback.md: a key realm listen cannot read sends none of its callbacks; said at start and once when due', () => {
    // Pinned by: the K2c claim 53 of the paragraph's first sentences; listen-switch-c2c (the start's warning for a key it cannot read); delivery-pass-sqlite-c3a 'keys this process cannot read — sealed under another master key, or a home opened with no master key — and a pair with none: nothing claimed, nothing sent, one line per pair and master key'.
    claim(
      CALLBACK,
      '`realm db backup` does not copy the master key: the copy has the keys, sealed, and not what opens them. Keep a copy of the master key somewhere safe, apart from your backups. If it is lost, or a store is restored on another machine without it, the stored keys cannot be read. Runs are not affected, only the keys: make each key again with `--replace` and give each receiver the new key. A `realm listen` that cannot read the key for a workflow and receiver sends none of the callbacks that key signs: it says so at start and once more when one is due, and they wait.',
    );
  });

  it('13. CHANGELOG: the callback row is written and read by realm listen, read by inspect and purge, removed by purge', () => {
    // Pinned by: this file's cell 5 (the callers).
    claim(
      CHANGELOG,
      "and then refuses a `callback`. `realm listen` writes a run's row and reads it, `realm run inspect` and `realm run purge` read it, and purge removes it. The store of `@sensigo/realm-store-sqlite` keeps one",
    );
  });

  it('14. CHANGELOG: the sender side is used by realm listen', () => {
    // Pinned by: this file's cell 5 (due, claim, freezeBody and mark, from the pass realm listen runs).
    claim(
      CHANGELOG,
      "`callbackStoreContract` gains the sender's laws. `realm listen` uses them to send callbacks.",
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Cell 2: the log rows are real.
// ---------------------------------------------------------------------------------------------

/** Where each door line is logged: the file, and the call's text up to its end. */
function doorCalls(): Array<{ file: string; level: string; msg: string; call: string }> {
  const out: Array<{ file: string; level: string; msg: string; call: string }> = [];
  for (const file of ['commands/listen.ts', 'lib/run-read-address.ts']) {
    const text = src(file);
    for (const m of text.matchAll(
      /logger\.(info|warn|error)\(\s*['`](webhook: [^'`$]*callback[^'`$]*)/g,
    )) {
      const end = text.indexOf(');', m.index);
      out.push({ file, level: m[1]!, msg: m[2]!, call: text.slice(m.index, end) });
    }
  }
  return out;
}
/** The door rows of the page: each `webhook: …callback…` code span's message, level and keys. */
function doorRows(): Array<{ level: string; msg: string; keys: string[] }> {
  return logRows().flatMap((r) =>
    r.spans
      .filter((s) => s.startsWith('webhook: ') && s.includes('callback'))
      .map((s) => {
        const brace = s.indexOf(' {');
        return {
          level: r.level,
          msg: s.slice(0, brace),
          keys: [...s.slice(brace).matchAll(/"([a-z_]+)"/g)].map((k) => k[1]!),
        };
      }),
  );
}

describe('C3c-2 — cell 2: the log rows are real', { timeout: 60_000 }, () => {
  it('2a. every door row is a log call at its level, with its keys; every door callback call has a row', () => {
    const calls = doorCalls();
    // The refusal's message is a template: its fixed words up to the reason.
    const callOf = (msg: string) =>
      calls.find(
        (c) =>
          c.msg === msg ||
          (msg.includes('(<reason>)') && c.msg === msg.split('(<reason>)')[0] + '('),
      );
    const rowsSeen = doorRows().map((r) => {
      const c = callOf(r.msg);
      return {
        row: `${r.level} ${r.msg}`,
        call: c === undefined ? 'no call' : `${c.level} in ${c.file}`,
        missingKeys:
          c === undefined ? [] : r.keys.filter((k) => !new RegExp(`\\b${k}\\b`).test(c.call)),
      };
    });
    const unrowed = calls
      .filter(
        (c) => !doorRows().some((r) => r.msg === c.msg || r.msg.startsWith(`${c.msg}<reason>`)),
      )
      .map((c) => `${c.level} ${c.msg} (${c.file})`);
    // (1) red when a row's words, level or keys differ from its call, a row names no call, or a door
    //     callback line has no row; (2) prints each row against its call and the calls with no row.
    expect({ rows: rowsSeen, unrowed }).toEqual({
      rows: [
        {
          row: 'warn webhook: callback not enabled',
          call: 'warn in commands/listen.ts',
          missingKeys: [],
        },
        {
          row: 'warn webhook: callback refused (<reason>)',
          call: 'warn in commands/listen.ts',
          missingKeys: [],
        },
        {
          row: 'info webhook: callback registered',
          call: 'info in commands/listen.ts',
          missingKeys: [],
        },
        {
          row: 'warn webhook: callback backlog full',
          call: 'warn in commands/listen.ts',
          missingKeys: [],
        },
        {
          row: 'error webhook: callback key could not be read',
          call: 'error in commands/listen.ts',
          missingKeys: [],
        },
        {
          row: 'error webhook: callback backlog could not be counted',
          call: 'error in commands/listen.ts',
          missingKeys: [],
        },
        {
          row: 'warn webhook: the callback of a repeated event could not be read',
          call: 'warn in commands/listen.ts',
          missingKeys: [],
        },
        {
          row: 'error webhook: failed to remove the callback of a run that did not start',
          call: 'error in commands/listen.ts',
          missingKeys: [],
        },
        {
          row: 'error webhook: callback view could not be read',
          call: 'error in lib/run-read-address.ts',
          missingKeys: [],
        },
      ],
      unrowed: [],
    });
  });

  it("2b. the runner says each pass line with `listen: ` before it, and runs the pass under the label 'callbacks'", () => {
    const listen = src('commands/listen.ts');
    const runner = listen.slice(listen.indexOf('function callbackRunnerOf('));
    const body = runner.slice(0, runner.indexOf('\n}\n'));
    // (1) red when the runner drops or changes the prefix, logs without it at one level, or gives the
    //     poll another label; (2) prints which part is missing.
    expect({
      prefix: body.includes('deps.logger[level](`listen: ${msg}`, data)'),
      levels: body.includes(
        "logger: { info: prefixed('info'), warn: prefixed('warn'), error: prefixed('error') }",
      ),
      label: body.includes("makePollRunner(pass, 'callbacks', deps.logger)"),
    }).toEqual({ prefix: true, levels: true, label: true });
  });

  it('2c. pass failed: a pass whose store cannot list the due rows says the row, at error, with its one key', async () => {
    const w = await world();
    w.callbacks.due = async () => {
      throw new Error('the store went away');
    };
    const runner = makePollRunner(w.pass(1), 'callbacks', w.logger);
    await runner.wake();
    await runner.stop();
    const page = passFailedRow();
    // (1) red when the row's words, level or key differ from the runner's line; (2) prints both.
    expect(
      w.logger.lines.map((l) => ({ level: l.level, msg: l.msg, keys: Object.keys(l.data ?? {}) })),
    ).toEqual([{ level: page.level, msg: page.msg, keys: page.keys }]);
    expect(page).toEqual({
      level: 'error',
      msg: 'listen: callbacks: pass failed',
      keys: ['error'],
    });
  });

  it('2d. the twelve pass rows, each from the line its trigger makes the pass say', async () => {
    const said: Record<string, string[]> = {};
    // delivered: a 2xx.
    {
      const w = await world();
      const port = await receiver(204);
      const { host } = await w.run(port);
      await w.callbacks.keys.make(W, host, KEY);
      await w.pass(port)(live);
      said['delivered'] = w.rows();
    }
    // attempt failed: a status (503), and a word (connection, a port nothing listens on).
    {
      const w = await world();
      const port = await receiver(503);
      const { host } = await w.run(port);
      await w.callbacks.keys.make(W, host, KEY);
      await w.pass(port)(live);
      const shut = await closedPort();
      const other = await w.run(shut);
      await w.callbacks.keys.make(W, other.host, KEY);
      await w.pass(shut)(live);
      said['retry'] = w.rows();
    }
    // 410.
    {
      const w = await world();
      const port = await receiver(410);
      const { host } = await w.run(port);
      await w.callbacks.keys.make(W, host, KEY);
      await w.pass(port)(live);
      said['gone'] = w.rows();
    }
    // not allowed: the lists no longer hold the address.
    {
      const w = await world();
      const port = await receiver(200);
      const { host } = await w.run(port);
      await w.callbacks.keys.make(W, host, KEY);
      await w.pass(port, { lists: privateList('http://127.0.0.1:1') })(live);
      said['notAllowed'] = w.rows();
    }
    // C3d-A: never sent: 3 days after the run finished, no try made (the sweep ends it).
    {
      const w = await world();
      const port = await receiver(200);
      const { host } = await w.run(port);
      await w.callbacks.keys.make(W, host, KEY);
      await w.clock.advance(3 * DAY + 1);
      await w.pass(port)(live);
      said['neverSent'] = w.rows();
    }
    // stopped: one try made (503), then 3 days after the run finished (the sweep ends it).
    {
      const w = await world();
      const port = await receiver(503);
      const { host } = await w.run(port);
      await w.callbacks.keys.make(W, host, KEY);
      await w.pass(port)(live);
      await w.clock.advance(3 * DAY + 1);
      await w.pass(port)(live);
      said['stopped'] = w.rows();
    }
    // C3d-A: more than 10 ended in one pass: 10 lines, then the count (12 rows: "2 more callbacks").
    {
      const w = await world();
      const port = await receiver(200);
      for (let i = 0; i < 12; i += 1) await w.run(port);
      await w.clock.advance(3 * DAY + 1);
      await w.pass(port)(live);
      said['more'] = w.rows();
    }
    // not mounted.
    {
      const w = await world();
      const port = await receiver(200);
      const { host } = await w.run(port, 'other');
      await w.callbacks.keys.make('other', host, KEY);
      await w.pass(port)(live);
      said['unmounted'] = w.rows();
    }
    // no signing key (none).
    {
      const w = await world();
      const port = await receiver(200);
      await w.run(port);
      await w.pass(port)(live);
      said['noKey'] = w.rows();
    }
    // the body cannot be built; the run is not found; any other failure.
    for (const [name, over] of [
      [
        'noBody',
        {
          disclosureProvider: async () => {
            throw new Error('no disclosure set');
          },
        },
      ],
      ['noRun', { getRun: async () => undefined }],
      [
        'unexpected',
        {
          getRun: async () => {
            throw new TypeError('the store went away');
          },
        },
      ],
    ] as Array<[string, Partial<CallbackPassDeps>]>) {
      const w = await world();
      const port = await receiver(200);
      const { host } = await w.run(port);
      await w.callbacks.keys.make(W, host, KEY);
      await w.pass(port, over)(live);
      said[name] = w.rows();
    }
    // (1) red when a row's words or level on the page differ from what the pass says on its trigger
    //     (no row, or two, then match), or the pass says another line; (2) prints, per trigger, the
    //     page's row each said line matched.
    expect(said).toEqual({
      delivered: [row('info', '<workflow> → <host>: delivered (attempt <n>)')],
      retry: [
        row(
          'warn',
          '<workflow> → <host>: attempt <n> failed (last answer <status or word>); it will try again',
        ),
        row(
          'warn',
          '<workflow> → <host>: attempt <n> failed (last answer <status or word>); it will try again',
        ),
      ],
      gone: [
        row(
          'warn',
          '<workflow> → <host>: the receiver answered 410, so it will not be tried again',
        ),
      ],
      notAllowed: [
        row(
          'warn',
          '<workflow> → <host>: not sent: its address is no longer allowed by this realm listen',
        ),
      ],
      neverSent: [
        row(
          'warn',
          '<workflow> → <host>: never sent: its time limit passed before a try could be made',
        ),
      ],
      stopped: [
        row(
          'warn',
          '<workflow> → <host>: attempt <n> failed (last answer <status or word>); it will try again',
        ),
        row(
          'warn',
          '<workflow> → <host>: stopped at attempt <n>: not delivered within its time limit',
        ),
      ],
      more: [
        ...Array.from({ length: 10 }, () =>
          row(
            'warn',
            '<workflow> → <host>: never sent: its time limit passed before a try could be made',
          ),
        ),
        row('warn', 'and <n> more callbacks ended the same way'),
      ],
      unmounted: [
        row('warn', '<workflow> is not mounted by this realm listen, so its callbacks wait'),
      ],
      noKey: [
        row(
          'warn',
          '<workflow> → <host>: no signing key this process can read (none | sealed with encryption key <fingerprint>), so its callbacks wait',
        ),
      ],
      noBody: [
        row(
          'warn',
          '<workflow> → <host>: could not build the body for run <run id>; it will try again',
        ),
      ],
      noRun: [row('warn', '<workflow> → <host>: run <run id> was not found; it will try again')],
      unexpected: [
        row('error', '<workflow> → <host>: unexpected error (<class>) for run <run id>'),
      ],
    });
    // Every pass row of the page was reached by a trigger above.
    const reached = new Set(Object.values(said).flat());
    // (1) red when the page gains a pass row no trigger reaches; (2) prints the rows not reached.
    expect(
      passRows()
        .map((r) => `${r.level} ${r.template}`)
        .filter((r) => !reached.has(r)),
    ).toEqual([]);
  });

  it("2e. the retry row's words are the post's failure words but not_allowed (which ends the callback)", () => {
    const WORDS = ['redirect', 'refused_address', 'timeout', 'connection'] as const;
    // Compile-time: red (typecheck:tests) when the post gains a failure word the row does not name.
    type Unnamed = Exclude<Exclude<PostFailureWord, 'not_allowed'>, (typeof WORDS)[number]>;
    const covered: [Unnamed] extends [never] ? true : false = true;
    const retry = logRows().find((r) => r.spans[0]?.includes('attempt <n> failed'));
    // (1) red when the row's list of words differs; (2) prints the row's words.
    expect({
      covered,
      words: [...(retry?.when ?? '').matchAll(/`([a-z_]+)`/g)].map((m) => m[1]),
    }).toEqual({ covered: true, words: [...WORDS] });
  });
});

/** The `pass failed` row of the page, as level, message and keys. */
function passFailedRow(): { level: string; msg: string; keys: string[] } {
  const r = logRows().find((x) => x.spans[0] === 'listen: callbacks: pass failed {"error"}');
  if (r === undefined) return { level: '-', msg: 'no row', keys: [] };
  const s = r.spans[0]!;
  return {
    level: r.level,
    msg: s.slice(0, s.indexOf(' {')),
    keys: [...s.matchAll(/"([a-z_]+)"/g)].map((k) => k[1]!),
  };
}

// ---------------------------------------------------------------------------------------------
// Cell 3: the false sentences are gone.
// ---------------------------------------------------------------------------------------------

/** Every Markdown file under docs/, as paths from the root. */
function docsFiles(dir = 'docs'): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = `${dir}/${name}`;
    if (statSync(join(ROOT, path)).isDirectory()) return docsFiles(path);
    return path.endsWith('.md') ? [path] : [];
  });
}

describe('C3c-2 — cell 3: the false sentences are gone', () => {
  it('no page and no CHANGELOG line says Realm does not send, does not check the address, or that no command uses the store', () => {
    const FALSE = [
      'does not yet send a callback',
      'this version does not check which address',
      'No Realm command reads or writes its rows yet',
      'No Realm command uses them yet',
      'No other command uses the callback store yet',
      'This version of Realm does not send a callback',
    ];
    const found = [...docsFiles(), CHANGELOG].flatMap((page) => {
      const text = flat(read(page));
      return FALSE.filter((s) => text.includes(s)).map((s) => `${page}: ${s}`);
    });
    // (1) red when a left-over sentence is on any page, or the walk finds no pages (the instrument
    //     reads docs/: 75 pages at 0b57a901); (2) prints each page and sentence.
    expect({
      pages: docsFiles().length > 50 && docsFiles().includes(LISTEN),
      found,
    }).toEqual({ pages: true, found: [] });
  });
});

// ---------------------------------------------------------------------------------------------
// Cell 4: the laws.
// ---------------------------------------------------------------------------------------------

/** The anchor a heading gets: lower case, its marks dropped (underscores kept), its spaces as hyphens. */
const slug = (heading: string): string =>
  heading
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, '')
    .trim()
    .replace(/ /g, '-');
function anchorsOf(page: string): Set<string> {
  const out = new Set<string>();
  let fence = false;
  for (const line of read(page).split('\n')) {
    if (line.startsWith('```')) fence = !fence;
    else if (!fence && /^#{1,6} /.test(line)) out.add(slug(line.replace(/^#+ /, '')));
  }
  return out;
}

describe('C3c-2 — cell 4: the laws', () => {
  it('every row of the Log lines table has three cells when split on unescaped |', () => {
    const lines = sectionOf(LISTEN, 'Log lines')
      .split('\n')
      .filter((l) => l.startsWith('|'));
    const odd = lines.filter((l) => partsOf(l).length !== 5).map((l) => l.slice(0, 120));
    // (1) red when a row gains an unescaped | (inside a code span too) or loses a cell; (2) prints the
    //     rows and how many rows there are.
    expect({ rows: lines.length > 70, odd }).toEqual({ rows: true, odd: [] });
  });

  it('the markers: the new section once; each new row; the stop paragraph; the read address in its own form', () => {
    const page = read(LISTEN);
    const sending = page.slice(
      page.indexOf('### Sending callbacks'),
      page.indexOf('## The health address'),
    );
    const rows = logRows().filter(
      (r) =>
        r.spans.some((s) => s.startsWith('webhook: ') && s.includes('callback')) ||
        isPassRow(r) ||
        r.spans[0] === 'listen: callbacks: pass failed {"error"}',
    );
    const stops = sectionOf(LISTEN, 'How it stops');
    const readAddress = sectionOf(LISTEN, 'The read address');
    const count = (t: string) => t.split(MARK).length - 1;
    // (1) red when a marker is dropped or said twice; (2) prints the counts.
    expect({
      sending: count(sending),
      rows: rows.length,
      rowsMarked: rows.filter((r) => count(r.when) === 1).length,
      stop: count(stops.slice(stops.indexOf('A callback being sent when'))),
      read: flat(readAddress).includes(
        '#seeing-how-a-callback-stands); added after version 0.50.0); the `202` gives',
      ),
    }).toEqual({ sending: 1, rows: 21, rowsMarked: 21, stop: 1, read: true });
  });

  it('the links the new words name resolve: the guide has both anchors, and every link added here points at one', () => {
    const own = anchorsOf(GUIDE);
    const links = [LISTEN, CALLBACK].flatMap((page) =>
      [...read(page).matchAll(/\]\(\.\.\/\.\.\/guides\/webhooks\.md#([a-z0-9-]+)\)/g)].map(
        (m) => `${page}#${m[1]}`,
      ),
    );
    // (1) red when the guide's heading is renamed or a link names a heading it does not have; (2)
    //     prints the anchors missing and the links. 8 links: the six this unit added (realm-listen.md's
    //     two flag rows, its --callback-allow section, Sending callbacks and the read address;
    //     realm-callback.md's first paragraph) and realm-callback.md's two to #getting-the-result-back.
    // Correction 1: the no-key bullet's link to this page's own "Sending callbacks" heading.
    const inPage = [...read(LISTEN).matchAll(/\]\(#(sending-callbacks)\)/g)].map((m) => m[1]!);
    expect({
      guide: existsSync(join(ROOT, GUIDE)),
      missing: ['receive-a-callback', 'seeing-how-a-callback-stands'].filter((a) => !own.has(a)),
      broken: links.filter((l) => !own.has(l.split('#')[1]!)),
      links: links.length,
      inPage,
      inPageBroken: inPage.filter((a) => !anchorsOf(LISTEN).has(a)),
    }).toEqual({
      guide: true,
      missing: [],
      broken: [],
      links: 8,
      inPage: ['sending-callbacks'],
      inPageBroken: [],
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Cell 5: the callers the callbacks row and the CHANGELOG name.
// ---------------------------------------------------------------------------------------------

describe('C3c-2 — cell 5: the callers are the code’s', () => {
  it("12. the callers the callbacks row names are the code's", () => {
    const has = (file: string, pattern: RegExp): boolean => pattern.test(src(file));
    // (1) red when a command named on the row no longer makes that call (or makes it through another
    //     path); (2) prints each caller and method with whether its call is there.
    expect({
      'callback key: keys': has(
        'commands/callback-key.ts',
        /\bkeys\.(make|rotate|replace|delete|endPrevious|read)\(/,
      ),
      'listen: countWaiting': has('commands/listen.ts', /callbacks\.countWaiting\(\)/),
      'listen: read (a repeated event)': has(
        'commands/listen.ts',
        /\(await callbacks\.read\(runId\)\) !== undefined \? 'ignored_duplicate'/,
      ),
      'listen: keys.read': has(
        'commands/listen.ts',
        /callbacks\.keys\.read\(workflow, address\.host\)/,
      ),
      'listen: keys.list': has('commands/listen.ts', /callbacks\?\.keys\.list\(\)/),
      'listen: deleteAllForRun (a run that did not start)': has(
        'commands/listen.ts',
        /callbacks\?\.deleteAllForRun\(run\.id\)/,
      ),
      'listen: the pass': has('commands/listen.ts', /makeCallbackPass\(\{/),
      'pass: endOverdue, due, claim, freezeBody, mark': [
        'endOverdue',
        'due',
        'claim',
        'freezeBody',
        'mark',
      ].every((m) => has('lib/callback/delivery-pass.ts', new RegExp(`callbacks\\.${m}\\(`))),
      'inspect: read':
        has('lib/callback/inspect-line.ts', /callbacks\.read\(/) &&
        has('commands/inspect.ts', /from '\.\.\/lib\/callback\/inspect-line\.js'/),
      'read address: read': has('lib/run-read-address.ts', /ctx\.callbacks\.read\(run\.id\)/),
      'purge: read (its hold)': has('commands/purge.ts', /store\.callbacks\?\.read\(runId\)/),
      'purge: statAllForRun and deleteAllForRun':
        has('commands/purge.ts', /home\.runStore\.callbacks, \/\/ SqliteCallbackStore/) &&
        has('commands/purge.ts', /store\.statAllForRun\(run\.id, dirEntries\)/) &&
        has('commands/purge.ts', /store\.deleteAllForRun\(run\.id, dirEntries\)/),
    }).toEqual({
      'callback key: keys': true,
      'listen: countWaiting': true,
      'listen: read (a repeated event)': true,
      'listen: keys.read': true,
      'listen: keys.list': true,
      'listen: deleteAllForRun (a run that did not start)': true,
      'listen: the pass': true,
      'pass: endOverdue, due, claim, freezeBody, mark': true,
      'inspect: read': true,
      'read address: read': true,
      'purge: read (its hold)': true,
      'purge: statAllForRun and deleteAllForRun': true,
    });
  });
});
