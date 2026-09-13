// The ONE admission path (issue #553): what `validate` blesses, `register` accepts, and what
// `register` refuses, `validate` refuses — by construction, because both (and `watch`) call
// this function and nothing else. Relocated from register.ts, where validate could not import
// it without a cycle.
import {
  loadWorkflowFromFileWithDiagnostics,
  type WorkflowDefinition,
  type LoaderWarning,
} from '@sensigo/realm';
import {
  loadProjectExtensions,
  type LoadedProjectExtensions,
} from '../extensions/load-project-extensions.js';
import { ManifestSecretsError } from '../extensions/manifest-secrets.js';
import { wrapSentinelWarnings } from './loader-warnings.js';

/**
 * Tags a failure thrown by the extensions load inside `loadWorkflowForAdmission` so the
 * callers' catches can say `Error loading extensions:` — the sentence run and validate already
 * print for this class (issue #451) — without guessing from the message. The message is the
 * original's, byte for byte (register-extensions.test.ts's broken-module cell matches on it
 * THROUGH this wrapper), and the original rides along as `cause`.
 *
 * Minted at exactly the two throw paths out of the extensions block: the real-mode load's
 * non-secrets failure, and the sentinel retry. The retry can never throw ManifestSecretsError
 * itself (sentinel mode resolves every name without reading a source), so nothing is wrapped
 * twice. A WorkflowError from the two-pass re-validation is thrown OUTSIDE the block and keeps
 * the family split.
 *
 * Carries the workflow's own pass-1 loader warnings (issue #463 — the #424 carry shape on this
 * vehicle) so the catch that renders the sentence can print them FIRST, instead of the author
 * fixing the module, re-running, and only then learning about the typo. ABSENT, never `[]`: a
 * construction that passes no warnings, or an empty list, leaves the field unset.
 *
 * Carries the pass-1 definition too (issue #553): validate's `--json` names `workflow_id` on
 * this arm and computes the retry advisory from the definition before printing the sentence.
 *
 * @internal Exported for register.ts, watch.ts, validate.ts and for tests.
 */
export class ExtensionLoadError extends Error {
  readonly warnings?: readonly LoaderWarning[];
  readonly definition?: WorkflowDefinition;

  constructor(
    original: unknown,
    warnings?: readonly LoaderWarning[],
    definition?: WorkflowDefinition,
  ) {
    super(original instanceof Error ? original.message : String(original), { cause: original });
    this.name = 'ExtensionLoadError';
    // The if-guard form on purpose: a ternary to `undefined` is a TS2412 under the repo's
    // exactOptionalPropertyTypes (lane-executed, #463).
    if (warnings !== undefined && warnings.length > 0) this.warnings = [...warnings];
    if (definition !== undefined) this.definition = definition;
  }
}

/**
 * The pass-1 definition of a workflow whose pass-2 (config_schema) re-validation threw. The
 * thrown WorkflowError is register's and watch's to render exactly as before — its identity,
 * message and family are untouched — so the definition rides beside it rather than on it.
 * validate's `--json` reads it back for `workflow_id` (issue #553, audit round 2 Q9).
 */
const admittedDefinitions = new WeakMap<object, WorkflowDefinition>();

/** @internal Exported for validate.ts. */
export function admittedDefinitionOf(err: unknown): WorkflowDefinition | undefined {
  return typeof err === 'object' && err !== null ? admittedDefinitions.get(err) : undefined;
}

/**
 * Loads and validates a workflow for admission — register, watch and validate all take exactly
 * this path (issue #553). The file loader (agent-profile resolution included), then the
 * UNCONDITIONAL project-extensions load (modules, manifest, config_schema two-pass), degrading
 * to SENTINEL credentials with a loud WARN when a secret source is unavailable.
 * Returns the definition alongside every accumulated LoaderWarning (issue #169) — pass-1's
 * structural warnings plus the sentinel-credential warnings, if any — and the resolved manifest
 * (validate's `Extensions:` line reports its counts). Prints NOTHING itself beyond the two
 * sentinel ⚠ lines; every caller decides how to surface/act on warnings (register supports
 * `--strict` + the dormant #170 reject; watch just prints and continues; validate reports).
 * `overrideModule` is `--extensions-module`: it must travel into BOTH loads or the repair flag
 * dies in its own scenario (the #353/#466 flag-travel class).
 * @throws on any validation or extension-load failure — nothing is persisted on throw.
 *         Extension-load failures are tagged `ExtensionLoadError` (issue #451).
 */
export async function loadWorkflowForAdmission(
  filePath: string,
  opts: { overrideModule?: string; surface: 'register' | 'watch' | 'validate' },
): Promise<{
  definition: WorkflowDefinition;
  warnings: LoaderWarning[];
  manifest: LoadedProjectExtensions['manifest'];
}> {
  const { definition, warnings: pass1Warnings } = loadWorkflowFromFileWithDiagnostics(filePath);
  const override = opts.overrideModule !== undefined ? { overrideModule: opts.overrideModule } : {};
  // Full module load + duck validation + manifest construction + config_schema two-pass
  // BEFORE persisting. Secret sources may be unavailable at provisioning time: degrade to
  // SENTINEL construction with a loud WARN (never silent, never a registration blocker);
  // execution paths still require real resolution.
  let loaded: LoadedProjectExtensions;
  try {
    loaded = await loadProjectExtensions(definition, { ...override });
  } catch (err) {
    // The guard is the degradation itself: only a secrets failure degrades, everything else is an
    // extension-load failure and leaves tagged (issue #451). Dropping the conditional kills
    // degradation — register-extensions.test.ts's sentinel control is the cell in this command's
    // own home that sees it (the manifest E2E in extensions/ does too, one substring deep).
    if (!(err instanceof ManifestSecretsError)) {
      throw new ExtensionLoadError(err, pass1Warnings, definition);
    }
    console.warn(`⚠ ${err.message}`);
    // Surface-keyed (issue #553): validate registers nothing, so "Registering" there is a false
    // claim; register and watch keep their text byte for byte.
    console.warn(
      `⚠ ${opts.surface === 'validate' ? 'Validating' : 'Registering'} with SENTINEL credentials — execution paths still require real secret resolution.`,
    );
    try {
      loaded = await loadProjectExtensions(definition, { ...override, secretMode: 'sentinel' });
    } catch (err) {
      throw new ExtensionLoadError(err, pass1Warnings, definition);
    }
  }
  // Two-pass: re-validate with the resolved registry so step config is checked against
  // each adapter's config_schema before the definition is persisted. Its warnings are proven
  // identical to pass-1's (same content, registry only adds config_schema checks) — discarded
  // here to avoid double-counting the same unknown key twice.
  try {
    loadWorkflowFromFileWithDiagnostics(filePath, loaded.registry);
  } catch (err) {
    if (typeof err === 'object' && err !== null) admittedDefinitions.set(err, definition);
    throw err;
  }

  return {
    definition,
    warnings: [...pass1Warnings, ...wrapSentinelWarnings(loaded.sentinelWarnings)],
    manifest: loaded.manifest,
  };
}
