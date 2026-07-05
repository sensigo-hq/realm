// Extension registry — stores and retrieves adapters, processors, and step handlers by name.
import type { ServiceAdapter } from './service-adapter.js';
import type { Processor } from './processor.js';
import type { StepHandler } from './step-handler.js';
import type { RateLimitConfig } from '../types/workflow-definition.js';
import type { ExtensionIdentityEntry } from '../types/extension-identity.js';
import type { RateLimiter } from '../adapters/rate-limiter.js';
import { TokenBucketRateLimiter } from '../adapters/token-bucket.js';

export class ExtensionRegistry {
  private adapters = new Map<string, ServiceAdapter>();
  private processors = new Map<string, Processor>();
  private handlers = new Map<string, StepHandler>();
  private rateLimiters = new Map<string, RateLimiter>();
  private identityEntry: ExtensionIdentityEntry | undefined;

  register(type: 'adapter', name: string, impl: ServiceAdapter): void;
  register(type: 'processor', name: string, impl: Processor): void;
  register(type: 'handler', name: string, impl: StepHandler): void;
  register(
    type: 'adapter' | 'processor' | 'handler',
    name: string,
    impl: ServiceAdapter | Processor | StepHandler,
  ): void {
    if (type === 'adapter') {
      this.adapters.set(name, impl as ServiceAdapter);
    } else if (type === 'processor') {
      this.processors.set(name, impl as Processor);
    } else {
      this.handlers.set(name, impl as StepHandler);
    }
  }

  /**
   * Returns a new registry sharing this registry's adapter/processor/handler INSTANCES
   * (shallow copies of the three maps — extension instances are stateless by contract)
   * with a fresh, EMPTY rate-limiter map.
   *
   * Why the rate limiters are NOT copied: rate-limiter buckets are per-registry-instance
   * state. Sharing them across a clone would couple a future co-resident server's
   * throttling to one-shot agent runs; a fresh map preserves the 0.12 behavior where
   * `realm agent` built its own registry per invocation.
   *
   * Use clone() before composing additional tiers on top of a shared/cached registry —
   * the shared instance must never be mutated.
   */
  clone(): ExtensionRegistry {
    const copy = new ExtensionRegistry();
    copy.adapters = new Map(this.adapters);
    copy.processors = new Map(this.processors);
    copy.handlers = new Map(this.handlers);
    // The identity describes the loaded extension CODE — the clone executes the same
    // instances, so it MUST carry the identity or tiered paths (agent/mcp) silently
    // lose the run's drift evidence.
    copy.identityEntry = this.identityEntry;
    return copy;
  }

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
    if (type === 'adapter') return this.adapters.has(name);
    if (type === 'processor') return this.processors.has(name);
    return this.handlers.has(name);
  }

  /** Returns the registered names for the given extension type (registration order). */
  names(type: 'adapter' | 'processor' | 'handler'): string[] {
    if (type === 'adapter') return [...this.adapters.keys()];
    if (type === 'processor') return [...this.processors.keys()];
    return [...this.handlers.keys()];
  }

  getAdapter(name: string): ServiceAdapter | undefined {
    return this.adapters.get(name);
  }

  getProcessor(name: string): Processor | undefined {
    return this.processors.get(name);
  }

  getHandler(name: string): StepHandler | undefined {
    return this.handlers.get(name);
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
}
