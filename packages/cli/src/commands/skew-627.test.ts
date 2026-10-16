// skew-627.test.ts — #627 W, cell 6 (skew; the sort's row 18: the owner's machines upgrade at
// different times, one store between them). Against the PUBLISHED tarballs — 0.47.0, and 0.46.0,
// which the Mac still runs — installed under the folder `REALM_627_PUBLISHED` names
// (`v0.47.0/node_modules/.bin/realm`, `v0.46.0/…`): the suite has no network, so without it the
// cell is skipped by name; the implementer's log runs it.
//   (a) an answer a published version wrote reads in W as `recorded_without_route`;
//   (b) an answer W wrote reads in each published version exactly as it reads with W's fields
//       deleted — `realm run inspect`, `realm run list` and `get_run_state` print the same.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: the
// versions and the differing lines — never a token.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JsonFileStore,
  JsonWorkflowStore,
  advanceRun,
  loadWorkflowFromString,
} from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const W_CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const PUBLISHED = process.env['REALM_627_PUBLISHED'];
const VERSIONS = ['0.47.0', '0.46.0'] as const;
const binOf = (v: string, name: 'realm' | 'realm-mcp') =>
  join(PUBLISHED ?? '', `v${v}`, 'node_modules', '.bin', name);

const YAML = [
  'id: skew627',
  'name: skew627',
  'version: 1',
  'steps:',
  '  q:',
  '    description: Ask.',
  '    execution: auto',
  '    trust: human_confirmed',
  '    gate:',
  '      choices: [approve, reject]',
  '      message: Ship it?',
  '  after:',
  '    description: After.',
  '    execution: agent',
  '    depends_on: [q]',
].join('\n');

async function opened() {
  const home = mkdtempSync(join(tmpdir(), 'realm-skew-627-'));
  const def = loadWorkflowFromString(YAML);
  await new JsonWorkflowStore(join(home, '.realm', 'workflows')).register(def);
  const store = new JsonFileStore(join(home, '.realm', 'runs'));
  const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
  await advanceRun(store, def, { runId: run.id });
  return { home, runId: run.id, gateId: (await store.get(run.id)).pending_gate!.gate_id };
}

function run(command: string, args: string[], home: string) {
  const r = spawnSync(
    command.endsWith('.js') ? process.execPath : command,
    command.endsWith('.js') ? [command, ...args] : args,
    {
      env: { PATH: process.env['PATH'] ?? '', HOME: home },
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
  return { code: r.status, out: r.stdout.split(home).join('<home>') };
}

async function runState(v: string, home: string, runId: string): Promise<string> {
  const client = new Client({ name: 'skew-627', version: '0' });
  await client.connect(
    new StdioClientTransport({
      command: binOf(v, 'realm-mcp'),
      args: [],
      env: { PATH: process.env['PATH'] ?? '', HOME: home },
      stderr: 'pipe',
    }),
  );
  try {
    const r = (await client.callTool({ name: 'get_run_state', arguments: { run_id: runId } })) as {
      content: Array<{ text: string }>;
    };
    return r.content[0]!.text.split(home).join('<home>');
  } finally {
    await client.close();
  }
}

const ready = PUBLISHED !== undefined && VERSIONS.every((v) => existsSync(binOf(v, 'realm')));

describe.skipIf(!ready)(
  '#627 W — cell 6: skew against the published tarballs (REALM_627_PUBLISHED)',
  () => {
    it.each(VERSIONS)(
      '(a) an answer %s wrote reads in W as recorded_without_route',
      async (v) => {
        const h = await opened();
        const answered = run(
          binOf(v, 'realm'),
          ['run', 'respond', h.runId, '--gate', h.gateId, '--choice', 'approve'],
          h.home,
        );
        const line = run(W_CLI, ['run', 'inspect', h.runId], h.home)
          .out.split('\n')
          .find((l) => l.trim().startsWith('Answer:'));
        // (a) red when W reads an old entry as having a route, or omits the typed absence; (b) prints
        //     the exit and the line.
        expect({ code: answered.code, line: line?.trim() }).toEqual({
          code: 0,
          line: "Answer: approve · answered by (not stated) · how it arrived was not recorded · token: none passed (only an answer through Realm's MCP answer tool, from the conversation that opened the question, can pass one)",
        });
      },
      120_000,
    );

    it.each(VERSIONS)(
      '(b) an answer W wrote reads in %s exactly as it reads with W’s fields deleted (inspect, list, get_run_state)',
      async (v) => {
        const h = await opened();
        const answered = run(
          W_CLI,
          ['run', 'respond', h.runId, '--gate', h.gateId, '--choice', 'approve', '--by', 'alice'],
          h.home,
        );
        expect(answered.code).toBe(0);
        // The same record with W's answer fields deleted, in a second HOME.
        const bare = mkdtempSync(join(tmpdir(), 'realm-skew-627-bare-'));
        cpSync(join(h.home, '.realm'), join(bare, '.realm'), { recursive: true });
        const file = join(bare, '.realm', 'runs', `${h.runId}.json`);
        const record = JSON.parse(readFileSync(file, 'utf8')) as {
          evidence: Array<Record<string, unknown>>;
        };
        for (const e of record.evidence) {
          if (e['kind'] !== 'gate_response') continue;
          delete e['answer'];
          delete e['principal'];
          delete e['client_prompt_requested'];
          delete e['driven_by'];
        }
        writeFileSync(file, JSON.stringify(record, null, 2));
        const view = (home: string) => ({
          inspect: run(binOf(v, 'realm'), ['run', 'inspect', h.runId], home).out.replace(
            home,
            '<home>',
          ),
          list: run(binOf(v, 'realm'), ['run', 'list'], home).out.replace(home, '<home>'),
        });
        const withW = { ...view(h.home), state: await runState(v, h.home, h.runId) };
        const without = {
          ...view(bare),
          state: (await runState(v, bare, h.runId)).split(bare).join('<home>'),
        };
        // `get_run_state` returns the record's evidence raw on neither version, so its reply is compared
        // whole; a timestamp the two reads stamp differently is masked.
        const masked = (s: string) =>
          s.replace(/"as_of":"[^"]+"/g, '"as_of":"<t>"').replace(/\d+m ago/g, '<age>');
        // (a) red when a W field changes what a published version prints (a route fact in
        //     output_summary or evidence a reader renders); (b) prints both outputs.
        expect({
          inspect: masked(withW.inspect),
          list: masked(withW.list),
          state: masked(withW.state),
        }).toEqual({
          inspect: masked(without.inspect),
          list: masked(without.list),
          state: masked(without.state),
        });
      },
      180_000,
    );
  },
);
