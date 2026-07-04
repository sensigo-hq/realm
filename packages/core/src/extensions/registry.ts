// Extension registry — stores and retrieves adapters, processors, and step handlers by name.
import type { ServiceAdapter } from './service-adapter.js';
import type { Processor } from './processor.js';
import type { StepHandler } from './step-handler.js';
import type { RateLimitConfig } from '../types/workflow-definition.js';
import type { RateLimiter } from '../adapters/rate-limiter.js';
import { TokenBucketRateLimiter } from '../adapters/token-bucket.js';

export class ExtensionRegistry {
  private adapters = new Map<string, ServiceAdapter>();
  private processors = new Map<string, Processor>();
  private handlers = new Map<string, StepHandler>();
  private rateLimiters = new Map<string, RateLimiter>();

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
