// #729 PR-3 (RECORD 05 "the proof", its second check): the table-generated suite over the MCP door's
// own tables. A distinct fake canary is planted in every value-, bounded- and question-classed field
// of every table; the generated reply goes through `toolContentOf` for the agent; each canary may
// appear only where the record allows it — an environment canary in question text, whole (R2).
// Failures print field paths and booleans, never a canary.
import { describe, it, expect } from 'vitest';
import {
  compileDisclosure,
  type ClassTable,
  type DisclosureClass,
  type DisclosureEntry,
} from '@sensigo/realm';
import { MCP_ENVELOPE_TABLE, toolContentOf } from './render-reply.js';
import { ABANDON_RUN_TABLE } from './tools/abandon-run.js';
import { APPEND_TRACE_TABLE } from './tools/append-trace.js';
import { LIST_WORKFLOWS_TABLE } from './tools/list-workflows.js';
import { WORKFLOW_PROTOCOL_TABLE } from './tools/get-workflow-protocol.js';
import { RUN_STATE_SUMMARY_TABLE } from './tools/get-run-state.js';
import { START_RUN_TABLE } from './tools/start-run.js';
import { START_RUN_BATCH_TABLE } from './tools/start-run-batch.js';

interface Planted {
  path: string;
  cls: 'value' | 'bounded' | 'question';
  env: string;
  declared: string;
}

function generate(table: ClassTable, path: string, planted: Planted[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, row] of Object.entries(table)) {
    out[key] = generateRow(row, path === '' ? key : `${path}.${key}`, planted);
  }
  return out;
}

function generateRow(row: DisclosureClass, path: string, planted: Planted[]): unknown {
  if (row === 'fact' || row === 'frozen') return `fact-of-${path}`;
  if (row === 'value' || row === 'bounded' || row === 'question') {
    const n = planted.length;
    const env = `FAKEMCPENV${String(n).padStart(4, '0')}`;
    const declared = `FAKEMCPDEC${String(n).padStart(4, '0')}`;
    planted.push({ path, cls: row, env, declared });
    return `text ${env} and ${declared} end`;
  }
  // #729 PR-3 correction 2 (E-11''): a row chosen by its value. A planted text holds run values, so
  // the row must mask it as a diagnostic copy: it is planted as `bounded`, whatever the row says.
  if ('choose' in row) return generateRow('bounded', path, planted);
  if ('map' in row) {
    const table = typeof row.map === 'function' ? row.map({ kind: 'guard_abort' }) : row.map;
    return { some_key: generate(table, `${path}.some_key`, planted) };
  }
  const table = typeof row.nested === 'function' ? row.nested({}) : row.nested;
  return [generate(table, path, planted)];
}

const TABLES: Record<string, ClassTable> = {
  MCP_ENVELOPE_TABLE,
  ABANDON_RUN_TABLE,
  APPEND_TRACE_TABLE,
  LIST_WORKFLOWS_TABLE,
  WORKFLOW_PROTOCOL_TABLE,
  RUN_STATE_SUMMARY_TABLE,
  START_RUN_TABLE,
  START_RUN_BATCH_TABLE,
};

describe('#729 PR-3 — the table-generated suite over the MCP tables', () => {
  for (const [name, table] of Object.entries(TABLES)) {
    it(`${name}: no canary reaches the agent, except an environment canary in question text`, () => {
      const planted: Planted[] = [];
      const reply = generate(table, '', planted);
      const entries: DisclosureEntry[] = planted.flatMap((p) => [
        { value: p.env, source: `env:E_${p.path}` as const },
        { value: p.declared, source: `declared:D_${p.path}` as const },
      ]);
      const set = compileDisclosure(entries, {
        declared: 'resolved',
        audience: 'agent',
        environment: 'swept',
      }).set;
      const text = toolContentOf(reply, { set, audience: 'agent', table }).content[0]!.text;
      // (a) red when a value-, bounded- or question-classed row is shown raw (the walk skipped or
      //     the row reclassified as a fact), or question text gets the environment tier; (b)
      //     prints each planted field's path, class and two booleans. A table with no such row
      //     plants nothing and asserts nothing more.
      expect(
        planted.map((p) => ({
          path: p.path,
          cls: p.cls,
          env: text.includes(p.env),
          declared: text.includes(p.declared),
        })),
      ).toEqual(
        planted.map((p) => ({
          path: p.path,
          cls: p.cls,
          env: p.cls === 'question',
          declared: false,
        })),
      );
    });
  }

  it('non-vacuity: the tables together plant every class the walk masks', () => {
    const planted: Planted[] = [];
    for (const table of Object.values(TABLES)) generate(table, '', planted);
    // (a) red when the tables lose every row of a class; (b) prints the classes found.
    expect([...new Set(planted.map((p) => p.cls))].sort()).toEqual([
      'bounded',
      'question',
      'value',
    ]);
  });
});
