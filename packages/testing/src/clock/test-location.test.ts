// test-location.test.ts — issue #715 (a) Part C.2 (D6-1, D6-54): `createTestLocation`, and the reach
// of its clock into a SEPARATE process (cell C15). This file builds no JSON store in-process under
// fake timers. Each cell names (a) the change that turns it red and (b) what it prints when it fails:
// instants only — never an environment or a path under a real home.
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_CLOCK_FILE_NAME } from '@sensigo/realm';
import { createTestLocation, type TestLocation } from './test-location.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const T = Date.parse('2034-07-08T09:10:11.012Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const made: TestLocation[] = [];
afterEach(async () => {
  for (const loc of made.splice(0)) await loc.remove();
});

describe('#715 (a) C.2 — createTestLocation', () => {
  it('C14 the root holds runs/ and the clock file; advancing writes the file; a waiter sees its when; remove() deletes the root; a second location on the root is refused', async () => {
    // (a) red when the file is not updated, or waiters see the end time; (b) prints instants.
    const loc = await createTestLocation({ start: new Date(T) });
    made.push(loc);
    expect(existsSync(loc.runsDir), 'runs/').toBe(true);
    expect(loc.runsDir, 'runsDir').toBe(join(loc.root, 'runs'));
    expect(existsSync(join(loc.root, TEST_CLOCK_FILE_NAME)), 'the clock file').toBe(true);
    expect(loc.clock.now().toISOString(), 'now() = start').toBe(iso(T));
    let seen = '';
    loc.clock.at(new Date(T + 1_800_000), () => {
      seen = loc.clock.now().toISOString();
    });
    await loc.clock.advance(3_600_000);
    const raw = JSON.parse(readFileSync(join(loc.root, TEST_CLOCK_FILE_NAME), 'utf8')) as {
      instant: string;
    };
    expect(raw.instant, 'the FILE after the advance').toBe(iso(T + 3_600_000));
    expect(seen, 'the waiter saw its when').toBe(iso(T + 1_800_000));
    await expect(createTestLocation({ start: new Date(T), root: loc.root })).rejects.toThrow(
      /already holds/,
    );
    await loc.remove();
    expect(existsSync(loc.root), 'removed').toBe(false);
  });

  it('C15 a spawned process reads the location’s time, and the time the test moved it to', async () => {
    // (a) red when a child stamps with the wall clock, or reads a cached file; (b) prints both
    // instants. The child imports the BUILT `@sensigo/realm` (tests run after the build).
    const loc = await createTestLocation({ start: new Date(T) });
    made.push(loc);
    const child = (): string => {
      const r = spawnSync(process.execPath, [join(HERE, 'test-location-child.mjs'), loc.runsDir], {
        encoding: 'utf8',
        timeout: 15_000,
      });
      return `${r.status}:${r.stdout.trim()}`;
    };
    const first = child();
    await loc.clock.advance(3_600_000);
    const second = child();
    expect([first, second], 'the two children’s created_at').toEqual([
      `0:${iso(T)}`,
      `0:${iso(T + 3_600_000)}`,
    ]);
  }, 20_000);
});
