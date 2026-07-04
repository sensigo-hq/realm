// H6: the TypeScript extension-module path exercised against fixture-stub `jiti` packages
// (tiny node_modules fixtures written into tmp project trees — jiti is NOT a dependency of
// any realm package; the loader resolves it from the CONSUMER project). Covers both
// published jiti export shapes: v2 (`createJiti(parent).import(path)`) and v1 (default
// factory returning a require-like function). The no-jiti actionable error is covered in
// load-project-extensions.test.ts.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowDefinition } from '@sensigo/realm';
import { CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import { loadProjectExtensions, clearProjectExtensionsCache } from './load-project-extensions.js';

/** The v2 shape: named `createJiti` export; `.import()` returns the module namespace.
 *  The stub "transpiles" by copying the .ts source (valid-JS subset) to an .mjs sibling. */
const JITI_V2_INDEX = `
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export function createJiti(parentPath) {
  return {
    async import(path) {
      const jsPath = path + '.stub.mjs';
      writeFileSync(jsPath, readFileSync(path));
      return await import(pathToFileURL(jsPath).href);
    },
  };
}
`;

/** The v1 shape: CJS default export is a factory returning a sync require-like function. */
const JITI_V1_INDEX = `
const { readFileSync } = require('fs');
module.exports = function jiti(parentPath, opts) {
  return function (path) {
    const src = readFileSync(path, 'utf8');
    const transformed = src.replace('export default', 'module.exports.default =');
    const m = { exports: {} };
    new Function('module', 'exports', transformed)(m, m.exports);
    return m.exports;
  };
};
`;

const TS_MODULE_SOURCE = `
export default {
  handlers: {
    ts_handler: { id: 'ts_handler', execute: async () => ({ data: { via: 'ts' } }) },
  },
};
`;

let proj: string;
let workflowDir: string;
let moduleCounter = 0;

beforeEach(() => {
  clearProjectExtensionsCache();
  proj = mkdtempSync(join(tmpdir(), 'realm-jiti-stub-'));
  workflowDir = join(proj, 'workflows', 'wf');
  mkdirSync(join(proj, 'dist'), { recursive: true });
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(join(proj, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
});

afterEach(() => {
  rmSync(proj, { recursive: true, force: true });
});

function installJitiStub(shape: 'v1' | 'v2'): void {
  const jitiDir = join(proj, 'node_modules', 'jiti');
  mkdirSync(jitiDir, { recursive: true });
  writeFileSync(
    join(jitiDir, 'package.json'),
    JSON.stringify(
      shape === 'v2'
        ? { name: 'jiti', version: '2.9.9-stub', type: 'module', main: 'index.js' }
        : { name: 'jiti', version: '1.21.0-stub', main: 'index.js' },
    ),
    'utf8',
  );
  writeFileSync(join(jitiDir, 'index.js'), shape === 'v2' ? JITI_V2_INDEX : JITI_V1_INDEX, 'utf8');
}

function writeTsModule(): string {
  const name = `registry-${Date.now()}-${moduleCounter++}.ts`;
  writeFileSync(join(proj, 'dist', name), TS_MODULE_SOURCE, 'utf8');
  return `../../dist/${name}`;
}

function makeDefinition(declared: string): WorkflowDefinition {
  return {
    id: 'jiti-wf',
    name: 'Jiti WF',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: { s1: { description: 'step', execution: 'agent' } },
    origin: 'human',
    extensions: [declared],
    source_dir: workflowDir,
    trust_root: proj,
  };
}

describe('TypeScript extension modules via consumer-resolved jiti (stub fixtures)', () => {
  it('loads a .ts module through the jiti v2 shape (createJiti().import)', async () => {
    installJitiStub('v2');
    const declared = writeTsModule();
    const { registry, manifest } = await loadProjectExtensions(makeDefinition(declared));
    const handler = registry.getHandler('ts_handler');
    expect(handler).toBeDefined();
    const result = await handler!.execute(
      { params: {} },
      { run_id: 'r', run_params: {}, config: {} },
    );
    expect(result.data).toEqual({ via: 'ts' });
    expect(manifest.handlers).toEqual(['ts_handler']);
  });

  it('loads a .ts module through the jiti v1 shape (default factory)', async () => {
    installJitiStub('v1');
    const declared = writeTsModule();
    const { registry, manifest } = await loadProjectExtensions(makeDefinition(declared));
    const handler = registry.getHandler('ts_handler');
    expect(handler).toBeDefined();
    const result = await handler!.execute(
      { params: {} },
      { run_id: 'r', run_params: {}, config: {} },
    );
    expect(result.data).toEqual({ via: 'ts' });
    expect(manifest.handlers).toEqual(['ts_handler']);
  });

  it('duck validation still applies to jiti-loaded modules (broken .ts export rejected)', async () => {
    installJitiStub('v2');
    const name = `broken-${Date.now()}-${moduleCounter++}.ts`;
    writeFileSync(join(proj, 'dist', name), `export default { handler: {} };`, 'utf8');
    await expect(loadProjectExtensions(makeDefinition(`../../dist/${name}`))).rejects.toThrow(
      /unknown key 'handler'/,
    );
  });
});
