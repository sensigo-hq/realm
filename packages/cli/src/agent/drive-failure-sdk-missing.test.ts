// drive-failure-sdk-missing.test.ts — a missing provider SDK is RECORDED, not fatal (issue #401).
//
// This is the failure the old `process.exit(1)` made structurally unrecordable: the process died
// inside the provider, before any catch in `runAgent` could write down what happened. The run then
// read healthy for 24 hours.
//
// Both SDKs are installed devDependencies, so the import catch is unreachable naturally — the
// module mock is what makes the path drivable. The provider's catch is BARE (`catch {}`), so
// nothing here asserts on what it caught; what matters is what it throws NEXT.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import { ExtensionRegistry } from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';
import { runAgent } from './run-agent.js';
import { OpenAIProvider } from './providers/openai-provider.js';

vi.mock('openai', () => {
  throw new Error('simulated: the openai package is not installed');
});

const WF = {
  id: 'sdk-missing-wf',
  name: 'SDK Missing',
  version: 1,
  schema_version: 1,
  steps: {
    classify: {
      description: 'Classify',
      execution: 'agent',
      depends_on: [],
      input_schema: { type: 'object', properties: { summary: { type: 'string' } } },
    },
  },
} as unknown as WorkflowDefinition;

describe('#401 — a missing SDK is recorded rather than fatal', () => {
  it('records sdk_missing WITH the step name, and preserves the message the exit path printed', async () => {
    const store = new InMemoryStore();
    // Deterministic across launch contexts: makes the sanitizer's npm-metadata exclusion the
    // thing under test, rather than whether npm happened to export the variable.
    vi.stubEnv('npm_package_name', 'realm');
    process.env['OPENAI_API_KEY'] = 'sk-test-sdk-missing-0000';
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const result = await runAgent(
        {
          store,
          workflowStore: {
            register: async () => {},
            get: async () => {
              throw new Error('not registered');
            },
            list: async () => [],
          },
          provider: new OpenAIProvider('gpt-4o'),
          registry: new ExtensionRegistry(),
        } as never,
        { definition: WF, params: {} },
      );

      // Routed through chokepoint (1)/(2), so it returns 'failed' rather than escaping — which is
      // why the step name is known here and would not have been at the last-resort catch.
      expect(result).toBe('failed');

      const runs = await store.list();
      const run = await store.get(runs[0]!.id);
      expect(run.drive_failures?.entries).toHaveLength(1);
      const entry = run.drive_failures!.entries[0]!;

      expect(entry.error_class).toBe('sdk_missing');
      expect(entry.step).toBe('classify');
      // The payload's genuine 0 survives — nothing substitutes a measured elapsed for it.
      expect(entry.elapsed_ms).toBe(0);
      // The message the removed `process.exit` path used to print, asserted WHOLE.
      //
      // `npm_package_name` is stubbed above rather than relied upon: under a bare `npx vitest`
      // no npm_* variable exists at all, and this assertion would then pass against the UNFIXED
      // sanitizer — green for a reason that has nothing to do with the fix.
      expect(entry.message).toBe(
        'realm agent requires the openai package. Run: npm install openai',
      );
    } finally {
      delete process.env['OPENAI_API_KEY'];
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }
  });
});
