// load-project-extensions.ts — the ONE loader for workflow-declared project extension modules.
//
// Every step-executing or config-validating CLI entry point (run, agent, listen, serve, mcp,
// test, validate, register, watch) resolves extensions through this function. Core resolves and
// stores PATHS only (source_dir / trust_root / declared relative paths on the definition) — the
// dynamic import lives here, in the CLI composition layer.
//
// Trust model: extension module paths originate ONLY from operator-registered workflow
// definitions or from the operator-typed --extensions-module flag — never from request data.
// Declared paths resolve against the definition's source_dir and must realpath-contain within
// its trust_root (nearest package.json/.git ancestor, derived at registration time).
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDefaultRegistry, ExtensionRegistry } from '@sensigo/realm';
import type { ExtensionManifest, ExtensionModuleRef, WorkflowDefinition } from '@sensigo/realm';

export interface LoadProjectExtensionsOptions {
  /**
   * Operator-typed module path that REPLACES the workflow's declared extension modules
   * (repair/override tool). Containment does not apply to an operator-typed path.
   */
  overrideModule?: string;
}

export interface LoadedProjectExtensions {
  registry: ExtensionRegistry;
  manifest: ExtensionManifest;
}

/** Registration surfaces of a declarative extension module, keyed by export map name. */
const EXTENSION_SURFACES = [
  { mapKey: 'adapters', type: 'adapter', probeMembers: ['fetch', 'create', 'update'] },
  { mapKey: 'handlers', type: 'handler', probeMembers: ['execute'] },
  { mapKey: 'processors', type: 'processor', probeMembers: ['process'] },
] as const;

const DEFAULT_REGISTRY_CACHE_KEY = '\u0000default-registry\u0000';

// Process-lifetime cache keyed by the ORDERED list of resolved module paths (plus a sentinel
// for the extension-less default registry). Restart-required semantics: module CONTENT changes
// in long-lived processes (listen parent, serve, mcp) need a process restart — there is no
// cache-busting re-import (ESM module cache would defeat it anyway).
const cache = new Map<string, LoadedProjectExtensions>();

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

/**
 * Loads the project extension modules declared by a workflow definition (or an operator
 * override) and returns a registry (defaults + extensions applied) plus a manifest of what
 * was loaded. No `extensions` on the definition and no override → `createDefaultRegistry()`
 * plus an empty manifest — the byte-identical fallback, cached process-wide.
 *
 * Precedence: defaults < legacy env-gated built-ins (applied by `realm agent`, see agent.ts)
 * < declared extensions < --extensions-module override.
 *
 * CONTRACT: returned registries are shared process-lifetime cache entries. The only
 * permitted mutation is `getOrCreateRateLimiter` (serve bucket persistence, by design);
 * any tier composition on top requires `ExtensionRegistry.clone()`.
 */
export async function loadProjectExtensions(
  definition: WorkflowDefinition,
  opts?: LoadProjectExtensionsOptions,
): Promise<LoadedProjectExtensions> {
  const moduleRefs = resolveModuleRefs(definition, opts?.overrideModule);

  if (moduleRefs === undefined) {
    // Extension-free fallback: byte-identical default registry, process-lifetime cached
    // (the sentinel keeps rate-limiter buckets stable across requests in serve/mcp too).
    let entry = cache.get(DEFAULT_REGISTRY_CACHE_KEY);
    if (entry === undefined) {
      entry = { registry: createDefaultRegistry(), manifest: emptyManifest() };
      cache.set(DEFAULT_REGISTRY_CACHE_KEY, entry);
    }
    return entry;
  }

  const cacheKey = moduleRefs.map((m) => m.resolved).join('\n');
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const registry = createDefaultRegistry();
  const builtinNames = {
    adapter: new Set(registry.names('adapter')),
    handler: new Set(registry.names('handler')),
    processor: new Set(registry.names('processor')),
  };
  // `${type}:${name}` → declared path of the module that first claimed it.
  const claimedBy = new Map<string, string>();
  const manifest: ExtensionManifest = {
    modules: moduleRefs,
    adapters: [],
    handlers: [],
    processors: [],
  };

  for (const ref of moduleRefs) {
    const exported = await importExtensionModule(ref);
    applyModule(exported, ref, registry, builtinNames, claimedBy, manifest);
  }

  const result: LoadedProjectExtensions = { registry, manifest };
  cache.set(cacheKey, result);
  return result;
}

/**
 * Resolves the list of modules to load. Returns undefined for the extension-free fallback.
 * Enforces the trust model for declared modules: agent-origin refusal, re-register guidance
 * when resolution metadata is missing, and realpath containment within trust_root.
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

/** Imports one extension module (jiti-bridged for TypeScript paths) and returns its default export. */
async function importExtensionModule(ref: ExtensionModuleRef): Promise<unknown> {
  const isTypescript = /\.(ts|mts|cts)$/.test(ref.resolved);
  let mod: Record<string, unknown>;
  if (isTypescript) {
    mod = await importViaJiti(ref);
  } else {
    try {
      mod = (await import(pathToFileURL(ref.resolved).href)) as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `Failed to import extension module '${ref.declared}' (${ref.resolved}): ${errMsg(err)}`,
      );
    }
  }
  const exported = mod['default'];
  if (exported === undefined) {
    throw new Error(
      `Extension module '${ref.declared}' has no default export — export a declarative object: ` +
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
async function importViaJiti(ref: ExtensionModuleRef): Promise<Record<string, unknown>> {
  const requireFromModule = createRequire(ref.resolved);
  let jitiPath: string;
  try {
    jitiPath = requireFromModule.resolve('jiti');
  } catch {
    throw new Error(
      `Extension module '${ref.declared}' (${ref.resolved}) is TypeScript, but 'jiti' is not ` +
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
        ref.resolved,
      );
      return (await jiti.import(ref.resolved)) as Record<string, unknown>;
    }
    // jiti v1: default export is a factory returning a require-like function.
    const factory = jitiModule['default'];
    if (typeof factory === 'function') {
      const jitiRequire = (factory as (parent: string, opts?: object) => (p: string) => unknown)(
        ref.resolved,
        { interopDefault: false },
      );
      const required = jitiRequire(ref.resolved);
      if (typeof required === 'object' && required !== null && 'default' in required) {
        return required as Record<string, unknown>;
      }
      return { default: required };
    }
  } catch (err) {
    throw new Error(
      `Failed to import TypeScript extension module '${ref.declared}' via jiti: ${errMsg(err)}`,
    );
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
 * definition's extensions through the process-lifetime loader cache. An operator override
 * replaces declared modules for EVERY definition served by this process.
 */
export function makeRegistryProvider(
  overrideModule?: string,
): (definition: WorkflowDefinition) => Promise<ExtensionRegistry> {
  return async (definition: WorkflowDefinition): Promise<ExtensionRegistry> =>
    (
      await loadProjectExtensions(
        definition,
        overrideModule !== undefined ? { overrideModule } : {},
      )
    ).registry;
}
