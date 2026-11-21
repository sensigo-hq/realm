// form-carry-on-a2b-625.test.ts — #625 PR-2b unit A2b, check 1 as a real case: example 08 (the PR
// review) through `realm mcp --project` on the default `asked`, in an app that shows forms (journey-627's
// forms-accept harness) with the GitHub stand-in. The `execute_step` call that reaches `confirm_review`
// sends its form; the person approves; that same call then runs `post_approval`.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8: (a) the change that
// turns it red; (b) what it prints when it fails.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadWorkflowFromFile } from '@sensigo/realm';
import {
  loadFixtureFromFile,
  startGitHubMockServer,
  type GitHubMockServerHandle,
} from '@sensigo/realm-testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { makeTempHome } from '../test-support/temp-home.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const CLI = join(ROOT, 'packages/cli/dist/index.js');
type Reply = Record<string, unknown>;

let github: GitHubMockServerHandle;
beforeAll(async () => {
  github = await startGitHubMockServer(
    join(ROOT, 'packages/core/src/adapters/fixtures/github-fixture-data.json'),
  );
});
afterAll(async () => {
  await github.close();
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
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });
}

describe('#625 PR-2b A2b check 1 — example 08, the opening call’s form, over realm mcp --project', () => {
  it('the execute_step call that reaches confirm_review runs post_approval after the person approves in the form', async () => {
    const h = await makeTempHome();
    const home = h.root;
    const proj = mkdtempSync(join(tmpdir(), 'realm-a2b-08-'));
    try {
      cpSync(join(ROOT, 'examples', '08-pr-review'), proj, { recursive: true });
      writeFileSync(
        join(proj, 'realm.yaml'),
        `version: 1\nadapters:\n  github:\n    use: github\n    config: { base_url: '${github.url}', auth: { token: 'test-token' } }\n`,
      );
      const reg = await realm(home, proj, ['workflow', 'register', join(proj, 'workflow.yaml')]);
      expect(reg.code, reg.out).toBe(0);
      const fixture = loadFixtureFromFile(join(proj, 'fixtures', 'approve-pr.yaml'));
      const def = loadWorkflowFromFile(join(proj, 'workflow.yaml'));
      const client = new Client(
        { name: 'a2b-08', version: '0' },
        { capabilities: { elicitation: { form: {} } } },
      );
      let forms = 0;
      client.setRequestHandler(ElicitRequestSchema, async () => {
        forms++;
        return { action: 'accept', content: { choice: 'approve' } };
      });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [CLI, 'mcp', '--project', proj],
        cwd: proj,
        env: { ...process.env, HOME: home } as Record<string, string>,
        stderr: 'pipe',
      });
      await client.connect(transport);
      const calls: Array<{ tool: string; reply: Reply }> = [];
      try {
        const call = async (name: string, args: Reply): Promise<Reply> => {
          const r = (await client.callTool({ name, arguments: args }, undefined, {
            timeout: 600_000,
          })) as { content: Array<{ text?: string }> };
          const reply = JSON.parse(r.content[0]?.text ?? '{}') as Reply;
          calls.push({ tool: name, reply });
          return reply;
        };
        // Drive the run, calling only what next_actions names (the form is answered inside a call).
        let reply = await call('start_run', {
          workflow_id: def.id,
          params: fixture.params ?? {},
        });
        for (let i = 0; i < 20; i++) {
          const action = (
            reply['next_actions'] as
              Array<{ instruction: { tool: string; call_with: Reply } | null }> | undefined
          )?.[0];
          if (action === undefined || action.instruction === null) break;
          const { tool, call_with } = action.instruction;
          const args: Reply = { ...call_with };
          if (tool === 'execute_step')
            args['params'] = fixture.agent_responses?.[call_with['command'] as string] ?? {};
          reply = await call(tool, args);
        }
      } finally {
        await client.close();
      }
      // The call whose reply carries the answer's claim: the one that reached the gate.
      const reached = calls.find((c) => c.reply['gate_claim'] !== undefined);
      const claim = reached?.reply['gate_claim'] as Record<string, unknown> | undefined;
      const chained = (
        (reached?.reply['chained_auto_steps'] as Array<{ step: string }> | undefined) ?? []
      ).map((c) => c.step);
      // (a) red when the opening call's form passes no token (proof_absent, post_approval owed to a
      //     later advance_run); (b) prints the calls made and the fields.
      expect({
        forms,
        tools: calls.map((c) => c.tool),
        reachedBy: reached?.tool,
        proof: claim?.['proof'],
        carried: claim?.['carried_on'],
        postApproval: chained.includes('post_approval'),
        phase: calls.at(-1)?.reply['run_phase'],
      }).toEqual({
        forms: 1,
        tools: ['start_run', 'execute_step'],
        reachedBy: 'execute_step',
        proof: 'matched',
        carried: true,
        postApproval: true,
        phase: 'completed',
      });
    } finally {
      await h.cleanup();
      rmSync(proj, { recursive: true, force: true });
    }
  }, 120_000);
});
