// issue #620 PR-C — the use sites U1 (adapter), U2 (handler), U7 (dispatcher): each kind of
// unrecognised value, plus the hostile throws the old catches could not print.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeChain } from './execution-loop.js';
import type { StepDispatcher } from './execution-loop.js';
import { JsonFileStore } from '../store/json-file-store.js';
import { createDefaultRegistry } from '../extensions/default-registry.js';
import { REALM_BRAND, brandClass, createRealmBrand } from '../brand.js';
import { fileURLToPath } from 'node:url';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

const OTHER = createRealmBrand('@sensigo/realm', '9.9.9', 'file:///tmp/other-realm/');

function foreignError(): Error {
  class WorkflowError extends Error {
    code = 'SERVICE_RATE_LIMITED';
  }
  brandClass(WorkflowError, Symbol.for('@sensigo/realm/WorkflowError'), OTHER);
  return new WorkflowError('rate limited');
}
function unbrandedError(): Error {
  class WorkflowError extends Error {
    code = 'SERVICE_RATE_LIMITED';
  }
  return new WorkflowError('rate limited');
}
const hostileToString = {
  toString(): string {
    throw new Error('no');
  },
};

const handlerDef: WorkflowDefinition = {
  id: 'u2-wf',
  name: 'U2',
  version: 1,
  steps: { a: { description: 'a', execution: 'auto', handler: 'h', depends_on: [] } },
};
const adapterDef: WorkflowDefinition = {
  id: 'u1-wf',
  name: 'U1',
  version: 1,
  services: { svc: { adapter: 'ad', trust: 'engine_delivered' } } as never,
  steps: { a: { description: 'a', execution: 'auto', uses_service: 'svc', depends_on: [] } },
};
const dispatchDef: WorkflowDefinition = {
  id: 'u7-wf',
  name: 'U7',
  version: 1,
  steps: { a: { description: 'a', execution: 'agent', depends_on: [] } },
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'realm-u-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function run(
  def: WorkflowDefinition,
  thrown: unknown,
): Promise<{ code: string | undefined; message: string; details: unknown }> {
  const store = new JsonFileStore(dir);
  const { run: r } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
  const registry = createDefaultRegistry();
  registry.register('handler', 'h', {
    id: 'h',
    execute: async () => {
      throw thrown;
    },
  } as never);
  registry.register('adapter', 'ad', {
    id: 'ad',
    fetch: async () => {
      throw thrown;
    },
  } as never);
  const dispatcher: StepDispatcher = async () => {
    throw thrown;
  };
  const env = await executeChain(store, def, {
    runId: r.id,
    command: 'a',
    input: {},
    dispatcher,
    registry,
  });
  return {
    code: env.error_code,
    message: env.errors.join('\n'),
    details: (env as { error_details?: unknown }).error_details,
  };
}

const SITES: Array<[string, WorkflowDefinition, string, string]> = [
  ['U1 adapter', adapterDef, 'ENGINE_ADAPTER_FAILED', "Adapter 'ad'"],
  ['U2 handler', handlerDef, 'ENGINE_HANDLER_FAILED', "Handler 'h'"],
  ['U7 dispatcher', dispatchDef, 'ENGINE_INTERNAL', "The dispatcher for step 'a'"],
];

const LOCAL_VERSION = REALM_BRAND.version;
const LOCAL_PATH = fileURLToPath(REALM_BRAND.url!).replace(/\/$/, '');
const TODAY: Record<string, (thrown: string) => string> = {
  ENGINE_ADAPTER_FAILED: (t) => `Adapter 'ad' threw: ${t}`,
  ENGINE_HANDLER_FAILED: (t) => `Handler 'h' threw: ${t}`,
  ENGINE_INTERNAL: (t) => `Dispatcher failed: ${t}`,
};

describe.each(SITES)('%s', (_name, def, code, role) => {
  it('foreign_line: ENGINE_RELEASE_LINE_MISMATCH, the whole message', async () => {
    const r = await run(def, foreignError());
    expect(r.code).toBe('ENGINE_RELEASE_LINE_MISMATCH');
    expect(r.message).toBe(
      `${role} threw a WorkflowError from realm 9.9.9 (/tmp/other-realm); this engine runs realm ${LOCAL_VERSION} (${LOCAL_PATH}). Realm objects do not cross versions, so its code 'SERVICE_RATE_LIMITED' and its retry setting were not used. Install @sensigo/realm@${LOCAL_VERSION} (and every other @sensigo package the project has, at ${LOCAL_VERSION}) in the project your code imports it from, or, when you run the realm command, run version 9.9.9 there: npm install --save-dev @sensigo/realm-cli@9.9.9, then npx realm.`,
    );
  });
  it('unbranded_copy: the site’s own code with the hedged clause, what was lost and the remedy, the whole message', async () => {
    const r = await run(def, unbrandedError());
    expect(r.code).toBe(code);
    expect(r.message).toBe(
      `${TODAY[code]!('rate limited')} — it looks like realm's WorkflowError by its class name but carries no release mark: an older realm copy that does not mark its classes, or another library's class of the same name. If it is realm's, its code 'SERVICE_RATE_LIMITED' and its retry setting were not used: install @sensigo/realm@${LOCAL_VERSION} (and every other @sensigo package the project has, at ${LOCAL_VERSION}) in the project your code imports it from, or, when you run the realm command, run the version the project has: npm install --save-dev @sensigo/realm-cli@<that version>, then npx realm (npm ls @sensigo/realm shows that version).`,
    );
  });
  it('not_realm: the site’s own code, unchanged text', async () => {
    const r = await run(def, new Error('plain'));
    expect(r.code).toBe(code);
    expect(r.message).not.toContain('release mark');
  });
  it('hostile: Object.create(null) gives the site’s own code and (unprintable value)', async () => {
    const r = await run(def, Object.create(null));
    expect(r.code).toBe(code);
    expect(r.message).toContain('(unprintable value)');
  });
  it('hostile: a throwing toString gives the site’s own code and (unprintable value)', async () => {
    const r = await run(def, hostileToString);
    expect(r.code).toBe(code);
    expect(r.message).toContain('(unprintable value)');
  });
});
