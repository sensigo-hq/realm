// read-run-manifest.ts — #729 PR-3 (RECORD 05 "read-only"; prompt 03 L-4): what the read commands
// (`realm run inspect`, `attempts`, `export`, `diff`, `abandon`, and `realm agent --run-id`'s
// ended-run refusal; correction 4, I-11) know of a run's declared secrets, read
// WITHOUT the extensions loader: no project code runs. It reads `<trust_root>/realm.yaml` through
// core's `parseDeploymentManifest`, resolves its `${secret:NAME}` values from the sources it declares,
// and adds the value of the webhook trigger's `secret_from` (a declared secret, not only swept). It is
// shared with PR P's `inspectPriceSource` (the economics file the manifest names).
//
// The declared state and its cause (RECORD 01 #7; D3/07 R3-5):
// - an unreadable or invalid manifest, a secret that cannot be resolved, or no workflow copy and no
//   manifest named by the run's record → `unknown`, `load_failed`. H-7: when the copy cannot be read,
//   the manifest the record names is read all the same (its path is stored on the record since
//   v0.14.0), and its state is the read's;
// - the run's record names a manifest that is not found here, or one that no longer decides the
//   run's declared values as when the run recorded it (D-12: a secret name the run recorded is no
//   longer referenced, or the `secrets` block whose hash it recorded changed) → `partial`,
//   `manifest_changed` (the values found are still used);
// - the record names none, and the deployment root holds no `realm.yaml` → `resolved`, zero members;
// - the workflow copy records no deployment root (no project) and the record names none →
//   `unknown`, `no_manifest` (D3/05.7);
// - correction 5 (J-5, R41's marker), placed by correction 6 (C6-1): where nothing is declared now
//   and the record names no manifest — the root holds no `realm.yaml` (`resolved`, zero members, as
//   above) or the copy records no root (`unknown`, `no_manifest`, values shown) — a newest entry that
//   is the creator's start entry captured whole with no manifest makes it `resolved`, `no_manifest`
//   (the record proves none was declared at creation). It never shows more: what is declared NOW
//   hides wherever a manifest can be read, and where the copy cannot be read the values are withheld;
// - otherwise `resolved`.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  collectManifestSecretRefs,
  manifestSecretsBlockHash,
  parseDeploymentManifest,
  type DeclaredCause,
  type DeclaredState,
  type DeploymentManifest,
  type RunRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { resolveManifestSecrets } from '../extensions/manifest-secrets.js';

/** What a read command knows of a run's declared secrets. */
export interface RunManifest {
  declaredState: DeclaredState;
  declaredCause?: DeclaredCause;
  /** Declared secret values by name (never printed). */
  declared: Record<string, string>;
  /** The manifest's `disclosure.not_secret` names. */
  notSecret?: string[];
  /** The manifest as parsed, when one was read. */
  document?: DeploymentManifest;
  /** Where it was read from, when one was. */
  path?: string;
  /** Why it could not be used (a sentence with no value in it). */
  detail?: string;
  /** #729 PR-3 correction 4 (I-8): the run's workflow copy could not be read and its record names
   *  no manifest — there is none to restore; the copy is what to repair. */
  copy_unread?: true;
}

/** The manifest the run's latest identity entry recorded, if any, with that entry's secret names. */
function recordedManifest(run: RunRecord | undefined):
  | {
      path: string;
      content_hash: string;
      secrets_block_hash?: string;
      secret_names: readonly string[];
    }
  | undefined {
  const entries = run?.extension_identity ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const manifest = entries[i]?.manifest;
    if (manifest !== undefined)
      return { ...manifest, secret_names: entries[i]?.secret_names ?? [] };
  }
  return undefined;
}

/**
 * D-12 (F29): whether the manifest still decides the run's declared values as when the run recorded
 * it — every secret name the run recorded is still referenced (current ⊇ recorded), and, where the
 * run recorded the `secrets` block's hash, the block is unchanged. Any other edit to `realm.yaml`
 * (adding `disclosure:`, a new handler with its own secret) keeps it. An entry without the block hash
 * (every run made before this build) is judged by its names alone (R28).
 */
function declaredPartChanged(
  recorded: { secrets_block_hash?: string; secret_names: readonly string[] },
  document: DeploymentManifest,
): boolean {
  const current = new Set(collectManifestSecretRefs(document).map((r) => r.name));
  if (!recorded.secret_names.every((name) => current.has(name))) return true;
  return (
    recorded.secrets_block_hash !== undefined &&
    recorded.secrets_block_hash !== manifestSecretsBlockHash(document)
  );
}

/**
 * #729 PR-3 correction 6 (C6-1): the run's newest identity entry is its creator's START entry,
 * captured whole (no `error`), naming no manifest — the record proves no `realm.yaml` was declared
 * when the run was created. Read only where the root holds none now.
 */
function startEntryWithoutManifest(run: RunRecord | undefined): boolean {
  const newest = run?.extension_identity?.at(-1);
  return newest?.origin === 'start' && newest.manifest === undefined && newest.error === undefined;
}

/** The webhook trigger's secret, from the environment variable it names (declared, m9). */
function webhookSecret(
  definition: WorkflowDefinition,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const auth = definition.trigger?.auth;
  if (auth === undefined || auth.mode === 'none') return {};
  const value = env[auth.secret_from];
  return value === undefined || value === '' ? {} : { [`webhook:${auth.secret_from}`]: value };
}

/**
 * Reads what a read command needs of a run's deployment manifest. Never throws: a failure is its
 * state and cause.
 */
export async function readRunManifest(
  definition: WorkflowDefinition | undefined,
  run?: RunRecord,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<RunManifest> {
  // The manifest to read: the one the run's record names (its path and content hash), else the
  // deployment root's. H-7: the record's path is read even when the workflow copy cannot be.
  const recorded = recordedManifest(run);
  if (definition === undefined && recorded === undefined) {
    return {
      declaredState: 'unknown',
      declaredCause: 'load_failed',
      declared: {},
      detail: "the run's workflow copy could not be read",
      copy_unread: true,
    };
  }
  const webhook = definition !== undefined ? webhookSecret(definition, env) : {};
  const root = definition?.trust_root;
  const path = recorded?.path ?? (root !== undefined ? join(root, 'realm.yaml') : undefined);
  let bytes: Buffer | undefined;
  if (path !== undefined) {
    try {
      bytes = await readFile(path);
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (code !== 'ENOENT') {
        return {
          declaredState: 'unknown',
          declaredCause: 'load_failed',
          declared: webhook,
          path,
          detail: `cannot read '${path}': ${typeof code === 'string' ? code : String(err)}`,
        };
      }
    }
  }
  if (bytes === undefined) {
    // No manifest here: the record names one that is gone, or names none (zero members).
    return recorded !== undefined
      ? {
          declaredState: 'partial',
          declaredCause: 'manifest_changed',
          declared: webhook,
          path: recorded.path,
          detail: `the run's record names '${recorded.path}', which is not found here`,
        }
      : root === undefined
        ? // #729 PR-3 correction 6 (C6-1, MA 1's ruling): no project here — correction 4 shows the
          // values (a run with no project is not withheld); the creation proof only names the state.
          startEntryWithoutManifest(run)
          ? { declaredState: 'resolved', declaredCause: 'no_manifest', declared: webhook }
          : {
              declaredState: 'unknown',
              declaredCause: 'no_manifest',
              declared: webhook,
              detail: "the run's workflow copy records no deployment root",
            }
        : {
            declaredState: 'resolved',
            // #729 PR-3 correction 6 (C6-1): R41's marker — only the cause word, only here.
            ...(startEntryWithoutManifest(run) ? { declaredCause: 'no_manifest' as const } : {}),
            declared: webhook,
          };
  }
  const text = bytes.toString('utf8');
  const parsed = parseDeploymentManifest(text);
  if ('error' in parsed) {
    return {
      declaredState: 'unknown',
      declaredCause: 'load_failed',
      declared: webhook,
      path: path!,
      detail:
        parsed.error.kind === 'yaml'
          ? `'${path}' is not valid YAML`
          : `'${path}' is invalid: ${parsed.error.errors[0] ?? 'invalid'}`,
    };
  }
  const document = parsed.document;
  let values: Record<string, string>;
  try {
    const refs = collectManifestSecretRefs(document);
    values = resolveManifestSecrets(refs, document.secrets, dirname(path!), 'real').values;
  } catch {
    return {
      declaredState: 'unknown',
      declaredCause: 'load_failed',
      declared: webhook,
      document,
      path: path!,
      detail: `a secret '${path}' names could not be resolved`,
    };
  }
  const changed = recorded !== undefined && declaredPartChanged(recorded, document);
  return {
    declaredState: changed ? 'partial' : 'resolved',
    ...(changed ? { declaredCause: 'manifest_changed' as const } : {}),
    declared: { ...values, ...webhook },
    ...(document.disclosure?.not_secret !== undefined
      ? { notSecret: document.disclosure.not_secret }
      : {}),
    document,
    path: path!,
    ...(changed ? { detail: `'${path}' changed since the run recorded it` } : {}),
  };
}
