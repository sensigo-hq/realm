// run-file-readdir-719.test.ts — issue #719 (F4): when the runs folder cannot be listed while a
// damaged run file is read, its side files are not judged (`side_files` unset) and the way out names
// none. A folder that reads its files but cannot be listed has no real-file seam, so `readdir` fails
// for one folder here (a module mock, this file only); every other call is the real one. Failure
// output is the fact and a boolean.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FAIL_MARK = 'realm-719-readdir-fails-';

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    readdir: (async (path: unknown, ...rest: unknown[]) => {
      if (typeof path === 'string' && path.includes(FAIL_MARK)) {
        throw Object.assign(new Error('EACCES: permission denied, scandir'), { code: 'EACCES' });
      }
      return (real.readdir as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof real.readdir,
  };
});

const { JsonFileStore } = await import('./json-file-store.js');
const { unreadableFactsOf } = await import('./run-file.js');

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), FAIL_MARK));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('issue #719 F4 — a folder that cannot be listed leaves the side files not judged', () => {
  it('side_files unset, and the way out names no side file', async () => {
    const id = '5f0c2a3e-7b1d-4c8e-9a6f-0123456789ab';
    await writeFile(join(dir, `${id}.json`), '{not json');
    await writeFile(join(dir, `${id}.attempts.jsonl`), '');
    const err = await new JsonFileStore(dir).get(id).catch((e: unknown) => e);
    const facts = unreadableFactsOf(err);
    // (a) red when a failed listing is taken for "none present" (`[]`) or a guess; (b) prints the
    //     class, whether the fact is set, and whether the message names a side file.
    expect({
      class: facts?.class,
      judged: facts !== undefined && 'side_files' in facts,
      namesSideFile: /attempts\.jsonl|trace-buffer-|sealed-trace-/.test(
        String((err as Error).message),
      ),
    }).toEqual({ class: 'parse', judged: false, namesSideFile: false });
  });
});
