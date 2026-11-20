// master-key-file-order-k2a1.test.ts — callback K2a-1 (R1.3): the order of `placeMasterKeyFile`'s
// writes, at run time. With `node:fs` wrapped, the cell records what the temporary file holds at the
// moment `linkSync` is called (its size, its mode) and which file `fsyncSync` synced before it. So a
// power loss after the link can never leave an empty `encryption.key` (the resolver calls an empty
// file `empty` and never makes another, which would orphan every sealed key: CB-K2A-AU-12). A cell
// reading the source text would only restate the code; this one runs it. A file of its own: the mock
// applies to the whole file.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { placeMasterKeyFile } from './master-key-file.js';

const seen = vi.hoisted(() => ({ events: [] as unknown[] }));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    fsyncSync: (fd: number) => {
      seen.events.push({ fsync: fs.fstatSync(fd).ino });
      fs.fsyncSync(fd);
    },
    linkSync: (from: string, to: string) => {
      const st = fs.statSync(from);
      seen.events.push({
        link: { ino: st.ino, bytes: st.size, mode: (st.mode & 0o777).toString(8) },
      });
      fs.linkSync(from, to);
    },
  };
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  seen.events.length = 0;
});

describe.runIf(process.platform !== 'win32')(
  'callback K2a-1 — the maker’s writes, in order',
  () => {
    it('the temporary file is whole, owner-only and synced before it is linked', () => {
      const home = mkdtempSync(join(tmpdir(), 'realm-k2a1-order-'));
      dirs.push(home);
      expect(placeMasterKeyFile(home)).toBe('placed');
      const [first, second] = seen.events as [{ fsync: number }, { link: { ino: number } }];
      // (1) red when the file is linked before it is synced, or not synced, or linked holding fewer
      //     than 65 bytes or wider than 0600; or when another file is synced (the inode differs);
      //     (2) prints every recorded event.
      expect({
        events: seen.events.map((e) => Object.keys(e as object)[0]),
        sameFile: first?.fsync === second?.link?.ino,
        linked: (seen.events[1] as { link?: object } | undefined)?.link,
      }).toEqual({
        events: ['fsync', 'link'],
        sameFile: true,
        linked: expect.objectContaining({ bytes: 65, mode: '600' }),
      });
    });
  },
);
