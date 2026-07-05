// extension-identity.ts — PURE fingerprint + compare for extension-code drift evidence
// (issue #119). This module is STRUCTURALLY incapable of loading code: no dynamic import,
// no module-require creation, anywhere. It only reads bytes (fs), hashes them (crypto),
// and manipulates paths — which is exactly why read-only commands (`realm run inspect
// --check-drift`) may use it without ever gaining the capability to execute project code.
// A structural test (read-only-no-extensions.test.ts) enforces this.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type {
  ExtensionIdentityEntry,
  ExtensionIdentityModule,
  ExtensionIdentitySignals,
} from '@sensigo/realm';
import { extensionIdentityDiffers } from '@sensigo/realm';

/** The one sweep-rule version this module can compute. Comparison ALWAYS recomputes under
 *  the RECORDED rule string — a future rules change must add a new version, never mutate v1. */
export const DIR_TREE_V1_RULES =
  'dir_tree_v1: include .js,.mjs,.cjs,.ts,.mts,.cts,.json; exclude dirs node_modules,.git; skip symlinks; sort by relpath; sha256(relpath\\0filehash); caps 2000 files/50MB';

const INCLUDED_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.json']);
const EXCLUDED_DIR_NAMES = new Set(['node_modules', '.git']);
const MAX_FILES = 2000;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

/** Compares two identity entries — tree_hash + per-module entry hashes + override flag. */
export { extensionIdentityDiffers as identityDiffers };

export interface ComputeIdentityInput {
  declared: string;
  resolved: string;
  format: ExtensionIdentityModule['format'];
}

export interface ComputeIdentityOptions {
  /** Trust root for the advisory signals (package.json version, .git HEAD). */
  trustRoot?: string;
  /** Set when --extensions-module replaced the declared modules. */
  overrideActive?: boolean;
  /** Injected for tests; defaults to `new Date().toISOString()`. */
  capturedAt?: string;
  /** Injected for tests; defaults to `process.pid`. */
  pid?: number;
  /** Deployment-manifest identity (path + raw-bytes sha256) — recorded AND compared. */
  manifest?: { path: string; content_hash: string };
  /** Secret NAMES referenced by the manifest — recorded, never compared, never values. */
  secretNames?: string[];
}

/** sha256 hex of raw bytes/text — exported for the loader's manifest content hash. */
export function sha256HexOf(data: Buffer | string): string {
  return sha256Hex(data);
}

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
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

interface TreeSweepResult {
  file_count: number;
  total_bytes: number;
  tree_hash: string;
  truncated: boolean;
}

/** Hashes the sorted file listing of `roots` under the dir_tree_v1 caps. */
function sweepTree(roots: string[]): TreeSweepResult {
  // Enumerate everything first (cheap), THEN hash under caps — the truncation point is a
  // deterministic prefix of the sorted listing, so truncated hashes stay comparable.
  const perRoot = roots.map((root) => enumerateTreeFiles(root).map((rel) => ({ root, rel })));
  const allFiles = perRoot.flat();

  const lines: string[] = [];
  let totalBytes = 0;
  let truncated = false;
  for (const file of allFiles) {
    if (lines.length >= MAX_FILES || totalBytes >= MAX_TOTAL_BYTES) {
      truncated = true;
      break;
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(file.root, file.rel));
    } catch {
      // File disappeared between enumeration and hashing — record it as unreadable
      // (deterministic for a given tree state; a vanishing file IS a tree change).
      lines.push(`${file.rel}\u0000<unreadable>`);
      continue;
    }
    totalBytes += bytes.length;
    lines.push(`${file.rel}\u0000${sha256Hex(bytes)}`);
  }

  return {
    file_count: lines.length,
    total_bytes: totalBytes,
    tree_hash: sha256Hex(lines.join('\n')),
    truncated,
  };
}

/** Advisory signals — each independently fail-soft to undefined; never compared. */
function collectSignals(trustRoot: string | undefined): ExtensionIdentitySignals | undefined {
  if (trustRoot === undefined) return undefined;
  const signals: ExtensionIdentitySignals = {};

  try {
    const pkg = JSON.parse(readFileSync(join(trustRoot, 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    if (typeof pkg.version === 'string') signals.package_version = pkg.version;
  } catch {
    // fail-soft
  }

  try {
    // Read .git/HEAD; dereference ONE ref file. No child processes, ever.
    const head = readFileSync(join(trustRoot, '.git', 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref: ')) {
      const refPath = head.slice('ref: '.length).trim();
      const refValue = readFileSync(join(trustRoot, '.git', refPath), 'utf8').trim();
      if (refValue !== '') signals.git_head = refValue;
    } else if (head !== '') {
      signals.git_head = head; // detached HEAD — the hash itself
    }
  } catch {
    // fail-soft (packed refs, no .git, unreadable — all acceptable)
  }

  return signals.package_version === undefined && signals.git_head === undefined
    ? undefined
    : signals;
}

/**
 * Computes the dir_tree_v1 identity of a set of loaded extension modules: per-module
 * sha256 entry hashes plus a deterministic directory-tree fingerprint over the deduped
 * parent directories of the resolved entries. Pure fs + crypto — never loads code.
 */
export function computeExtensionIdentity(
  modules: ComputeIdentityInput[],
  opts: ComputeIdentityOptions = {},
): ExtensionIdentityEntry {
  const moduleEntries: ExtensionIdentityModule[] = modules.map((m) => ({
    declared: m.declared,
    resolved: m.resolved,
    entry_hash: sha256Hex(readFileSync(m.resolved)),
    format: m.format,
  }));

  const roots = [...new Set(modules.map((m) => dirname(m.resolved)))].sort();
  const tree = sweepTree(roots);

  const signals = collectSignals(opts.trustRoot);
  return {
    captured_at: opts.capturedAt ?? new Date().toISOString(),
    pid: opts.pid ?? process.pid,
    modules: moduleEntries,
    tree: { roots, rules: DIR_TREE_V1_RULES, ...tree },
    ...(signals !== undefined ? { signals } : {}),
    coverage: 'dir_tree_v1',
    ...(opts.manifest !== undefined ? { manifest: opts.manifest } : {}),
    ...(opts.secretNames !== undefined && opts.secretNames.length > 0
      ? { secret_names: opts.secretNames }
      : {}),
    ...(opts.overrideActive === true ? { override_active: true as const } : {}),
  };
}

/**
 * Builds an identity entry that records a capture/load FAILURE — the failure is itself
 * evidence (WorkflowContextSnapshot.error precedent). Modules/tree are empty placeholders.
 */
export function errorExtensionIdentityEntry(
  message: string,
  opts: Pick<ComputeIdentityOptions, 'capturedAt' | 'pid' | 'overrideActive'> = {},
): ExtensionIdentityEntry {
  return {
    captured_at: opts.capturedAt ?? new Date().toISOString(),
    pid: opts.pid ?? process.pid,
    modules: [],
    tree: {
      roots: [],
      rules: DIR_TREE_V1_RULES,
      file_count: 0,
      total_bytes: 0,
      tree_hash: '',
      truncated: false,
    },
    coverage: 'dir_tree_v1',
    ...(opts.overrideActive === true ? { override_active: true as const } : {}),
    error: message,
  };
}

/** Per-component result of a --check-drift recomputation against current disk state. */
export interface RecomputeResult {
  comparable: true;
  /** Per recorded module: current entry hash (undefined = file unreadable/missing). */
  modules: Array<{ resolved: string; recorded_hash: string; current_hash?: string }>;
  tree: { recorded_hash: string; current_hash: string; current_truncated: boolean };
  signals?: ExtensionIdentitySignals;
}

export interface RecomputeNotComparable {
  comparable: false;
  reason: string;
}

/**
 * Recomputes an entry's identity from CURRENT disk state STRICTLY under the entry's
 * RECORDED rules and roots — an unknown rules version yields an explicit cannot-compare
 * rather than a guess (a rules change must never manufacture phantom drift).
 * Pure fs + crypto — never loads code.
 */
export function recomputeIdentity(
  entry: ExtensionIdentityEntry,
  opts: { trustRoot?: string } = {},
): RecomputeResult | RecomputeNotComparable {
  if (entry.tree.rules !== DIR_TREE_V1_RULES) {
    return {
      comparable: false,
      reason: `cannot compare (unknown rules '${entry.tree.rules}')`,
    };
  }

  const modules = entry.modules.map((m) => {
    let currentHash: string | undefined;
    try {
      currentHash = sha256Hex(readFileSync(m.resolved));
    } catch {
      currentHash = undefined;
    }
    return {
      resolved: m.resolved,
      recorded_hash: m.entry_hash,
      ...(currentHash !== undefined ? { current_hash: currentHash } : {}),
    };
  });

  const tree = sweepTree(entry.tree.roots);
  const signals = collectSignals(opts.trustRoot);
  return {
    comparable: true,
    modules,
    tree: {
      recorded_hash: entry.tree.tree_hash,
      current_hash: tree.tree_hash,
      current_truncated: tree.truncated,
    },
    ...(signals !== undefined ? { signals } : {}),
  };
}
