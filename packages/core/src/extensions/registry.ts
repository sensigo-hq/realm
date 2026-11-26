// Extension registry — stores and retrieves adapters, processors, and step handlers by name, each
// with where its code came from (#828 unit 2b: `CodeSource`, types/code-source.ts).
import type { ServiceAdapter } from './service-adapter.js';
import type { Processor } from './processor.js';
import type { StepHandler } from './step-handler.js';
import type { RateLimitConfig } from '../types/workflow-definition.js';
import type { ExtensionIdentityEntry } from '../types/extension-identity.js';
import type { CodeSource, ProjectSource } from '../types/code-source.js';
import type { RateLimiter } from '../adapters/rate-limiter.js';
import { TokenBucketRateLimiter } from '../adapters/token-bucket.js';
import { brandClass, REALM_BRAND } from '../brand.js';
import { WorkflowError } from '../types/workflow-error.js';
import { assertRegistryLine } from '../release-line.js';
import { codeTextOf } from './code-text.js';
import { replacesBuiltIn } from './built-in-requirements.js';

type Kind = 'adapter' | 'processor' | 'handler';
type Impl = ServiceAdapter | Processor | StepHandler;

/** One stored entry, frozen with its source. The code object itself is never frozen. */
interface Entry {
  readonly impl: Impl;
  readonly source: CodeSource;
  readonly replacesBuiltIn: boolean;
}

const VIAS: readonly ProjectSource['via'][] = [
  'manifest',
  'extensions_file',
  'override_flag',
  'host_stated',
];
const HASH = /^[0-9a-f]{64}$/;
const BUILT_IN: CodeSource = Object.freeze({ source: 'built_in' });

function refusal(message: string, details: Record<string, unknown>): WorkflowError {
  return new WorkflowError(message, {
    code: 'VALIDATION_OPTION_INVALID',
    category: 'VALIDATION',
    agentAction: 'report_to_user',
    retryable: false,
    details,
  });
}

/**
 * A stated source as `register` records it (a frozen copy holding only its own keys), or the words
 * for what is wrong with it. Only a well-formed `project` source, or a `catalog` one on an adapter,
 * is taken: Realm reads the built-in and host sources itself.
 */
function readStated(kind: Kind, stated: unknown): CodeSource | string {
  if (typeof stated !== 'object' || stated === null || Array.isArray(stated))
    return 'a source that is not an object';
  const s = stated as Record<string, unknown>;
  const only = (keys: readonly string[]): string | undefined => {
    const extra = Object.keys(s).find((key) => !keys.includes(key));
    return extra === undefined ? undefined : `an unknown key '${extra}'`;
  };
  const named = s['source'];
  if (named === 'built_in' || named === 'host_registered') return `a '${named}' source`;
  if (named === 'catalog') {
    const use = s['use'];
    if (kind !== 'adapter') return `a 'catalog' source on a ${kind}`;
    if (typeof use !== 'string' || use === '') return "a 'catalog' source without a 'use' name";
    return only(['source', 'use']) ?? Object.freeze({ source: 'catalog', use } as const);
  }
  if (named !== 'project')
    return typeof named === 'string'
      ? `an unknown source '${named}'`
      : "a source without its 'source' name";
  const { declared, via } = s;
  if (typeof declared !== 'string' || declared === '')
    return "a 'project' source without 'declared'";
  if (!VIAS.includes(via as ProjectSource['via'])) return `'via' must be one of ${VIAS.join(', ')}`;
  const how = via as ProjectSource['via'];
  if ('absent' in s) {
    if ('entry_hash' in s || 'folder_tree_hash' in s)
      return "both hashes and 'absent' in one 'project' source";
    if (s['absent'] !== 'hashes_unavailable') return "'absent' must be 'hashes_unavailable'";
    return (
      only(['source', 'declared', 'via', 'absent']) ??
      Object.freeze({
        source: 'project',
        declared,
        via: how,
        absent: 'hashes_unavailable',
      } as const)
    );
  }
  const { entry_hash, folder_tree_hash } = s;
  for (const [key, hash] of [
    ['entry_hash', entry_hash],
    ['folder_tree_hash', folder_tree_hash],
  ] as const)
    if (typeof hash !== 'string' || !HASH.test(hash))
      return `'${key}' must be 64 lowercase hex characters`;
  return (
    only(['source', 'declared', 'via', 'entry_hash', 'folder_tree_hash']) ??
    Object.freeze({
      source: 'project',
      declared,
      via: how,
      entry_hash: entry_hash as string,
      folder_tree_hash: folder_tree_hash as string,
    } as const)
  );
}

/** Set once, by the class's static block: stores a built-in entry, which `register` never does. */
let storeBuiltIn!: (registry: ExtensionRegistry, kind: Kind, name: string, impl: Impl) => void;

/**
 * The handlers, service adapters and processors a program registers by name; the engine looks a
 * step's handler or adapter up in it.
 * @public
 */
export class ExtensionRegistry {
  private adapters = new Map<string, Entry>();
  private processors = new Map<string, Entry>();
  private handlers = new Map<string, Entry>();
  private rateLimiters = new Map<string, RateLimiter>();
  private identityEntry: ExtensionIdentityEntry | undefined;

  static {
    storeBuiltIn = (registry, kind, name, impl) => registry.store(kind, name, impl, BUILT_IN);
  }

  /**
   * Registers `impl` under `name`, replacing whatever that name held, source included.
   *
   * `source` states where the code came from: a `project` source (from `projectSourceOf` in
   * `@sensigo/realm-mcp`, or the CLI's loader) or a `catalog` one on an adapter, recorded as given
   * once its shape holds. With none (or `null`), Realm records `host_registered` with the
   * fingerprint of `impl`'s code, taken now. A `built_in` or `host_registered` source, or one of
   * any other shape, is refused with `VALIDATION_OPTION_INVALID` and nothing is registered.
   */
  register(
    type: 'adapter',
    name: string,
    impl: ServiceAdapter,
    /** @beta */
    source?: CodeSource | null,
  ): void;
  register(
    type: 'processor',
    name: string,
    impl: Processor,
    /** @beta */
    source?: CodeSource | null,
  ): void;
  register(
    type: 'handler',
    name: string,
    impl: StepHandler,
    /** @beta */
    source?: CodeSource | null,
  ): void;
  register(type: Kind, name: string, impl: Impl, source?: CodeSource | null): void {
    if (source === undefined || source === null) {
      this.store(
        type,
        name,
        impl,
        Object.freeze({ source: 'host_registered' as const, ...codeTextOf(impl) }),
      );
      return;
    }
    const read = readStated(type, source);
    if (typeof read === 'string') {
      throw refusal(
        `register cannot take this source: ${read}. Realm reads where built-in and host code come ` +
          `from itself; state a 'project' or 'catalog' source, or none. To copy an entry with its ` +
          `source, use copyEntry(from, kind, name).`,
        { kind: type, name, defect: read },
      );
    }
    this.store(type, name, impl, read);
  }

  /**
   * The entry registered under `name`: its code, where that code came from, and whether it
   * replaces one of Realm's built-ins; `undefined` when the name holds none. The entry and its
   * source are frozen.
   * @beta
   */
  entry(
    type: 'adapter' | 'processor' | 'handler',
    name: string,
  ):
    | {
        readonly impl: ServiceAdapter | Processor | StepHandler;
        readonly source: CodeSource;
        readonly replacesBuiltIn: boolean;
      }
    | undefined {
    return this.mapOf(type).get(name);
  }

  /**
   * Copies the entry `from` holds under `name` into this registry, its source included (`built_in`
   * too), replacing whatever this registry held there: the way to copy a registry, since it never
   * states a new source. Refused with nothing copied: `from` of another Realm release
   * (`ENGINE_RELEASE_LINE_MISMATCH`); `from` without `entry()`, or holding no such entry
   * (`VALIDATION_OPTION_INVALID`).
   */
  copyEntry(
    from: ExtensionRegistry,
    type: 'adapter' | 'processor' | 'handler',
    name: string,
  ): void {
    assertRegistryLine(from, 'the registry handed to copyEntry', ExtensionRegistry);
    const read: unknown = (from as { entry?: unknown } | null | undefined)?.entry;
    if (typeof read !== 'function') {
      throw refusal(
        'copyEntry: the other registry has no entry(), so it is not a registry of this Realm ' +
          'release. Nothing was copied.',
        { kind: type, name },
      );
    }
    const held = Reflect.apply(read, from, [type, name]) as Entry | undefined;
    if (held === undefined) {
      throw refusal(
        `copyEntry: the other registry holds no ${type} '${name}'. Nothing was copied.`,
        { kind: type, name },
      );
    }
    this.store(type, name, held.impl, Object.freeze({ ...held.source }) as CodeSource);
  }

  /* clone() was removed in v0.14.0: it existed solely for the legacy env-gated adapter
   * tier in `realm agent` (composeAgentRegistry), which is gone — loader registries flow
   * into runs directly and are never mutated. */

  /**
   * Attaches the CLI-computed extension-code identity record (issue #119). Core never
   * computes identity — it only carries/copies this record so the execution loop's lazy
   * append-on-change site can reach it without any contract change.
   */
  setIdentity(entry: ExtensionIdentityEntry): void {
    this.identityEntry = entry;
  }

  /** The extension-code identity captured at module-load time, when one was attached. */
  get identity(): ExtensionIdentityEntry | undefined {
    return this.identityEntry;
  }

  /** Returns true when an extension of the given type is registered under `name`. */
  has(type: 'adapter' | 'processor' | 'handler', name: string): boolean {
    return this.mapOf(type).has(name);
  }

  /** Returns the registered names for the given extension type (registration order). */
  names(type: 'adapter' | 'processor' | 'handler'): string[] {
    return [...this.mapOf(type).keys()];
  }

  getAdapter(name: string): ServiceAdapter | undefined {
    return this.adapters.get(name)?.impl as ServiceAdapter | undefined;
  }

  getProcessor(name: string): Processor | undefined {
    return this.processors.get(name)?.impl as Processor | undefined;
  }

  getHandler(name: string): StepHandler | undefined {
    return this.handlers.get(name)?.impl as StepHandler | undefined;
  }

  /**
   * Returns the RateLimiter for the given service, creating one if it does not
   * yet exist. The limiter is keyed by service name and lives for the lifetime
   * of the registry — callers should use a stable registry instance to get the
   * benefit of shared rate limiting across concurrent steps.
   */
  getOrCreateRateLimiter(serviceName: string, config: RateLimitConfig): RateLimiter {
    if (!this.rateLimiters.has(serviceName)) {
      this.rateLimiters.set(
        serviceName,
        new TokenBucketRateLimiter({
          requests_per_second: config.requests_per_second!,
          burst: config.burst ?? config.requests_per_second!,
        }),
      );
    }
    return this.rateLimiters.get(serviceName)!;
  }

  /** Stores one frozen entry; whether it replaces a built-in comes from its name and source. */
  private store(type: Kind, name: string, impl: Impl, source: CodeSource): void {
    const entry: Entry = Object.freeze({
      impl,
      source,
      replacesBuiltIn: replacesBuiltIn(type, name, source),
    });
    this.mapOf(type).set(name, entry);
  }

  private mapOf(type: Kind): Map<string, Entry> {
    if (type === 'adapter') return this.adapters;
    if (type === 'processor') return this.processors;
    return this.handlers;
  }
}

/**
 * Core only, on no package entry: registers one of Realm's own built-ins as `built_in`, which the
 * public `register` refuses to record. `createDefaultRegistry()` is its one caller.
 */
export function registerBuiltIn(
  registry: ExtensionRegistry,
  kind: 'adapter' | 'handler',
  name: string,
  impl: ServiceAdapter | StepHandler,
): void {
  storeBuiltIn(registry, kind, name, impl);
}

brandClass(ExtensionRegistry, Symbol.for('@sensigo/realm/ExtensionRegistry'), REALM_BRAND);
