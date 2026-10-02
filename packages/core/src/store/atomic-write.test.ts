// Tests for atomicWriteFile's temp names (issue #620 PR-B): two writers of one file never share a
// temp file — one process or two loaded copies of realm — and a writer only ever cleans up a temp it
// created itself. POSIX only: on win32 the write is in place and there is no temp.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { atomicWriteFile } from './atomic-write.js';

// The random source and the temp write are wrapped, not replaced: they behave as the real ones
// unless a test says otherwise, and every call is recorded.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomBytes: vi.fn(actual.randomBytes) };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

const posix = process.platform !== 'win32';
const TAKEN = Buffer.from('aabbccdd', 'hex');

/** The names `atomicWriteFile` created temps under: every write whose path ends in `.tmp`. */
function tempNames(): string[] {
  return vi
    .mocked(writeFile)
    .mock.calls.map((call) => String(call[0]))
    .filter((name) => name.endsWith('.tmp'));
}

describe('atomicWriteFile — temp files that cannot collide', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-atomic-write-'));
    vi.mocked(randomBytes).mockClear();
    vi.mocked(writeFile).mockClear();
  });

  afterEach(async () => {
    // Back to the wrapped real implementation (mockReset restores what `vi.fn(impl)` was given).
    vi.mocked(randomBytes).mockReset();
    await rm(dir, { recursive: true, force: true });
  });

  it.skipIf(!posix)(
    'names the temp <path>.<pid>.<8 hex>.tmp, differently each time, and leaves none behind',
    async () => {
      const path = join(dir, 'run.json');
      await atomicWriteFile(path, 'first');
      await atomicWriteFile(path, 'second');
      const names = tempNames();
      expect(names).toHaveLength(2);
      expect(new Set(names).size).toBe(2);
      for (const name of names) {
        expect(name).toMatch(new RegExp(`^${path}\\.${process.pid}\\.[0-9a-f]{8}\\.tmp$`));
      }
      expect(await readFile(path, 'utf8')).toBe('second');
      expect(readdirSync(dir)).toEqual(['run.json']);
    },
  );

  it.skipIf(!posix)(
    'two writes of one path started together both resolve; the file holds one of them whole',
    async () => {
      const path = join(dir, 'run.json');
      const a = JSON.stringify({ writer: 'a', pad: 'x'.repeat(8192) });
      const b = JSON.stringify({ writer: 'b', pad: 'y'.repeat(8192) });
      await Promise.all([atomicWriteFile(path, a), atomicWriteFile(path, b)]);
      expect([a, b]).toContain(await readFile(path, 'utf8'));
      expect(readdirSync(dir)).toEqual(['run.json']);
    },
  );

  it.skipIf(!posix)(
    'a temp name already taken is another writer’s file: left alone, the write goes under a fresh name',
    async () => {
      const path = join(dir, 'run.json');
      const taken = `${path}.${process.pid}.${TAKEN.toString('hex')}.tmp`;
      writeFileSync(taken, 'someone else’s temp');
      // The same name twice: both attempts find it taken; the third draws a fresh one.
      vi.mocked(randomBytes)
        .mockReturnValueOnce(TAKEN as never)
        .mockReturnValueOnce(TAKEN as never);

      await atomicWriteFile(path, 'mine');

      expect(await readFile(path, 'utf8')).toBe('mine');
      expect(existsSync(taken)).toBe(true);
      expect(readFileSync(taken, 'utf8')).toBe('someone else’s temp');
      expect(vi.mocked(randomBytes)).toHaveBeenCalledTimes(3);
    },
  );

  it.skipIf(!posix)(
    'a name that is always taken fails after four attempts with EEXIST, the other file untouched',
    async () => {
      const path = join(dir, 'run.json');
      const taken = `${path}.${process.pid}.${TAKEN.toString('hex')}.tmp`;
      writeFileSync(taken, 'someone else’s temp');
      vi.mocked(randomBytes).mockReturnValue(TAKEN as never);

      await expect(atomicWriteFile(path, 'mine')).rejects.toMatchObject({ code: 'EEXIST' });

      expect(vi.mocked(randomBytes)).toHaveBeenCalledTimes(4);
      expect(existsSync(taken)).toBe(true);
      expect(readFileSync(taken, 'utf8')).toBe('someone else’s temp');
      expect(existsSync(path)).toBe(false);
    },
  );

  it.skipIf(!posix)(
    'a rename that fails removes the temp this call created and rethrows the rename’s error',
    async () => {
      // The target is a non-empty directory: the temp is written, the rename over it is refused.
      const path = join(dir, 'run.json');
      mkdirSync(path);
      writeFileSync(join(path, 'inside'), 'x');

      await expect(atomicWriteFile(path, 'mine')).rejects.toMatchObject({ syscall: 'rename' });

      expect(tempNames()).toHaveLength(1);
      expect(readdirSync(dir)).toEqual(['run.json']);
      expect(readdirSync(path)).toEqual(['inside']);
    },
  );
});
