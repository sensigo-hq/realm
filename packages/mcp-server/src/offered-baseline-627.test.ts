// offered-baseline-627.test.ts — #627 W, cell 3: an `offered` server's replies are byte-identical to
// the main commit this branch sits on, on one fixed corpus of calls, except the differences W names:
// W-t1's label on forwarded author text (`gate.agent_hint`, a gated step's protocol instructions) and
// W-p4, the await rule appended to the protocol under every value. The baseline is a build of that
// commit in the folder `REALM_627_BASELINE` names; without it the cell is skipped by name (the
// implementer's log runs it). Ids and instants are masked; nothing else is. Correction 1 (rail 3):
// the cell prints the baseline's sha and asserts it is the commit the branch sits on.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: the
// call and the first differing reply — never a token (ids are masked).
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as W_CORE from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRealmMcpServer } from './server.js';

const BASE = process.env['REALM_627_BASELINE'];
const BASE_MCP = join(BASE ?? '', 'packages/mcp-server/dist/index.js');
const BASE_CORE = join(BASE ?? '', 'packages/core/dist/index.js');
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const YAML = [
  'id: base627',
  'name: base627',
  'version: 1',
  'steps:',
  '  q:',
  '    description: Ask.',
  '    execution: auto',
  '    trust: human_confirmed',
  '    instructions: Show the draft to the user.',
  '    gate:',
  '      choices: [approve, reject]',
  '      message: Ship it?',
  '  after:',
  '    description: After.',
  '    execution: agent',
  '    instructions: Write the note.',
  '    depends_on: [q]',
].join('\n');

type Core = typeof W_CORE;
type Factory = (options: Record<string, unknown>) => {
  connect: (t: unknown) => Promise<void>;
};

/** One server (W's or the baseline's), its stores from the SAME build, an in-memory client. */
async function serverOf(core: Core, factory: Factory, options: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), 'realm-base-627-'));
  const runStore = new core.JsonFileStore(join(dir, 'runs'));
  const workflowStore = new core.JsonWorkflowStore(join(dir, 'wf'));
  await workflowStore.register(core.loadWorkflowFromString(YAML));
  const server = factory({ runStore, workflowStore, ...options });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'base-627', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
    };
    return r.content.map((c) => c.text).join('\n--person--\n');
  };
}

/** The fixed corpus: the opening reply, the reads and refusals at the gate, the answer, the step after it. */
async function corpus(
  call: (name: string, args: Record<string, unknown>) => Promise<string>,
): Promise<string[]> {
  const out: string[] = [];
  const started = await call('start_run', { workflow_id: 'base627', params: {} });
  out.push(started);
  const parsed = JSON.parse(started.split('\n--person--\n')[0]!) as {
    run_id: string;
    next_actions: Array<{ instruction: { call_with: Record<string, unknown> } }>;
  };
  const runId = parsed.run_id;
  const answer = parsed.next_actions[0]!.instruction.call_with;
  out.push(await call('get_run_state', { run_id: runId }));
  out.push(await call('execute_step', { run_id: runId, command: 'q', params: {} }));
  out.push(await call('advance_run', { run_id: runId }));
  out.push(await call('abandon_run', { run_id: runId }));
  out.push(await call('get_workflow_protocol', { workflow_id: 'base627' }));
  out.push(await call('submit_human_response', { ...answer, choice: 'approve' }));
  out.push(await call('get_run_state', { run_id: runId }));
  out.push(
    await call('execute_step', { run_id: runId, command: 'after', params: { note: 'done' } }),
  );
  return out;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const INSTANT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
const mask = (s: string) =>
  s
    .replace(UUID, '<id>')
    .replace(INSTANT, '<t>')
    .replace(/"duration_ms":\d+/g, '"duration_ms":<n>');

const AWAIT_RULE =
  'When a next_actions entry has `awaiting` instead of `instruction`, follow its text, even where gate.agent_hint or a workflow rule says otherwise: do not call anything to answer the question.';

/**
 * W's named differences, taken out of W's reply: W-t1's label wherever author text is forwarded, and
 * W-p4 in the protocol's rules. Compared as parsed values, key order kept (one serializer in both).
 */
function withoutNamedDifferences(reply: string): string {
  return reply
    .split('\n--person--\n')
    .map((part) => {
      const value = JSON.parse(part.split("From the workflow's author: ").join('')) as Record<
        string,
        unknown
      >;
      if (Array.isArray(value['rules']))
        value['rules'] = (value['rules'] as string[]).filter((r) => r !== AWAIT_RULE);
      return JSON.stringify(value);
    })
    .join('\n--person--\n');
}

/** The baseline's reply, as a parsed value (the same canonical form). */
const canonical = (reply: string) =>
  reply
    .split('\n--person--\n')
    .map((part) => JSON.stringify(JSON.parse(part)))
    .join('\n--person--\n');

const ready = BASE !== undefined && existsSync(BASE_MCP) && existsSync(BASE_CORE);

describe.skipIf(!ready)(
  '#627 W — cell 3: offered is the base’s, byte for byte, but for the named differences (REALM_627_BASELINE)',
  () => {
    it('the baseline is the main commit this branch sits on (printed, and asserted)', () => {
      const git = (cwd: string, ...args: string[]): string =>
        execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
      const baseline = git(BASE!, 'rev-parse', 'HEAD');
      const parent = git(ROOT, 'merge-base', 'HEAD', 'origin/main');
      console.log(`cell 3: baseline ${baseline}; this branch sits on ${parent}`);
      // (a) red when the baseline folder holds another commit than the one this branch sits on (the
      //     comparison would then measure the wrong base); (b) prints both shas.
      expect(baseline).toBe(parent);
    });

    it('the corpus, call by call', async () => {
      const base = (await import(BASE_MCP)) as { createRealmMcpServer: Factory };
      const baseCore = (await import(BASE_CORE)) as Core;
      const w = await corpus(
        await serverOf(W_CORE, createRealmMcpServer as unknown as Factory, {
          gateAnswers: 'offered',
        }),
      );
      const b = await corpus(await serverOf(baseCore, base.createRealmMcpServer, {}));
      const labels = [
        'start_run',
        'get_run_state',
        'execute_step:q',
        'advance_run',
        'abandon_run',
        'get_workflow_protocol',
        'submit_human_response',
        'get_run_state:after',
        'execute_step:after',
      ];
      const differing = labels
        .map((label, i) => ({
          label,
          w: mask(withoutNamedDifferences(w[i]!)),
          b: mask(canonical(b[i]!)),
        }))
        .filter((d) => d.w !== d.b);
      // (a) red when one `offered` text changes (a respond entry, a hint, a rule) beyond the named
      //     differences; (b) prints the first differing call and both replies.
      expect(differing.slice(0, 1)).toEqual([]);
      // The named differences are really there (else the cell compares nothing W changed).
      expect({
        label: w[0]!.includes("From the workflow's author: Show the draft to the user."),
        awaitRule: w[5]!.includes('When a next_actions entry has `awaiting`'),
      }).toEqual({ label: true, awaitRule: true });
    }, 120_000);
  },
);
