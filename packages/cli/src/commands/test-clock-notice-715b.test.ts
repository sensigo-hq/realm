// test-clock-notice-715b.test.ts — issue #715 (b) 02 §C.3 (D6-1, D6-53) with Amendment 5, on the CLI
// text surface, through the BUILT CLI: a `realm` process whose run store is at a test location says
// so ONCE on stderr, at its first read — `this store runs on a test clock, now <instant>`, the
// instant that read's reading (the location's clock). A process on an ordinary store says nothing.
// (The copied location's refusal, `STATE_TEST_CLOCK_FOREIGN`, keeps its cells in
// `foreign-test-clock-715.test.ts`.)
//
// Each child runs with a scratch HOME and working directory and an environment of PATH and HOME only.
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testClockNoticeLine } from '@sensigo/realm';
import { createTestHome, type TestHome } from '@sensigo/realm-testing';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const T = new Date('2033-01-02T03:04:05.000Z');

let scratch = '';
let location: TestHome | undefined;
/** #616 PR-2b: the handle on the location, opened after it; its `root` is the child's HOME. */
let located: TempHome | undefined;
let runId = '';

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'realm-notice-715b-'));
  mkdirSync(join(scratch, 'plain'), { recursive: true });
  location = await createTestHome({ start: T, root: join(scratch, 'at-location', '.realm') });
  located = await makeTempHome({ home: location.root });
  const { record } = await located.home.runStore.create({
    workflowId: 'notice-715b',
    workflowVersion: 1,
    params: {},
  });
  runId = record.id;
}, 30_000);

afterAll(async () => {
  await located?.cleanup();
  await location?.remove();
  rmSync(scratch, { recursive: true, force: true });
});

function realm(args: string[], home: string) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: scratch,
    env: { PATH: process.env['PATH'] ?? '', HOME: home },
    encoding: 'utf8',
    timeout: 20_000,
    input: '',
  });
  return {
    notices: r.stderr.split('\n').filter((l) => l.startsWith('this store runs on a test clock')),
  };
}

describe('#715 (b) §C.3 — the test-location notice on the CLI', () => {
  it('realm run list at a test location: the notice once, with the location clock’s instant', () => {
    // (a) red when the command's store is not wrapped with the notice (openRunStore), or the line
    //     carries another instant; (b) prints the notice lines.
    expect(realm(['run', 'list'], located!.root!).notices).toEqual([testClockNoticeLine(T)]);
  }, 30_000);

  it('realm run inspect at a test location reads the run more than once and says it once', () => {
    // (a) red when the notice is said per read, not per process; (b) prints the notice lines.
    expect(realm(['run', 'inspect', runId], located!.root!).notices).toEqual([
      testClockNoticeLine(T),
    ]);
  }, 30_000);

  it('an ordinary store says nothing', () => {
    // (a) red when the notice fires for a store that is not at a test location; (b) prints them.
    expect(realm(['run', 'list'], join(scratch, 'plain')).notices).toEqual([]);
  }, 30_000);
});
