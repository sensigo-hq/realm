import { describe, it, expect } from 'vitest';
import { ExtensionRegistry } from './registry.js';
import type { ServiceAdapter } from './service-adapter.js';
import type { Processor, ProcessorInput, ProcessorOutput } from './processor.js';
import type {
  StepHandler,
  StepHandlerInputs,
  StepContext,
  StepHandlerResult,
} from './step-handler.js';

const stubAdapter: ServiceAdapter = {
  id: 'test-adapter',
  fetch: async (_op, _p, _c) => ({ status: 200, data: null }),
  create: async (_op, _p, _c) => ({ status: 201, data: null }),
  update: async (_op, _p, _c) => ({ status: 200, data: null }),
};

const stubProcessor: Processor = {
  id: 'test-processor',
  process: async (content: ProcessorInput, _c): Promise<ProcessorOutput> => content,
};

const stubHandler: StepHandler = {
  id: 'test-handler',
  execute: async (_inputs: StepHandlerInputs, _ctx: StepContext): Promise<StepHandlerResult> => ({
    data: {},
  }),
};

describe('ExtensionRegistry', () => {
  it('registers and retrieves an adapter by name', () => {
    const registry = new ExtensionRegistry();
    registry.register('adapter', 'my-adapter', stubAdapter);
    expect(registry.getAdapter('my-adapter')).toBe(stubAdapter);
  });

  it('registers and retrieves a processor by name', () => {
    const registry = new ExtensionRegistry();
    registry.register('processor', 'my-processor', stubProcessor);
    expect(registry.getProcessor('my-processor')).toBe(stubProcessor);
  });

  it('registers and retrieves a handler by name', () => {
    const registry = new ExtensionRegistry();
    registry.register('handler', 'my-handler', stubHandler);
    expect(registry.getHandler('my-handler')).toBe(stubHandler);
  });

  it('returns undefined for unknown adapter', () => {
    const registry = new ExtensionRegistry();
    expect(registry.getAdapter('unknown')).toBeUndefined();
  });

  it('returns undefined for unknown processor', () => {
    const registry = new ExtensionRegistry();
    expect(registry.getProcessor('unknown')).toBeUndefined();
  });

  it('returns undefined for unknown handler', () => {
    const registry = new ExtensionRegistry();
    expect(registry.getHandler('unknown')).toBeUndefined();
  });

  it('overwriting a registered name replaces the previous entry', () => {
    const registry = new ExtensionRegistry();
    const first: ServiceAdapter = { ...stubAdapter, id: 'first' };
    const second: ServiceAdapter = { ...stubAdapter, id: 'second' };
    registry.register('adapter', 'my-adapter', first);
    registry.register('adapter', 'my-adapter', second);
    expect(registry.getAdapter('my-adapter')).toBe(second);
  });

  it('has() reports registered names per type without cross-type leakage', () => {
    const registry = new ExtensionRegistry();
    registry.register('adapter', 'shared-name', stubAdapter);
    expect(registry.has('adapter', 'shared-name')).toBe(true);
    expect(registry.has('handler', 'shared-name')).toBe(false);
    expect(registry.has('processor', 'shared-name')).toBe(false);
    expect(registry.has('adapter', 'unknown')).toBe(false);
  });

  it('names() lists registered names per type in registration order', () => {
    const registry = new ExtensionRegistry();
    registry.register('adapter', 'a1', stubAdapter);
    registry.register('adapter', 'a2', stubAdapter);
    registry.register('handler', 'h1', stubHandler);
    registry.register('processor', 'p1', stubProcessor);
    expect(registry.names('adapter')).toEqual(['a1', 'a2']);
    expect(registry.names('handler')).toEqual(['h1']);
    expect(registry.names('processor')).toEqual(['p1']);
  });

  it('names() is empty for a fresh registry', () => {
    const registry = new ExtensionRegistry();
    expect(registry.names('adapter')).toEqual([]);
    expect(registry.names('handler')).toEqual([]);
    expect(registry.names('processor')).toEqual([]);
  });
});
