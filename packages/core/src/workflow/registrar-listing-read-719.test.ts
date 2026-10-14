// registrar-listing-read-719.test.ts — issue #719 (C6): a registered copy that passes the probe and
// then fails its read (a race: a chmod or a disk error between the two calls) is `unreadable`, with
// its errno, in the registrar's listing — never "is not JSON". The race has no real-file seam, so
// `readFileSync` fails for one file name here (a module mock, this file only); every other read is
// the real one. Failure output is file names, classes, errnos and the fixed message.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    readFileSync: ((path: unknown, ...rest: unknown[]) => {
      if (typeof path === 'string' && path.endsWith('race-719.json')) {
        throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' });
      }
      return (real.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof real.readFileSync,
  };
});

const { JsonWorkflowStore } = await import('./registrar.js');

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'realm-719-reg-read-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('issue #719 C6 — the registrar listing classifies a read failure as unreadable', () => {
  it('a copy whose read fails after its probe: unreadable with its errno, never "is not JSON"', async () => {
    const path = join(dir, 'race-719.json');
    await writeFile(path, '{"id":"race-719"}');
    const { unreadable } = await new JsonWorkflowStore(dir).listWithDiagnostics();
    // (a) red when the read sits inside the parse `try` (a read error reads "is not JSON"); (b)
    //     prints the entry's file, class, errno and reason.
    expect(
      unreadable.map((u) => ({ file: u.file, class: u.class, errno: u.errno, reason: u.reason })),
    ).toEqual([
      {
        file: 'race-719.json',
        class: 'unreadable',
        errno: 'EIO',
        reason: `the registered copy of 'race-719' could not be read (EIO: ${path})`,
      },
    ]);
  });
});
