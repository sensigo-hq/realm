// journey-627.test.ts — #627 W, cell 2, the journey scan (M-7): examples 03, 07, 08 and 09, each
// driven to its gate through THREE real `realm mcp --project` sessions (stdio) — `withheld`; `asked`
// with a test client that declares forms (it declines each form); `asked` without forms (the
// fallback) — then a fixed probe script on the run at its gate. Every string of every reply, and of
// the protocol, outside the author's own fields, is held to a CLOSED forbidden list; in the fallback
// session only the answer tool's name and the answer entry (its `call_with`, and its words naming the
// claim_token it passes back) are allowed — the rest of that entry's words are scanned. Every probe
// asserts its reply class (never ENGINE_INTERNAL) and the server's stderr holds ZERO W-e2 lines.
//
// 07/08/09 run against realm-testing's GitHub mock (09's Slack post against a local stand-in);
// nothing reaches a network. Every assertion carries (a) the change that turns it red and (b) what
// it prints on failure: the session, the probe and the forbidden string — never a token.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JsonFileStore, loadWorkflowFromFile, type WorkflowDefinition } from '@sensigo/realm';
import {
  loadFixtureFromFile,
  startGitHubMockServer,
  type GitHubMockServerHandle,
} from '@sensigo/realm-testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const CLI = join(ROOT, 'packages/cli/dist/index.js');
const EXAMPLES = join(ROOT, 'examples');

type Reply = Record<string, unknown>;
type Session = 'withheld' | 'forms' | 'fallback';

let github: GitHubMockServerHandle;
let slack: Server;
let slackUrl: string;

beforeAll(async () => {
  github = await startGitHubMockServer(
    join(ROOT, 'packages/core/src/adapters/fixtures/github-fixture-data.json'),
  );
  slack = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise<void>((resolve) => slack.listen(0, '127.0.0.1', () => resolve()));
  const addr = slack.address();
  slackUrl = `http://127.0.0.1:${typeof addr === 'object' && addr !== null ? addr.port : 0}/hook`;
});

afterAll(async () => {
  await github.close();
  await new Promise<void>((resolve) => slack.close(() => resolve()));
});

const ghManifest = () =>
  `version: 1\nadapters:\n  github:\n    use: github\n    config: { base_url: '${github.url}', auth: { token: 'test-token' } }\n`;

const CASES = [
  { dir: '03-incident-response', fixture: 'approved.yaml' },
  { dir: '07-issue-triage', fixture: 'approve-critical-issue.yaml', manifest: ghManifest },
  { dir: '08-pr-review', fixture: 'approve-pr.yaml', manifest: ghManifest },
  {
    dir: '09-webhook-pr-review',
    fixture: 'approve-review.yaml',
    manifest: () =>
      ghManifest() + `  slack:\n    use: slack\n    config: { webhook_url: '${slackUrl}' }\n`,
  },
] as const;

function realm(
  home: string,
  cwd: string,
  args: string[],
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, HOME: home },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });
}

function realParams(params: Record<string, unknown>, proj: string): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params).map(([k, v]) => [
      k,
      typeof v === 'string' && v.startsWith('/fake/') ? join(proj, v.slice('/fake/'.length)) : v,
    ]),
  );
}

/** The author's own fields, removed before the scan: their text is the author's, labelled (W-t1). */
function withoutAuthorText(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    if (key === 'rules') {
      const label = value.indexOf("Rules from the workflow's author:");
      const own = value.findIndex(
        (r) => typeof r === 'string' && r.startsWith('When a next_actions entry has `awaiting`'),
      );
      return label === -1 ? value : [...value.slice(0, label), ...value.slice(own)];
    }
    return value.map((v) => withoutAuthorText(v));
  }
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(
        ([k]) =>
          ![
            'instructions',
            'agent_hint',
            'display',
            'prompt',
            'description',
            'resolved_message',
            'gate_message',
            'preview',
            'data',
            'quick_start',
          ].includes(k),
      )
      .map(([k, v]) => [k, withoutAuthorText(v, k)]),
  );
}

/** The closed forbidden list over one reply (agent-facing JSON and the person block). */
function forbidden(session: Session, reply: Reply, person: string): string[] {
  const found: string[] = [];
  const scanned = withoutAuthorText(reply) as Reply;
  // The fallback's one allowance: the answer entry — its instruction (the tool's name, its
  // call_with and the token in it) and its own words about them, which name the tool and the
  // claim_token it passes back. Every other forbidden string is still looked for in those words.
  type Entry = { instruction?: { tool?: string } | null };
  const isAnswer = (a: Entry): boolean =>
    session === 'fallback' && a.instruction?.tool === 'submit_human_response';
  const entries = (scanned['next_actions'] as Entry[] | undefined) ?? [];
  const answerWords = JSON.stringify(
    entries.filter(isAnswer).map(({ instruction: _instruction, ...words }) => words),
  );
  const rest = JSON.stringify({ ...scanned, next_actions: entries.filter((a) => !isAnswer(a)) });
  const text = `${rest}\n${person}`;
  const all = `${text}\n${answerWords}`;
  const list: [string, boolean][] = [
    // The answer tool's NAME may be said anywhere in the fallback (its own texts tell the agent to
    // call it); a claim_token only inside the answer entry.
    ['submit_human_response', session !== 'fallback' && all.includes('submit_human_response')],
    ['claim_token', text.includes('claim_token')],
    ['Available choices', all.includes('Available choices')],
    ['run respond', all.includes('run respond')],
    ['present_question (not row 2)', session !== 'forms' && all.includes('present_question')],
  ];
  for (const [name, hit] of list) if (hit) found.push(name);
  const elsewhere =
    (reply['elsewhere'] as Array<{ verb?: string; operator_command?: unknown }> | undefined) ?? [];
  if (elsewhere.some((e) => e.verb === 'respond')) found.push('an elsewhere entry for respond');
  const also = (reply['also'] as Array<{ instruction?: { tool?: string } }> | undefined) ?? [];
  if (
    also.some(
      (a) =>
        a.instruction?.tool === 'submit_human_response' ||
        a.instruction?.tool === 'present_question',
    )
  ) {
    found.push('an also entry naming an answer way');
  }
  const callable = (
    (reply['next_actions'] as Array<{ instruction: unknown }> | undefined) ?? []
  ).some((a) => a.instruction !== null);
  if (reply['agent_action'] === 'resolve_precondition' && !callable)
    found.push('resolve_precondition without a callable way');
  return found;
}

describe('#627 W — cell 2: the journey scan over examples 03, 07, 08, 09 × three sessions', () => {
  for (const c of CASES) {
    for (const session of ['withheld', 'forms', 'fallback'] as const) {
      it(`${c.dir} · ${session}`, async () => {
        const home = mkdtempSync(join(tmpdir(), 'realm-journey-627-home-'));
        const proj = mkdtempSync(join(tmpdir(), 'realm-journey-627-proj-'));
        try {
          cpSync(join(EXAMPLES, c.dir), proj, { recursive: true });
          if ('manifest' in c) writeFileSync(join(proj, 'realm.yaml'), c.manifest());
          const reg = await realm(home, proj, [
            'workflow',
            'register',
            join(proj, 'workflow.yaml'),
          ]);
          expect(reg.code, reg.out).toBe(0);
          const fixture = loadFixtureFromFile(join(proj, 'fixtures', c.fixture));
          const def: WorkflowDefinition = loadWorkflowFromFile(join(proj, 'workflow.yaml'));
          const client = new Client(
            { name: 'journey-627', version: '0' },
            session === 'forms' ? { capabilities: { elicitation: { form: {} } } } : {},
          );
          if (session === 'forms')
            client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'decline' }));
          const transport = new StdioClientTransport({
            command: process.execPath,
            args: [
              CLI,
              'mcp',
              '--project',
              proj,
              ...(session === 'withheld' ? ['--gate-answers', 'withheld'] : []),
            ],
            cwd: proj,
            env: { ...process.env, HOME: home } as Record<string, string>,
            stderr: 'pipe',
          });
          let stderr = '';
          transport.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
          await client.connect(transport);
          const results: { probe: string; class: string; found: string[] }[] = [];
          try {
            const call = async (probe: string, name: string, args: Reply): Promise<Reply> => {
              const r = (await client.callTool({ name, arguments: args })) as {
                content: Array<{ text?: string }>;
                isError?: boolean;
              };
              const reply = JSON.parse(r.content[0]?.text ?? '{}') as Reply;
              const person = r.content[1]?.text ?? '';
              results.push({
                probe,
                class:
                  reply['error_code'] === 'ENGINE_INTERNAL'
                    ? 'internal_error'
                    : String(reply['status'] ?? (r.isError === true ? 'tool_error' : 'none')),
                found: forbidden(session, reply, person),
              });
              return reply;
            };
            // Drive to the gate, calling only what next_actions names (an await entry stops it).
            let reply = await call('start_run', 'start_run', {
              workflow_id: def.id,
              params: realParams(fixture.params ?? {}, proj),
              idempotency_key: 'journey',
            });
            const runId = String(reply['run_id']);
            for (let i = 0; i < 20; i++) {
              const action = (
                reply['next_actions'] as
                  Array<{ instruction: { tool: string; call_with: Reply } | null }> | undefined
              )?.[0];
              if (action === undefined || action.instruction === null) break;
              const { tool, call_with } = action.instruction;
              if (tool === 'submit_human_response' || tool === 'present_question') break;
              const args: Reply = { ...call_with };
              if (tool === 'execute_step')
                args['params'] = fixture.agent_responses?.[call_with['command'] as string] ?? {};
              reply = await call(`drive:${tool}`, tool, args);
            }
            const store = new JsonFileStore(join(home, '.realm', 'runs'));
            const atGate = await store.get(runId);
            expect(atGate.pending_gate, `${c.dir} reached its gate`).toBeDefined();
            const gate = atGate.pending_gate!;
            const downstream = Object.entries(def.steps).find(([, s]) =>
              s.depends_on?.includes(gate.step_name),
            )?.[0];
            // The fixed probe script.
            await call('get_run_state', 'get_run_state', { run_id: runId });
            await call('get_run_state+steps', 'get_run_state', {
              run_id: runId,
              include_steps: true,
            });
            await call('execute_step:gate', 'execute_step', {
              run_id: runId,
              command: gate.step_name,
              params: {},
            });
            if (downstream !== undefined) {
              await call('execute_step:downstream', 'execute_step', {
                run_id: runId,
                command: downstream,
                params: {},
              });
            }
            await call('advance_run', 'advance_run', { run_id: runId });
            await call('abandon_run:refused', 'abandon_run', { run_id: runId });
            // The one probe that reaches the gate-mismatch tail on a door without the answer tool:
            // present_question for a gate that is not the open one (`gate_not_open`; row 2 only).
            if (session === 'forms')
              await call('present_question:other-gate', 'present_question', {
                run_id: runId,
                gate_id: 'not-the-open-gate',
              });
            await call('start_run:deduped', 'start_run', {
              workflow_id: def.id,
              params: realParams(fixture.params ?? {}, proj),
              idempotency_key: 'journey',
            });
            await call('start_run_batch', 'start_run_batch', {
              workflow_id: def.id,
              items: [{ params: realParams(fixture.params ?? {}, proj) }],
            });
            await call('get_workflow_protocol', 'get_workflow_protocol', { workflow_id: def.id });
            // The due-expiry variant: the question's time is up.
            const due = await store.get(runId);
            await store.update({
              ...due,
              pending_gate: {
                ...due.pending_gate!,
                expires_at: '2000-01-01T00:00:00.000Z',
                on_expiry: 'abort',
              },
            });
            await call('get_run_state:due', 'get_run_state', { run_id: runId });
            await store.update({ ...(await store.get(runId)), pending_gate: gate });
            // The corrupt-definition variant, at each live registrar site this session serves.
            const copy = join(home, '.realm', 'workflows', `${def.id}.json`);
            const { readFileSync } = await import('node:fs');
            const good = readFileSync(copy, 'utf8');
            writeFileSync(copy, '{ not json');
            await call('get_run_state:corrupt', 'get_run_state', { run_id: runId });
            await call('execute_step:corrupt', 'execute_step', {
              run_id: runId,
              command: gate.step_name,
              params: {},
            });
            await call('advance_run:corrupt', 'advance_run', { run_id: runId });
            writeFileSync(copy, good);
            // Settled by the person's CLI answer.
            const answered = await realm(home, proj, [
              'run',
              'respond',
              runId,
              '--gate',
              gate.gate_id,
              '--choice',
              gate.choices[0]!,
            ]);
            expect(answered.code, answered.out).toBe(0);
            await call('get_run_state:settled', 'get_run_state', { run_id: runId });
          } finally {
            await client.close();
          }
          // (a) red when one census text is reverted (a forbidden string reaches a reply), a probe
          //     internal-errors, or the exit assertion fires; (b) prints each offending probe.
          expect({
            offending: results
              .filter((r) => r.found.length > 0)
              .map((r) => `${r.probe}: ${r.found.join(', ')}`),
            internal: results.filter((r) => r.class === 'internal_error').map((r) => r.probe),
            heldBack: (stderr.match(/realm: held back a /g) ?? []).length,
          }).toEqual({ offending: [], internal: [], heldBack: 0 });
        } finally {
          rmSync(home, { recursive: true, force: true });
          rmSync(proj, { recursive: true, force: true });
        }
      }, 120_000);
    }
  }
});
