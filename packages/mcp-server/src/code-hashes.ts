// code-hashes.ts — #828 unit 1 (PR A): the one home of the project code's hashes, published as the
// subpath `@sensigo/realm-mcp/code-hashes` (off the package root for its import graph, as `./home`
// is; its names are untagged, so internal). It holds the dir_tree_v1 sweep, moved here from the CLI's
// `extension-identity.ts` with its rules unchanged, and the per-process map of the hashes a program
// took just before it first imported the code.
//
// WHY A MAP. Node serves a module from its import cache for the life of the process, and jiti does
// too, so the code that runs is the code as it was at its first successful import. Hashing the files
// again after a rebuild would record bytes the process never loaded. So each file's hash is taken
// once, just before its first import, and kept; a later sweep of the same folder reuses it.
//
// WHEN A VALUE IS KEPT. A load reads through a `CodeHashLoad`. A module's own entry hash is kept as
// soon as its import succeeds (Node now runs those bytes). Everything else the load read (its folder
// sweeps and the signals) is kept only when the whole load succeeds (`commit`): a failed load is
// retried after a fix, and the retry reads again, as Node then loads the fixed file.
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

/** What this process keeps: each file's hash by its real path, each folder's last sweep, the signals. */
interface Kept {
  readonly files: Map<string, FileHash>;
  readonly folders: Map<string, FolderSweep>;
  readonly signals: Map<string, ExtensionIdentitySignals | undefined>;
}

const kept: Kept = { files: new Map(), folders: new Map(), signals: new Map() };

/** Test-only: forgets every kept hash, as a new process would start with none. */
export function clearCodeHashes(): void {
  kept.files.clear();
  kept.folders.clear();
  kept.signals.clear();
}

/** What a load needs to read the signals: its trust root, and the reader (the CLI's). */
export interface CodeHashLoadOptions {
  readonly trustRoot?: string;
  readonly readSignals: (trustRoot: string) => ExtensionIdentitySignals | undefined;
}

/**
 * One load's reads of the project code, over the process map. Ask `beforeImport` just before each
 * import and `imported` once it has succeeded; read the values for the identity; `commit` when the
 * whole load has succeeded. A load that fails is dropped: only its successful imports' entry hashes
 * stay.
 */
export class CodeHashLoad {
  private readonly files = new Map<string, FileHash>();
  private readonly folders = new Map<string, FolderSweep>();
  private signalsTaken = false;
  private signalsValue: ExtensionIdentitySignals | undefined;

  constructor(private readonly options: CodeHashLoadOptions) {}

  /** A file's hash: the kept one, else this load's, else read now (this load's until committed). */
  fileHash(path: string): FileHash | undefined {
    const held = kept.files.get(path) ?? this.files.get(path);
    if (held !== undefined) return held;
    const read = hashFile(path);
    if (read !== undefined) this.files.set(path, read);
    return read;
  }

  /**
   * Just before importing `entry`. The first import of a file (none kept for it) sweeps its folder
   * again in this load, reusing every kept hash; the signals are taken before the load's first import.
   */
  beforeImport(entry: string): void {
    this.takeSignals();
    if (kept.files.has(entry)) return;
    this.sweep(dirname(entry));
  }

  /** `entry`'s import succeeded: its hash is kept now, whatever happens to the rest of the load. */
  imported(entry: string): void {
    const hash = this.fileHash(entry);
    if (hash !== undefined) kept.files.set(entry, hash);
  }

  /** The entry hash for the identity (`undefined`: unreadable, so the identity reads it and fails). */
  entryHash(entry: string): string | undefined {
    return this.fileHash(entry)?.sha256;
  }

  /** The joined tree of `roots`: each folder's sweep in this load, else its kept one, else swept now. */
  tree(roots: readonly string[]): TreeSweepResult {
    return joinSweeps(
      roots.map((root) => this.folders.get(root) ?? kept.folders.get(root) ?? this.sweep(root)),
    );
  }

  /** The signals: kept by trust root, else read once in this load. */
  signals(): ExtensionIdentitySignals | undefined {
    this.takeSignals();
    return this.signalsValue;
  }

  /** The whole load succeeded: every value it read is kept. */
  commit(): void {
    for (const [path, hash] of this.files) if (!kept.files.has(path)) kept.files.set(path, hash);
    for (const [root, sweep] of this.folders) kept.folders.set(root, sweep);
    const trustRoot = this.options.trustRoot;
    if (this.signalsTaken && trustRoot !== undefined && !kept.signals.has(trustRoot)) {
      kept.signals.set(trustRoot, this.signalsValue);
    }
  }

  private sweep(root: string): FolderSweep {
    const swept = this.folders.get(root) ?? sweepFolder(root, (path) => this.fileHash(path));
    this.folders.set(root, swept);
    return swept;
  }

  private takeSignals(): void {
    if (this.signalsTaken) return;
    this.signalsTaken = true;
    const trustRoot = this.options.trustRoot;
    if (trustRoot === undefined) return;
    this.signalsValue = kept.signals.has(trustRoot)
      ? kept.signals.get(trustRoot)
      : this.options.readSignals(trustRoot);
  }
}
