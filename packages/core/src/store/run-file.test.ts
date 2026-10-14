// run-file.test.ts — issue #719 (B1, B2): the one reader of a JSON-store run file, through the
// store's `get` (its call site), and the one composer of a damaged file's message. Failure output
// is codes, classes, paths and type words — a fixture here holds no secret, and the leak cell
// asserts a boolean, so a failure prints nothing of its file.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from './json-file-store.js';
import {
  renderUnreadableStoredFile,
  unreadableFactsOf,
  unreadableRunFileError,
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
const keep = (p: string) =>
  `Restore '${p}' from a backup or repair it; the run and its key are kept. Or move it out of ` +
  `'${dir}' together with every file there whose name contains 'x' (its attempt log and trace ` +
  `files; moved alone, they become orphans that 'realm run gc --force' deletes). If it held an ` +
  `idempotency key, the next delivery with that key starts a new run.`;

/** What one damaged file is, as it is written, and what reading it must give. */
interface ClassCase {
  label: string;
  bytes: () => string;
  code: string;
  agentAction: string;
  facts: () => UnreadableFileFacts;
  message: () => string;
}

const CASES: ClassCase[] = [
  {
    label: 'empty (zero bytes)',
    bytes: () => '',
    code: 'RESOURCE_FORMAT_INVALID',
    agentAction: 'stop',
    facts: () => ({ resource: 'run_file', class: 'empty', path: P() }),
    message: () => `The run file '${P()}' is empty. ${keep(P())}`,
  },
  {
    label: 'empty (whitespace only)',
    bytes: () => '  \n\t',
    code: 'RESOURCE_FORMAT_INVALID',
    agentAction: 'stop',
    facts: () => ({ resource: 'run_file', class: 'empty', path: P() }),
    message: () => `The run file '${P()}' is empty. ${keep(P())}`,
  },
  {
    label: 'parse (not JSON)',
    bytes: () => '{not json',
    code: 'RESOURCE_FORMAT_INVALID',
    agentAction: 'stop',
    facts: () => ({ resource: 'run_file', class: 'parse', path: P() }),
    message: () => `The run file '${P()}' is not JSON. ${keep(P())}`,
  },
  {
    label: 'parse (JSON that is not an object)',
    bytes: () => '[1, 2]',
    code: 'RESOURCE_FORMAT_INVALID',
    agentAction: 'stop',
    facts: () => ({ resource: 'run_file', class: 'parse', path: P(), shape: 'array' }),
    message: () => `The run file '${P()}' is JSON but not an object (it is array). ${keep(P())}`,
  },
  {
    label: 'not_a_run',
    bytes: () => JSON.stringify({ id: 'x', version: 'one' }),
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
      `workflow_version is missing; completed_steps is missing; …and 10 more). ${keep(P())}`,
  },
  {
    label: 'mismatched',
    bytes: () => JSON.stringify(record('other')),
    code: 'RESOURCE_FORMAT_INVALID',
    agentAction: 'stop',
    facts: () => ({ resource: 'run_file', class: 'mismatched', path: P(), held_id: 'other' }),
    message: () =>
      `The run file '${P()}' holds run 'other', not 'x'. It is named 'x' but holds run ` +
      `'other'. If it is a copy, move it out of '${dir}'; run 'other' is not affected.`,
  },
  {
    label: 'legacy',
    bytes: () => JSON.stringify({ id: 'x', state: 'running' }),
    code: 'STATE_LEGACY_FORMAT',
    agentAction: 'report_to_user',
    facts: () => ({ resource: 'run_file', class: 'legacy', path: P() }),
    message: () =>
      `The run file '${P()}' is in the format of an earlier Realm. It was written by an earlier ` +
      `Realm. Restore it from a backup of that version, or move it out of '${dir}' together with ` +
      `every file there whose name contains 'x'. If it held an idempotency key, the next delivery ` +
      `with that key starts a new run.`,
  },
];

describe('issue #719 B1/B2 — the reader, through get(): one cell per class', () => {
  it.each(CASES.map((c) => [c.label, c] as const))('%s', async (_label, c) => {
    await writeFile(P(), c.bytes());
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
    'unreadable (EACCES): ENGINE_STORE_FAILED, not retryable, no "Then retry."',
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
          `The run file '${P()}' cannot be read (EACCES). Check that '${P()}' is a file this ` +
          `user can read; this file was not changed.`,
      });
    },
  );

  // No fs seam lets a test make `readFile` fail with EIO without patching Node (stated, as the
  // prompt allows); the builder the reader throws through is the cell instead.
  it('unreadable (EIO, through the builder the reader uses): retryable, and "Then retry."', () => {
    const facts: UnreadableFileFacts = {
      resource: 'run_file',
      class: 'unreadable',
      path: '/runs/x.json',
      errno: 'EIO',
    };
    const err = unreadableRunFileError(facts);
    // (a) red when a transient read error is not offered a retry; (b) prints it.
    expect({ code: err.code, retryable: err.retryable, message: err.message }).toEqual({
      code: 'ENGINE_STORE_FAILED',
      retryable: true,
      message:
        "The run file '/runs/x.json' cannot be read (EIO). Check that '/runs/x.json' is a file " +
        'this user can read; this file was not changed. Then retry.',
    });
  });

  it('the composer alone reproduces each class’s message byte for byte, from the facts', async () => {
    const mismatchedBy: string[] = [];
    for (const c of CASES) {
      await writeFile(P(), c.bytes());
      const err = (await store.get('x').catch((e: unknown) => e)) as WorkflowError;
      const facts = unreadableFactsOf(err);
      if (facts === undefined || renderUnreadableStoredFile(facts) !== err.message) {
        mismatchedBy.push(c.label);
      }
    }
    // (a) red when a message carries anything its facts do not (a second composer, or the parser's
    //     text); (b) prints the classes whose message the composer does not reproduce.
    expect(mismatchedBy).toEqual([]);
  });

  it('the leak cell (library error): a fault AT a token never reaches the message', async () => {
    // The token sits where the parser stops, so the parser's own message quotes it (F719-AU-4).
    await writeFile(P(), '{"params":{"token": ghp_FAKE719}}');
    const err = (await store.get('x').catch((e: unknown) => e)) as Error;
    const leaked = String(err.message).includes('ghp_FAKE7');
    // (a) red when the parser's text reaches the error; (b) prints a boolean only.
    expect(leaked).toBe(false);
  });
});
