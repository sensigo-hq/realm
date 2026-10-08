// docs-pages-625-guides.test.ts — issue #625 PR-2a, decision C174 (round 22), pin lane E2: the
// guides and the other reference pages, on the built `realm` as a child process (fresh HOME). Each
// sentence on those pages that says what a `realm` command (or the `realm-mcp` command) does, and
// that #625 PR-2a added or changed, is quoted here (read from the repository, whitespace folded) and
// the case it states is run, so neither the page nor the command can change alone.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JsonFileStore } from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { resolveMcpServerEntry } from '../agent/test-support/mcp-server-entry.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../../..');
const CLI = join(HERE, '../../dist/index.js');
const AGENT_API = join(HERE, '../../dist/agent/index.js');
const flat = (t: string) => t.replace(/\s+/g, ' ');

/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(page: string, sentence: string): void {
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

/** The lines of the page's first fenced block that holds `marker`. */
function block(page: string, marker: string): string[] {
  const text = readFileSync(join(ROOT, page), 'utf8');
  const blocks = text.split(/^```[a-z]*\n/m).filter((_, i) => i % 2 === 1);
  const found = blocks.find((b) => b.includes(marker));
  if (found === undefined) throw new Error(`${page} has no block with: ${marker}`);
  return found
    .replace(/\n```[\s\S]*$/, '')
    .split('\n')
    .filter((l) => l !== '');
}

type Reply = Record<string, unknown>;

/** The step-handlers guide's own `registry.mjs` and `workflow.yaml`. */
function guideProject(dir: string, handlerName = 'order_total'): void {
  const page = 'docs/guides/step-handlers.md';
  writeFileSync(join(dir, 'registry.mjs'), `${block(page, 'handlers: {').join('\n')}\n`);
  writeFileSync(
    join(dir, 'workflow.yaml'),
    `${block(page, 'handler: order_total')
      .join('\n')
      .replace('handler: order_total', `handler: ${handlerName}`)}\n`,
  );
}

describe(
  '#625 PR-2a, C174 lane E2 — guides and reference pages, from the built realm',
  { timeout: 60_000 },
  () => {
    let home: string;
    let project: string;
    let runStore: JsonFileStore;

    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'realm-pages-625-e2-home-'));
      project = mkdtempSync(join(tmpdir(), 'realm-pages-625-e2-proj-'));
      runStore = new JsonFileStore(join(home, '.realm', 'runs'));
    });
    afterEach(() => {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    });

    const env = (extra: Record<string, string> = {}): Record<string, string> => ({
      PATH: process.env['PATH'] ?? '',
      HOME: home,
      NO_COLOR: '1',
      ...extra,
    });

    function realm(
      args: string[],
      extra: Record<string, string> = {},
    ): { code: number | null; out: string[]; err: string[] } {
      const r = spawnSync(process.execPath, [CLI, ...args], {
        cwd: project,
        env: env(extra),
        encoding: 'utf8',
        timeout: 60_000,
      });
      const lines = (t: string) => t.split('\n').filter((l) => l !== '');
      return { code: r.status, out: lines(r.stdout), err: lines(r.stderr) };
    }

    async function call(client: Client, name: string, args: Reply): Promise<Reply> {
      const raw = (await client.callTool({ name, arguments: args })) as {
        content: Array<{ text: string }>;
      };
      return JSON.parse(raw.content[0]!.text) as Reply;
    }

    async function stdio(entry: string, args: string[]): Promise<Client> {
      const client = new Client({ name: 'docs-pages-625-e2', version: '0' });
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [entry, ...args],
          env: env(),
          cwd: project,
        }),
      );
      return client;
    }

    /** A run the engine owes `total` on: the guide's workflow registered from its folder. */
    function registered(handlerName = 'order_total'): void {
      guideProject(project, handlerName);
      const reg = realm(['workflow', 'register', './']);
      expect(reg.code, `fixture: ${reg.err.join('\n')}`).toBe(0);
    }
    async function owedRun(): Promise<string> {
      const { run } = await runStore.create({
        workflowId: 'price',
        workflowVersion: 1,
        params: { quantity: 4 },
      });
      return run.id;
    }

    it('realm-mcp-and-serve.md: realm mcp and realm serve both serve the 11 tools, for the workflows in ~/.realm/workflows/, and keep runs in ~/.realm/runs/', async () => {
      claim(
        'docs/reference/cli/realm-mcp-and-serve.md',
        'Both serve the 11 tools listed in [MCP tools](../mcp/tools.md) (`advance_run` was added after version 0.46.0, which serves 10), for every workflow registered in `~/.realm/workflows/`, and both keep runs in `~/.realm/runs/`.',
      );
      registered();
      async function served(client: Client) {
        const listed = (await client.listTools()).tools.map((t) => t.name);
        const workflows = (await call(client, 'list_workflows', {}))['workflows'] as Array<{
          id: string;
        }>;
        const s = await call(client, 'start_run', {
          workflow_id: 'price',
          params: { quantity: 4 },
        });
        return {
          tools: listed.length,
          advance: listed.includes('advance_run'),
          workflows: workflows.map((w) => w.id),
          runFile: existsSync(join(home, '.realm', 'runs', `${String(s['run_id'])}.json`)),
        };
      }
      const viaMcp = await stdio(CLI, ['mcp']);
      const mcp = await served(viaMcp).finally(() => viaMcp.close());
      const port = await new Promise<number>((resolve, reject) => {
        const probe = createServer();
        probe.on('error', reject);
        probe.listen(0, '127.0.0.1', () => {
          const address = probe.address();
          const free = typeof address === 'object' && address !== null ? address.port : 0;
          probe.close(() => resolve(free));
        });
      });
      const child = spawn(
        process.execPath,
        [CLI, 'serve', '--dev', '--port', String(port), '--host', '127.0.0.1'],
        { cwd: project, env: env(), stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let serve: Awaited<ReturnType<typeof served>>;
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('serve never listened')), 20_000);
          child.stdout.on('data', (d: Buffer) => {
            if (d.toString().includes('listening on')) {
              clearTimeout(timer);
              resolve();
            }
          });
          child.on('close', () => reject(new Error('serve exited before listening')));
        });
        const viaHttp = new Client({ name: 'docs-pages-625-e2-http', version: '0' });
        await viaHttp.connect(
          new StreamableHTTPClientTransport(
            new URL(`http://127.0.0.1:${port}/`),
          ) as unknown as Parameters<Client['connect']>[0],
        );
        serve = await served(viaHttp).finally(() => viaHttp.close());
      } finally {
        child.kill('SIGTERM');
      }
      const each = { tools: 11, advance: true, workflows: ['price'], runFile: true };
      // (a) red when either serves another number of tools, misses the registered workflow, or
      //     keeps its run elsewhere; (b) prints what each served.
      expect({ mcp, serve }).toEqual({ mcp: each, serve: each });
    });

    it('realm-mcp-and-serve.md: the realm-mcp command — start_run creates the run, replies ok, and the block is in its warnings', async () => {
      const page = 'docs/reference/cli/realm-mcp-and-serve.md';
      claim(
        page,
        '`start_run` still creates the run and replies `status: ok`; the block is in its `warnings` (added after version 0.46.0, which replies `status: error`):',
      );
      const shown = block(page, "Step 'fetch' is blocked:")[0]!.replace(' …', '');
      writeFileSync(
        join(project, 'registry.mjs'),
        [
          'export default {',
          '  handlers: {',
          "    fetch_record: { id: 'fetch_record', async execute() { return { data: { ok: true } }; } },",
          '  },',
          '};',
          '',
        ].join('\n'),
      );
      writeFileSync(
        join(project, 'workflow.yaml'),
        [
          'id: records',
          'name: records',
          'version: 1',
          'extensions: ./registry.mjs',
          'steps:',
          '  fetch:',
          '    description: Fetch the record.',
          '    execution: auto',
          '    handler: fetch_record',
          '  read:',
          '    description: Read it.',
          '    execution: agent',
          '    depends_on: [fetch]',
          '',
        ].join('\n'),
      );
      expect(realm(['workflow', 'register', './']).code, 'fixture').toBe(0);
      const client = await stdio(resolveMcpServerEntry(), []);
      const s = await call(client, 'start_run', { workflow_id: 'records' }).finally(() =>
        client.close(),
      );
      const record = await runStore.get(s['run_id'] as string);
      // (a) red when realm-mcp refuses, creates no run, or leaves the block out of warnings;
      //     (b) prints the reply.
      expect({
        status: s['status'],
        created: record.id,
        warned: ((s['warnings'] as string[]) ?? []).some((w) => w.startsWith(shown)),
        phase: record.run_phase,
      }).toEqual({ status: 'ok', created: s['run_id'], warned: true, phase: 'running' });
    });

    it('environment-and-files.md: realm run advance reads REALM_OPERATOR — the name on the step it takes, ambient; without it, derived', async () => {
      claim(
        'docs/reference/environment-and-files.md',
        '| `REALM_OPERATOR` | `realm agent`, `realm workflow run`, `realm mcp`, `realm serve`, the `realm-mcp` command, `realm run respond`, `realm run drain`, `realm run advance` (added after version 0.46.0) |',
      );
      registered();
      const named = await owedRun();
      const r1 = realm(['run', 'advance', named], { REALM_OPERATOR: 'ops-e2' });
      const unnamed = await owedRun();
      const r2 = realm(['run', 'advance', unnamed]);
      const by = async (id: string) => {
        const entry = (await runStore.get(id)).evidence.find((e) => e.step_id === 'total');
        const d = entry?.driven_by as { by?: string; by_source?: string } | undefined;
        return [d?.by, d?.by_source];
      };
      const derived = await by(unnamed);
      // (a) red when realm run advance does not read the variable, or writes it with another
      //     source; (b) prints the exits and the names written.
      expect([r1.code, r2.code, await by(named), derived[1]]).toEqual([
        0,
        0,
        ['ops-e2', 'ambient'],
        'derived',
      ]);
      expect(derived[0]).not.toBe('ops-e2');
    });

    it('project-extensions.md: realm run advance loads the project code when it runs; when loading fails, the command fails', async () => {
      claim(
        'docs/reference/project-extensions.md',
        '| `realm run respond`, `realm run drain`, `realm run advance` (added after version 0.46.0) | When it runs. | The command fails. |',
      );
      registered();
      const ok = await owedRun();
      const r1 = realm(['run', 'advance', ok]);
      const loaded = (await runStore.get(ok)).evidence.find((e) => e.step_id === 'total');
      // The code breaks after registration: only a load at run time can see it.
      writeFileSync(join(project, 'registry.mjs'), "throw new Error('boom at import');\n");
      const broken = await owedRun();
      const r2 = realm(['run', 'advance', broken]);
      const after = await runStore.get(broken);
      // (a) red when the command does not load the code when it runs (the handler's output is
      //     missing), or exits 0 with code that does not load; (b) prints the exits and stderr.
      expect({
        ran: [r1.code, loaded?.output_summary],
        failed: [r2.code !== 0, r2.err.join('\n').includes('boom at import')],
        untouched: after.evidence.length,
      }).toEqual({ ran: [0, { total: 50 }], failed: [true, true], untouched: 0 });
    });

    it('project-extensions.md: each command the page names takes --extensions-module <path>; realm run advance loads it in place of the workflow’s file', async () => {
      claim(
        'docs/reference/project-extensions.md',
        '`realm agent`, `realm workflow run`, `realm workflow validate`, `realm workflow test`, `realm mcp`, `realm serve`, `realm run respond`, `realm run drain` and `realm run advance` (added after version 0.46.0) take `--extensions-module <path>`.',
      );
      const commands = [
        ['agent'],
        ['workflow', 'run'],
        ['workflow', 'validate'],
        ['workflow', 'test'],
        ['mcp'],
        ['serve'],
        ['run', 'respond'],
        ['run', 'drain'],
        ['run', 'advance'],
      ];
      const without = commands
        .filter(
          (c) =>
            !realm([...c, '--help'])
              .out.join('\n')
              .includes('--extensions-module <path>'),
        )
        .map((c) => c.join(' '));
      registered();
      // The workflow's own file breaks; the override provides the handler.
      writeFileSync(join(project, 'registry.mjs'), "throw new Error('boom at import');\n");
      const repair = join(project, 'repair.mjs');
      writeFileSync(
        repair,
        "export default { handlers: { order_total: { id: 'order_total', async execute() { return { data: { total: 7 } }; } } } };\n",
      );
      const id = await owedRun();
      const r = realm(['run', 'advance', id, '--extensions-module', repair]);
      const entry = (await runStore.get(id)).evidence.find((e) => e.step_id === 'total');
      // (a) red when a named command drops the flag, or advance does not load the file in place
      //     of the workflow's; (b) prints the commands without it, the exit and the output.
      expect({ without, code: r.code, output: entry?.output_summary }).toEqual({
        without: [],
        code: 0,
        output: { total: 7 },
      });
    });

    it('step-handlers.md: realm agent on a handler that is not registered prints the guide’s ⚠ line', async () => {
      claim(
        'docs/guides/step-handlers.md',
        "`realm agent` prints `⚠ Step 'total' is blocked: handler 'order_totl' is not registered in this runner. The run is NOT failed — add handler 'order_totl' and re-attach (…)`).",
      );
      guideProject(project, 'order_totl');
      const provider = join(project, 'provider.mjs');
      writeFileSync(
        provider,
        [
          `import { LlmProvider } from '${pathToFileURL(AGENT_API).href}';`,
          "class Stub extends LlmProvider { async callStep() { throw new Error('the model was called'); } }",
          'export default new Stub();',
          '',
        ].join('\n'),
      );
      const r = realm([
        'agent',
        '--workflow',
        './',
        '--provider-module',
        provider,
        '--params',
        '{"quantity":4}',
      ]);
      const page = flat(readFileSync(join(ROOT, 'docs/guides/step-handlers.md'), 'utf8'));
      const shown = /`realm agent` prints `(⚠ [^`]*) \(…\)`/.exec(page)![1]!;
      // The pre-flight warning (`⚠ Step 'total' needs handler …`) comes first; the block line follows.
      const line = r.err.find((l) => l.startsWith("⚠ Step 'total' is blocked: "));
      const runs = (await runStore.list()).map((x) => [x.run_phase, x.failed_steps]);
      // (a) red when the line is not the guide's (up to its `(…)`), or the run is failed;
      //     (b) prints stderr and the run.
      expect([line?.startsWith(`${shown} (`), runs]).toEqual([true, [['running', []]]]);
    });
  },
);
