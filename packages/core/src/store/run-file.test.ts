// run-file.test.ts — issue #719 (B1, B2, C2, C3, C6): the one reader of a JSON-store run file,
// through the store's `get` (its call site), and the one composer of a damaged file's message.
// Failure output is codes, classes, paths and type words — a fixture here holds no secret, and the
// leak cell asserts a boolean, so a failure prints nothing of its file.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from './json-file-store.js';
import {
  displayId,
  renderUnreadableStoredFile,
  unreadableFactsOf,
  unreadableRunFileError,
  unreadableRunFilesError,
  unreadableRunFilesOf,
  type UnreadableFileFacts,
} from './run-file.js';
import type { WorkflowError } from '../types/workflow-error.js';

let dir: string;
let store: JsonFileStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'realm-719-run-file-'));
  store = new JsonFileStore(dir);
  await store.listRunIds(); // nothing; the folder exists
});
afterEach(async () => {
  await chmod(dir, 0o700).catch(() => undefined);
  await chmod(join(dir, 'x.json'), 0o600).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

/** A full run record whose id is `id`. */
const record = (id: string): Record<string, unknown> => ({
  id,
  workflow_id: 'w',
  workflow_version: 1,
  completed_steps: [],
  in_progress_steps: [],
  failed_steps: [],
  skipped_steps: [],
  run_phase: 'running',
  version: 0,
  params: {},
  evidence: [],
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  terminal_state: false,
});

const P = () => join(dir, 'x.json');
/** The three side files of run `x`, named exactly. */
const SIDE = "'x.attempts.jsonl', 'trace-buffer-x-*.jsonl' and 'sealed-trace-x-*.jsonl'";
const KEY_EFFECT =
  'If it held an idempotency key, the next delivery with that key starts a new run.';
const keep = () =>
  `Restore it from a backup or repair it: the run keeps its record and its idempotency key. Or ` +
  `move it out of '${dir}' together with ${SIDE} (moved alone, they become orphans that ` +
  `'realm run gc --older-than <age> --force' deletes). ${KEY_EFFECT}`;

/** What one damaged file is, as it is written, and what reading it must give. */
interface ClassCase {
  label: string;
  write: () => Promise<void>;
  code: string;
  agentAction: string;
  facts: () => UnreadableFileFacts;
  message: () => string;
}

const bytes = (b: string) => () => writeFile(P(), b);

const CASES: ClassCase[] = [
  {
    label: 'empty (zero bytes)',
    write: bytes(''),
    code: 'RESOURCE_FORMAT_INVALID',
    agentAction: 'stop',
    facts: () => ({ resource: 'run_file', class: 'empty', path: P() }),
    message: () => `The run file '${P()}' is empty. ${keep()}`,
  },
  {
    label: 'empty (whitespace only)',
    write: bytes('  \n\t'),
    code: 'RESOURCE_FORMAT_INVALID',
    agentAction: 'stop',
    facts: () => ({ resource: 'run_file', class: 'empty', path: P() }),
    message: () => `The run file '${P()}' is empty. ${keep()}`,
  },
  {
    label: 'parse (not JSON)',
    write: bytes('{not json'),
    code: 'RESOURCE_FORMAT_INVALID',
    agentAction: 'stop',
    facts: () => ({ resource: 'run_file', class: 'parse', path: P() }),
    message: () => `The run file '${P()}' is not JSON. ${keep()}`,
  },
  {
    label: 'parse (JSON that is not an object)',
    write: bytes('[1, 2]'),
    code: 'RESOURCE_FORMAT_INVALID',
    agentAction: 'stop',
    facts: () => ({ resource: 'run_file', class: 'parse', path: P(), shape: 'array' }),
    message: () => `The run file '${P()}' is JSON but not an object (it is array). ${keep()}`,
  },
  {
    label: 'not_a_run',
    write: bytes(JSON.stringify({ id: 'x', version: 'one' })),
    code: 'RESOURCE_FORMAT_INVALID',
    agentAction: 'stop',
    facts: () => ({
      resource: 'run_file',
      class: 'not_a_run',
      path: P(),
      fields: [
        { field: 'workflow_id', problem: 'missing' },
        { field: 'workflow_version', problem: 'missing' },
        { field: 'completed_steps', problem: 'missing' },
        { field: 'in_progress_steps', problem: 'missing' },
        { field: 'failed_steps', problem: 'missing' },
        { field: 'skipped_steps', problem: 'missing' },
        { field: 'run_phase', problem: 'missing' },
        { field: 'version', problem: 'wrong_type' },
        { field: 'params', problem: 'missing' },
        { field: 'evidence', problem: 'missing' },
        { field: 'created_at', problem: 'missing' },
        { field: 'updated_at', problem: 'missing' },
        { field: 'terminal_state', problem: 'missing' },
      ],
    }),
    message: () =>
      `The run file '${P()}' is JSON but not a run record (workflow_id is missing; ` +
      `workflow_version is missing; completed_steps is missing; …and 10 more). ${keep()}`,
  },
  {
    label: 'mismatched, the held run’s own file missing',
    write: bytes(JSON.stringify(record('other'))),
    code: 'RESOURCE_FORMAT_INVALID',
    agentAction: 'stop',
    facts: () => ({
      resource: 'run_file',
      class: 'mismatched',
      path: P(),
      held_id: 'other',
      held_present: false,
    }),
    message: () =>
      `The run file '${P()}' holds run 'other', not 'x'. It holds run 'other', whose own file ` +
      `is missing: rename it to 'other.json' to restore that run, or move it out of '${dir}'.`,
  },
  {
    label: 'mismatched, the held run’s own file readable',
    write: async () => {
      await writeFile(P(), JSON.stringify(record('other')));
      await writeFile(join(dir, 'other.json'), JSON.stringify(record('other')));
    },
    code: 'RESOURCE_FORMAT_INVALID',
    agentAction: 'stop',
    facts: () => ({
      resource: 'run_file',
      class: 'mismatched',
      path: P(),
      held_id: 'other',
      held_present: true,
    }),
    message: () =>
      `The run file '${P()}' holds run 'other', not 'x'. It is a copy of run 'other', whose own ` +
      `file is readable; move it out of '${dir}' — nothing else changes.`,
  },
  {
    label: 'mismatched, the held run’s own file present but itself damaged',
    write: async () => {
      await writeFile(P(), JSON.stringify(record('other')));
      await writeFile(join(dir, 'other.json'), '{not json');
    },
    code: 'RESOURCE_FORMAT_INVALID',
    agentAction: 'stop',
    facts: () => ({
      resource: 'run_file',
      class: 'mismatched',
      path: P(),
      held_id: 'other',
      held_present: false,
    }),
    message: () =>
      `The run file '${P()}' holds run 'other', not 'x'. It holds run 'other', whose own file ` +
      `is missing: rename it to 'other.json' to restore that run, or move it out of '${dir}'.`,
  },
  {
    label: 'mismatched, holding an id text may not show',
    write: bytes(JSON.stringify(record('two words'))),
    code: 'RESOURCE_FORMAT_INVALID',
    agentAction: 'stop',
    facts: () => ({ resource: 'run_file', class: 'mismatched', path: P(), held_id: 'two words' }),
    message: () =>
      `The run file '${P()}' holds another run id (not shown), not 'x'. It holds another run ` +
      `id (not shown); move it out of '${dir}'.`,
  },
  {
    label: 'legacy',
    write: bytes(JSON.stringify({ id: 'x', state: 'running' })),
    code: 'STATE_LEGACY_FORMAT',
    agentAction: 'report_to_user',
    facts: () => ({ resource: 'run_file', class: 'legacy', path: P() }),
    message: () =>
      `The run file '${P()}' is in the format of an earlier Realm. It was written by an earlier ` +
      `Realm, in a format this version cannot read. Move it out of '${dir}' together with ` +
      `${SIDE}. ${KEY_EFFECT}`,
  },
  {
    label: 'unreadable (EISDIR: a folder named like a run file)',
    write: () => mkdir(P()),
    code: 'ENGINE_STORE_FAILED',
    agentAction: 'stop',
    facts: () => ({ resource: 'run_file', class: 'unreadable', path: P(), errno: 'EISDIR' }),
    message: () =>
      `The run file '${P()}' cannot be read (EISDIR). It is a folder, not a file: move it out ` +
      `of '${dir}'; nothing was changed.`,
  },
];

describe('issue #719 B1/B2/C2 — the reader, through get(): one cell per class', () => {
  it.each(CASES.map((c) => [c.label, c] as const))('%s', async (_label, c) => {
    await c.write();
    const err = (await store.get('x').catch((e: unknown) => e)) as WorkflowError;
    // (a) red when the class, code, action, retryability, facts or words change, or the file is
    //     returned as a run; (b) prints them (the fixture holds no secret).
    expect({
      code: err.code,
      agentAction: err.agentAction,
      retryable: err.retryable,
      facts: unreadableFactsOf(err),
      message: err.message,
    }).toEqual({
      code: c.code,
      agentAction: c.agentAction,
      retryable: false,
      facts: c.facts(),
      message: c.message(),
    });
  });

  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  it.skipIf(asRoot)(
    'unreadable (EACCES): ENGINE_STORE_FAILED, not retryable, its way out, no "Then retry."',
    async () => {
      await writeFile(P(), JSON.stringify(record('x')));
      await chmod(P(), 0o000);
      const err = (await store.get('x').catch((e: unknown) => e)) as WorkflowError;
      // (a) red when a permission error is offered a retry, or its words change; (b) prints them.
      expect({
        code: err.code,
        agentAction: err.agentAction,
        retryable: err.retryable,
        facts: unreadableFactsOf(err),
        message: err.message,
      }).toEqual({
        code: 'ENGINE_STORE_FAILED',
        agentAction: 'stop',
        retryable: false,
        facts: { resource: 'run_file', class: 'unreadable', path: P(), errno: 'EACCES' },
        message:
          `The run file '${P()}' cannot be read (EACCES). Give this user read access to it; ` +
          `this file was not changed.`,
      });
    },
  );

  // No fs seam lets a test make `readFile` fail with EIO, EBUSY or EPERM without patching Node
  // (stated, as the prompt allows); the builder the reader throws through is the cell instead.
  it.each([
    ['EIO', true, 'This file was not changed; the read may succeed if retried. Then retry.'],
    ['EBUSY', true, 'This file was not changed; the read may succeed if retried. Then retry.'],
    ['EPERM', false, 'Give this user read access to it; this file was not changed.'],
    ['ELOOP', false, 'Check that it is a file this user can read; this file was not changed.'],
  ] as const)(
    'unreadable (%s, through the builder the reader uses): retryable %s, and its way out',
    (errno, retryable, wayOut) => {
      const facts: UnreadableFileFacts = {
        resource: 'run_file',
        class: 'unreadable',
        path: '/runs/x.json',
        errno,
      };
      const err = unreadableRunFileError(facts);
      // (a) red when the errno's arm changes (its retry, its way out); (b) prints them.
      expect({ code: err.code, retryable: err.retryable, message: err.message }).toEqual({
        code: 'ENGINE_STORE_FAILED',
        retryable,
        message: `The run file '/runs/x.json' cannot be read (${errno}). ${wayOut}`,
      });
    },
  );

  it('the leak cell (library error): a fault AT a token never reaches the error, its details or its stack', async () => {
    // The token sits where the parser stops, so the parser's own message quotes it (F719-AU-4).
    await writeFile(P(), '{"params":{"token": ghp_FAKE719}}');
    const err = (await store.get('x').catch((e: unknown) => e)) as WorkflowError;
    const serialised = `${err.message}\n${JSON.stringify(err.details)}\n${String(err.stack)}`;
    const leaked = serialised.includes('ghp_FAKE7');
    // (a) red when the parser's text reaches the message, the details or the stack; (b) prints a
    //     boolean only.
    expect(leaked).toBe(false);
  });
});

describe('issue #719 C3 — the runs folder, through the one composer', () => {
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  it.skipIf(asRoot)(
    'a runs folder this user cannot read: ENGINE_STORE_FAILED naming the folder, its facts, its way out',
    async () => {
      await chmod(dir, 0o000);
      const err = (await store.list().catch((e: unknown) => e)) as WorkflowError;
      await chmod(dir, 0o700);
      // (a) red when the folder's error carries run-file facts, words of its own, or escapes
      //     untyped; (b) prints the code, retryability, facts and message (paths only).
      expect({
        code: err.code,
        retryable: err.retryable,
        facts: unreadableFactsOf(err),
        message: err.message,
      }).toEqual({
        code: 'ENGINE_STORE_FAILED',
        retryable: false,
        facts: { resource: 'run_folder', class: 'unreadable', path: dir, errno: 'EACCES' },
        message:
          `The runs folder '${dir}' cannot be read (EACCES). Give this user read access to it; ` +
          `nothing in it was changed.`,
      });
    },
  );

  it('a runs folder that cannot be made (its path is a file): typed, through the same builder', async () => {
    const path = join(dir, 'a-file');
    await writeFile(path, 'x');
    const err = (await new JsonFileStore(path).list().catch((e: unknown) => e)) as WorkflowError;
    // (a) red when `ensureDir`'s failure escapes untyped (it sat outside the scan's `try`); (b)
    //     prints the code, facts and message.
    expect({ code: err.code, facts: unreadableFactsOf(err), message: err.message }).toEqual({
      code: 'ENGINE_STORE_FAILED',
      facts: { resource: 'run_folder', class: 'unreadable', path, errno: 'EEXIST' },
      message:
        `The runs folder '${path}' cannot be read (EEXIST). Check that it is a folder this user ` +
        `can read; nothing in it was changed.`,
    });
  });
});

describe('issue #719 C3 — the composer rebuilds every message from its facts alone', () => {
  it('every class through get(), the keyed branches through create(), and the runs folder: byte for byte', async () => {
    const thrown: Array<{ label: string; err: unknown }> = [];
    for (const c of CASES) {
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      await c.write();
      thrown.push({ label: c.label, err: await store.get('x').catch((e: unknown) => e) });
    }
    // The keyed branches: a file whose content cannot be read refuses every new key; a readable
    // object carrying the key refuses that key.
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await writeFile(P(), '{not json');
    thrown.push({
      label: 'keyed: every_new_key',
      err: await store
        .create({ workflowId: 'w', workflowVersion: 1, params: {}, idempotencyKey: 'k' })
        .catch((e: unknown) => e),
    });
    await writeFile(P(), JSON.stringify({ id: 'x', state: 'running', idempotency_key: 'k' }));
    thrown.push({
      label: 'keyed: this_key',
      err: await store
        .create({ workflowId: 'w', workflowVersion: 1, params: {}, idempotencyKey: 'k' })
        .catch((e: unknown) => e),
    });
    const path = join(dir, 'a-file');
    await writeFile(path, 'x');
    thrown.push({
      label: 'runs folder',
      err: await new JsonFileStore(path).list().catch((e: unknown) => e),
    });
    const notRebuilt = thrown
      .filter(({ err }) => {
        const facts = unreadableFactsOf(err);
        return facts === undefined || renderUnreadableStoredFile(facts) !== (err as Error).message;
      })
      .map(({ label }) => label);
    const refused = thrown.slice(-3, -1).map(({ err }) => unreadableFactsOf(err)?.refused);
    // (a) red when a message carries anything its facts do not (an option, a second composer, a
    //     folder worded apart); (b) prints the labels not rebuilt, and the two keyed facts.
    expect({ notRebuilt, refused }).toEqual({
      notRebuilt: [],
      refused: ['every_new_key', 'this_key'],
    });
  });
});

describe('issue #719 C3 — the aggregate, read through its one helper', () => {
  it('unreadableRunFilesOf returns the command, the folder and every file’s facts', () => {
    const files: UnreadableFileFacts[] = [
      { resource: 'run_file', class: 'parse', path: '/runs/a.json' },
      { resource: 'run_file', class: 'empty', path: '/runs/b.json' },
    ];
    const err = unreadableRunFilesError('realm run gc --heal --force', '/runs', files);
    // (a) red when the aggregate's details lose the command or the folder, or the helper reads
    //     another shape; (b) prints the facts (paths and classes only) and the message.
    expect({ facts: unreadableRunFilesOf(err), last: err.message.split('\n').at(-1) }).toEqual({
      facts: { command: 'realm run gc --heal --force', folder: '/runs', files },
      last:
        "Repair, restore or move each one out ('realm run list' shows each file's way out), then " +
        "run 'realm run gc --heal --force' again.",
    });
  });

  it('guard: the helper reads no other error, and the facts reader reads no aggregate', () => {
    const agg = unreadableRunFilesError('reconcileKeys', '/runs', []);
    const one = unreadableRunFileError({ resource: 'run_file', class: 'empty', path: '/r/x.json' });
    // (b) prints the two readers' answers.
    expect({
      aggregateAsFile: unreadableFactsOf(agg),
      fileAsAggregate: unreadableRunFilesOf(one),
      plain: unreadableRunFilesOf(new Error('x')),
    }).toEqual({ aggregateAsFile: undefined, fileAsAggregate: undefined, plain: undefined });
  });
});

describe('issue #719 C6 — displayId: a file-held id enters text only when it is a plain id', () => {
  it('a letters-digits-dot-underscore-hyphen id of 1–64 characters is shown; any other is not', () => {
    const shown = (id: string) => displayId(id) === id;
    // (a) red when an id with a blank, a newline, a terminal escape or 65 characters is shown, or a
    //     plain one is hidden; (b) prints each verdict (the ids are fixed test words).
    expect({
      uuid: shown('5f0c2a3e-7b1d-4c8e-9a6f-0123456789ab'),
      dotted: shown('run_1.bak'),
      maxLength: shown('a'.repeat(64)),
      tooLong: shown('a'.repeat(65)),
      blank: shown('two words'),
      newline: shown('a\nb'),
      escape: shown(`a${String.fromCharCode(27)}[31m`),
      empty: shown(''),
      hiddenText: displayId('two words'),
    }).toEqual({
      uuid: true,
      dotted: true,
      maxLength: true,
      tooLong: false,
      blank: false,
      newline: false,
      escape: false,
      empty: false,
      hiddenText: 'another run id (not shown)',
    });
  });
});
