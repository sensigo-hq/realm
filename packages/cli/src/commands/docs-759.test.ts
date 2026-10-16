// docs-759.test.ts — issue #759 (Part G): every docs sentence this unit rewrites is quoted here word
// for word (read from the repository), and every example it regenerates is compared with a real
// run on this build — an MCP reply through `createRealmMcpServer`, a `realm run attempts` screen
// from the built `realm` (fresh HOME), a trace warning from the engine — its run ID and time put in
// the page's place. So neither the page nor the behaviour can change alone.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: the
// page's sentence or lines and the run's — key names, rules and counts, never a submitted value.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JsonFileStore,
  JsonWorkflowStore,
  executeStep,
  loadWorkflowFromString,
} from '@sensigo/realm';
import { createRealmMcpServer } from '@sensigo/realm-mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../../..');
const CLI = join(HERE, '../../dist/index.js');
const flat = (t: string): string => t.replace(/\s+/g, ' ');
const BLOCKS = 'docs/reference/workflow/json-schema-blocks.md';
const TOOLS = 'docs/reference/mcp/tools.md';
const READING = 'docs/reference/cli/realm-run-reading.md';

/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(page: string, sentence: string): void {
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

/** The page's fenced blocks, each without its fences, in page order. */
function blocks(page: string): string[] {
  return readFileSync(join(ROOT, page), 'utf8')
    .split(/^\s*```[a-z]*\n/m)
    .filter((_, i) => i % 2 === 1)
    .map((b) => b.replace(/\n\s*```[\s\S]*$/, ''));
}

/** The one block on the page that holds `marker`, its lines with the list indent removed. */
function blockWith(page: string, marker: string): string[] {
  const found = blocks(page).filter((b) => b.includes(marker));
  expect(found.length, `${page} has one block with: ${marker}`).toBe(1);
  const lines = found[0]!.split('\n');
  const indent = /^ */.exec(lines[0]!)![0].length;
  return lines.map((l) => l.slice(indent)).filter((l) => l !== '');
}

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/;

/** The triage of tools.md's and realm-run-reading.md's examples: `classify` checks its input. */
const TRIAGE = `id: triage
name: triage
version: 1
steps:
  classify:
    description: Classify.
    execution: agent
    input_schema:
      type: object
      required: [category, confidence, reason]
      properties:
        category: { enum: [billing, bug, other] }
        confidence: { type: number, minimum: 0, maximum: 1 }
        reason: { type: string }
  draft:
    description: Draft.
    execution: agent
    depends_on: [classify]
`;
/** Breaks three rules: `reason` missing, `category` not one of three, `confidence` above 1. */
const TRIAGE_ANSWER = { category: 'refund', confidence: 2 };

/** json-schema-blocks.md's thirteen-problem answer. */
const INTAKE = `id: ticket-intake
name: Ticket intake
version: 1
steps:
  extract:
    description: Extract the ticket's fields
    execution: agent
    output_schema:
      type: object
      required: [code, title, priority, area, reporter, product, version]
      properties:
        code: { type: string, pattern: "^[A-Z]+-[0-9]+$" }
        title: { type: string, minLength: 5 }
        priority: { enum: [low, normal, high] }
        area: { type: string }
        reporter: { type: string }
        product: { type: string }
        version: { type: string }
        estimate: { type: number, minimum: 0 }
        tags: { type: array, maxItems: 3, uniqueItems: true }
        due: { type: string, pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" }
        source: { const: email }
      additionalProperties: false
`;
const INTAKE_ANSWER = {
  code: 'abc',
  title: 'x',
  priority: 'urgent',
  estimate: -1,
  tags: ['a', 'a', 'b', 'c'],
  due: 'tomorrow',
  source: 'chat',
  note: 'n',
};

/**
 * One refused answer over MCP, in a fresh HOME whose runs folder the server's sidecar shares; then
 * `realm run attempts` (text and `--json`) from the built `realm` on that HOME.
 */
async function refuse(
  yaml: string,
  step: string,
  answer: Record<string, unknown>,
): Promise<{
  reply: Record<string, unknown>;
  runId: string;
  table: string[];
  json: Record<string, unknown>;
}> {
  const home = await mkdtemp(join(tmpdir(), 'realm-docs-759-'));
  try {
    const runStore = new JsonFileStore(join(home, '.realm', 'runs'));
    const workflowStore = new JsonWorkflowStore(join(home, '.realm', 'workflows'));
    const definition = loadWorkflowFromString(yaml);
    await workflowStore.register(definition);
    const server = createRealmMcpServer({ runStore, workflowStore });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'docs-759', version: '0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const call = async (name: string, args: Record<string, unknown>) =>
      JSON.parse(
        ((await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> })
          .content[0]!.text,
      ) as Record<string, unknown>;
    const started = await call('start_run', {
      workflow_id: definition.id,
      params: { ticket: 101 },
    });
    const runId = started['run_id'] as string;
    const reply = await call('execute_step', { run_id: runId, command: step, params: answer });
    await client.close();
    const realm = (args: string[]): string =>
      spawnSync(process.execPath, [CLI, ...args], {
        cwd: home,
        env: { PATH: process.env['PATH'] ?? '', HOME: home, NO_COLOR: '1' },
        encoding: 'utf8',
        timeout: 60_000,
      }).stdout;
    const table = realm(['run', 'attempts', runId])
      .split('\n')
      .filter((l) => l !== '');
    const json = JSON.parse(realm(['run', 'attempts', runId, '--json'])) as Record<string, unknown>;
    return { reply, runId, table, json };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

describe('issue #759 — json-schema-blocks.md', { timeout: 60_000 }, () => {
  it('the refusal bullet: every problem, up to 10, and the total — its `realm run attempts` example is a real run’s screen (reds: the old "first problem" sentence; a stale example)', async () => {
    // The wire clause ("the first 10 in `error_details.errors` and the total in `error_count`") is
    // pinned by execution in packages/mcp-server/src/tools/refusal-759.test.ts (ten rows,
    // `error_count: 13`); the printed `and N more` by this example and by run-agent.test.ts's
    // #759 cross cell (the repair message).
    claim(
      BLOCKS,
      "**A refusal names every problem found, up to 10, and gives the total.** The reply carries the first 10 in `error_details.errors` and the total in `error_count`; `realm run attempts` and `realm agent`'s repair message print the 10 and `and N more`:",
    );
    const page = blockWith(BLOCKS, '13 problems');
    const { table, runId } = await refuse(INTAKE, 'extract', INTAKE_ANSWER);
    const shownTime = ISO.exec(page[0]!)![0];
    const run = table
      .slice(table.findIndex((l) => l.includes('extract')))
      .map((l) => l.replace(ISO, shownTime).replaceAll(runId, '<id>'));
    expect(run).toEqual(page);
  });

  it('the bound sentence: every rule is checked, so string fields get a `maxLength` and lists a `maxItems` (red: the sentence dropped)', () => {
    // "Realm checks an answer against every rule of its schema" is pinned by execution in
    // packages/core/src/validation/input-schema.test.ts ("A: nine required fields …").
    claim(
      BLOCKS,
      '**Every rule is checked, so bound what an answer may hold.** Realm checks an answer against every rule of its schema, not only up to the first one it breaks.',
    );
    claim(BLOCKS, 'give string fields a `maxLength` and lists a `maxItems`.');
  });

  it('the trace warning example is the engine’s own line for one entry — the root violation in the pointer words — and the count sentence holds (reds: the old bare message; a stale example)', async () => {
    const page = blockWith(BLOCKS, 'Trace schema violation for step');
    const step = /```yaml\n(research:[\s\S]*?)```/.exec(readFileSync(join(ROOT, BLOCKS), 'utf8'))!;
    // the page's step, in the default mode it was called in
    const research = loadWorkflowFromString(
      `id: t\nname: t\nversion: 1\nsteps:\n${step[1]!
        .split('\n')
        .filter((l) => !l.includes('trace_validation_mode'))
        .map((l) => `  ${l}`)
        .join('\n')}`,
    );
    const store = new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-docs-759-trace-')));
    const { run } = await store.create({ workflowId: 't', workflowVersion: 1, params: {} });
    const reply = await executeStep(store, research, {
      runId: run.id,
      command: 'research',
      input: { answer: 'x' },
      dispatcher: async (_name, input) => ({ ...input }),
      trace: [{ event: 'searched' }],
    });
    expect({
      status: reply.status,
      warning: (reply.warnings ?? []).filter((w) => w.startsWith('Trace schema violation')),
    }).toEqual({ status: 'ok', warning: page });
    // "names every violation, up to 10, then `and N more`" and the true count are pinned by
    // execution in input-schema.test.ts ("G: the trace warning names ten violations …", "G: through
    // the engine, … `validation_errors: 13`").
    claim(
      BLOCKS,
      "The warning names every violation, up to 10, then `and N more`, and `validation_errors` in the step's trace summary is the number of violations found (added after version 0.47.0, whose check stopped at the first violation, so a run it recorded can count fewer).",
    );
  });
});

describe('issue #759 — tools.md', { timeout: 60_000 }, () => {
  it('the refused-answer row: the rules broken, up to 10, with the total in `error_count` (red: the old row)', () => {
    claim(
      TOOLS,
      '| The answer does not fit the step\'s schema | `error` | `error_code: "VALIDATION_INPUT_SCHEMA"`, `agent_action: "provide_input"`, and in `error_details` the rules broken (up to 10, with the total in `error_count`), and for an agent step `rejections` and `threshold`. |',
    );
  });

  it('"A refused answer:" is a real reply, field by field — three rules, `error_count`, the countdown (red: a stale example)', async () => {
    const found = blocks(TOOLS).filter(
      (b) => b.includes('"error_code": "VALIDATION_INPUT_SCHEMA"') && b.includes('"error_count"'),
    );
    expect(found.length, 'the page has one "A refused answer" example').toBe(1);
    const example = JSON.parse(found[0]!) as Record<string, unknown>;
    const { reply, runId } = await refuse(TRIAGE, 'classify', TRIAGE_ANSWER);
    const fields = [
      'command',
      'run_version',
      'status',
      'errors',
      'error_code',
      'error_details',
      'agent_action',
      'context_hint',
      'run_phase',
    ];
    expect({
      ...Object.fromEntries(fields.map((f) => [f, reply[f]])),
      run_id: reply['run_id'] === runId ? example['run_id'] : reply['run_id'],
    }).toEqual({
      ...Object.fromEntries(fields.map((f) => [f, example[f]])),
      run_id: example['run_id'],
    });
  });
});

describe('issue #759 — realm-run-reading.md (realm run attempts)', { timeout: 60_000 }, () => {
  it('the sentence: the count on the line, every rule below it, `and N more`, the floor for older records (red: the old `(+N more)` sentence)', () => {
    // Pinned by execution in attempts.test.ts ("13 problems → …", "a record written before #759 …").
    claim(
      READING,
      "Each answer's first line holds the time, the step, the error code, how many fields the answer had, and how many problems it had. Below it come every rule it broke, up to 10, each with the field that broke it, and `and N more` when it broke more. An answer recorded by version 0.47.0 or earlier does not hold its total, so its count reads `≥N problems` when there may have been more.",
    );
  });

  it('the screen and the `--json` record are a real run’s, its ID and time put in the page’s place (red: a stale example)', async () => {
    const screen = blockWith(READING, '3 problems');
    const record = JSON.parse(
      blocks(READING).find((b) => b.includes('"records"') && b.includes('"error_count": 3'))!,
    ) as { records: Array<Record<string, unknown>> };
    const shownId = record.records[0]!['run_id'] as string;
    const shownTime = record.records[0]!['ts'] as string;
    const { table, json, runId } = await refuse(TRIAGE, 'classify', TRIAGE_ANSWER);
    const put = (t: string): string => t.replaceAll(runId, shownId).replace(ISO, shownTime);
    expect(table.map(put)).toEqual(screen);
    expect(JSON.parse(put(JSON.stringify(json)))).toEqual(record);
  });
});

describe('issue #759 — CHANGELOG.md', () => {
  it('each bullet sits under its own heading of [Unreleased] (red: a bullet under the wrong heading)', () => {
    const text = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
    const from = text.indexOf('## [Unreleased]');
    const unreleased = text.slice(from, text.indexOf('\n## [', from + 1));
    const section = (heading: string): string => {
      const start = unreleased.indexOf(`\n### ${heading}\n`);
      const end = unreleased.indexOf('\n### ', start + 1);
      return flat(unreleased.slice(start, end === -1 ? undefined : end));
    };
    expect({
      fixed: section('Fixed').includes(
        '**A refused answer names every problem, not only the first (issue #759).**',
      ),
      added: section('Added').includes(
        '**`error_count`: the total number of problems a refusal found (issue #759).**',
      ),
      changed: section('Changed').includes(
        '**`realm run attempts` prints every problem of a refused answer (issue #759).**',
      ),
      breaking: section('Changed').includes(
        "**BREAKING — for programs:** the rules a validation refusal broke moved to the error's typed facts (issue #759).",
      ),
      forPrograms: section('Added').includes('For programs: `ValidationErrorFacts`'),
    }).toEqual({ fixed: true, added: true, changed: true, breaking: true, forPrograms: true });
  });
});
