// code-hashes.ts — #828 unit 1 (PR A): the one home of the project code's hashes, published as the
// subpath `@sensigo/realm-mcp/code-hashes` (off the package root for its import graph, as `./home`
// is; its names are untagged, so internal). It holds the dir_tree_v1 sweep, moved here from the CLI's
// `extension-identity.ts` with its rules unchanged, and the per-process map of the hashes a program
// took just before it first imported the code.
//
// WHY A MAP. Node serves a module from its import cache for the life of the process, and jiti does
// too, so the code that runs is the code as it was at its first successful import. Hashing the files
// again after a rebuild would record bytes the process never loaded. So the map holds one hash per
// file per process, shared by every workflow the process loads (#828 correction 1):
// - a module's own file is hashed just before the loader first imports that module, even when a
//   sweep of its folder already holds a hash for it, and that hash is final once the import succeeds;
// - every other file keeps the first hash a sweep of its folder took;
// - before each first import of a module its folder is swept, reusing every kept hash, and also when
//   the map holds no sweep of that folder; the identity step never sweeps;
// - when an import fails, what this load read in the failed module's folder is dropped, but the own
//   file of each module whose import succeeded: Node reads the failed file again at the retry. Any
//   other failure keeps everything, as a success does;
// - the signals are taken once per trust root, just before the first import that reads them.
//
// This module loads no code: no dynamic import, no module-require creation. It imports only `node:`
// modules and `@sensigo/realm` (types). A structural test in the CLI holds it to that.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { ExtensionIdentitySignals } from '@sensigo/realm';

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

/**
 * What this process keeps: each file's first hash by its real path, the modules whose import
 * succeeded (their own file's hash is final), each folder's sweep, and the signals by trust root.
 */
interface Kept {
  readonly files: Map<string, FileHash>;
  readonly modules: Set<string>;
  readonly folders: Map<string, FolderSweep>;
  readonly signals: Map<string, ExtensionIdentitySignals | undefined>;
}

const kept: Kept = { files: new Map(), modules: new Set(), folders: new Map(), signals: new Map() };

/** Test-only: forgets every kept hash, as a new process would start with none. */
export function clearCodeHashes(): void {
  kept.files.clear();
  kept.modules.clear();
  kept.folders.clear();
  kept.signals.clear();
}

/** What a load needs to read the signals: its trust root, and the reader (the CLI's). */
export interface CodeHashLoadOptions {
  readonly trustRoot?: string;
  readonly readSignals: (trustRoot: string) => ExtensionIdentitySignals | undefined;
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
  /** `entry`'s import threw: this load's reads in its folder are dropped, but loaded modules' own files. */
  importFailed(entry: string): void;
  /** The entry hash for the identity (`undefined`: unreadable, so the identity reads it and fails). */
  entryHash(entry: string): string | undefined;
  /** The joined tree of `roots`, from the sweeps taken before the imports; it never sweeps. */
  tree(roots: readonly string[]): TreeSweepResult;
  /** The signals: taken once per trust root per process. */
  signals(): ExtensionIdentitySignals | undefined;
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
  /** The sweeps this load put in the map, with the sweep each replaced: what a failed import undoes. */
  private readonly swept = new Map<string, FolderSweep | undefined>();
  /** Own-file hashes taken just before an import that has not succeeded yet. */
  private readonly own = new Map<string, FileHash | undefined>();
  private signalsTaken = false;

  constructor(private readonly options: CodeHashLoadOptions) {}

  beforeImport(entry: string): void {
    this.takeSignals();
    const root = dirname(entry);
    if (!kept.modules.has(entry)) {
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
    for (const [folder, before] of this.swept) {
      if (!within(folder, root)) continue;
      if (before === undefined) kept.folders.delete(folder);
      else kept.folders.set(folder, before);
      this.swept.delete(folder);
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
    if (!this.swept.has(root)) this.swept.set(root, kept.folders.get(root));
    kept.folders.set(
      root,
      sweepFolder(root, (path) => this.fileHash(path)),
    );
  }

  private takeSignals(): void {
    if (this.signalsTaken) return;
    this.signalsTaken = true;
    const trustRoot = this.options.trustRoot;
    if (trustRoot !== undefined && !kept.signals.has(trustRoot))
      kept.signals.set(trustRoot, this.options.readSignals(trustRoot));
  }
}
