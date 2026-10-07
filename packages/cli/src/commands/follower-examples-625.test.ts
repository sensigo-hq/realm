// follower-examples-625.test.ts — issue #625 PR-2a, law L4 (Follower) on the shipped examples: a
// client that makes ONLY the calls `next_actions` names finishes examples 01–09 through realm's own
// MCP server (`realm mcp --project <copy>`, real stdio), sending each agent step a committed valid
// output — the example's own `fixtures/*.yaml` agent response (decision C20) — and answering each gate
// with its first choice. 07/08/09 run against realm-testing's GitHub mock (09's Slack post against a
// local stand-in webhook); nothing reaches a network.
//
// Homed in the CLI package, not beside `follower-625.test.ts`: the examples need the deployment
// manifest's adapters (`realm mcp --project`), the fixture loader and the GitHub mock, none of which
// the MCP server package depends on. Every child gets a scratch HOME; the CLI is spawned ASYNCHRONOUSLY
// (a `spawnSync` would block the in-process mock it talks to).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  JsonFileStore,
  loadWorkflowFromFile,
  validateInputSchema,
  type WorkflowDefinition,
} from '@sensigo/realm';
import {
  loadFixtureFromFile,
  startGitHubMockServer,
  type GitHubMockServerHandle,
} from '@sensigo/realm-testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { printChildrenWhenATestFails } from '../test-support/child-output.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const CLI = process.env['FOLLOWER_CLI_ENTRY'] ?? join(ROOT, 'packages/cli/dist/index.js');
const EXAMPLES = join(ROOT, 'examples');
const children = printChildrenWhenATestFails();

type Reply = Record<string, unknown> & {
  status: string;
  run_id?: string;
  next_actions?: Array<{
    instruction: { tool: string; call_with: Record<string, unknown> } | null;
  }>;
};

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
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code, signal) =>
      children.record({ args: [CLI, ...args], status: code, signal, stdout, stderr }),
    );
    child.on('close', (code) => resolve({ code, out }));
  });
}

interface ExampleCase {
  dir: string;
  fixture: string;
  /** The manifest the copy runs with (adapters pointed at the stand-ins), when it needs one. */
  manifest?: () => string;
  /** An engine step follows a gate, so the follower must be handed `advance_run`. */
  advances?: boolean;
}

const ghManifest = () =>
  `version: 1\nadapters:\n  github:\n    use: github\n    config: { base_url: '${github.url}', auth: { token: 'test-token' } }\n`;

const CASES: ExampleCase[] = [
  { dir: '01-code-reviewer', fixture: 'breaking-change-review.yaml' },
  { dir: '02-ticket-classifier', fixture: 'billing-ticket.yaml' },
  { dir: '03-incident-response', fixture: 'approved.yaml' },
  { dir: '04-content-pipeline', fixture: 'happy-path.yaml' },
  { dir: '05-parallel-code-review', fixture: 'fan-out-pass.yaml' },
  { dir: '06-ticket-router', fixture: 'account-issue.yaml' },
  {
    dir: '07-issue-triage',
    fixture: 'approve-critical-issue.yaml',
    manifest: ghManifest,
    advances: true,
  },
  { dir: '08-pr-review', fixture: 'approve-pr.yaml', manifest: ghManifest, advances: true },
  {
    dir: '09-webhook-pr-review',
    fixture: 'approve-review.yaml',
    advances: true,
    manifest: () =>
      ghManifest() + `  slack:\n    use: slack\n    config: { webhook_url: '${slackUrl}' }\n`,
  },
];

/** The example's own fixture paths (`/fake/<dir>/<file>`) point at the copy's real files. */
function realParams(params: Record<string, unknown>, proj: string): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params).map(([k, v]) => [
      k,
      typeof v === 'string' && v.startsWith('/fake/') ? join(proj, v.slice('/fake/'.length)) : v,
    ]),
  );
}

describe('#625 PR-2a — L4 Follower on examples 01–09 (realm mcp --project, real stdio)', () => {
  it('C20: every committed agent output the follower sends validates against its step schema', () => {
    for (const c of CASES) {
      const def: WorkflowDefinition = loadWorkflowFromFile(join(EXAMPLES, c.dir, 'workflow.yaml'));
      const fixture = loadFixtureFromFile(join(EXAMPLES, c.dir, 'fixtures', c.fixture));
      for (const [step, output] of Object.entries(fixture.agent_responses ?? {})) {
        const schema = def.steps[step]?.input_schema;
        expect(def.steps[step]?.execution, `${c.dir}:${step}`).toBe('agent');
        if (schema !== undefined) {
          expect(
            () => validateInputSchema(output as Record<string, unknown>, schema, step),
            `${c.dir}:${step}`,
          ).not.toThrow();
        }
      }
    }
  });

  it('every example directory is a case (none left out)', () => {
    const dirs = readdirSync(EXAMPLES)
      .filter((d) => /^\d\d-/.test(d))
      .sort();
    expect(dirs).toEqual(CASES.map((c) => c.dir));
  });

  for (const c of CASES) {
    it(`${c.dir}: the follower finishes, calling only what next_actions names`, async () => {
      const home = mkdtempSync(join(tmpdir(), 'realm-follower-ex-home-'));
      const proj = mkdtempSync(join(tmpdir(), 'realm-follower-ex-proj-'));
      try {
        cpSync(join(EXAMPLES, c.dir), proj, { recursive: true });
        if (c.manifest !== undefined) writeFileSync(join(proj, 'realm.yaml'), c.manifest());
        const reg = await realm(home, proj, ['workflow', 'register', join(proj, 'workflow.yaml')]);
        expect(reg.code, reg.out).toBe(0);
        const fixture = loadFixtureFromFile(join(proj, 'fixtures', c.fixture));
        const def: WorkflowDefinition = loadWorkflowFromFile(join(proj, 'workflow.yaml'));
        const client = new Client({ name: 'follower-examples', version: '0' });
        await client.connect(
          children.watch(
            'realm mcp',
            new StdioClientTransport({
              command: process.execPath,
              args: [CLI, 'mcp', '--project', proj],
              cwd: proj,
              env: { ...process.env, HOME: home } as Record<string, string>,
              stderr: 'pipe',
            }),
          ),
        );
        try {
          const call = async (name: string, args: Record<string, unknown>): Promise<Reply> => {
            const r = (await client.callTool({ name, arguments: args })) as {
              content: Array<{ text?: string }>;
            };
            return JSON.parse(r.content[0]?.text ?? '{}') as Reply;
          };
          let reply = await call('start_run', {
            workflow_id: def.id,
            params: realParams(fixture.params ?? {}, proj),
          });
          expect(reply.status, JSON.stringify(reply)).toBe('ok');
          const runId = reply.run_id!;
          const calls: string[] = [];
          for (let i = 0; i < 20; i++) {
            const action = reply.next_actions?.[0];
            if (action === undefined || action.instruction === null) break;
            const { tool, call_with } = action.instruction;
            const args: Record<string, unknown> = { ...call_with };
            if (tool === 'execute_step') {
              args['params'] = fixture.agent_responses?.[call_with['command'] as string] ?? {};
            }
            if (tool === 'submit_human_response') {
              args['choice'] = String(call_with['choice']).replace(/^<|>$/g, '').split('|')[0];
            }
            calls.push(tool);
            reply = await call(tool, args);
          }
          expect(reply.next_actions ?? [], JSON.stringify(reply)).toEqual([]);
          const run = await new JsonFileStore(join(home, '.realm', 'runs')).get(runId);
          expect(run.run_phase, `${c.dir} calls=${calls.join(',')}`).toBe('completed');
          expect(calls.includes('advance_run'), calls.join(',')).toBe(c.advances === true);
        } finally {
          await client.close();
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
      }
    }, 60000);
  }
});
