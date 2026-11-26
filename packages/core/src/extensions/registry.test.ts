import { describe, it, expect } from 'vitest';
import { ExtensionRegistry } from './registry.js';
import { createDefaultRegistry } from './default-registry.js';
import { BUILT_IN_REQUIREMENTS } from './built-in-requirements.js';
import { codeTextOf } from './code-text.js';
import { brandClass, createRealmBrand } from '../brand.js';
import type { CodeSource } from '../types/code-source.js';
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

  describe('extension identity attachment', () => {
    it('setIdentity attaches and the getter returns it', () => {
      const registry = new ExtensionRegistry();
      expect(registry.identity).toBeUndefined();
      const entry = {
        captured_at: '2026-07-05T00:00:00.000Z',
        modules: [],
        tree: {
          roots: [],
          rules: 'dir_tree_v1: test',
          file_count: 0,
          total_bytes: 0,
          tree_hash: 'abc',
          truncated: false,
        },
        coverage: 'dir_tree_v1' as const,
      };
      registry.setIdentity(entry);
      expect(registry.identity).toBe(entry);
    });
  });
});

// #828 unit 2b (prompt feat-828-u2b-registry-source.md rev 2.1, checks 1–5): every entry says where its
// code came from. Each cell names (1) the break that turns it red and (2) what it prints when it fails.
describe('#828 unit 2b — every registry entry carries its source', () => {
  const H = 'a'.repeat(64);
  const T = 'b'.repeat(64);
  const PROJECT: CodeSource = {
    source: 'project',
    declared: './extensions.js',
    via: 'extensions_file',
    entry_hash: H,
    folder_tree_hash: T,
  };
  const KINDS = ['adapter', 'handler', 'processor'] as const;
  /** What a registry holds under `name`: its source and whether it replaces a built-in. */
  const held = (r: ExtensionRegistry, kind: (typeof KINDS)[number], name: string) => {
    const e = r.entry(kind, name);
    return e === undefined ? undefined : { source: e.source, replaces: e.replacesBuiltIn };
  };
  /** A refused call's code and words, or what it returned. */
  const refusedBy = (call: () => void): { code: unknown; message: string } | 'no throw' => {
    try {
      call();
      return 'no throw';
    } catch (err) {
      return { code: (err as { code?: unknown }).code, message: (err as Error).message };
    }
  };

  // (1) red when the default registry registers through the public `register` (host_registered), or
  //     leaves a table name out; (2) prints each kind's names and each entry's source.
  it('check 1: the default registry: each name is built_in and replaces nothing; names(kind) are the table’s', () => {
    const r = createDefaultRegistry();
    const got = KINDS.map((kind) => ({
      kind,
      entries: r.names(kind).map((name) => ({ name, ...held(r, kind, name) })),
    }));
    expect(got).toEqual(
      KINDS.map((kind) => ({
        kind,
        entries: BUILT_IN_REQUIREMENTS.filter((b) => b.kind === kind).map((b) => ({
          name: b.name,
          source: { source: 'built_in' },
          replaces: false,
        })),
      })),
    );
  });

  describe('check 2: replacesBuiltIn, one cell per conjunct', () => {
    // (1) red when the predicate returns false; (2) prints the entry.
    it('a project source over filesystem replaces', () => {
      const r = createDefaultRegistry();
      r.register('adapter', 'filesystem', stubAdapter, PROJECT);
      expect(held(r, 'adapter', 'filesystem')).toEqual({ source: PROJECT, replaces: true });
    });
    // (1) red when the name conjunct is dropped; (2) prints both entries.
    it('a project source, and a host’s register with no source, under my_check replace nothing', () => {
      const r = createDefaultRegistry();
      r.register('handler', 'my_check', stubHandler, PROJECT);
      r.register('handler', 'my_other_check', stubHandler);
      expect([
        held(r, 'handler', 'my_check')?.replaces,
        held(r, 'handler', 'my_other_check')?.replaces,
      ]).toEqual([false, false]);
    });
    // (1) red when the decision reads the previous entry; (2) prints the entry.
    it('a host on a fresh registry registering filesystem replaces', () => {
      const r = new ExtensionRegistry();
      r.register('adapter', 'filesystem', stubAdapter);
      expect(held(r, 'adapter', 'filesystem')).toEqual({
        source: { source: 'host_registered', ...codeTextOf(stubAdapter) },
        replaces: true,
      });
    });
    // (1) red when the catalog arm is removed; (2) prints the entry.
    it("catalog { use: 'filesystem' } under filesystem replaces nothing", () => {
      const r = createDefaultRegistry();
      r.register('adapter', 'filesystem', stubAdapter, { source: 'catalog', use: 'filesystem' });
      expect(held(r, 'adapter', 'filesystem')).toEqual({
        source: { source: 'catalog', use: 'filesystem' },
        replaces: false,
      });
    });
    // (1) red when the `use` conjunct is dropped; (2) prints the entry.
    it("catalog { use: 'http' } under filesystem replaces", () => {
      const r = createDefaultRegistry();
      r.register('adapter', 'filesystem', stubAdapter, { source: 'catalog', use: 'http' });
      expect(held(r, 'adapter', 'filesystem')?.replaces).toBe(true);
    });
    // (1) red when the decision reads the previous entry; (2) prints the entry.
    it('a register over an earlier replacement still replaces', () => {
      const r = createDefaultRegistry();
      r.register('adapter', 'filesystem', stubAdapter, PROJECT);
      r.register('adapter', 'filesystem', stubAdapter);
      expect(held(r, 'adapter', 'filesystem')?.replaces).toBe(true);
    });
  });

  describe("check 3: register's refusals", () => {
    const words = (defect: string) =>
      `register cannot take this source: ${defect}. Realm reads where built-in and host code come ` +
      `from itself; state a 'project' or 'catalog' source, or none. To copy an entry with its ` +
      `source, use copyEntry(from, kind, name).`;
    const {
      entry_hash: _h,
      folder_tree_hash: _t,
      ...noHashes
    } = PROJECT as Record<string, unknown>;
    const VIA = "'via' must be one of manifest, extensions_file, override_flag, host_stated";
    const CASES: ReadonlyArray<{
      readonly what: string;
      readonly kind: (typeof KINDS)[number];
      readonly name: string;
      readonly stated: unknown;
      readonly defect: string;
    }> = [
      {
        what: 'not an object',
        kind: 'adapter',
        name: 'x',
        stated: 'project',
        defect: 'a source that is not an object',
      },
      {
        what: 'built_in',
        kind: 'adapter',
        name: 'filesystem',
        stated: { source: 'built_in' },
        defect: "a 'built_in' source",
      },
      {
        what: 'host_registered',
        kind: 'handler',
        name: 'x',
        stated: { source: 'host_registered', code_text_sha256: H },
        defect: "a 'host_registered' source",
      },
      {
        what: 'catalog on the handler check_quotes (would hide a replacement)',
        kind: 'handler',
        name: 'check_quotes',
        stated: { source: 'catalog', use: 'check_quotes' },
        defect: "a 'catalog' source on a handler",
      },
      {
        what: 'catalog on a processor',
        kind: 'processor',
        name: 'x',
        stated: { source: 'catalog', use: 'x' },
        defect: "a 'catalog' source on a processor",
      },
      {
        what: 'catalog without use',
        kind: 'adapter',
        name: 'x',
        stated: { source: 'catalog' },
        defect: "a 'catalog' source without a 'use' name",
      },
      {
        what: 'catalog with an extra key',
        kind: 'adapter',
        name: 'x',
        stated: { source: 'catalog', use: 'filesystem', config: {} },
        defect: "an unknown key 'config'",
      },
      {
        what: 'an unknown source',
        kind: 'adapter',
        name: 'x',
        stated: { ...PROJECT, source: 'Project' },
        defect: "an unknown source 'Project'",
      },
      {
        what: 'no source name',
        kind: 'adapter',
        name: 'x',
        stated: { declared: './x.js' },
        defect: "a source without its 'source' name",
      },
      {
        what: 'project without declared',
        kind: 'adapter',
        name: 'x',
        stated: { ...PROJECT, declared: undefined },
        defect: "a 'project' source without 'declared'",
      },
      {
        what: 'project without via',
        kind: 'adapter',
        name: 'x',
        stated: { ...PROJECT, via: undefined },
        defect: VIA,
      },
      {
        what: 'a via outside the four',
        kind: 'adapter',
        name: 'x',
        stated: { ...PROJECT, via: 'npm' },
        defect: VIA,
      },
      {
        what: 'a hash that is not 64 hex',
        kind: 'adapter',
        name: 'x',
        stated: { ...PROJECT, entry_hash: 'abc' },
        defect: "'entry_hash' must be 64 lowercase hex characters",
      },
      {
        what: 'an upper-case hash',
        kind: 'adapter',
        name: 'x',
        stated: { ...PROJECT, folder_tree_hash: 'B'.repeat(64) },
        defect: "'folder_tree_hash' must be 64 lowercase hex characters",
      },
      {
        what: 'both hashes and absent',
        kind: 'adapter',
        name: 'x',
        stated: { ...PROJECT, absent: 'hashes_unavailable' },
        defect: "both hashes and 'absent' in one 'project' source",
      },
      {
        what: 'an absent of another kind',
        kind: 'adapter',
        name: 'x',
        stated: { ...noHashes, absent: 'missing' },
        defect: "'absent' must be 'hashes_unavailable'",
      },
      {
        what: 'project with an extra key',
        kind: 'adapter',
        name: 'x',
        stated: { ...PROJECT, resolved: '/x.js' },
        defect: "an unknown key 'resolved'",
      },
      {
        what: 'absent project with an extra key',
        kind: 'adapter',
        name: 'x',
        stated: { ...noHashes, absent: 'hashes_unavailable', resolved: '/x.js' },
        defect: "an unknown key 'resolved'",
      },
    ];
    // (1) red, per cell, when that shape is accepted; (2) prints the code and the words, and whether
    //     the entry already under the name, and the names, are unchanged.
    it.each(CASES)(
      'refuses $what with VALIDATION_OPTION_INVALID; the registry is unchanged',
      (c) => {
        const r = new ExtensionRegistry();
        r.register(c.kind as 'adapter', c.name, stubAdapter);
        const before = r.entry(c.kind, c.name);
        const refusal = refusedBy(() =>
          r.register(c.kind as 'adapter', c.name, stubAdapter, c.stated as CodeSource),
        );
        expect({
          refusal,
          unchanged: r.entry(c.kind, c.name) === before,
          names: r.names(c.kind),
        }).toEqual({
          refusal: { code: 'VALIDATION_OPTION_INVALID', message: words(c.defect) },
          unchanged: true,
          names: [c.name],
        });
      },
    );
    // (1) red when `null` is refused; (2) prints the entry.
    it('source: null records host_registered, as no source does', () => {
      const r = new ExtensionRegistry();
      r.register('handler', 'h', stubHandler, null);
      expect(held(r, 'handler', 'h')?.source).toEqual({
        source: 'host_registered',
        ...codeTextOf(stubHandler),
      });
    });
    // (1) red when the caller's own source object is stored (or frozen in place), or the entry is not
    //     frozen; (2) prints what was checked.
    it("a stated source is stored as a frozen copy; the caller's object and the code object stay unfrozen", () => {
      const r = new ExtensionRegistry();
      const stated = { ...PROJECT };
      const impl = { ...stubHandler };
      r.register('handler', 'h', impl, stated);
      const e = r.entry('handler', 'h');
      expect({
        equal: e?.source,
        copy: e?.source !== stated,
        frozen: [Object.isFrozen(e), Object.isFrozen(e?.source)],
        unfrozen: [Object.isFrozen(stated), Object.isFrozen(impl)],
      }).toEqual({ equal: PROJECT, copy: true, frozen: [true, true], unfrozen: [false, false] });
    });
  });

  // (1) red when the fingerprint is taken at entry() rather than at register; (2) prints the source
  //     recorded and whether the change changed the fingerprint.
  it('check 4: register with no source records codeTextOf taken at that call', () => {
    const r = new ExtensionRegistry();
    const handler: Record<string, unknown> = { ...stubHandler };
    r.register('handler', 'h', handler as unknown as StepHandler);
    const atRegister = codeTextOf(handler);
    handler['limit'] = function limit() {
      return 1;
    };
    expect({
      recorded: r.entry('handler', 'h')?.source,
      changed: JSON.stringify(codeTextOf(handler)) !== JSON.stringify(atRegister),
    }).toEqual({ recorded: { source: 'host_registered', ...atRegister }, changed: true });
  });

  describe('check 5: copyEntry', () => {
    // (1) red when the copy goes through `register` (host_registered, or a refusal of built_in); (2)
    //     prints both entries and whether the code object is the same.
    it("keeps a project entry's source and a built_in one's", () => {
      const from = createDefaultRegistry();
      from.register('handler', 'mine', stubHandler, PROJECT);
      const to = new ExtensionRegistry();
      to.copyEntry(from, 'adapter', 'filesystem');
      to.copyEntry(from, 'handler', 'mine');
      expect({
        filesystem: held(to, 'adapter', 'filesystem'),
        mine: held(to, 'handler', 'mine'),
        same: to.getHandler('mine') === stubHandler,
      }).toEqual({
        filesystem: { source: { source: 'built_in' }, replaces: false },
        mine: { source: PROJECT, replaces: false },
        same: true,
      });
    });
    // (1) red when the missing name is copied as undefined; (2) prints the code, the words and what
    //     the copy holds.
    it('a name the other registry lacks is refused, nothing copied', () => {
      const to = new ExtensionRegistry();
      expect({
        refusal: refusedBy(() => to.copyEntry(new ExtensionRegistry(), 'handler', 'nope')),
        has: to.has('handler', 'nope'),
      }).toEqual({
        refusal: {
          code: 'VALIDATION_OPTION_INVALID',
          message: "copyEntry: the other registry holds no handler 'nope'. Nothing was copied.",
        },
        has: false,
      });
    });
    // (1) red when such a `from` is read through getHandler; (2) prints the code, the words and what
    //     the copy holds.
    it('a from with no entry() is refused, never read another way', () => {
      const duck = { getHandler: () => stubHandler, names: () => ['h'], has: () => true };
      const to = new ExtensionRegistry();
      expect({
        refusal: refusedBy(() =>
          to.copyEntry(duck as unknown as ExtensionRegistry, 'handler', 'h'),
        ),
        has: to.has('handler', 'h'),
      }).toEqual({
        refusal: {
          code: 'VALIDATION_OPTION_INVALID',
          message:
            'copyEntry: the other registry has no entry(), so it is not a registry of this Realm release. Nothing was copied.',
        },
        has: false,
      });
    });
    // (1) red when copyEntry skips the release-line check; (2) prints the code.
    it('a from of another Realm release is refused as every engine entry refuses one', () => {
      class ExtensionRegistryOfAnother {}
      brandClass(
        ExtensionRegistryOfAnother,
        Symbol.for('@sensigo/realm/ExtensionRegistry'),
        createRealmBrand('@sensigo/realm', '9.9.9', 'file:///tmp/other-realm/'),
      );
      const foreign = new ExtensionRegistryOfAnother() as unknown as ExtensionRegistry;
      const refusal = refusedBy(() => new ExtensionRegistry().copyEntry(foreign, 'handler', 'h'));
      expect(refusal === 'no throw' ? refusal : refusal.code).toBe('ENGINE_RELEASE_LINE_MISMATCH');
    });
  });
});
