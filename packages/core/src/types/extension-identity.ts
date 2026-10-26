// Extension-code drift evidence types (issue #119) — pure data shapes carried on RunRecord.
//
// An ExtensionIdentityEntry records the identity of the project extension code that was in
// memory when a run executed: per-module entry hashes plus a versioned deterministic
// directory-tree fingerprint (dir_tree_v1). Core only defines and compares these shapes —
// identity is COMPUTED by the CLI (extension-identity.ts, pure fs+crypto) at module-load
// time, attached to the ExtensionRegistry, and appended to the run by the execution loop's
// lazy append-on-change site. Never a gate; advisory evidence only.

/** One loaded extension module's identity. */
export interface ExtensionIdentityModule {
  /** The authored path (workflow.yaml `extensions:` entry or the --extensions-module value). */
  declared: string;
  /** Absolute realpath-resolved module path that was imported. */
  resolved: string;
  /** sha256 hex of the entry module file's bytes at load time. */
  entry_hash: string;
  /** How the module was loaded. Descriptive metadata — not part of the drift comparison. */
  format: 'esm' | 'cjs' | 'ts-jiti';
}

/** Versioned deterministic directory-tree fingerprint over the module roots. */
export interface ExtensionIdentityTree {
  /** Deduped, sorted parent directories of the resolved entry modules. */
  roots: string[];
  /** The sweep rule string the fingerprint was computed under (governs recomputation). */
  rules: string;
  /** Number of files included in the fingerprint. */
  file_count: number;
  /** Total bytes of the included files. */
  total_bytes: number;
  /** sha256 hex over the sorted `relpath\0filehash` lines. */
  tree_hash: string;
  /** True when the sweep hit its caps — the fingerprint covers a deterministic prefix only. */
  truncated: boolean;
}

/** Labeled advisory signals — each independently fail-soft; never part of the comparison. */
export interface ExtensionIdentitySignals {
  /** `version` from the trust root's package.json, when readable. */
  package_version?: string;
  /** Commit hash from .git/HEAD (one ref-file dereference; no child processes), when readable. */
  git_head?: string;
}

/**
 * One point-in-time identity of the extension code executing a run. Appended to
 * `RunRecord.extension_identity` on change (history, newest last). The shape is
 * load-bearing evidence — never collapsible to a boolean.
 */
export interface ExtensionIdentityEntry {
  /** ISO timestamp of module-LOAD-time capture (what was in memory), not of the append. */
  captured_at: string;
  /** PID of the capturing process. */
  pid?: number;
  modules: ExtensionIdentityModule[];
  tree: ExtensionIdentityTree;
  signals?: ExtensionIdentitySignals;
  /** Coverage label of the sweep rules — never 'complete'. */
  coverage: 'dir_tree_v1';
  /**
   * Deployment-manifest identity: the manifest file's path and its raw-bytes sha256
   * (placeholders included — an edited binding IS drift; a rotated secret VALUE is not).
   * The manifest file never contributes a sweep root — only this content hash.
   */
  manifest?: {
    path: string;
    content_hash: string;
    /**
     * #729 PR-3 (D-12): sha256 of the canonical `secrets` block (its JSON with sorted keys) — what,
     * with the referenced secret names, decides the run's declared values. Absent on entries written
     * before this build (R28): those are judged by their recorded `secret_names` alone.
     */
    secrets_block_hash?: string;
  };
  /**
   * Secret NAMES referenced by the manifest at load time — never values or value hashes. A read
   * compares them (D-12): the run's declared part has changed when one is no longer referenced.
   */
  secret_names?: string[];
  /** Present when --extensions-module replaced the declared modules — omitting it would lie. */
  override_active?: true;
  /** Present when capture (or the extension load itself) failed — the failure is itself a record. */
  error?: string;
  /**
   * #729 PR-3 correction 5 (J-5, R48): `'start'` on the entry a program that loaded a project writes
   * when it CREATES the run, so a run that never executes a step still names its manifest. Absent
   * on every other entry — those an execution appends, and every entry written before this build.
   * Drift is judged from the other entries only.
   */
  origin?: 'start';
}

/**
 * #729 PR-3 correction 5 (J-5): the entry a creator writes at the run's creation — its loaded
 * registry's identity, marked `origin: 'start'` — or `undefined` when it loaded no project (S5:
 * none is made up). `captured_at` stays the load-time capture.
 */
export function startIdentityEntry(
  registry: { readonly identity?: ExtensionIdentityEntry | undefined } | undefined,
): ExtensionIdentityEntry | undefined {
  const identity = registry?.identity;
  return identity === undefined ? undefined : { ...identity, origin: 'start' };
}

/** J-5: the newest entry drift is judged from — the newest one that is not a start entry. */
export function lastExecutionIdentity(
  history: readonly ExtensionIdentityEntry[] | undefined,
): ExtensionIdentityEntry | undefined {
  if (history === undefined) return undefined;
  for (let i = history.length - 1; i >= 0; i--)
    if (history[i]!.origin !== 'start') return history[i];
  return undefined;
}

/**
 * Returns true when two identity entries denote DIFFERENT extension code:
 * tree_hash, the per-module entry hashes (as an ordered resolved→hash list), or the
 * override flag differ. Signals, timestamps, and pid are advisory — never compared.
 */
export function extensionIdentityDiffers(
  a: ExtensionIdentityEntry,
  b: ExtensionIdentityEntry,
): boolean {
  if (a.tree.tree_hash !== b.tree.tree_hash) return true;
  if (a.manifest?.content_hash !== b.manifest?.content_hash) return true;
  if ((a.override_active === true) !== (b.override_active === true)) return true;
  if (a.modules.length !== b.modules.length) return true;
  const key = (m: ExtensionIdentityModule): string => `${m.resolved}\u0000${m.entry_hash}`;
  const aModules = a.modules.map(key).sort();
  const bModules = b.modules.map(key).sort();
  return aModules.some((line, i) => line !== bModules[i]);
}
