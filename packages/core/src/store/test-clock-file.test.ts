// test-clock-file.test.ts — issue #715 (a) Part C.1 (D6-1, D6-53, D6-54): a test location's clock
// file, the clock a JSON store resolves from it, and the refusal of a copied location. Every
// location lives in its own `mkdtemp` root (a clock file is never written directly under the
// system temp folder). Each cell names (a) the change that turns it red and (b) what it prints when it
// fails: instants, a message, a listing — never an environment or a path under a real home.
import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, readdirSync, realpathSync, symlinkSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from './json-file-store.js';
import {
  TEST_CLOCK_FILE_NAME,
  fileClock,
  resolveStoreClock,
  testClockFilePath,
  writeTestClockFile,
} from './test-clock-file.js';
import { systemClock } from '../utils/clock.js';
import { WorkflowError } from '../types/workflow-error.js';

const T = Date.parse('2032-01-02T03:04:05.006Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function freshRoot(): Promise<{ root: string; runsDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'realm-715a-c-'));
  roots.push(root);
  const runsDir = join(root, 'runs');
  await mkdir(runsDir);
  return { root, runsDir };
}

describe('#715 (a) C.1 — the clock file', () => {
  it('C1 a directory with no clock file resolves to the shared system clock', async () => {
    // (a) red when an ordinary directory gets a file clock.
    const { runsDir } = await freshRoot();
    expect(resolveStoreClock(runsDir) === systemClock, 'systemClock, by identity').toBe(true);
    expect(new JsonFileStore(runsDir).clock === systemClock, 'the store’s clock').toBe(true);
  });

  it('C2 at a location the store reads the file on every call; a rewrite moves the next create', async () => {
    // (a) red when now() caches the file; (b) prints the two instants.
    const { root, runsDir } = await freshRoot();
    await writeTestClockFile(root, new Date(T));
    const store = new JsonFileStore(runsDir);
    expect(store.clock.now().toISOString(), 'first now()').toBe(iso(T));
    await writeTestClockFile(root, new Date(T + 3_600_000));
    expect(store.clock.now().toISOString(), 'after the rewrite').toBe(iso(T + 3_600_000));
    const { run } = await store.create({ workflowId: 'wf', workflowVersion: 1, params: {} });
    expect(run.created_at, 'the next create').toBe(iso(T + 3_600_000));
  });

  it('C3 a COPY of a location refuses with the four-clause message; a symlink to it opens', async () => {
    // (a) red when the comparison is on strings not realpaths, or the refusal is absent;
    // (b) prints the message.
    const { root, runsDir } = await freshRoot();
    await writeTestClockFile(root, new Date(T));
    const other = await mkdtemp(join(tmpdir(), 'realm-715a-copy-'));
    roots.push(other);
    const copy = join(other, 'loc');
    cpSync(root, copy, { recursive: true });
    const a = realpathSync(root);
    const b = realpathSync(copy);
    let caught: unknown;
    try {
      new JsonFileStore(join(copy, 'runs'));
    } catch (err) {
      caught = err;
    }
    expect(caught, 'a WorkflowError').toBeInstanceOf(WorkflowError);
    const e = caught as WorkflowError;
    expect(
      { code: e.code, category: e.category, agentAction: e.agentAction, retryable: e.retryable },
      e.message,
    ).toEqual({
      code: 'STATE_TEST_CLOCK_FOREIGN',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
    });
    expect(e.message).toBe(
      `This store's clock file was created for ${a}, not ${b}. A store opened here would run on another location's test clock. To use this folder as an ordinary store, delete its clock file (${join(b, TEST_CLOCK_FILE_NAME)}); to keep the test location it came from, open the store at ${a}; to make a new test location, use createTestLocation on a folder that has none.`,
    );
    const link = join(other, 'link');
    symlinkSync(root, link);
    const viaLink = new JsonFileStore(join(link, 'runs'));
    expect(viaLink.clock.now().toISOString(), 'opened through the symlink').toBe(iso(T));
    expect(runsDir, 'the original runs folder').toBe(join(root, 'runs'));
  });

  it('C4 the clock file sits beside runs/, and list() returns only the runs', async () => {
    // (a) red when the file lands in runs/ or is read as a run; (b) prints the listing.
    const { root, runsDir } = await freshRoot();
    await writeTestClockFile(root, new Date(T));
    expect(testClockFilePath(runsDir), 'its path').toBe(join(root, TEST_CLOCK_FILE_NAME));
    expect(existsSync(join(root, TEST_CLOCK_FILE_NAME)), 'beside runs/').toBe(true);
    const store = new JsonFileStore(runsDir);
    const a = (await store.create({ workflowId: 'wf', workflowVersion: 1, params: {} })).run;
    const b = (await store.create({ workflowId: 'wf', workflowVersion: 1, params: {} })).run;
    expect(readdirSync(runsDir).includes(TEST_CLOCK_FILE_NAME), 'not inside runs/').toBe(false);
    const listed = (await store.list()).map((r) => r.id).sort();
    expect(listed, `listing: ${listed.join(', ')}`).toEqual([a.id, b.id].sort());
  });

  it('C5 a file clock’s at() throws the stated sentence', async () => {
    // (a) red when at() silently registers; (b) prints the message.
    const { root, runsDir } = await freshRoot();
    await writeTestClockFile(root, new Date(T));
    const clock = fileClock(testClockFilePath(runsDir));
    expect(() => clock.at(new Date(T + 1_000), () => {})).toThrow(
      "a test location's clock cannot run waiters until the unit that registers them (#715 (b)) is built",
    );
  });

  it('C6 a clock file that cannot be read after construction makes create fail loud and write nothing', async () => {
    // (a) red when the write falls back to the wall clock; (b) prints the thrown message.
    const { root, runsDir } = await freshRoot();
    await writeTestClockFile(root, new Date(T));
    const store = new JsonFileStore(runsDir);
    await writeFile(join(root, TEST_CLOCK_FILE_NAME), 'not json');
    let message = '';
    try {
      await store.create({ workflowId: 'wf', workflowVersion: 1, params: {} });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message, 'the thrown message').toMatch(/test clock file/);
    expect(
      readdirSync(runsDir).filter((f) => f.endsWith('.json')),
      'no run file written',
    ).toEqual([]);
  });
});
