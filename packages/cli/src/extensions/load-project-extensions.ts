// load-project-extensions.ts — the ONE project loader: workflow-declared extension CODE
// modules (#117) plus the deployment MANIFEST (`<deployment root>/realm.yaml`, v0.14) that
// owns ALL deployment configuration — adapter construction (built-in catalog + custom
// factories), handler/processor construction config, secret bindings, gate-notifier config.
//
// Every step-executing or config-validating CLI entry point (run, agent, listen, serve,
// mcp, test, validate, register, watch) resolves through this function. Core validates
// SHAPES and stores PATHS only — fs, dynamic import, secret resolution, and construction
// live here, in the CLI composition layer.
//
// Anchor mechanics (v6 §1): definitions WITH trust_root → manifest at
// `<trust_root>/realm.yaml`, loaded iff present (absent = defaults only; no walking).
// Definitions WITHOUT trust_root (agent-origin, from-string) → the DAEMON's deployment
// root via `--project` (default cwd for serve/agent/run ONLY; `realm mcp` has NO default —
// its stdio cwd is CLIENT-controlled, a recorded security decision).
//
// Trust model: manifest-write = credential-redirection = code-write-equivalent. Extension
// module paths and manifest `use:` refs originate ONLY from operator-registered definitions,
// the operator's deployment root, or operator-typed flags — never from request data.
import { createRequire } from 'node:module';
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import {
  createDefaultRegistry,
  ExtensionRegistry,
  validateDeploymentManifest,
  collectManifestSecretRefs,
  interpolateConfigTree,
  findSecretRefSites,
  VERSION,
  GitHubAdapter,
  SlackAdapter,
  GenericHttpAdapter,
  AirtableAdapter,
  GorgiasAdapter,
  ShopifyAdapter,
  NotionAdapter,
  ParcelPanelAdapter,
  FileSystemAdapter,
  MockAdapter,
} from '@sensigo/realm';
import type {
  DeploymentManifest,
  ExtensionFactory,
  ExtensionManifest,
  ExtensionModuleRef,
  ManifestEntry,
  SlackGateNotifierConfig,
  WorkflowDefinition,
} from '@sensigo/realm';
import {
  computeExtensionIdentity,
  errorExtensionIdentityEntry,
  sha256HexOf,
} from './extension-identity.js';
import { resolveManifestSecrets, redactSecretValues, type SecretMode } from './manifest-secrets.js';

export interface LoadProjectExtensionsOptions {
  /**
   * Operator-typed module path that REPLACES the workflow's declared extension CODE
   * modules (repair/override tool). Containment does not apply to an operator-typed path.
   * The deployment manifest (config) still loads — `--project` is the manifest override.
   */
  overrideModule?: string;
  /**
   * The daemon's deployment root (`--project <dir>`), used for definitions WITHOUT
   * trust_root. Absent → no manifest for such definitions (defaults only).
   */
  projectDir?: string;
  /**
   * 'real' (default): secrets resolve from the declared sources — any miss is a loud
   * aggregated error, construction failures are errors (fail-before-create).
   * 'sentinel' (validate/test; register/watch degrade-with-WARN): `${secret:}` refs
   * resolve to `<sentinel:NAME>` labels and construction failures downgrade to warnings.
   */
  secretMode?: SecretMode;
}

export interface LoadedProjectExtensions {
  registry: ExtensionRegistry;
  manifest: ExtensionManifest;
  /** Secret-resolved notifier configs from the deployment manifest, when declared. */
  notifiers?: { slack_gate?: SlackGateNotifierConfig['config'] };
  /** Sentinel-mode construction warnings (entries skipped, listed — never silent). */
  sentinelWarnings?: string[];
  /**
   * REAL resolved manifest-secret VALUES (values only, frozen, never names→values;
   * sentinel-mode values excluded; values < 4 chars excluded). Consumed by the agent
   * redaction pass — must never ride any persisted or serialized structure.
   */
  secretValues?: readonly string[];
}

/** Registration surfaces of a declarative extension module, keyed by export map name. */
const EXTENSION_SURFACES = [
  { mapKey: 'adapters', type: 'adapter', probeMembers: ['fetch', 'create', 'update'] },
  { mapKey: 'handlers', type: 'handler', probeMembers: ['execute'] },
  { mapKey: 'processors', type: 'processor', probeMembers: ['process'] },
] as const;

const PROBE_MEMBERS: Record<'adapter' | 'handler' | 'processor', readonly string[]> = {
  adapter: ['fetch', 'create', 'update'],
  handler: ['execute'],
  processor: ['process'],
};

/**
 * The built-in adapter catalog: name → factory wrapping the constructor. The factory
 * contract is the ONE construction shape: `({ id, config }) => instance`.
 * `filesystem` and `mock` are config-less — declaring `config:` for them is an ERROR.
 */
const BUILTIN_ADAPTER_CATALOG: Record<string, { factory: ExtensionFactory; configless?: boolean }> =
  {
    github: { factory: ({ id, config }) => new GitHubAdapter(id, config as never) },
    slack: { factory: ({ id, config }) => new SlackAdapter(id, config as never) },
    http: { factory: ({ id, config }) => new GenericHttpAdapter(id, config as never) },
    airtable: { factory: ({ id, config }) => new AirtableAdapter(id, config as never) },
    gorgias: { factory: ({ id, config }) => new GorgiasAdapter(id, config as never) },
    shopify: { factory: ({ id, config }) => new ShopifyAdapter(id, config as never) },
    notion: { factory: ({ id, config }) => new NotionAdapter(id, config as never) },
    parcelpanel: { factory: ({ id, config }) => new ParcelPanelAdapter(id, config as never) },
    filesystem: { factory: ({ id }) => new FileSystemAdapter(id), configless: true },
    mock: { factory: ({ id }) => new MockAdapter(id, {}), configless: true },
  };

const DEFAULT_REGISTRY_CACHE_KEY = '\u0000default-registry\u0000';

interface CacheEntry {
  result: LoadedProjectExtensions;
  /**
   * Memory-only freshness hash = sha256(manifest bytes ‖ dotenv bytes), re-checked per
   * load: a mismatch rebuilds-and-REPLACES the entry (dotenv rotation reaches the next
   * run without a restart; the rebuild resets rate-limiter buckets). NEVER recorded in
   * drift evidence. Module CODE stays restart-required (ESM cache). undefined = no
   * manifest (module-only entries never rebuild). Concurrent rebuilds race benignly
   * (last-wins).
   */
  freshness?: string;
}

const cache = new Map<string, CacheEntry>();

/** @internal Test-only: clears the process-lifetime registry cache. */
export function clearProjectExtensionsCache(): void {
  cache.clear();
}

function emptyManifest(): ExtensionManifest {
  return { modules: [], adapters: [], handlers: [], processors: [] };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function realpathOrFail(path: string, what: string): string {
  try {
    return realpathSync(path);
  } catch (err) {
    throw new Error(`Cannot resolve ${what}: ${errMsg(err)}`);
  }
}

/** True when `child` is `root` or lives underneath it (both must be realpaths). */
function isContainedIn(child: string, root: string): boolean {
  return child === root || child.startsWith(root + sep);
}

function normalizeDeclared(extensions: string | string[] | undefined): string[] | undefined {
  if (extensions === undefined) return undefined;
  return typeof extensions === 'string' ? [extensions] : extensions;
}

interface ManifestContext {
  document: DeploymentManifest;
  path: string;
  realPath: string;
  dir: string;
  rootReal: string;
  bytes: Buffer;
  contentHash: string;
  dotenvBytes: Buffer;
}

/**
 * Orphaned-manifest guard (#123): throws when a `realm.yaml` sits anywhere in the span
 * `[source_dir, trust_root)` — from the workflow directory walking UP to, but NOT
 * including, the resolved trust_root. Such a manifest is silently ignored by the
 * strict-single-location loader, so surfacing it loudly before run creation turns a
 * confusing downstream `adapter 'X' not registered` (or total silence under
 * validate/sentinel/fixture paths) into an actionable placement error.
 *
 * No-op unless the definition carries BOTH `source_dir` and `trust_root` and they differ
 * (agent-origin / from-string definitions have no source_dir; a workflow dir that is its
 * own trust_root has an empty span). Never scans at or above trust_root — a stray at
 * trust_root IS the loaded manifest; Case C (above trust_root) is deliberately out of #123.
 */
function checkForOrphanedManifests(definition: WorkflowDefinition, root: string): void {
  const sourceDir = definition.source_dir;
  const trustRoot = definition.trust_root;
  // Only meaningful for file-loaded definitions whose trust_root is the resolved root.
  if (sourceDir === undefined || trustRoot === undefined || trustRoot !== root) return;
  if (sourceDir === trustRoot) return;

  const orphans: string[] = [];
  let current = sourceDir;
  // Walk [source_dir, trust_root): stop BEFORE trust_root; guard against a source_dir that
  // is not actually under trust_root (never terminates otherwise).
  while (current !== trustRoot) {
    const candidate = join(current, 'realm.yaml');
    if (existsSync(candidate)) orphans.push(candidate);
    const parent = dirname(current);
    if (parent === current) break; // hit the filesystem root without meeting trust_root
    current = parent;
  }

  if (orphans.length === 0) return;
  const found =
    orphans.length === 1
      ? `Deployment manifest at '${orphans[0]!}'`
      : `Deployment manifests at ${orphans.map((o) => `'${o}'`).join(', ')}`;
  const nearest = orphans[0]!;
  throw new Error(
    `${found} will NOT be loaded — manifests are read only from the deployment root ` +
      `'${join(trustRoot, 'realm.yaml')}'. Move it to '${join(trustRoot, 'realm.yaml')}' ` +
      `(the nearest package.json/.git ancestor of the workflow), or add a package.json/.git ` +
      `at '${dirname(nearest)}' to make that the deployment root.`,
  );
}

/**
 * Resolves the deployment root and loads+validates the manifest document when present.
 * Definitions WITH trust_root anchor there; definitions WITHOUT it anchor at the daemon's
 * `--project` root (absent → no manifest, defaults only — NO walking, NO error).
 */
function loadManifestContext(
  definition: WorkflowDefinition,
  projectDir: string | undefined,
): ManifestContext | undefined {
  const root = definition.trust_root ?? projectDir;
  if (root === undefined) return undefined;

  // Orphaned-manifest guard (#123): manifests load ONLY from <trust_root>/realm.yaml.
  // A realm.yaml placed anywhere in the span [source_dir, trust_root) — the workflow dir
  // or an intermediate dir below the resolved trust_root — is silently ignored, which is
  // the common misplacement (workflow in a repo subdir whose package.json/.git is an
  // ancestor). Detect it and fail loud BEFORE loading, consistent with the invalid-YAML /
  // schema-error throws below. Runs before the trust_root load: a correctly-placed
  // manifest does NOT excuse a stray one below it (the stray is still ignored, still
  // operator error). Detection-only — LOADING semantics stay strict-single-location.
  // Case C (realm.yaml ABOVE trust_root) is deliberately NOT scanned (see #123).
  checkForOrphanedManifests(definition, root);

  const manifestPath = join(root, 'realm.yaml');
  let bytes: Buffer;
  try {
    bytes = readFileSync(manifestPath);
  } catch {
    return undefined; // absent manifest = defaults only, valid for config-free projects
  }
  let raw: unknown;
  try {
    raw = loadYaml(bytes.toString('utf8'));
  } catch (err) {
    throw new Error(`Deployment manifest '${manifestPath}' is not valid YAML: ${errMsg(err)}`);
  }
  const errors = validateDeploymentManifest(raw);
  if (errors.length > 0) {
    throw new Error(`Deployment manifest '${manifestPath}' is invalid:\n  ${errors.join('\n  ')}`);
  }
  const document = raw as DeploymentManifest;

  // dotenv bytes participate in the freshness hash ONLY (rotation detection) — never in
  // drift evidence.
  const dotenvPath = join(dirname(manifestPath), document.secrets?.dotenv ?? '.env');
  let dotenvBytes: Buffer;
  try {
    dotenvBytes = readFileSync(dotenvPath);
  } catch {
    dotenvBytes = Buffer.alloc(0);
  }

  return {
    document,
    path: manifestPath,
    realPath: realpathOrFail(manifestPath, `deployment manifest '${manifestPath}'`),
    dir: dirname(manifestPath),
    rootReal: realpathOrFail(root, `deployment root '${root}'`),
    bytes,
    contentHash: sha256HexOf(bytes),
    dotenvBytes,
  };
}

/** `use:` disambiguation — contains `/` or a module file extension → module ref. */
function isModuleRef(use: string): boolean {
  const beforeHash = use.split('#')[0]!;
  return beforeHash.includes('/') || /\.(js|mjs|cjs|ts|mts|cts)$/.test(beforeHash);
}

/**
 * Loads the project extensions and deployment configuration for a definition:
 * workflow-declared CODE modules + the deployment manifest's constructed instances,
 * one registry, one namespace, one collision map. No extensions, no manifest → the
 * process-stable filesystem-only default registry.
 *
 * CONTRACT: returned registries are shared process-lifetime cache entries. The only
 * permitted mutation is `getOrCreateRateLimiter` (serve bucket persistence, by design).
 */
export async function loadProjectExtensions(
  definition: WorkflowDefinition,
  opts?: LoadProjectExtensionsOptions,
): Promise<LoadedProjectExtensions> {
  const secretMode: SecretMode = opts?.secretMode ?? 'real';
  const moduleRefs = resolveModuleRefs(definition, opts?.overrideModule);
  const manifestCtx = loadManifestContext(definition, opts?.projectDir);

  if (moduleRefs === undefined && manifestCtx === undefined) {
    // Extension-free, manifest-free fallback: process-stable default registry.
    let entry = cache.get(DEFAULT_REGISTRY_CACHE_KEY);
    if (entry === undefined) {
      entry = { result: { registry: createDefaultRegistry(), manifest: emptyManifest() } };
      cache.set(DEFAULT_REGISTRY_CACHE_KEY, entry);
    }
    return entry.result;
  }

  // Resolve manifest `use:` module refs up front — they are part of the cache key.
  const useModuleRefs =
    manifestCtx !== undefined ? resolveUseModuleRefs(manifestCtx) : new Map<string, string>();

  const cacheKey = [
    `mode:${secretMode}`,
    `manifest:${manifestCtx?.realPath ?? '\u0000none'}`,
    `root:${manifestCtx?.rootReal ?? '\u0000none'}`,
    ...(moduleRefs ?? []).map((m) => `ext:${m.resolved}`),
    ...[...useModuleRefs.values()].sort().map((p) => `use:${p}`),
  ].join('\n');

  const freshness =
    manifestCtx !== undefined
      ? sha256HexOf(
          Buffer.concat([manifestCtx.bytes, Buffer.from('\u0000'), manifestCtx.dotenvBytes]),
        )
      : undefined;

  const cached = cache.get(cacheKey);
  if (cached !== undefined && cached.freshness === freshness) return cached.result;
  // freshness mismatch → rebuild-and-REPLACE (dotenv rotation / manifest edit reaches
  // the next run without restart; rate-limiter buckets reset with the new registry).

  const registry = createDefaultRegistry();
  const builtinNames = {
    adapter: new Set(registry.names('adapter')),
    handler: new Set(registry.names('handler')),
    processor: new Set(registry.names('processor')),
  };
  const claimedBy = new Map<string, string>();
  const manifest: ExtensionManifest = {
    modules: moduleRefs ?? [],
    adapters: [],
    handlers: [],
    processors: [],
  };

  const moduleFormats = new Map<string, 'esm' | 'cjs' | 'ts-jiti'>();
  for (const ref of moduleRefs ?? []) {
    const { namespace, format } = await importModuleNamespace(ref.resolved, ref.declared);
    moduleFormats.set(ref.resolved, format);
    applyModule(
      defaultExportOf(namespace, ref.declared),
      ref,
      registry,
      builtinNames,
      claimedBy,
      manifest,
    );
  }

  const sentinelWarnings: string[] = [];
  let notifiers: LoadedProjectExtensions['notifiers'];
  let secretValues: readonly string[] | undefined;
  const identityModules: Array<{
    declared: string;
    resolved: string;
    format: 'esm' | 'cjs' | 'ts-jiti';
  }> = (moduleRefs ?? []).map((ref) => ({
    declared: ref.declared,
    resolved: ref.resolved,
    format: moduleFormats.get(ref.resolved) ?? 'esm',
  }));
  let secretNames: string[] = [];

  if (manifestCtx !== undefined) {
    const applied = await applyDeploymentManifest(
      manifestCtx,
      useModuleRefs,
      registry,
      builtinNames,
      claimedBy,
      manifest,
      secretMode,
      sentinelWarnings,
    );
    notifiers = applied.notifiers;
    secretNames = applied.secretNames;
    secretValues = applied.secretValues;
    for (const [use, real] of useModuleRefs) {
      identityModules.push({
        declared: use,
        resolved: real,
        format: moduleFormats.get(real) ?? applied.useFormats.get(real) ?? 'esm',
      });
    }
  }

  // Drift evidence: identity captured ONCE per cache entry at module-LOAD time. The
  // manifest contributes its content hash (never a sweep root); `use:`-resolved module
  // FILES contribute sweep roots exactly like extension-list modules; secret NAMES are
  // recorded, never compared; the freshness hash is NEVER recorded.
  const overrideActive = opts?.overrideModule !== undefined;
  try {
    registry.setIdentity(
      computeExtensionIdentity(identityModules, {
        ...(definition.trust_root !== undefined ? { trustRoot: definition.trust_root } : {}),
        ...(overrideActive ? { overrideActive: true } : {}),
        ...(manifestCtx !== undefined
          ? { manifest: { path: manifestCtx.path, content_hash: manifestCtx.contentHash } }
          : {}),
        secretNames,
      }),
    );
  } catch (err) {
    console.error(
      `[realm] extension identity capture failed: ${errMsg(err)} — drift evidence will carry an error entry for this load.`,
    );
    registry.setIdentity(
      errorExtensionIdentityEntry(
        `identity capture failed: ${errMsg(err)}`,
        overrideActive ? { overrideActive: true } : {},
      ),
    );
  }

  const result: LoadedProjectExtensions = {
    registry,
    manifest,
    ...(notifiers !== undefined ? { notifiers } : {}),
    ...(sentinelWarnings.length > 0 ? { sentinelWarnings } : {}),
    ...(secretValues !== undefined && secretValues.length > 0 ? { secretValues } : {}),
  };
  cache.set(cacheKey, { result, ...(freshness !== undefined ? { freshness } : {}) });
  return result;
}

/** Resolves every manifest `use:` module ref (realpathed + containment-checked). */
function resolveUseModuleRefs(ctx: ManifestContext): Map<string, string> {
  const resolvedRefs = new Map<string, string>();
  const sections: Array<Record<string, ManifestEntry> | undefined> = [
    ctx.document.adapters,
    ctx.document.handlers,
    ctx.document.processors,
  ];
  for (const section of sections) {
    for (const entry of Object.values(section ?? {})) {
      if (entry.use === undefined || !isModuleRef(entry.use)) continue;
      const modulePath = entry.use.split('#')[0]!;
      if (resolvedRefs.has(entry.use)) continue;
      const resolved = resolve(ctx.dir, modulePath);
      const real = realpathOrFail(
        resolved,
        `manifest module '${modulePath}' (from '${ctx.path}', resolved: ${resolved})`,
      );
      if (!isContainedIn(real, ctx.rootReal)) {
        throw new Error(
          `Deployment manifest module '${modulePath}' resolves to '${real}', which is OUTSIDE ` +
            `the deployment root '${ctx.rootReal}'. Manifest 'use:' modules must live within ` +
            `the deployment root — move the module inside it, or fix the reference in '${ctx.path}'.`,
        );
      }
      resolvedRefs.set(entry.use, real);
    }
  }
  return resolvedRefs;
}

/** Parses/constructs/registers everything the manifest declares. */
async function applyDeploymentManifest(
  ctx: ManifestContext,
  useModuleRefs: Map<string, string>,
  registry: ExtensionRegistry,
  builtinNames: Record<'adapter' | 'handler' | 'processor', Set<string>>,
  claimedBy: Map<string, string>,
  manifest: ExtensionManifest,
  secretMode: SecretMode,
  sentinelWarnings: string[],
): Promise<{
  notifiers?: LoadedProjectExtensions['notifiers'];
  secretNames: string[];
  secretValues: readonly string[];
  useFormats: Map<string, 'esm' | 'cjs' | 'ts-jiti'>;
}> {
  const refs = collectManifestSecretRefs(ctx.document);
  const resolved = resolveManifestSecrets(refs, ctx.document.secrets, ctx.dir, secretMode);
  const resolveName = (name: string): string => resolved.values[name] ?? '';
  const secretValues = Object.values(resolved.values);
  const useFormats = new Map<string, 'esm' | 'cjs' | 'ts-jiti'>();
  const secretBearingHandlers: string[] = [];
  const secretBearingProcessors: string[] = [];

  const sections = [
    { key: 'adapters' as const, type: 'adapter' as const },
    { key: 'handlers' as const, type: 'handler' as const },
    { key: 'processors' as const, type: 'processor' as const },
  ];

  for (const section of sections) {
    for (const [name, entry] of Object.entries(ctx.document[section.key] ?? {})) {
      const site = `${section.key}.${name}`;
      if (entry.use === undefined) {
        throw new Error(
          `Deployment manifest '${ctx.path}': ${site} needs 'use:' — a catalog name ` +
            `(adapters) or a module reference './path.js#Export'.`,
        );
      }

      const factory = await resolveEntryFactory(
        ctx,
        useModuleRefs,
        useFormats,
        section.type,
        name,
        entry,
        site,
      );

      const hasRefs = findSecretRefSites(entry.config, site).sites.length > 0;
      if (section.type === 'handler' && hasRefs) secretBearingHandlers.push(name);
      if (section.type === 'processor' && hasRefs) secretBearingProcessors.push(name);

      const config = interpolateConfigTree(entry.config ?? {}, resolveName);

      let instance: unknown;
      try {
        instance = factory({ id: name, config });
      } catch (err) {
        const redacted = redactSecretValues(
          `Deployment manifest '${ctx.path}': constructing ${site} (use: ${entry.use}) failed: ${errMsg(err)}`,
          secretValues,
        );
        if (secretMode === 'sentinel') {
          // Sentinel degrade: warn-and-skip — never a hard failure, never silent.
          sentinelWarnings.push(`${redacted} (sentinel mode — entry skipped)`);
          continue;
        }
        throw new Error(redacted);
      }

      probeShape(instance, section.type, PROBE_MEMBERS[section.type], name, {
        declared: `${ctx.path}#${site}`,
        resolved: ctx.realPath,
      });

      const claimKey = `${section.type}:${name}`;
      const previousClaim = claimedBy.get(claimKey);
      if (previousClaim !== undefined) {
        throw new Error(
          `Extension ${section.type} '${name}' is declared by both '${previousClaim}' and the ` +
            `deployment manifest '${ctx.path}' — manifest entries and code-module exports ` +
            `share one namespace; names must be unique.`,
        );
      }
      claimedBy.set(claimKey, `manifest ${ctx.path}`);
      if (builtinNames[section.type].has(name)) {
        console.warn(
          `[realm] manifest ${section.type} '${name}' overrides the built-in ${section.type} '${name}'.`,
        );
      }
      registry.register(section.type as 'adapter', name, instance as never);
      manifest[section.key].push(name);
    }
  }

  if (secretBearingHandlers.length > 0) manifest.secret_bearing_handlers = secretBearingHandlers;
  if (secretBearingProcessors.length > 0)
    manifest.secret_bearing_processors = secretBearingProcessors;

  let notifiers: LoadedProjectExtensions['notifiers'];
  const slackGate = ctx.document.notifiers?.slack_gate;
  if (slackGate !== undefined) {
    notifiers = {
      slack_gate: interpolateConfigTree(slackGate.config, resolveName),
    };
  }

  return {
    ...(notifiers !== undefined ? { notifiers } : {}),
    secretNames: [...new Set(refs.map((r) => r.name))].sort(),
    // Values-only, frozen, real-mode only: the agent redaction feed. Never persisted.
    secretValues: resolved.sentinel
      ? Object.freeze([])
      : Object.freeze([...new Set(Object.values(resolved.values))].filter((v) => v.length >= 4)),
    useFormats,
  };
}

/** Resolves an entry's factory: catalog name (adapters only) or module ref `#Export`. */
async function resolveEntryFactory(
  ctx: ManifestContext,
  useModuleRefs: Map<string, string>,
  useFormats: Map<string, 'esm' | 'cjs' | 'ts-jiti'>,
  type: 'adapter' | 'handler' | 'processor',
  name: string,
  entry: ManifestEntry,
  site: string,
): Promise<ExtensionFactory> {
  const use = entry.use!;
  if (!isModuleRef(use)) {
    if (type !== 'adapter') {
      throw new Error(
        `Deployment manifest '${ctx.path}': ${site} — there is no built-in catalog for ` +
          `${type}s; use a module reference './path.js#ExportName'.`,
      );
    }
    const catalogEntry = BUILTIN_ADAPTER_CATALOG[use];
    if (catalogEntry === undefined) {
      throw new Error(
        `Deployment manifest '${ctx.path}': ${site} — unknown catalog adapter '${use}'. ` +
          `Valid catalog names (realm v${VERSION}): ${Object.keys(BUILTIN_ADAPTER_CATALOG).join(', ')}. ` +
          `For a custom adapter use a module reference './path.js#ExportName'.`,
      );
    }
    if (catalogEntry.configless === true && entry.config !== undefined) {
      throw new Error(
        `Deployment manifest '${ctx.path}': ${site} — catalog adapter '${use}' takes no ` +
          `config; remove the 'config:' block.`,
      );
    }
    return catalogEntry.factory;
  }

  const [modulePath, exportName] = use.split('#') as [string, string | undefined];
  const real = useModuleRefs.get(use) ?? useModuleRefs.get(modulePath);
  if (real === undefined) {
    throw new Error(`Deployment manifest '${ctx.path}': ${site} — unresolved module '${use}'.`);
  }
  const { namespace, format } = await importModuleNamespace(real, `${ctx.path}#${site}`);
  useFormats.set(real, format);

  const candidate = pickExport(namespace, exportName, use, ctx.path, site);
  if (typeof candidate !== 'function') {
    throw new Error(
      `Deployment manifest '${ctx.path}': ${site} — '${use}' must export a FACTORY ` +
        `(ctx: { id, config }) => instance; got ${typeof candidate}.`,
    );
  }
  return candidate as ExtensionFactory;
}

/** Picks the named (or default) export, naming the available exports on a miss. */
function pickExport(
  namespace: Record<string, unknown>,
  exportName: string | undefined,
  use: string,
  manifestPath: string,
  site: string,
): unknown {
  const unwrapped = unwrapCjsNamespace(namespace);
  const wanted = exportName ?? 'default';
  const candidate = unwrapped[wanted];
  if (candidate !== undefined) return candidate;
  const available = Object.keys(unwrapped).filter((k) => k !== '__esModule');
  throw new Error(
    `Deployment manifest '${manifestPath}': ${site} — module '${use}' has no ` +
      `${exportName !== undefined ? `export '${exportName}'` : 'default export'}. ` +
      `Available exports: ${available.length > 0 ? available.join(', ') : '(none)'}.`,
  );
}

/** Flattens the tsc-CJS `{ default: { __esModule, ...exports } }` interop wrapper. */
function unwrapCjsNamespace(namespace: Record<string, unknown>): Record<string, unknown> {
  const def = namespace['default'];
  if (
    typeof def === 'object' &&
    def !== null &&
    (def as Record<string, unknown>)['__esModule'] === true
  ) {
    return { ...namespace, ...(def as Record<string, unknown>) };
  }
  return namespace;
}

/**
 * Resolves the list of extension CODE modules. Returns undefined when none are declared.
 * Enforces the trust model: agent-origin refusal, re-register guidance when resolution
 * metadata is missing, and realpath containment within trust_root.
 */
function resolveModuleRefs(
  definition: WorkflowDefinition,
  overrideModule: string | undefined,
): ExtensionModuleRef[] | undefined {
  if (overrideModule !== undefined) {
    const resolved = resolve(overrideModule);
    const real = realpathOrFail(resolved, `--extensions-module '${overrideModule}'`);
    // Loud by design: the override replaces whatever the workflow declared.
    console.warn(
      `[realm] --extensions-module override active: loading '${overrideModule}' (resolved: ${real}). ` +
        `Declared workflow extensions are IGNORED.`,
    );
    return [{ declared: overrideModule, resolved: real }];
  }

  const declared = normalizeDeclared(definition.extensions);
  if (declared === undefined || declared.length === 0) return undefined;

  if (definition.origin === 'agent') {
    throw new Error(
      `Workflow '${definition.id}' was created by an agent (origin: 'agent') but declares 'extensions' — ` +
        `refusing to load extension code. Extensions are register-time and operator-only: ` +
        `register the workflow from its YAML file with 'realm workflow register <path>'.`,
    );
  }

  if (definition.source_dir === undefined || definition.trust_root === undefined) {
    throw new Error(
      `Workflow '${definition.id}' declares 'extensions' but its stored definition carries no ` +
        `source_dir/trust_root resolution metadata (registered by an older Realm version). ` +
        `Re-register this workflow: realm workflow register <path-to-workflow>`,
    );
  }

  const trustRootReal = realpathOrFail(
    definition.trust_root,
    `trust_root '${definition.trust_root}' of workflow '${definition.id}'`,
  );

  return declared.map((declaredPath) => {
    const resolved = resolve(definition.source_dir!, declaredPath);
    const real = realpathOrFail(
      resolved,
      `extension module '${declaredPath}' of workflow '${definition.id}' (resolved: ${resolved})`,
    );
    if (!isContainedIn(real, trustRootReal)) {
      throw new Error(
        `Extension module '${declaredPath}' resolves to '${real}', which is OUTSIDE the ` +
          `workflow's trust root '${trustRootReal}'. Extension modules must live within the ` +
          `project containing the workflow (nearest package.json/.git ancestor of the workflow ` +
          `directory). Move the module inside the project, or re-register the workflow from ` +
          `its real location.`,
      );
    }
    return { declared: declaredPath, resolved: real };
  });
}

/**
 * Imports one module (jiti-bridged for TypeScript paths) and returns its full namespace
 * plus the load format (ts-jiti for TypeScript paths, cjs for .cjs / detected CJS-interop
 * wrappers, esm otherwise).
 */
async function importModuleNamespace(
  resolvedPath: string,
  label: string,
): Promise<{ namespace: Record<string, unknown>; format: 'esm' | 'cjs' | 'ts-jiti' }> {
  const isTypescript = /\.(ts|mts|cts)$/.test(resolvedPath);
  let namespace: Record<string, unknown>;
  if (isTypescript) {
    namespace = await importViaJiti(resolvedPath, label);
  } else {
    try {
      namespace = (await import(pathToFileURL(resolvedPath).href)) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`Failed to import module '${label}' (${resolvedPath}): ${errMsg(err)}`);
    }
  }
  let format: 'esm' | 'cjs' | 'ts-jiti' = isTypescript
    ? 'ts-jiti'
    : resolvedPath.endsWith('.cjs')
      ? 'cjs'
      : 'esm';
  const def = namespace['default'];
  if (
    !isTypescript &&
    typeof def === 'object' &&
    def !== null &&
    (def as Record<string, unknown>)['__esModule'] === true
  ) {
    format = 'cjs';
  }
  return { namespace, format };
}

/** The workflow-extensions default-export contract: unwraps tsc-CJS interop, requires default. */
function defaultExportOf(namespace: Record<string, unknown>, declared: string): unknown {
  let exported = namespace['default'];
  // CJS-ESM interop: `import()` of a tsc-CommonJS build ("type" not "module") yields
  // namespace.default = module.exports = { __esModule: true, default: <manifest> }.
  if (
    typeof exported === 'object' &&
    exported !== null &&
    (exported as Record<string, unknown>)['__esModule'] === true &&
    'default' in (exported as Record<string, unknown>)
  ) {
    exported = (exported as Record<string, unknown>)['default'];
  }
  if (exported === undefined) {
    throw new Error(
      `Extension module '${declared}' has no default export — export a declarative object: ` +
        `export default { adapters: { name: instance }, handlers: { ... }, processors: { ... } }`,
    );
  }
  return exported;
}

/**
 * TypeScript modules load through jiti resolved from the MODULE'S OWN directory (the consumer
 * project's node_modules) — never from the CLI install (npx/global installs carry no jiti).
 * Compiled JS is the documented default; jiti is a consumer-side optional peer.
 */
async function importViaJiti(
  resolvedPath: string,
  label: string,
): Promise<Record<string, unknown>> {
  const requireFromModule = createRequire(resolvedPath);
  let jitiPath: string;
  try {
    jitiPath = requireFromModule.resolve('jiti');
  } catch {
    throw new Error(
      `Module '${label}' (${resolvedPath}) is TypeScript, but 'jiti' is not ` +
        `installed in your project. Install jiti in your project (npm install --save-dev jiti), ` +
        `or compile the module to JS and declare the compiled path.`,
    );
  }
  let jitiModule: Record<string, unknown>;
  try {
    jitiModule = (await import(pathToFileURL(jitiPath).href)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Failed to load 'jiti' from '${jitiPath}': ${errMsg(err)}`);
  }
  try {
    // jiti v2: createJiti(parentPath).import(path) → module namespace.
    const createJiti = jitiModule['createJiti'];
    if (typeof createJiti === 'function') {
      const jiti = (createJiti as (parent: string) => { import: (p: string) => Promise<unknown> })(
        resolvedPath,
      );
      return (await jiti.import(resolvedPath)) as Record<string, unknown>;
    }
    // jiti v1: default export is a factory returning a require-like function.
    const factory = jitiModule['default'];
    if (typeof factory === 'function') {
      const jitiRequire = (factory as (parent: string, opts?: object) => (p: string) => unknown)(
        resolvedPath,
        { interopDefault: false },
      );
      const required = jitiRequire(resolvedPath);
      if (typeof required === 'object' && required !== null && 'default' in required) {
        return required as Record<string, unknown>;
      }
      return { default: required };
    }
  } catch (err) {
    throw new Error(`Failed to import TypeScript module '${label}' via jiti: ${errMsg(err)}`);
  }
  throw new Error(
    `Unrecognized 'jiti' package shape at '${jitiPath}' — upgrade jiti in your project, or ` +
      `compile the extension module to JS.`,
  );
}

/** Reads a property defensively — a throwing getter becomes a clean validation error. */
function safeGet(obj: object, key: string, context: string): unknown {
  try {
    return (obj as Record<string, unknown>)[key];
  } catch (err) {
    throw new Error(`${context}: reading '${key}' threw: ${errMsg(err)}`);
  }
}

/**
 * Duck-validates and applies one module's declarative default export onto the registry.
 * Collision policy: overriding a BUILT-IN name → WARN and allow; the same name claimed twice
 * across declared modules → ERROR. Registration name = map key (a differing instance `id` WARNs).
 */
function applyModule(
  exported: unknown,
  ref: ExtensionModuleRef,
  registry: ExtensionRegistry,
  builtinNames: Record<'adapter' | 'handler' | 'processor', Set<string>>,
  claimedBy: Map<string, string>,
  manifest: ExtensionManifest,
): void {
  const context = `Extension module '${ref.declared}'`;
  if (typeof exported !== 'object' || exported === null || Array.isArray(exported)) {
    throw new Error(
      `${context}: default export must be a plain object ({ adapters?, handlers?, processors? }), ` +
        `got ${Array.isArray(exported) ? 'array' : typeof exported}.`,
    );
  }
  // Reject registry-instance-like exports: the contract is declarative maps, not a registry.
  if (
    typeof safeGet(exported, 'register', context) === 'function' ||
    typeof safeGet(exported, 'getAdapter', context) === 'function'
  ) {
    throw new Error(
      `${context}: default export looks like an ExtensionRegistry instance. Export a declarative ` +
        `object instead: export default { adapters: { name: instance }, handlers: { ... }, ` +
        `processors: { ... } }`,
    );
  }
  const allowedKeys = new Set<string>(EXTENSION_SURFACES.map((s) => s.mapKey));
  for (const key of Object.keys(exported)) {
    if (!allowedKeys.has(key)) {
      throw new Error(
        `${context}: unknown key '${key}' in default export — allowed keys are ` +
          `'adapters', 'handlers', 'processors'.`,
      );
    }
  }

  for (const surface of EXTENSION_SURFACES) {
    const map = safeGet(exported, surface.mapKey, context);
    if (map === undefined) continue;
    if (typeof map !== 'object' || map === null || Array.isArray(map)) {
      throw new Error(
        `${context}: '${surface.mapKey}' must be an object map of name → instance, got ` +
          `${Array.isArray(map) ? 'array' : typeof map}.`,
      );
    }
    for (const name of Object.keys(map)) {
      const impl = safeGet(map, name, `${context}, ${surface.type} '${name}'`);
      probeShape(impl, surface.type, surface.probeMembers, name, ref);
      warnOnIdMismatch(impl as object, surface.type, name, ref);

      const claimKey = `${surface.type}:${name}`;
      const previousClaim = claimedBy.get(claimKey);
      if (previousClaim !== undefined) {
        throw new Error(
          `Extension ${surface.type} '${name}' is declared by both '${previousClaim}' and ` +
            `'${ref.declared}' — extension names must be unique across declared modules.`,
        );
      }
      claimedBy.set(claimKey, ref.declared);

      if (builtinNames[surface.type].has(name)) {
        console.warn(
          `[realm] extension ${surface.type} '${name}' from '${ref.declared}' overrides the ` +
            `built-in ${surface.type} '${name}'.`,
        );
      }

      // Safe: probeShape validated the minimal distinguishing members of each interface.
      registry.register(surface.type as 'adapter', name, impl as never);
      manifest[surface.mapKey].push(name);
    }
  }
}

/** Probes the minimal distinguishing members of the extension interface — no instanceof. */
function probeShape(
  impl: unknown,
  type: string,
  members: readonly string[],
  name: string,
  ref: ExtensionModuleRef,
): void {
  const context = `Extension ${type} '${name}' in '${ref.declared}'`;
  if (typeof impl !== 'object' || impl === null) {
    throw new Error(
      `${context}: expected an object instance, got ${impl === null ? 'null' : typeof impl}.`,
    );
  }
  for (const member of members) {
    const value = safeGet(impl, member, context);
    if (typeof value !== 'function') {
      throw new Error(
        `${context}: missing callable '${member}' — ${type}s must implement ` +
          `${members.map((m) => `'${m}'`).join('/')} per the @sensigo/realm ${
            type === 'adapter' ? 'ServiceAdapter' : type === 'handler' ? 'StepHandler' : 'Processor'
          } interface.`,
      );
    }
  }
}

/** Registration name = map key; a differing instance `id` is evidence worth surfacing. */
function warnOnIdMismatch(impl: object, type: string, name: string, ref: ExtensionModuleRef): void {
  let id: unknown;
  try {
    id = (impl as Record<string, unknown>)['id'];
  } catch {
    return; // a throwing id getter is not worth failing the load over — probe already passed
  }
  if (typeof id === 'string' && id !== name) {
    console.warn(
      `[realm] extension ${type} registered as '${name}' (map key) but its instance id is ` +
        `'${id}' (module '${ref.declared}'). The registration name is the map key.`,
    );
  }
}

/**
 * Builds a `registryProvider` for the MCP server (serve / mcp stdio): resolves each
 * definition through the process-lifetime project loader. `--extensions-module` overrides
 * CODE modules; `projectDir` anchors the manifest for definitions without trust_root
 * (`realm mcp` passes it ONLY when --project was given — no cwd default there).
 */
export function makeRegistryProvider(
  overrideModule?: string,
  projectDir?: string,
): (definition: WorkflowDefinition) => Promise<ExtensionRegistry> {
  return async (definition: WorkflowDefinition): Promise<ExtensionRegistry> =>
    (
      await loadProjectExtensions(definition, {
        ...(overrideModule !== undefined ? { overrideModule } : {}),
        ...(projectDir !== undefined ? { projectDir } : {}),
      })
    ).registry;
}
