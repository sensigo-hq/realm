// code-hashes.ts — #828 unit 1 (PR A): the one home of the project code's hashes, published as the
// subpath `@sensigo/realm-mcp/code-hashes` (off the package root for its import graph, as `./home`
// is; its names are untagged, so internal: #828 unit 2b's `projectSourceOf`, for a host, is a wrapper of
// `statedProjectSource` in `project-source.ts`, on the main entry). It holds the dir_tree_v1 sweep,
// moved here from the CLI's
// `extension-identity.ts` with its rules unchanged, and the per-process map of the hashes a program
// took just before it first imported the code.
//
// WHY A MAP. Node serves a module from its import cache for the life of the process, and jiti does
// too, so the code that runs is the code as it was at its first successful import. Hashing the files
// again after a rebuild would record bytes the process never loaded. So the map holds one hash per
// file per process, shared by every workflow the process loads (#828 corrections 1 and 2):
// - a module's own file is hashed just before the loader first imports that module, even when a
//   sweep of its folder already holds a hash for it, and that hash is final once the import succeeds;
// - every other file keeps the first hash a sweep of its folder took;
// - before each first import of a module its folder is swept, reusing every kept hash, and also when
//   the map holds no sweep of that folder; the identity step never sweeps;
// - when an import fails, the hashes this load read in the failed module's folder are dropped, but
//   the own file of each module whose import succeeded: Node reads the failed file again at the
//   retry. No folder's sweep changes: the map keeps the latest sweep any load took, as when every
//   load succeeds, and the retry's first import sweeps the folder again. Any other failure keeps
//   everything, as a success does;
// - the signals are taken once per trust root, just before the first import that reads them;
// - the project's lockfile (#828 PR B) is located once per process per project folder, and each
//   lockfile file is read once per process, by its real path, in maps of their own: just before the
//   first import of the first load that needs it, or at the identity step of a load that made no
//   first import. It is kept whatever happens to that load or a later one, as the signals are: Node
//   loads each package once per process and never reloads it, so the packages that run came from the
//   lockfile read first. A failed import never drops it, even when its folder's sweep lists the file.
//
// This module loads no code: no dynamic import, no module-require creation. It imports only `node:`
// modules and `@sensigo/realm` (types, `realmHomePath`, realm's one asker for the home folder, and
// `WorkflowError` for `projectSourceOf`'s refusal). A structural test in the CLI holds it to that.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realmHomePath, WorkflowError } from '@sensigo/realm';
import type {
  ExtensionIdentityLockfile,
  ExtensionIdentitySignals,
  ProjectSource,
} from '@sensigo/realm';

/** The one sweep-rule version this module can compute. Comparison ALWAYS recomputes under
 *  the RECORDED rule string — a future rules change must add a new version, never mutate v1. */
export const DIR_TREE_V1_RULES =
  'dir_tree_v1: include .js,.mjs,.cjs,.ts,.mts,.cts,.json; exclude dirs node_modules,.git; skip symlinks; sort by relpath; sha256(relpath\\0filehash); caps 2000 files/50MB';

const INCLUDED_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.json']);
const EXCLUDED_DIR_NAMES = new Set(['node_modules', '.git']);
const MAX_FILES = 2000;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

/** One file's sha256 hex and its length in bytes. */
export interface FileHash {
  readonly sha256: string;
  readonly bytes: number;
}

/** One line of a folder's sweep: the file's path from the folder, its path, and its hash (none: unreadable). */
export interface SweptFile {
  readonly rel: string;
  readonly path: string;
  readonly hash?: FileHash;
}

/** One folder's dir_tree_v1 sweep under the caps; `more` when it stopped at a cap with files left. */
export interface FolderSweep {
  readonly root: string;
  readonly files: readonly SweptFile[];
  readonly more: boolean;
}

/** The joined fingerprint of several folders, as `ExtensionIdentityTree` records it. */
export interface TreeSweepResult {
  file_count: number;
  total_bytes: number;
  tree_hash: string;
  truncated: boolean;
}

/** sha256 hex of raw bytes or text. */
export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Reads one file and hashes it; `undefined` when it cannot be read. */
export function hashFile(path: string): FileHash | undefined {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    return undefined;
  }
  return { sha256: sha256Hex(bytes), bytes: bytes.length };
}

function fileExtension(path: string): string {
  const base = path.slice(path.lastIndexOf(sep) + 1);
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot);
}

/**
 * Deterministically enumerates the relative paths of sweep-eligible files under `root`
 * per dir_tree_v1: included extensions only, `node_modules`/`.git` directories excluded at
 * any depth, symlinks (files and directories) skipped, sorted by relative path.
 * Enumeration is cap-free — caps apply at the hashing stage so the truncated fingerprint
 * covers a DETERMINISTIC prefix of the sorted listing.
 */
function enumerateTreeFiles(root: string): string[] {
  const relPaths: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skipped (deterministic for a given tree state)
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue; // dir_tree_v1: symlinks skipped
      if (entry.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile()) {
        if (INCLUDED_EXTENSIONS.has(fileExtension(entry.name))) {
          relPaths.push(relative(root, full));
        }
      }
    }
  };
  walk(root);
  return relPaths.sort();
}

/** True when a list of `count` lines totalling `bytes` has reached a dir_tree_v1 cap. */
function atCap(count: number, bytes: number): boolean {
  return count >= MAX_FILES || bytes >= MAX_TOTAL_BYTES;
}

/**
 * Sweeps one folder under the dir_tree_v1 caps. `hashOf` gives each file's hash (by default, read
 * now); a vanished or unreadable file is a line without a hash.
 */
export function sweepFolder(
  root: string,
  hashOf: (path: string) => FileHash | undefined = hashFile,
): FolderSweep {
  const files: SweptFile[] = [];
  let bytes = 0;
  let more = false;
  for (const rel of enumerateTreeFiles(root)) {
    if (atCap(files.length, bytes)) {
      more = true;
      break;
    }
    const path = join(root, rel);
    const hash = hashOf(path);
    if (hash !== undefined) bytes += hash.bytes;
    files.push(hash !== undefined ? { rel, path, hash } : { rel, path });
  }
  return { root, files, more };
}

/**
 * Joins folders' sweeps, in the order given, into one fingerprint with the caps applied again over
 * the joined lines. `truncated` is set when the join stops early, and when it takes the whole of a
 * folder whose own sweep stopped at a cap (#828 audit S5: that folder had files left).
 */
export function joinSweeps(sweeps: readonly FolderSweep[]): TreeSweepResult {
  const lines: string[] = [];
  let totalBytes = 0;
  let truncated = false;
  outer: for (const sweep of sweeps) {
    for (const file of sweep.files) {
      if (atCap(lines.length, totalBytes)) {
        truncated = true;
        break outer;
      }
      if (file.hash === undefined) {
        // File disappeared between enumeration and hashing — recorded as unreadable
        // (deterministic for a given tree state; a vanishing file IS a tree change).
        lines.push(`${file.rel}\u0000<unreadable>`);
        continue;
      }
      totalBytes += file.hash.bytes;
      lines.push(`${file.rel}\u0000${file.hash.sha256}`);
    }
    if (sweep.more) truncated = true;
  }
  return {
    file_count: lines.length,
    total_bytes: totalBytes,
    tree_hash: sha256Hex(lines.join('\n')),
    truncated,
  };
}

/** Hashes the sorted file listing of `roots` under the dir_tree_v1 caps, reading the disk now. */
export function sweepTree(roots: readonly string[]): TreeSweepResult {
  return joinSweeps(roots.map((root) => sweepFolder(root)));
}

/** The lockfile names a folder may hold (#828 PR B). */
const LOCKFILE_NAMES = [
  'npm-shrinkwrap.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
] as const;

/** Whether `path` is a file once its links are followed, readable or not; a dangling link is not. */
function isFilePath(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectoryPath(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The real path of `path`, or `path` itself when it cannot be resolved. */
function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The user's home folder (a real path), from realm's one place that asks the system for it (the folder
 * above `~/.realm`); `undefined` when there is none to use, and then the walk has no home stop.
 */
function userHome(): string | undefined {
  try {
    return realOrSelf(dirname(realmHomePath()));
  } catch {
    return undefined;
  }
}

/**
 * The project's lockfiles (#828 PR B, rev 3.1 item 4): from `projectFolder` (a real path) up, the
 * first folder holding any of {@link LOCKFILE_NAMES}, every one present taken, and
 * `package-lock.json` left out beside `npm-shrinkwrap.json`, as npm ignores it. The walk passes a
 * folder that holds none, stops after the first folder holding a `.git` directory (a `.git` file does
 * not stop it), and outside a repository never looks in the user's home folder or above it, unless
 * the project's folder is the home folder. `undefined`: none found.
 */
function locateLockfiles(projectFolder: string): string[] | undefined {
  const home = userHome();
  let folder = projectFolder;
  for (;;) {
    if (folder === home && folder !== projectFolder) return undefined;
    const present = LOCKFILE_NAMES.filter((name) => isFilePath(join(folder, name)));
    if (present.length > 0) {
      const taken = present.includes('npm-shrinkwrap.json')
        ? present.filter((name) => name !== 'package-lock.json')
        : present;
      return taken.map((name) => join(folder, name));
    }
    if (isDirectoryPath(join(folder, '.git'))) return undefined;
    if (folder === home) return undefined;
    const parent = dirname(folder);
    if (parent === folder) return undefined;
    folder = parent;
  }
}

/** A lockfile's kept read: its hash, or that it cannot be read. */
type LockfileRead = FileHash | 'unreadable';

/**
 * The `lockfile` member for a project folder, from the files found and each file's read (#828 PR B,
 * rev 3.1 item 4): the paths from the project's folder with `/` separators, sorted, and the sha256 of
 * the lines `<path>\0<the file's sha256>` joined with `\n`; `unreadable` when any cannot be read.
 */
function lockfileMember(
  projectFolder: string,
  files: readonly string[] | undefined,
  readOf: (path: string) => LockfileRead,
): ExtensionIdentityLockfile {
  if (files === undefined) return { absent: 'none_found' };
  const named = files
    .map((path) => ({
      rel: relative(projectFolder, path).split(sep).join('/'),
      read: readOf(path),
    }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const rels = named.map((n) => n.rel);
  if (named.some((n) => n.read === 'unreadable')) return { files: rels, absent: 'unreadable' };
  const lines = named.map((n) => `${n.rel}\u0000${(n.read as FileHash).sha256}`);
  return { files: rels, sha256: sha256Hex(lines.join('\n')) };
}

/** Reads one lockfile now: its hash, or `unreadable`. */
function readLockfile(path: string): LockfileRead {
  return hashFile(path) ?? 'unreadable';
}

/**
 * The project's lockfile read from the disk now (#828 PR B): pure and uncached, for an identity
 * computed without a loader's values and for `--check-drift`'s recompute. `undefined` folder: none.
 */
export function lockfileNow(projectFolder: string | undefined): ExtensionIdentityLockfile {
  if (projectFolder === undefined) return { absent: 'none_found' };
  return lockfileMember(projectFolder, locateLockfiles(projectFolder), readLockfile);
}

/**
 * What this process keeps: each file's first hash by its real path, the modules whose import
 * succeeded (their own file's hash is final), each folder's sweep, and the signals by trust root.
 */
interface Kept {
  readonly files: Map<string, FileHash>;
  readonly modules: Set<string>;
  readonly folders: Map<string, FolderSweep>;
  readonly signals: Map<string, ExtensionIdentitySignals | undefined>;
  /** #828 PR B: each project folder's lockfiles, located once (`undefined`: none found). */
  readonly lockfileChoices: Map<string, string[] | undefined>;
  /** #828 PR B: each lockfile file's read, once, by its real path. Never dropped by a failure. */
  readonly lockfiles: Map<string, LockfileRead>;
  /** #828 unit 2b: `projectSourceOf`'s result for each real path, kept from its first call. */
  readonly stated: Map<string, ProjectSource>;
}

const kept: Kept = {
  files: new Map(),
  modules: new Set(),
  folders: new Map(),
  signals: new Map(),
  lockfileChoices: new Map(),
  lockfiles: new Map(),
  stated: new Map(),
};

/** Test-only: forgets every kept hash, as a new process would start with none. */
export function clearCodeHashes(): void {
  kept.files.clear();
  kept.modules.clear();
  kept.folders.clear();
  kept.signals.clear();
  kept.lockfileChoices.clear();
  kept.lockfiles.clear();
  kept.stated.clear();
}

/**
 * #828 unit 2b: `projectSourceOf`'s work (project-source.ts, which documents it), here because it reads
 * and keeps the per-process map: the module's real path, its own file's hash and its folder's tree,
 * taken at the first call for that real path (reusing what a load already took) and kept.
 */
export function statedProjectSource(module: string | URL): ProjectSource {
  const fail = (path: string, what: string): WorkflowError =>
    new WorkflowError(`projectSourceOf: ${path} ${what}.`, {
      code: 'RESOURCE_FETCH_FAILED',
      category: 'RESOURCE',
      agentAction: 'report_to_user',
      retryable: false,
      details: { path },
    });
  let path: string;
  // A URL string: a scheme of two letters or more (a Windows drive letter has one).
  if (module instanceof URL || /^[a-z][a-z\d+.-]+:/i.test(module)) {
    let url: URL | undefined;
    try {
      url = module instanceof URL ? module : new URL(module);
    } catch {
      url = undefined;
    }
    const text = module instanceof URL ? module.href : module;
    if (url?.protocol !== 'file:') throw fail(text, 'is not a file: URL');
    try {
      path = fileURLToPath(url);
    } catch {
      throw fail(text, 'cannot be read');
    }
  } else path = resolve(module);
  let real: string;
  try {
    real = realpathSync(path);
  } catch (err) {
    throw fail(
      path,
      (err as { code?: unknown }).code === 'ENOENT' ? 'is missing' : 'cannot be read',
    );
  }
  const held = kept.stated.get(real);
  if (held !== undefined) return held;
  let folder: boolean;
  try {
    folder = statSync(real).isDirectory();
  } catch {
    throw fail(path, 'cannot be read');
  }
  if (folder) throw fail(path, 'is a folder');
  const own = kept.files.get(real) ?? hashFile(real);
  if (own === undefined) throw fail(path, 'cannot be read');
  const root = dirname(real);
  const sweep =
    kept.folders.get(root) ?? sweepFolder(root, (p) => kept.files.get(p) ?? hashFile(p));
  const source: ProjectSource = Object.freeze({
    source: 'project',
    declared: real,
    via: 'host_stated',
    entry_hash: own.sha256,
    folder_tree_hash: joinSweeps([sweep]).tree_hash,
  });
  kept.stated.set(real, source);
  return source;
}

/**
 * What a load needs: its trust root and the reader for the signals (the CLI's), and (#828 PR B) its
 * project folder, `realpath(trust_root ?? projectDir)`, for the lockfile.
 */
export interface CodeHashLoadOptions {
  readonly trustRoot?: string;
  readonly readSignals: (trustRoot: string) => ExtensionIdentitySignals | undefined;
  readonly projectFolder?: string;
}

/**
 * One load's reads of the project code, over the process map (see the module comment). Ask
 * `beforeImport` just before each import, then `imported` once it has succeeded or `importFailed`
 * when it threw; then read the values for the identity.
 */
export interface CodeHashLoad {
  /** Just before importing `entry`: its own file is hashed at a first import, and its folder swept. */
  beforeImport(entry: string): void;
  /** `entry`'s import succeeded: its own hash is final for the process. */
  imported(entry: string): void;
  /**
   * `entry`'s import threw: this load's hashes in its folder are dropped, but loaded modules' own
   * files. No folder's sweep changes.
   */
  importFailed(entry: string): void;
  /** The entry hash for the identity (`undefined`: unreadable, so the identity reads it and fails). */
  entryHash(entry: string): string | undefined;
  /** The joined tree of `roots`, from the sweeps taken before the imports; it never sweeps. */
  tree(roots: readonly string[]): TreeSweepResult;
  /** The signals: taken once per trust root per process. */
  signals(): ExtensionIdentitySignals | undefined;
  /**
   * #828 PR B: the lockfile member, from the kept reads (read now when none is kept: a load that made
   * no first import). With no project folder, `none_found`.
   */
  lockfile(): ExtensionIdentityLockfile;
}

/**
 * Starts one load's reads over the process map. A factory, not an exported class: every class a
 * published entry exports carries its package's release mark (`check:brands`), and that mark lives
 * in a module this one does not import.
 */
export function beginCodeHashLoad(options: CodeHashLoadOptions): CodeHashLoad {
  return new Load(options);
}

/** Whether `path` is `root` or inside it. */
const within = (path: string, root: string): boolean =>
  path === root || path.startsWith(root + sep);

class Load implements CodeHashLoad {
  /** The files this load hashed into the map: what a failed import in their folder drops. */
  private readonly read = new Set<string>();
  /** Own-file hashes taken just before an import that has not succeeded yet. */
  private readonly own = new Map<string, FileHash | undefined>();
  private signalsTaken = false;

  constructor(private readonly options: CodeHashLoadOptions) {}

  beforeImport(entry: string): void {
    this.takeSignals();
    const root = dirname(entry);
    if (!kept.modules.has(entry)) {
      // A first import: the lockfile is read just before it, when not kept yet (#828 PR B).
      this.takeLockfile();
      this.own.set(entry, hashFile(entry));
      this.sweep(root);
    } else if (!kept.folders.has(root)) this.sweep(root);
  }

  imported(entry: string): void {
    if (kept.modules.has(entry)) return;
    const hash = this.own.get(entry);
    this.own.delete(entry);
    if (hash === undefined) return;
    kept.files.set(entry, hash);
    kept.modules.add(entry);
  }

  importFailed(entry: string): void {
    this.own.delete(entry);
    const root = dirname(entry);
    for (const path of this.read) {
      if (!within(path, root) || kept.modules.has(path)) continue;
      kept.files.delete(path);
      this.read.delete(path);
    }
  }

  entryHash(entry: string): string | undefined {
    return this.fileHash(entry)?.sha256;
  }

  tree(roots: readonly string[]): TreeSweepResult {
    return joinSweeps(
      roots.map((root) => {
        const sweep = kept.folders.get(root);
        if (sweep === undefined) throw new Error(`no sweep of ${root} was taken before its import`);
        return sweep;
      }),
    );
  }

  signals(): ExtensionIdentitySignals | undefined {
    this.takeSignals();
    const trustRoot = this.options.trustRoot;
    return trustRoot === undefined ? undefined : kept.signals.get(trustRoot);
  }

  lockfile(): ExtensionIdentityLockfile {
    this.takeLockfile();
    const folder = this.options.projectFolder;
    if (folder === undefined) return { absent: 'none_found' };
    return lockfileMember(folder, kept.lockfileChoices.get(folder), (path) => {
      return kept.lockfiles.get(realOrSelf(path)) ?? 'unreadable';
    });
  }

  /** A file's hash: a loaded module's final one, this load's own-file one, the kept one, else read now. */
  private fileHash(path: string): FileHash | undefined {
    if (kept.modules.has(path) || !this.own.has(path)) {
      const held = kept.files.get(path);
      if (held !== undefined) return held;
    }
    if (this.own.has(path)) return this.own.get(path);
    const hash = hashFile(path);
    if (hash !== undefined) {
      kept.files.set(path, hash);
      this.read.add(path);
    }
    return hash;
  }

  private sweep(root: string): void {
    kept.folders.set(
      root,
      sweepFolder(root, (path) => this.fileHash(path)),
    );
  }

  /** Locates this load's project folder's lockfiles and reads each file, once per process. */
  private takeLockfile(): void {
    const folder = this.options.projectFolder;
    if (folder === undefined) return;
    if (!kept.lockfileChoices.has(folder))
      kept.lockfileChoices.set(folder, locateLockfiles(folder));
    for (const path of kept.lockfileChoices.get(folder) ?? []) {
      const real = realOrSelf(path);
      if (!kept.lockfiles.has(real)) kept.lockfiles.set(real, readLockfile(path));
    }
  }

  private takeSignals(): void {
    if (this.signalsTaken) return;
    this.signalsTaken = true;
    const trustRoot = this.options.trustRoot;
    if (trustRoot !== undefined && !kept.signals.has(trustRoot))
      kept.signals.set(trustRoot, this.options.readSignals(trustRoot));
  }
}
