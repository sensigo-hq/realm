// extension-identity.ts — PURE fingerprint + compare for extension-code drift evidence
// (issue #119). This module is STRUCTURALLY incapable of loading code: no dynamic import,
// no module-require creation, anywhere. It only reads bytes (fs), hashes them (crypto),
// and manipulates paths — which is exactly why read-only commands (`realm run inspect
// --check-drift`) may use it without ever gaining the capability to execute project code.
// A structural test (read-only-no-extensions.test.ts) enforces this.
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  ExtensionIdentityEntry,
  ExtensionIdentityLockfile,
  ExtensionIdentityModule,
  ExtensionIdentitySignals,
} from '@sensigo/realm';
import { extensionIdentityDiffers, extensionLockfileDiffers } from '@sensigo/realm';
// #828 unit 1: the dir_tree_v1 sweep lives in the one hashing home, the realm-mcp subpath (loads no
// code either); this module re-exports its rule string and keeps its pure functions.
import {
  DIR_TREE_V1_RULES,
  lockfileNow,
  sha256Hex,
  sweepTree,
  type TreeSweepResult,
} from '@sensigo/realm-mcp/code-hashes';

export { DIR_TREE_V1_RULES };

/** Compares two identity entries — tree_hash + per-module entry hashes + override flag. */
export { extensionIdentityDiffers as identityDiffers };

export interface ComputeIdentityInput {
  declared: string;
  resolved: string;
  format: ExtensionIdentityModule['format'];
}

/**
 * #828 unit 1: the values a loader took once per process, just before it first imported the code.
 * Each one given replaces the read of the disk; each one left out is read now, as before.
 */
export interface ComputeIdentityValues {
  /** A module's entry hash by its resolved path (`undefined`: not known, read the file). */
  entryHash?: (resolved: string) => string | undefined;
  /** The joined tree of the module roots. */
  tree?: (roots: string[]) => TreeSweepResult;
  /** The signals (`undefined` is a value: none). */
  signals?: () => ExtensionIdentitySignals | undefined;
  /** #828 PR B: the project's lockfile, as the process read it once. */
  lockfile?: () => ExtensionIdentityLockfile;
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
  manifest?: { path: string; content_hash: string; secrets_block_hash?: string };
  /** Secret NAMES referenced by the manifest — never values; a read compares them (D-12). */
  secretNames?: string[];
  /** #828 unit 1: the loader's values, taken before the code first loaded. */
  values?: ComputeIdentityValues;
  /**
   * #828 PR B: the project's folder (a real path), where the lockfile's walk starts when no loader
   * value is given; with neither, the member is `{ absent: 'none_found' }`.
   */
  projectFolder?: string;
}

/** sha256 hex of raw bytes/text — exported for the loader's manifest content hash. */
export function sha256HexOf(data: Buffer | string): string {
  return sha256Hex(data);
}

/**
 * Advisory signals — each independently fail-soft to undefined; never compared. Exported as the
 * reader the loader hands the per-process map (#828 unit 1).
 */
export function collectSignals(
  trustRoot: string | undefined,
): ExtensionIdentitySignals | undefined {
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
  const values = opts.values;
  const moduleEntries: ExtensionIdentityModule[] = modules.map((m) => ({
    declared: m.declared,
    resolved: m.resolved,
    entry_hash: values?.entryHash?.(m.resolved) ?? sha256Hex(readFileSync(m.resolved)),
    format: m.format,
  }));

  const roots = [...new Set(modules.map((m) => dirname(m.resolved)))].sort();
  const tree = values?.tree !== undefined ? values.tree(roots) : sweepTree(roots);

  const signals = values?.signals !== undefined ? values.signals() : collectSignals(opts.trustRoot);
  const lockfile =
    values?.lockfile !== undefined ? values.lockfile() : lockfileNow(opts.projectFolder);
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
    lockfile,
  };
}

/**
 * #828 PR B: one recorded or current lockfile in words, for `--check-drift` and the drift warning
 * (one wording, R13): `sha256 <hash>`, `none found` or `unreadable`.
 */
export function lockfileWords(lockfile: ExtensionIdentityLockfile): string {
  if ('sha256' in lockfile) return `sha256 ${lockfile.sha256}`;
  return lockfile.absent === 'none_found' ? 'none found' : 'unreadable';
}

/** #828 PR B: whether two lockfiles differ, by the comparison's own table. */
export { extensionLockfileDiffers as lockfileDiffers };

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
  /**
   * Deployment-manifest bytes-hash recompute (pure fs read of entry.manifest.path — no
   * YAML parsing, no secret resolution). Absent when the entry recorded no manifest
   * (older entries); current_hash undefined = manifest file missing/unreadable.
   */
  manifest?: { path: string; recorded_hash: string; current_hash?: string };
  signals?: ExtensionIdentitySignals;
  /**
   * #828 PR B: the lockfile re-located and re-hashed from the walk's start (the folder of
   * `entry.manifest.path`, else the definition's trust root), when the entry recorded one. `current`
   * absent: the project's folder is not known.
   */
  lockfile?: { recorded: ExtensionIdentityLockfile; current?: ExtensionIdentityLockfile };
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

  let manifestResult: RecomputeResult['manifest'];
  if (entry.manifest !== undefined) {
    let currentHash: string | undefined;
    try {
      currentHash = sha256Hex(readFileSync(entry.manifest.path));
    } catch {
      currentHash = undefined; // missing/unreadable — reported as MISSING by inspect
    }
    manifestResult = {
      path: entry.manifest.path,
      recorded_hash: entry.manifest.content_hash,
      ...(currentHash !== undefined ? { current_hash: currentHash } : {}),
    };
  }

  const signals = collectSignals(opts.trustRoot);
  let lockfileResult: RecomputeResult['lockfile'];
  if (entry.lockfile !== undefined) {
    const start = entry.manifest !== undefined ? dirname(entry.manifest.path) : opts.trustRoot;
    lockfileResult = {
      recorded: entry.lockfile,
      ...(start !== undefined ? { current: lockfileNow(realOrSelf(start)) } : {}),
    };
  }
  return {
    comparable: true,
    modules,
    tree: {
      recorded_hash: entry.tree.tree_hash,
      current_hash: tree.tree_hash,
      current_truncated: tree.truncated,
    },
    ...(manifestResult !== undefined ? { manifest: manifestResult } : {}),
    ...(signals !== undefined ? { signals } : {}),
    ...(lockfileResult !== undefined ? { lockfile: lockfileResult } : {}),
  };
}

/** The real path of `path`, or `path` itself when it cannot be resolved (fail-soft). */
export function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
