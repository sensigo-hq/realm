// filesystem-gate.ts — issue #616 PR-1a unit 5 (design d4-frozen-r3 §2, the open's step 2): whether
// a Realm home is on a local filesystem, where SQLite's write-ahead log works. WAL needs shared
// memory that network filesystems do not give (`sources/sqlite-docs/wal.txt` ~104-105), so the open
// asks the system about the mount of the home's REAL path, never judging by the folder's name:
// Linux by the kernel's filesystem type (`statfs`), macOS by the mount table's `local` flag. Every
// other platform is refused, because the check cannot judge. It opens no database, reads nothing
// inside the home and creates nothing; `REALM_STORE_FS=local` is the one escape.
import { execFileSync } from 'node:child_process';
import { lstatSync, readlinkSync, realpathSync, statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import { WorkflowError } from '@sensigo/realm';

/**
 * Linux: the `statfs` filesystem types (f_type) of the local filesystems the store may live on, with
 * their names. Each is in `linux/magic.h` and `man 2 statfs`, except two: zfs (OpenZFS's
 * `include/sys/fs/zfs.h`, `ZFS_SUPER_MAGIC`) and bcachefs (Linux's own
 * `include/uapi/linux/magic.h`, `BCACHEFS_SUPER_MAGIC`, since 6.7).
 */
export const LINUX_LOCAL_FILESYSTEMS: ReadonlyMap<number, string> = new Map([
  [0xef53, 'ext2/ext3/ext4'],
  [0x58465342, 'xfs'],
  [0x9123683e, 'btrfs'],
  [0x01021994, 'tmpfs'],
  [0x2fc12fc1, 'zfs'],
  [0xf2f52010, 'f2fs'],
  [0x794c7630, 'overlayfs'],
  [0xca451a4e, 'bcachefs'],
  [0x858458f6, 'ramfs'],
]);

/**
 * Linux: the names of refused types the kernel commonly reports for a network or bridged mount, so
 * the refusal can say which (all in `linux/magic.h`). A type in neither table is refused unnamed.
 */
export const LINUX_REFUSED_NAMES: ReadonlyMap<number, string> = new Map([
  [0x01021997, '9p'],
  [0x6969, 'nfs'],
  [0xff534d42, 'cifs'],
  [0xfe534d42, 'smb2'],
  [0x517b, 'smb'],
  [0x65735546, 'fuse'],
]);

/** What the gate asks the system. The default asks this machine; tests pass their own. */
export interface FilesystemProbe {
  readonly platform: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The path with every symbolic link resolved; throws when the path or a link's target is missing. */
  realpath(path: string): string;
  /** Whether something is at `path`, a dangling symbolic link included (the link is not followed). */
  lexists(path: string): boolean;
  /** The text of the symbolic link at `path`, or `undefined` when `path` is not a link. */
  readlink(path: string): string | undefined;
  /** Linux: the `statfs` type of the filesystem holding `path`. */
  statfsType(path: string): number;
  /** macOS: `/sbin/mount`'s output. The gate reads it once per probe. */
  mountTable(): string;
}

/** This machine. */
export const SYSTEM_PROBE: FilesystemProbe = {
  platform: process.platform,
  env: process.env,
  realpath: (path) => realpathSync(path),
  lexists: (path) => {
    try {
      lstatSync(path);
      return true;
    } catch {
      return false;
    }
  },
  readlink: (path) => {
    try {
      return readlinkSync(path);
    } catch {
      return undefined;
    }
  },
  statfsType: (path) => Number(statfsSync(path).type),
  mountTable: () => execFileSync('/sbin/mount', { encoding: 'utf8' }),
};

/** One parsed line of `/sbin/mount`: `<device> on <mount point> (<type>, <flags>…)`. */
export interface MountEntry {
  readonly mountPoint: string;
  readonly type: string;
  readonly local: boolean;
}

/**
 * Parses `/sbin/mount`'s output. The mount point runs to the last ` (` of the line, so a mount point
 * with spaces is whole. Returns `undefined` when a non-empty line does not parse.
 */
export function parseMountTable(text: string): MountEntry[] | undefined {
  const entries: MountEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const m = /^(.+?) on (.+) \(([^()]*)\)$/.exec(line);
    if (m === null) return undefined;
    const options = m[3]!.split(',').map((o) => o.trim());
    entries.push({ mountPoint: m[2]!, type: options[0]!, local: options.includes('local') });
  }
  return entries;
}

/** The entry whose mount point is the longest prefix of `path` (by whole path segments). */
export function mountOf(entries: readonly MountEntry[], path: string): MountEntry | undefined {
  let best: MountEntry | undefined;
  for (const e of entries) {
    const holds =
      e.mountPoint === '/' || path === e.mountPoint || path.startsWith(`${e.mountPoint}/`);
    if (holds && (best === undefined || e.mountPoint.length > best.mountPoint.length)) best = e;
  }
  return best;
}

/** What the gate accepted: the folder it judged and the filesystem's name where it has one. */
export interface LocalFilesystem {
  /** The real path whose mount was judged (the home, or its nearest existing folder above). */
  readonly judged: string | undefined;
  readonly filesystem: string | undefined;
  /** True when `REALM_STORE_FS=local` accepted without asking. */
  readonly escaped: boolean;
}

const tables = new WeakMap<FilesystemProbe, MountEntry[] | undefined>();

function mountEntries(probe: FilesystemProbe): MountEntry[] | undefined {
  if (!tables.has(probe)) {
    let parsed: MountEntry[] | undefined;
    try {
      parsed = parseMountTable(probe.mountTable());
    } catch {
      parsed = undefined;
    }
    tables.set(probe, parsed);
  }
  return tables.get(probe);
}

function refused(message: string, details: Record<string, unknown>): WorkflowError {
  return new WorkflowError(message, {
    code: 'STATE_STORE_FILESYSTEM_REFUSED',
    category: 'STATE',
    agentAction: 'report_to_user',
    retryable: false,
    details,
  });
}

function networkRefusal(home: string, name: string | undefined, details: Record<string, unknown>) {
  const filesystem = `a network or unrecognised filesystem${name === undefined ? '' : ` (${name})`}`;
  return refused(
    `The Realm home ${home} is on ${filesystem}, where SQLite's write-ahead log does not work. Put the store on a local disk and make the Realm home a symbolic link to that directory (a link to the directory, never to realm.db).`,
    details,
  );
}

/**
 * Accepts a Realm home on a local filesystem and refuses any other with `STATE_STORE_FILESYSTEM_REFUSED`
 * (design §2, step 2). The home is judged by the mount of its real path: a home that does not exist
 * yet by its nearest existing folder above it, where a new folder would be made. A symbolic link
 * whose target cannot be found, at the home or at a folder above it, is refused naming the link and
 * its text; any other failure to resolve the path (a loop of links, no permission to look, a file in
 * the path) passes up unchanged, with its operating-system code. `REALM_STORE_FS=local` accepts
 * without asking.
 */
export function assertLocalFilesystem(
  home: string,
  probe: FilesystemProbe = SYSTEM_PROBE,
): LocalFilesystem {
  if (probe.env['REALM_STORE_FS'] === 'local') {
    return { judged: undefined, filesystem: undefined, escaped: true };
  }
  let existing = home;
  while (!probe.lexists(existing)) {
    const up = dirname(existing);
    if (up === existing) break;
    existing = up;
  }
  let real: string;
  try {
    real = probe.realpath(existing);
  } catch (err) {
    // `existing` was found without following its last link, so every folder above it resolved: a
    // missing target here is a dangling link at `existing` itself, possibly the end of a chain.
    const target = probe.readlink(existing);
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || target === undefined) throw err;
    throw refused(
      `${existing} is a symbolic link to ${target}, which cannot be found, so the Realm home ${home} cannot be used. Point the link at an existing directory on a local disk.`,
      { home, link: existing, target, platform: probe.platform },
    );
  }
  if (probe.platform === 'linux') {
    let type: number | undefined;
    try {
      type = probe.statfsType(real);
    } catch {
      type = undefined;
    }
    const local = type === undefined ? undefined : LINUX_LOCAL_FILESYSTEMS.get(type);
    if (local !== undefined) return { judged: real, filesystem: local, escaped: false };
    const name = type === undefined ? undefined : LINUX_REFUSED_NAMES.get(type);
    throw networkRefusal(home, name, {
      home,
      judged: real,
      platform: 'linux',
      ...(type === undefined ? {} : { statfs_type: `0x${type.toString(16)}` }),
      ...(name === undefined ? {} : { filesystem: name }),
    });
  }
  if (probe.platform === 'darwin') {
    const entries = mountEntries(probe);
    const entry = entries === undefined ? undefined : mountOf(entries, real);
    if (entry?.local === true) return { judged: real, filesystem: entry.type, escaped: false };
    throw networkRefusal(home, entry?.type, {
      home,
      judged: real,
      platform: 'darwin',
      ...(entry === undefined ? {} : { filesystem: entry.type, mount_point: entry.mountPoint }),
    });
  }
  throw refused(
    `Realm cannot tell whether ${home} is on a local filesystem on this platform (${probe.platform}), so it does not open the store. Set REALM_STORE_FS=local to use this folder anyway.`,
    { home, platform: probe.platform },
  );
}
