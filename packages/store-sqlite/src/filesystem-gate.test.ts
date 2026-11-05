// filesystem-gate.test.ts — issue #616 PR-1a unit 5: the filesystem gate. A home is accepted only on
// a local filesystem, judged by the mount of its real path; a network, unrecognised or unjudgeable
// one is refused with `STATE_STORE_FILESYSTEM_REFUSED` and a sentence that says what to do. The
// folders and links below are real (a temporary folder); the platform, the environment and the
// filesystem's answer are injected where a cell needs a filesystem this machine does not have.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowError } from '@sensigo/realm';
import { assertLocalFilesystem, SYSTEM_PROBE, type FilesystemProbe } from './filesystem-gate.js';
import {
  MOUNT_LINE_SMB,
  MOUNT_LINE_SPACES,
  MOUNT_TABLE_MACOS_14,
  MOUNT_TABLE_MACOS_15,
  MOUNT_TABLE_MACOS_26,
} from './test-support/darwin-mount-tables.js';

const EXT4 = 0xef53;
const NINEP = 0x01021997;

let root: string; // the temporary folder, as its real path
let local: string; // a real folder the cells treat as local
let refusedDir: string; // a real folder the cells treat as a 9p mount

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'realm-616-fs-')));
  local = join(root, 'local');
  refusedDir = join(root, 'refused');
  mkdirSync(local);
  mkdirSync(refusedDir);
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** This machine's folders, with the platform and the environment given, and Linux's answer
 *  injected: `refusedDir` is a 9p mount, everything else ext4. */
function linux(over: Partial<FilesystemProbe> = {}): FilesystemProbe {
  return {
    ...SYSTEM_PROBE,
    platform: 'linux',
    env: {},
    statfsType: (path) => (path === refusedDir || path.startsWith(`${refusedDir}/`) ? NINEP : EXT4),
    ...over,
  };
}

/** A macOS probe over a mount table; every path exists and is its own real path. */
function darwin(table: string, over: Partial<FilesystemProbe> = {}): FilesystemProbe {
  return {
    ...SYSTEM_PROBE,
    platform: 'darwin',
    env: {},
    realpath: (path) => path,
    lexists: () => true,
    mountTable: () => table,
    ...over,
  };
}

/** The gate's answer as data: `accepted <filesystem>`, or the refusal's code and message. */
function verdict(home: string, probe: FilesystemProbe): string {
  try {
    const ok = assertLocalFilesystem(home, probe);
    return ok.escaped ? 'accepted by REALM_STORE_FS' : `accepted ${String(ok.filesystem)}`;
  } catch (e) {
    if (e instanceof WorkflowError) return `${e.code}: ${e.message}`;
    throw e;
  }
}

const network = (home: string, name?: string): string =>
  `STATE_STORE_FILESYSTEM_REFUSED: The Realm home ${home} is on a network or unrecognised filesystem${name === undefined ? '' : ` (${name})`}, where SQLite's write-ahead log does not work. Put the store on a local disk and make the Realm home a symbolic link to that directory (a link to the directory, never to realm.db).`;

describe('#616 PR-1a unit 5 — the filesystem gate', { timeout: 30_000 }, () => {
  it('a home in a real temporary folder on this machine is accepted, judged by the system', () => {
    // (1) Can it fail: red when the gate refuses a local filesystem (the named break: the Linux
    //     test inverted, so a type in the list is refused), or cannot read this machine's answer.
    // (2) Prints: the gate's answer, the refusal's sentence if it refused (a temporary path).
    expect(verdict(join(local, 'realm'), { ...SYSTEM_PROBE, env: {} })).toMatch(/^accepted /);
  });

  it('Linux: 9p, NFS, CIFS, SMB2, SMB and FUSE are refused by name; an unknown type and no answer, unnamed', () => {
    const home = join(local, 'realm');
    const at = (type: number | 'throws'): string =>
      verdict(
        home,
        linux({
          statfsType: () => {
            if (type === 'throws') throw new Error('statfs failed');
            return type;
          },
        }),
      );
    // (1) Can it fail: red when a network type is accepted (the named breaks: 9p added to the list;
    //     no answer taken as local), or a sentence or a name changes.
    // (2) Prints: each type's verdict, the whole sentence (a temporary path, no secret).
    expect({
      '9p': at(NINEP),
      nfs: at(0x6969),
      cifs: at(0xff534d42),
      smb2: at(0xfe534d42),
      smb: at(0x517b),
      fuse: at(0x65735546),
      unknown: at(0x12345678),
      noAnswer: at('throws'),
    }).toEqual({
      '9p': network(home, '9p'),
      nfs: network(home, 'nfs'),
      cifs: network(home, 'cifs'),
      smb2: network(home, 'smb2'),
      smb: network(home, 'smb'),
      fuse: network(home, 'fuse'),
      unknown: network(home),
      noAnswer: network(home),
    });
  });

  it('macOS: the three observed mount tables, a network share, a mount point with spaces, the longest prefix', () => {
    const home = '/Users/runner/.realm';
    // (1) Can it fail: red when the parser or the match changes — the named breaks: the `local` flag
    //     ignored (the shares are accepted), the first match taken instead of the longest (the autofs
    //     home under /System/Volumes/Data is accepted through `/`), or the mount point split at its
    //     first space (the "Team Share" share falls to `/` and is accepted).
    // (2) Prints: each row's verdict (fixture paths only).
    expect({
      'macos-14': verdict(home, darwin(MOUNT_TABLE_MACOS_14)),
      'macos-15': verdict(home, darwin(MOUNT_TABLE_MACOS_15)),
      'macos-26': verdict(home, darwin(MOUNT_TABLE_MACOS_26)),
      data: verdict('/System/Volumes/Data/x', darwin(MOUNT_TABLE_MACOS_26)),
      autofsHome: verdict('/System/Volumes/Data/home/x', darwin(MOUNT_TABLE_MACOS_26)),
      smb: verdict('/Volumes/share/realm', darwin(`${MOUNT_TABLE_MACOS_26}\n${MOUNT_LINE_SMB}`)),
      spaces: verdict(
        '/Volumes/Team Share/realm',
        darwin(`${MOUNT_TABLE_MACOS_26}\n${MOUNT_LINE_SPACES}`),
      ),
      noEntry: verdict(home, darwin('devfs on /dev (devfs, local, nobrowse)')),
      garbage: verdict(home, darwin('this is not a mount table')),
    }).toEqual({
      'macos-14': 'accepted apfs',
      'macos-15': 'accepted apfs',
      'macos-26': 'accepted apfs',
      data: 'accepted apfs',
      autofsHome: network('/System/Volumes/Data/home/x', 'autofs'),
      smb: network('/Volumes/share/realm', 'smbfs'),
      spaces: network('/Volumes/Team Share/realm', 'smbfs'),
      noEntry: network(home),
      garbage: network(home),
    });
  });

  it('the real path is judged, not the spelling: a link to a local folder is accepted wherever it sits; a link to a refused folder is refused', () => {
    const inRefused = join(refusedDir, 'link-to-local');
    const inLocal = join(local, 'link-to-refused');
    symlinkSync(local, inRefused);
    symlinkSync(refusedDir, inLocal);
    // (1) Can it fail: red when the gate judges the path as spelled (the named break: `statfsType`
    //     asked about the unresolved path): the link in the refused folder is then refused.
    // (2) Prints: both verdicts (temporary paths).
    expect({ inRefused: verdict(inRefused, linux()), inLocal: verdict(inLocal, linux()) }).toEqual({
      inRefused: 'accepted ext2/ext3/ext4',
      inLocal: network(inLocal, '9p'),
    });
  });

  it('a home that does not exist yet is judged by the nearest existing folder above it', () => {
    // (1) Can it fail: red when the gate asks about the missing path itself (the named break: no
    //     walk up): every missing home is then refused, so the local row goes red.
    // (2) Prints: both verdicts (temporary paths).
    const underLocal = join(local, 'not-yet', 'realm');
    const underRefused = join(refusedDir, 'not-yet', 'realm');
    expect({
      underLocal: verdict(underLocal, linux()),
      underRefused: verdict(underRefused, linux()),
    }).toEqual({
      underLocal: 'accepted ext2/ext3/ext4',
      underRefused: network(underRefused, '9p'),
    });
  });

  it('a home that is a link whose target cannot be found is refused naming the link and its text', () => {
    const link = join(local, 'dangling');
    symlinkSync('missing-target', link);
    // (1) Can it fail: red when the home's own dangling link is not refused with its sentence (the
    //     named break: the dangling branch removed, so the system's ENOENT passes up instead).
    // (2) Prints: the verdict (a temporary path and the link's text).
    expect(verdict(link, linux())).toBe(
      `STATE_STORE_FILESYSTEM_REFUSED: ${link} is a symbolic link to missing-target, which cannot be found, so the Realm home ${link} cannot be used. Point the link at an existing directory on a local disk.`,
    );
  });

  it('a home under a folder that is a link whose target cannot be found is refused naming that folder', () => {
    const link = join(local, 'dangling-dir');
    symlinkSync(join(root, 'gone'), link);
    const home = join(link, 'realm');
    // (1) Can it fail: red when the folder above is not named as the link (the named break: the
    //     dangling branch removed; or the home named as the link).
    // (2) Prints: the verdict (temporary paths and the link's text).
    expect(verdict(home, linux())).toBe(
      `STATE_STORE_FILESYSTEM_REFUSED: ${link} is a symbolic link to ${join(root, 'gone')}, which cannot be found, so the Realm home ${home} cannot be used. Point the link at an existing directory on a local disk.`,
    );
  });

  it('any other failure to resolve the home passes up unchanged with its system code (a loop of links)', () => {
    const loop = join(local, 'loop');
    symlinkSync(loop, loop);
    let caught: unknown;
    try {
      assertLocalFilesystem(loop, linux());
    } catch (e) {
      caught = e;
    }
    // (1) Can it fail: red when a failure that is not a missing target is reworded as the gate's
    //     refusal (the named break: every resolve error taken as a dangling link).
    // (2) Prints: whether a WorkflowError came out, and the error's code (ELOOP; no path, no secret).
    expect({
      workflowError: caught instanceof WorkflowError,
      code: (caught as NodeJS.ErrnoException | undefined)?.code,
    }).toEqual({ workflowError: false, code: 'ELOOP' });
  });

  it('a home whose path runs through a regular file passes up the system error (ENOTDIR), never judged by the folder above', () => {
    const file = join(local, 'afile');
    writeFileSync(file, '');
    let caught: unknown;
    try {
      assertLocalFilesystem(join(file, 'realm'), linux());
    } catch (e) {
      caught = e;
    }
    // (1) Can it fail: red when an lstat failure other than "no such file" is taken as "not there
    //     yet" (the named break: the catch-all put back in the existence check), so the gate climbs
    //     to the folder above and accepts it.
    // (2) Prints: whether a WorkflowError came out, and the error's code (no path, no secret).
    expect({
      workflowError: caught instanceof WorkflowError,
      code: (caught as NodeJS.ErrnoException | undefined)?.code,
    }).toEqual({ workflowError: false, code: 'ENOTDIR' });
  });

  it.skipIf(process.platform !== 'darwin')(
    'macOS: a home typed in another case resolves to the case the volume stores (case-insensitive APFS)',
    () => {
      mkdirSync(join(root, 'CaseCheck'));
      // (1) Can it fail: red when the real path keeps the typed case (the named break: the
      //     JavaScript resolver), so a mis-cased home misses its mount table entry. Runs on a
      //     macOS runner only; skipped elsewhere.
      // (2) Prints: the path the gate judged (a temporary path).
      expect(
        assertLocalFilesystem(join(root, 'casecheck'), { ...SYSTEM_PROBE, env: {} }).judged,
      ).toBe(join(root, 'CaseCheck'));
    },
  );

  it('REALM_STORE_FS=local accepts a refused filesystem without asking; any other value does not', () => {
    const home = join(refusedDir, 'realm');
    // (1) Can it fail: red when the escape is ignored (the named break) or taken for another value.
    // (2) Prints: the three verdicts (a temporary path).
    expect({
      escape: verdict(home, linux({ env: { REALM_STORE_FS: 'local' } })),
      other: verdict(home, linux({ env: { REALM_STORE_FS: 'yes' } })),
      unset: verdict(home, linux()),
    }).toEqual({
      escape: 'accepted by REALM_STORE_FS',
      other: network(home, '9p'),
      unset: network(home, '9p'),
    });
  });

  it('macOS reads the mount table once per process, however many homes it judges', () => {
    let reads = 0;
    const probe = darwin(MOUNT_TABLE_MACOS_26, {
      mountTable: () => {
        reads += 1;
        return MOUNT_TABLE_MACOS_26;
      },
    });
    for (let i = 0; i < 10; i += 1) assertLocalFilesystem(`/Users/runner/home-${i}`, probe);
    // (1) Can it fail: red when the table is read on every call (the named break: the cache removed).
    // (2) Prints: the number of reads.
    expect(reads).toBe(1);
  });

  it('a platform other than Linux and macOS refuses with its own sentence', () => {
    const home = join(local, 'realm');
    const on = (platform: string): string => verdict(home, linux({ platform }));
    // (1) Can it fail: red when another platform is accepted (the named break), or given the
    //     network sentence.
    // (2) Prints: each platform's verdict (a temporary path).
    expect({ win32: on('win32'), freebsd: on('freebsd') }).toEqual({
      win32: `STATE_STORE_FILESYSTEM_REFUSED: Realm cannot tell whether ${home} is on a local filesystem on this platform (win32), so it does not open the store. Set REALM_STORE_FS=local to use this folder anyway.`,
      freebsd: `STATE_STORE_FILESYSTEM_REFUSED: Realm cannot tell whether ${home} is on a local filesystem on this platform (freebsd), so it does not open the store. Set REALM_STORE_FS=local to use this folder anyway.`,
    });
  });
});
