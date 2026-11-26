// step-code-source-828.test.ts — #828 unit 2c (check 4, the CLI's cell): a project's module that
// replaces Realm's built-in `check_quotes`, loaded by the CLI's loader, runs a step, and that step's
// evidence entry records the project source 2b's loader stated, with `replaces_built_in: true` and no
// Realm version.
//
// A second cell runs the changelog's claim: a library reply's `evidence` entries and `realm run
// export`'s bundle carry the field as the store keeps it.
//
// The project is a temp folder with a `realm.yaml`; the module's handler is synthetic. Every
// assertion carries (1) the change that turns it red and (2) what it prints when it fails.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CURRENT_WORKFLOW_SCHEMA_VERSION, ExtensionRegistry, executeStep } from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';
import { InMemoryStore } from '@sensigo/realm-testing';
import { loadProjectExtensions, clearProjectExtensionsCache } from './load-project-extensions.js';
import { buildExportBundle } from '../commands/export.js';

let root: string;

beforeEach(() => {
  clearProjectExtensionsCache();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'realm-828-step-source-')));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', version: '1.0.0' }));
  writeFileSync(join(root, 'realm.yaml'), 'version: 1\n');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('#828 unit 2c check 4 — a project module in place of a built-in, end to end', () => {
  // (1) red when the attempt records no source, a duck's or Realm's own, `replaces_built_in` is read
  //     from anything but 2b's rule, or `realm_version` is set on a project's code; (2) prints the
  //     entry's whole code_source beside the registry entry's source.
  it("a project's check_quotes records 2b's project source and replaces_built_in", async () => {
    mkdirSync(join(root, 'ext'), { recursive: true });
    const file = `cq-${Date.now()}.js`;
    writeFileSync(
      join(root, 'ext', file),
      "export default { handlers: { check_quotes: { id: 'check_quotes', execute: async () => ({ data: { mine: true } }) } } };\n",
    );
    const definition: WorkflowDefinition = {
      id: `wf-828-step-source-${Date.now()}`,
      name: 'Step source WF',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        s: { description: 'S.', execution: 'auto', depends_on: [], handler: 'check_quotes' },
      },
      origin: 'human',
      source_dir: root,
      trust_root: root,
      extensions: [`./ext/${file}`],
    };
    const { registry } = await loadProjectExtensions(definition);
    const store = new InMemoryStore();
    const { record } = await store.create({
      workflowId: definition.id,
      workflowVersion: 1,
      params: {},
    });
    await executeStep(store, definition, {
      runId: record.id,
      command: 's',
      input: {},
      dispatcher: async () => ({}),
      registry,
    });
    const entry = (await store.get(record.id)).record.evidence.find((e) => e.step_id === 's');
    const stated = registry.entry('handler', 'check_quotes')?.source;
    expect({ output: entry?.output_summary, code_source: entry?.code_source, stated }).toEqual({
      output: { mine: true },
      code_source: { kind: 'handler', name: 'check_quotes', from: stated, replaces_built_in: true },
      stated: expect.objectContaining({
        source: 'project',
        via: 'extensions_file',
        declared: `./ext/${file}`,
      }),
    });
  });
});

describe('#828 unit 2c — the field reaches a library reply and the export, as stored', () => {
  // (1) red when the attempt's entry carries no field, or the export drops it before its walk;
  //     (2) prints the stored source beside the reply's and the export's.
  it("executeStep's reply and realm run export's bundle carry the entry's code_source", async () => {
    const registry = new ExtensionRegistry();
    registry.register('handler', 'h', { id: 'h', execute: async () => ({ data: { ok: true } }) });
    const definition: WorkflowDefinition = {
      id: `wf-828-step-source-export-${Date.now()}`,
      name: 'Export WF',
      version: 1,
      steps: { s: { description: 'S.', execution: 'auto', depends_on: [], handler: 'h' } },
    };
    const store = new InMemoryStore();
    const { record } = await store.create({
      workflowId: definition.id,
      workflowVersion: 1,
      params: {},
    });
    const reply = await executeStep(store, definition, {
      runId: record.id,
      command: 's',
      input: {},
      dispatcher: async () => ({}),
      registry,
    });
    const stored = (await store.get(record.id)).record.evidence.find((e) => e.step_id === 's');
    const { bundle } = await buildExportBundle(record.id, {
      runStore: store,
      failedAttemptStore: { read: async () => ({ records: [], capped: false }) },
      traceBufferStore: { readAllForRun: async () => ({}) },
    });
    const exported = bundle.run.evidence.find((e) => e.step_id === 's');
    expect({
      stored: stored?.code_source,
      reply: reply.evidence.find((e) => e.step_id === 's')?.code_source,
      exported: exported?.code_source,
    }).toEqual({
      stored: { kind: 'handler', name: 'h', from: registry.entry('handler', 'h')?.source },
      reply: stored?.code_source,
      exported: stored?.code_source,
    });
  });
});
