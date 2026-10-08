// docs-examples-625.test.ts — issue #625 PR-2a, decision C180 (round 23): every code example in a
// README or guide that #625 PR-2a changes is executed here (C163's rule, widened to code). The
// first cell lists every fenced block on those pages that is not `text` (an output) and holds the
// list against TABLE, so a block added or removed turns it red until it has a row. Each row says
// how its block runs; the other cells run them, AS WRITTEN, read from the page:
//
//   - a program (`ts`, `javascript`) is written to a file in a temporary project that sees the
//     repository's node_modules, and run with `node` (Node 24 strips the types of a `.ts` file);
//     a FRAGMENT gets exactly the names it uses and never defines from a preamble, named in its row;
//   - a whole workflow is loaded (`loadWorkflowFromString`, or `loadWorkflowFromFile` when it names
//     `extensions`) and registered; a piece of one is checked to be part of the page's whole
//     example, or merged into one and validated;
//   - an MCP client configuration is started as the client would start it (its `command` and
//     `args`, found on PATH), and a tool's arguments are sent to the real server over stdio;
//   - a `bash` line runs in `bash -c` with `realm` and `realm-mcp` on PATH (each the built bin of
//     its package) and a fresh HOME; placeholders (`<run-id>`, `<gate-id>`, …) are filled from a
//     real run. `realm workflow run` prompts on a terminal: a preload marks stdin a terminal and
//     each prompt is answered as it appears. What cannot run in a test (the npm registry, a third
//     party's program, a model provider) has a row that says why and what is checked instead.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { load as parseYaml } from 'js-yaml';
import { JsonFileStore, loadWorkflowFromFile, loadWorkflowFromString } from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { resolveMcpServerEntry } from '../agent/test-support/mcp-server-entry.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The exit of a `realm workflow run` whose run ends failed (measured; the page shows no code). */
const REFUSED_EXIT = 1;
const ROOT = join(HERE, '../../../..');

const PAGES = [
  'README.md',
  'docs/guides/agent-created-workflows.md',
  'docs/guides/call-a-service.md',
  'docs/guides/connect-an-mcp-client.md',
  'docs/guides/human-gates.md',
  'docs/guides/idempotency-and-batches.md',
  'docs/guides/operate-runs.md',
  'docs/guides/step-handlers.md',
  'packages/cli/README.md',
  'packages/core/README.md',
  'packages/mcp-server/README.md',
] as const;
type Page = (typeof PAGES)[number];

/** The cells that run the rows; each row names one. */
const CELLS = {
  installs:
    'npm install lines: each package named exists, is published, and has the bin the pages use',
  quickStart: 'README quick start: init, the edited workflow.yaml, validate, register and run',
  clients: 'MCP client configurations and realm mcp: started as a client starts them, 11 tools',
  serve: 'realm serve lines: up on the port, 401 without the token, 11 tools with it',
  readmeExtensions: 'README extensions line: merged into the scaffold and validated',
  repo: 'README development and security commands: the scripts and the provenance they rely on',
  agentCreated: 'agent-created-workflows: create_workflow as sent, then realm workflow list',
  callAService: 'call-a-service: the pieces are the whole file; register, run, inspect, refuse',
  credentials: 'call-a-service: realm.yaml and the github service validate with the secret in .env',
  listReply: 'connect-an-mcp-client: list_workflows returns the reply the page shows',
  gates: 'human-gates: the workflow, list, respond, respond --by',
  gateTimeout: 'human-gates: the time limit validates; drain enacts an expired gate',
  idempotency: 'idempotency-and-batches: start_run twice and start_run_batch as sent',
  operate: 'operate-runs: every realm run line on a real run',
  handlers: 'step-handlers: the handler, the workflow, validate, register and a run',
  coreQuickStart: 'core README: the quick start program runs a step',
  coreAdapter: 'core README: the adapter fragment serves a step through executeStep',
  embedded: 'mcp-server README: the embedded server program serves 11 tools over stdio',
  provider: 'cli README: the custom provider module drives realm agent',
} as const;
type Cell = keyof typeof CELLS;

/**
 * One row per non-`text` fenced block, in page order: the page, the block's first line (at most 60
 * characters), its language (`-` for none), how it is executed, and the cell that executes it.
 */
// prettier-ignore
const TABLE: ReadonlyArray<readonly [Page, string, string, string, Cell]> = [
  ['README.md', 'npm install -g @sensigo/realm-cli', 'bash', 'EXCLUDED: the npm registry; the package is checked', 'installs'],
  ['README.md', 'npm install -g @sensigo/realm-mcp', 'bash', 'EXCLUDED: the npm registry; the package is checked', 'installs'],
  ['README.md', 'npm install @sensigo/realm', 'bash', 'EXCLUDED: the npm registry; the package is checked', 'installs'],
  ['README.md', 'npm install --save-dev @sensigo/realm-testing', 'bash', 'EXCLUDED: the npm registry; the package is checked', 'installs'],
  ['README.md', 'realm workflow init my-workflow', 'bash', 'run; the six files exist', 'quickStart'],
  ['README.md', 'id: my-workflow', 'yaml', 'whole workflow: loaded, written over the scaffold, run', 'quickStart'],
  ['README.md', 'realm workflow validate ./my-workflow   # check the YAML', 'bash', 'each line run; the run answered at its prompts', 'quickStart'],
  ['README.md', 'realm mcp', 'bash', 'long-running: started over stdio, listTools, stopped', 'clients'],
  ['README.md', '{', 'json', 'client config: command and args started, listTools', 'clients'],
  ['README.md', '{', 'json', 'client config: command and args started, listTools', 'clients'],
  ['README.md', 'REALM_SERVE_TOKEN=<secret> realm serve --port 3001', 'bash', 'long-running: <secret> filled, a free port for 3001; HTTP checked, stopped', 'serve'],
  ['README.md', '# workflow.yaml', 'yaml', 'fragment: merged into the scaffold, registry.sample.js as ./registry.js, validated', 'readmeExtensions'],
  ['README.md', 'npm install          # install all workspace dependencies', 'bash', 'EXCLUDED: the registry and the whole build and suite; the scripts are checked', 'repo'],
  ['README.md', 'npm audit signatures', 'bash', 'EXCLUDED: the npm registry; the publish workflow is checked for provenance', 'repo'],
  ['docs/guides/agent-created-workflows.md', '{', 'json', 'create_workflow arguments: sent over stdio', 'agentCreated'],
  ['docs/guides/agent-created-workflows.md', 'realm workflow list', 'bash', 'run after the create', 'agentCreated'],
  ['docs/guides/call-a-service.md', 'services:', 'yaml', 'fragment: part of the complete file', 'callAService'],
  ['docs/guides/call-a-service.md', 'steps:', 'yaml', 'fragment: part of the complete file', 'callAService'],
  ['docs/guides/call-a-service.md', 'steps:', 'yaml', 'fragment: part of the complete file', 'callAService'],
  ['docs/guides/call-a-service.md', 'id: notes', 'yaml', 'whole workflow: loaded, registered, run', 'callAService'],
  ['docs/guides/call-a-service.md', 'realm workflow register ./', 'bash', 'each line run; the path filled with a real file', 'callAService'],
  ['docs/guides/call-a-service.md', 'realm run inspect <run-id>', 'bash', 'run on the run above', 'callAService'],
  ['docs/guides/call-a-service.md', `realm workflow run ./ --params '{"path":"note.txt"}'`, 'bash', 'run; the page says the run fails', 'callAService'],
  ['docs/guides/call-a-service.md', 'version: 1', 'yaml', 'realm.yaml: written beside the workflow, validated', 'credentials'],
  ['docs/guides/call-a-service.md', 'services:', 'yaml', 'fragment: merged into a workflow with a github step, validated', 'credentials'],
  ['docs/guides/connect-an-mcp-client.md', '{', 'json', 'client config: command and args started, listTools', 'clients'],
  ['docs/guides/connect-an-mcp-client.md', 'claude mcp add realm -- realm mcp', 'bash', 'EXCLUDED: a third party program; the command after -- is started', 'clients'],
  ['docs/guides/connect-an-mcp-client.md', '{', 'json', 'a reply: list_workflows with the article workflow', 'listReply'],
  ['docs/guides/connect-an-mcp-client.md', 'REALM_SERVE_TOKEN=choose-a-long-secret realm serve --port 30', 'bash', 'long-running: a free port for 3001; HTTP checked, stopped', 'serve'],
  ['docs/guides/human-gates.md', 'id: announce', 'yaml', 'whole workflow: loaded, registered, run to its gate', 'gates'],
  ['docs/guides/human-gates.md', `when: "review.choice == 'send'"`, 'yaml', 'fragment: part of the workflow above', 'gates'],
  ['docs/guides/human-gates.md', 'realm run list --status gate_waiting', 'bash', 'run on a run at the gate', 'gates'],
  ['docs/guides/human-gates.md', 'realm run respond 64993bb2-6f65-47d9-801c-d008e9291a00 --gat', 'bash', 'run; the page’s IDs replaced by a real run’s', 'gates'],
  ['docs/guides/human-gates.md', 'realm run respond 64993bb2-6f65-47d9-801c-d008e9291a00 --gat', 'bash', 'run; the page’s IDs replaced by a real run’s', 'gates'],
  ['docs/guides/human-gates.md', 'gate:', 'yaml', 'fragment: merged into the workflow above, validated', 'gateTimeout'],
  ['docs/guides/human-gates.md', 'realm run drain --expired --all --force', 'bash', 'run on an expired gate (a one-second limit)', 'gateTimeout'],
  ['docs/guides/idempotency-and-batches.md', '{ "workflow_id": "sync", "params": {}, "idempotency_key": "o', 'json', 'start_run arguments: sent twice over stdio', 'idempotency'],
  ['docs/guides/idempotency-and-batches.md', '{', 'json', 'start_run_batch arguments: sent over stdio', 'idempotency'],
  ['docs/guides/operate-runs.md', 'realm run list', 'bash', 'run', 'operate'],
  ['docs/guides/operate-runs.md', 'realm run list --stuck', 'bash', 'run', 'operate'],
  ['docs/guides/operate-runs.md', 'realm run inspect <run-id>', 'bash', 'run on a real run', 'operate'],
  ['docs/guides/operate-runs.md', 'realm run respond <run-id> --gate <gate-id> --choice <choice', 'bash', 'run on a run at a gate', 'operate'],
  ['docs/guides/operate-runs.md', 'realm run advance <run-id>', 'bash', 'run on a run that owes an auto step', 'operate'],
  ['docs/guides/operate-runs.md', 'realm agent --run-id <run-id> --model <model>', 'bash', 'EXCLUDED: a model provider and its key; the flags are checked', 'operate'],
  ['docs/guides/operate-runs.md', 'realm run resume <run-id> --from <step>', 'bash', 'run on a failed run', 'operate'],
  ['docs/guides/operate-runs.md', 'realm run abandon <run-id> --reason "docs test"', 'bash', 'run on an open run', 'operate'],
  ['docs/guides/operate-runs.md', 'realm run cleanup --older-than 7d --dry-run', 'bash', 'run', 'operate'],
  ['docs/guides/operate-runs.md', 'realm run export <run-id> --out ./run-44df45a3.json', 'bash', 'run on a real run', 'operate'],
  ['docs/guides/operate-runs.md', 'realm run purge --older-than 30d', 'bash', 'run', 'operate'],
  ['docs/guides/operate-runs.md', 'realm run gc --older-than 1d', 'bash', 'run', 'operate'],
  ['docs/guides/step-handlers.md', 'export default {', 'javascript', 'program: imported, execute called three ways; and run by the engine', 'handlers'],
  ['docs/guides/step-handlers.md', 'id: price', 'yaml', 'whole workflow: loaded, registered, run', 'handlers'],
  ['docs/guides/step-handlers.md', 'realm workflow validate ./', 'bash', 'run', 'handlers'],
  ['docs/guides/step-handlers.md', 'realm workflow register ./', 'bash', 'run; then start_run over stdio', 'handlers'],
  ['packages/cli/README.md', 'npm install -g @sensigo/realm-cli', '-', 'EXCLUDED: the npm registry; the package is checked', 'installs'],
  ['packages/cli/README.md', 'OPENAI_API_KEY=<your-key> realm agent \\', 'bash', 'EXCLUDED: a model provider and its key; the flags are checked', 'provider'],
  ['packages/cli/README.md', '// my-ollama-provider.mjs', 'javascript', 'program: written under the name its first line gives; Ollama is a stub', 'provider'],
  ['packages/cli/README.md', 'realm agent --workflow ./my-workflow --provider-module ./my-', 'bash', 'run with the module above', 'provider'],
  ['packages/core/README.md', 'npm install @sensigo/realm', '-', 'EXCLUDED: the npm registry; the package is checked', 'installs'],
  ['packages/core/README.md', 'import { loadWorkflowFromFile, JsonFileStore, executeStep }', 'ts', 'program: run with my-workflow/workflow.yaml and its step my_step', 'coreQuickStart'],
  ['packages/core/README.md', 'import {', 'ts', 'fragment: supplies callMyApi; then serves a step through executeStep', 'coreAdapter'],
  ['packages/mcp-server/README.md', '# Standalone binary (for AI agent MCP config)', '-', 'EXCLUDED: the npm registry; the package is checked', 'installs'],
  ['packages/mcp-server/README.md', '{', 'json', 'client config: command started, listTools', 'clients'],
  ['packages/mcp-server/README.md', "import { createRealmMcpServer } from '@sensigo/realm-mcp';", 'ts', 'program: run as a stdio server, listTools', 'embedded'],
];

interface Fence {
  readonly lang: string;
  readonly first: string;
  readonly body: string;
}

/** Every fenced block on the page that is not `text`, in order. */
function fences(page: Page): Fence[] {
  const lines = readFileSync(join(ROOT, page), 'utf8').split('\n');
  const found: Fence[] = [];
  let open: { lang: string; body: string[] } | undefined;
  for (const line of lines) {
    if (open === undefined) {
      const m = /^```(\S*)\s*$/.exec(line);
      if (m !== null) open = { lang: m[1] === '' ? '-' : m[1]!, body: [] };
    } else if (/^```\s*$/.test(line)) {
      if (open.lang !== 'text') {
        found.push({ lang: open.lang, first: open.body[0] ?? '', body: open.body.join('\n') });
      }
      open = undefined;
    } else {
      open.body.push(line);
    }
  }
  return found;
}

/** The body of the page's first non-`text` block that holds `marker` (the nth, from 0). */
function fence(page: Page, marker: string, nth = 0): string {
  const found = fences(page).filter((f) => f.body.includes(marker))[nth];
  if (found === undefined) throw new Error(`${page} has no block with: ${marker}`);
  return found.body;
}

/** The lines of a block that are commands (not blank, not only a comment). */
const commands = (body: string): string[] =>
  body.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));

type Reply = Record<string, unknown>;
interface Ran {
  code: number | null;
  out: string;
  err: string;
}

const pkg = (dir: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(ROOT, 'packages', dir, 'package.json'), 'utf8')) as Record<
    string,
    unknown
  >;

/** The file a package's `bin` names for `name`. */
const binOf = (dir: string, name: string): string =>
  join(ROOT, 'packages', dir, (pkg(dir)['bin'] as Record<string, string>)[name]!);

/** A port nothing listens on. */
async function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createNetServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const free = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(free));
    });
  });
}

describe(
  '#625 PR-2a, C180 — every code example on the pages it changes runs',
  { timeout: 90_000 },
  () => {
    let home: string;
    let project: string;
    let bin: string;
    let runStore: JsonFileStore;

    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'realm-examples-625-home-'));
      project = mkdtempSync(join(tmpdir(), 'realm-examples-625-proj-'));
      bin = join(home, 'bin');
      mkdirSync(bin);
      // `realm` and `realm-mcp` on PATH, each the file its package.json `bin` names.
      for (const [name, file] of [
        ['realm', binOf('cli', 'realm')],
        ['realm-mcp', binOf('mcp-server', 'realm-mcp')],
      ] as const) {
        writeFileSync(join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${file}" "$@"\n`);
        chmodSync(join(bin, name), 0o755);
      }
      runStore = new JsonFileStore(join(home, '.realm', 'runs'));
    });
    afterEach(() => {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    });

    const env = (extra: Record<string, string> = {}): Record<string, string> => ({
      PATH: `${bin}:${dirname(process.execPath)}:${process.env['PATH'] ?? ''}`,
      HOME: home,
      NO_COLOR: '1',
      ...extra,
    });

    /** One line of a `bash` block, as written, in `cwd` (the project by default). */
    function sh(line: string, cwd = project, extra: Record<string, string> = {}): Ran {
      const r = spawnSync('bash', ['-c', line], {
        cwd,
        env: env(extra),
        encoding: 'utf8',
        timeout: 60_000,
      });
      return { code: r.status, out: r.stdout, err: r.stderr };
    }

    /** `sh`, without blocking this process (for a line that calls a server the test runs). */
    function shAsync(line: string, cwd = project): Promise<Ran> {
      const child = spawn('bash', ['-c', line], {
        cwd,
        env: env(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer) => (err += d.toString()));
      return new Promise<Ran>((resolve) => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ code, out, err });
        });
      });
    }

    /** A `realm workflow run` line: stdin marked a terminal, each prompt answered as it appears. */
    function interactive(line: string, answers: string[], cwd = project): Promise<Ran> {
      const preload = join(home, 'tty.mjs');
      writeFileSync(preload, 'process.stdin.isTTY = true;\n');
      const child = spawn('bash', ['-c', line], {
        cwd,
        env: env({ NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` }),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      let answered = 0;
      const left = [...answers];
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer) => {
        err += d.toString();
        const prompts = err.match(/\(Enter for \{\}\): |Choice \[[^\]\n]*\]: /g)?.length ?? 0;
        while (answered < prompts && left.length > 0) {
          answered++;
          child.stdin.write(`${left.shift()}\r`);
        }
      });
      return new Promise<Ran>((resolve) => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ code, out, err });
        });
      });
    }

    async function client(command: string, args: string[] = [], cwd = project): Promise<Client> {
      const c = new Client({ name: 'docs-examples-625', version: '0' });
      await c.connect(new StdioClientTransport({ command, args, env: env(), cwd }));
      return c;
    }

    async function call(c: Client, name: string, args: Reply): Promise<Reply> {
      const raw = (await c.callTool({ name, arguments: args })) as {
        content: Array<{ text: string }>;
      };
      return JSON.parse(raw.content[0]!.text) as Reply;
    }

    const toolCount = async (c: Client): Promise<number> =>
      (await c.listTools().finally(() => c.close())).tools.length;

    /** A folder of the project holding `workflow.yaml` (and more files), registered with realm. */
    function registered(folder: string, files: Record<string, string>): string {
      const dir = join(project, folder);
      mkdirSync(dir, { recursive: true });
      for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
      const r = sh('realm workflow register ./', dir);
      expect(r.code, `fixture: register ${folder}: ${r.err}`).toBe(0);
      return dir;
    }

    /** A temporary project that sees the repository's node_modules, as an ES module package. */
    function nodeProject(): string {
      symlinkSync(join(ROOT, 'node_modules'), join(project, 'node_modules'));
      writeFileSync(join(project, 'package.json'), '{"type":"module"}\n');
      return project;
    }

    it(`enumerate: every non-text block on the pages is a row of the table`, () => {
      const found = PAGES.flatMap((page) =>
        fences(page).map((f) => [page, f.first.slice(0, 60).trimEnd(), f.lang]),
      );
      // (a) red when a block is added, removed, reordered, or its first line or language changes
      //     without its row; (b) prints both lists.
      expect(found).toEqual(TABLE.map(([page, first, lang]) => [page, first, lang]));
      // (a) red when a row names no cell; (b) prints the rows.
      expect(TABLE.filter((r) => !(r[4] in CELLS))).toEqual([]);
    });

    it(CELLS.installs, () => {
      const lines = [
        ...PAGES.flatMap((p) => fences(p).flatMap((f) => commands(f.body))).filter(
          (l) =>
            l.startsWith('npm install @') ||
            l.startsWith('npm install -g') ||
            l.includes('--save-dev'),
        ),
      ];
      const byName = new Map(
        readdirSync(join(ROOT, 'packages')).map((d) => [pkg(d)['name'] as string, pkg(d)]),
      );
      const checked = lines.map((line) => {
        const name = line.split(' ').at(-1)!;
        const p = byName.get(name);
        return [
          line,
          p !== undefined && p['private'] !== true,
          Object.keys((p?.['bin'] as object) ?? {}),
        ];
      });
      // (a) red when a page installs a package the repository does not publish, or a bin the pages
      //     run is gone from its package; (b) prints each line with what was found.
      expect(checked).toEqual([
        ['npm install -g @sensigo/realm-cli', true, ['realm']],
        ['npm install -g @sensigo/realm-mcp', true, ['realm-mcp']],
        ['npm install @sensigo/realm', true, []],
        ['npm install --save-dev @sensigo/realm-testing', true, []],
        ['npm install -g @sensigo/realm-cli', true, ['realm']],
        ['npm install @sensigo/realm', true, []],
        ['npm install -g @sensigo/realm-mcp', true, ['realm-mcp']],
        ['npm install @sensigo/realm-mcp', true, ['realm-mcp']],
      ]);
    });

    it(CELLS.quickStart, async () => {
      const page = 'README.md';
      const init = sh(fence(page, 'realm workflow init'));
      const scaffold = [
        'workflow.yaml',
        'schema.json',
        'realm.yaml',
        'registry.sample.js',
        '.env.example',
        'README.md',
      ];
      const yaml = fence(page, 'id: my-workflow');
      const definition = loadWorkflowFromString(yaml);
      writeFileSync(join(project, 'my-workflow', 'workflow.yaml'), `${yaml}\n`);
      const [validate, register, run] = commands(
        fence(page, 'realm workflow validate ./my-workflow'),
      );
      const v = sh(validate!);
      const r = sh(register!);
      // The run asks for gather_input's answer, then for the gate's choice.
      const ran = await interactive(run!, ['{"summary":"A short summary."}', 'approve']);
      const runs = await runStore.list();
      // (a) red when init fails or makes other files, the page's workflow does not load, validate or
      //     register fails, or the run does not end completed; (b) prints each exit and stderr.
      expect({
        init: [init.code, scaffold.filter((f) => !existsSync(join(project, 'my-workflow', f)))],
        steps: Object.keys(definition.steps),
        validate: [v.code, v.err],
        register: [r.code, r.err],
        run: [ran.code, ran.out.includes('Run complete. Phase: completed')],
        record: runs.map((x) => [x.workflow_id, x.run_phase, x.completed_steps]),
      }).toEqual({
        init: [0, []],
        steps: ['gather_input', 'finalize'],
        validate: [0, ''],
        register: [0, ''],
        run: [0, true],
        record: [['my-workflow', 'completed', ['gather_input', 'finalize']]],
      });
    });

    it(CELLS.clients, async () => {
      const configs = [
        fence('README.md', '"mcpServers"', 0),
        fence('README.md', '"mcpServers"', 1),
        fence('docs/guides/connect-an-mcp-client.md', '"mcpServers"'),
        fence('packages/mcp-server/README.md', '"mcpServers"'),
      ].map(
        (t) =>
          (JSON.parse(t) as { mcpServers: { realm: { command: string; args?: string[] } } })
            .mcpServers.realm,
      );
      const counts: number[] = [];
      for (const c of configs) counts.push(await toolCount(await client(c.command, c.args ?? [])));
      // `realm mcp` on its own line, and the command `claude mcp add` is given after its `--`.
      const lines = [
        fence('README.md', 'realm mcp').trim(),
        fence('docs/guides/connect-an-mcp-client.md', 'claude mcp add').split(' -- ')[1]!.trim(),
      ];
      for (const line of lines) {
        const [command, ...args] = line.split(' ');
        counts.push(await toolCount(await client(command!, args)));
      }
      // (a) red when a configuration names a command or argument no package installs, or the server
      //     it starts does not serve the 11 tools; (b) prints the configurations and the counts.
      expect({ configs, lines, counts }).toEqual({
        configs: [
          { command: 'realm', args: ['mcp'] },
          { command: 'realm', args: ['mcp'] },
          { command: 'realm', args: ['mcp'] },
          { command: 'realm-mcp' },
        ],
        lines: ['realm mcp', 'realm mcp'],
        counts: [11, 11, 11, 11, 11, 11],
      });
    });

    it(CELLS.serve, async () => {
      const lines = [
        fence('README.md', 'realm serve').trim().replace('<secret>', 'docs-secret-625'),
        fence('docs/guides/connect-an-mcp-client.md', 'realm serve').trim(),
      ];
      const seen: unknown[] = [];
      for (const line of lines) {
        const token = /^REALM_SERVE_TOKEN=(\S+) /.exec(line)![1]!;
        const port = await freePort();
        const child = spawn('bash', ['-c', line.replace('--port 3001', `--port ${port}`)], {
          cwd: project,
          env: env(),
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        });
        let said = '';
        child.stderr.on('data', (d: Buffer) => (said += d.toString()));
        try {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('serve never listened')), 20_000);
            child.stdout.on('data', (d: Buffer) => {
              if (d.toString().includes(`listening on http://127.0.0.1:${port}/`)) {
                clearTimeout(timer);
                resolve();
              }
            });
            child.on('close', () => reject(new Error(`serve exited before listening: ${said}`)));
          });
          const url = new URL(`http://127.0.0.1:${port}/`);
          const bare = await fetch(url, { method: 'POST', body: '{}' });
          const c = new Client({ name: 'docs-examples-625-http', version: '0' });
          await c.connect(
            new StreamableHTTPClientTransport(url, {
              requestInit: { headers: { Authorization: `Bearer ${token}` } },
            }) as unknown as Parameters<Client['connect']>[0],
          );
          seen.push([bare.status, await toolCount(c)]);
        } finally {
          // The line's own process group: bash and the server it started.
          process.kill(-child.pid!, 'SIGTERM');
        }
      }
      // (a) red when a line does not start a server on its port, lets a request in without the
      //     token, or refuses the token; (b) prints the status without the token and the tool count.
      expect(seen).toEqual([
        [401, 11],
        [401, 11],
      ]);
    });

    it(CELLS.readmeExtensions, () => {
      expect(sh('realm workflow init my-workflow').code, 'fixture: init').toBe(0);
      const dir = join(project, 'my-workflow');
      const piece = parseYaml(fence('README.md', '# workflow.yaml')) as { extensions: string };
      const workflow = readFileSync(join(dir, 'workflow.yaml'), 'utf8');
      writeFileSync(join(dir, 'workflow.yaml'), `${workflow}\nextensions: ${piece.extensions}\n`);
      // The scaffold's own template, under the name the line gives.
      writeFileSync(join(dir, piece.extensions), readFileSync(join(dir, 'registry.sample.js')));
      const v = sh('realm workflow validate ./my-workflow');
      // (a) red when the line's path does not load as the workflow's extensions; (b) prints stdout.
      expect(
        [
          v.code,
          v.out.includes('Extensions: ./registry.js (adapters: 0, handlers: 0, processors: 0)'),
        ],
        v.out + v.err,
      ).toEqual([0, true]);
    });

    it(CELLS.repo, () => {
      const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
        workspaces?: string[];
        scripts: Record<string, string>;
      };
      const scripts = commands(fence('README.md', 'npm run build'))
        .map((l) => l.split('#')[0]!.trim())
        .filter((l) => l.startsWith('npm run '))
        .map((l) => [l, l.slice('npm run '.length) in root.scripts]);
      const publish = readFileSync(join(ROOT, '.github/workflows/publish.yml'), 'utf8');
      // (a) red when `npm install` no longer installs the workspaces, a script the README runs is
      //     gone, or publishing stops attaching provenance (what `npm audit signatures` checks);
      //     (b) prints what was found.
      expect({
        workspaces: (root.workspaces ?? []).length > 0,
        scripts,
        provenance:
          /id-token:\s*write/.test(publish) &&
          /--provenance|NPM_CONFIG_PROVENANCE|provenance:\s*true/.test(publish),
        audit: fence('README.md', 'npm audit').trim(),
      }).toEqual({
        workspaces: true,
        scripts: [
          ['npm run build', true],
          ['npm run test', true],
          ['npm run lint', true],
        ],
        provenance: true,
        audit: 'npm audit signatures',
      });
    });

    it(CELLS.agentCreated, async () => {
      const page = 'docs/guides/agent-created-workflows.md';
      const args = JSON.parse(fence(page, '"task_description"')) as Reply;
      const c = await client('realm', ['mcp']);
      const reply = await call(c, 'create_workflow', args).finally(() => c.close());
      const list = sh(fence(page, 'realm workflow list').trim());
      const row = list.out.split('\n').find((l) => l.startsWith('release-notes-'));
      // (a) red when create_workflow refuses the page's plan, or the list does not show it as made by
      //     an agent; (b) prints the reply and the list.
      expect(
        {
          status: reply['status'],
          run: (await runStore.list()).length,
          list: [list.code, row?.split(/\s+/).slice(1, 4)],
        },
        JSON.stringify(reply) + list.out + list.err,
      ).toEqual({ status: 'ok', run: 1, list: [0, ['release-notes', '1', 'agent']] });
    });

    it(CELLS.callAService, async () => {
      const page = 'docs/guides/call-a-service.md';
      const whole = fence(page, 'id: notes');
      const all = parseYaml(whole) as Record<string, Record<string, unknown>>;
      const services = parseYaml(fence(page, 'services:\n  files:')) as typeof all;
      const read = parseYaml(fence(page, 'read_note:\n    description')) as typeof all;
      const sum = parseYaml(fence(page, '# read_note: as above')) as typeof all;
      // (a) red when a piece shown in steps 1–3 is not what the complete file holds; (b) prints it.
      expect([services['services'], read['steps'], sum['steps']]).toEqual([
        all['services'],
        { read_note: all['steps']!['read_note'] },
        { summarise: all['steps']!['summarise'] },
      ]);
      loadWorkflowFromString(whole);
      writeFileSync(join(project, 'workflow.yaml'), `${whole}\n`);
      const note = join(project, 'note.txt');
      writeFileSync(note, 'Realm 0.45 ships a replay page.\n');
      const [register, run] = commands(fence(page, 'realm workflow register ./'));
      const reg = sh(register!);
      const ran = await interactive(run!.replace('/home/you/notes/note.txt', note), [
        '',
        '{"summary":"A replay page."}',
      ]);
      const runId = /Run ID: (\S+)/.exec(ran.out)?.[1] ?? '';
      const inspect = sh(
        fence(page, 'realm run inspect <run-id>').trim().replace('<run-id>', runId),
      );
      const refused = await interactive(fence(page, '"path":"note.txt"').trim(), ['']);
      // (a) red when the file does not register, the run does not complete with the file read, inspect
      //     does not show the resolved path, or the relative path is not refused as the page says;
      //     (b) prints each exit and output.
      expect(
        {
          register: reg.code,
          run: [ran.code, ran.out.includes('Run complete. Phase: completed')],
          inspect: [inspect.code, inspect.out.includes(`Resolved: {"path":"${note}"}`)],
          refused: [
            refused.code,
            refused.err.includes('✗ error: path must be absolute'),
            refused.out.includes('Run complete. Phase: failed'),
          ],
        },
        ran.out + ran.err + inspect.out + refused.out + refused.err,
      ).toEqual({
        register: 0,
        run: [0, true],
        inspect: [0, true],
        refused: [REFUSED_EXIT, true, true],
      });
    });

    it(CELLS.credentials, () => {
      const page = 'docs/guides/call-a-service.md';
      const service = parseYaml(fence(page, 'adapter: github')) as { services: Reply };
      writeFileSync(join(project, 'realm.yaml'), `${fence(page, 'version: 1\nadapters:')}\n`);
      writeFileSync(join(project, '.env'), 'GITHUB_TOKEN=docs-test-token\n');
      const merged = [
        'id: issues',
        'name: Read an issue',
        'version: 1',
        fence(page, 'adapter: github'),
        'steps:',
        '  fetch:',
        '    description: Read the issue.',
        '    execution: auto',
        '    uses_service: github',
        '    operation: get_issue',
        '    input_map:',
        '      owner: run.params.owner',
        '',
      ].join('\n');
      writeFileSync(join(project, 'workflow.yaml'), merged);
      const v = sh('realm workflow validate ./');
      // (a) red when the realm.yaml piece or the services piece stops validating together;
      //     (b) prints the exit and output.
      expect([Object.keys(service.services), v.code], v.out + v.err).toEqual([['github'], 0]);
    });

    it(CELLS.listReply, async () => {
      registered('article', {
        'workflow.yaml': [
          'id: article',
          'name: Write a short article',
          'version: 1',
          'steps:',
          '  draft:',
          '    description: Draft the article.',
          '    execution: agent',
          '',
        ].join('\n'),
      });
      const c = await client('realm', ['mcp']);
      const reply = await call(c, 'list_workflows', {}).finally(() => c.close());
      // (a) red when list_workflows replies other keys or values than the page shows; (b) prints both.
      expect(reply).toEqual(
        JSON.parse(fence('docs/guides/connect-an-mcp-client.md', '"unreadable"')),
      );
    });

    /** The human-gates workflow registered, and a run of it at its gate. */
    async function atGate(label: string): Promise<{ runId: string; gateId: string }> {
      const c = await client('realm', ['mcp']);
      try {
        const s = await call(c, 'start_run', { workflow_id: 'announce' });
        const runId = s['run_id'] as string;
        await call(c, 'execute_step', {
          run_id: runId,
          command: 'draft',
          params: { subject: 'Office closed Friday', body: 'The office is closed this Friday.' },
        });
        const gateId = (await runStore.get(runId)).pending_gate?.gate_id ?? '';
        expect(gateId, `fixture: no gate on the ${label} run`).not.toBe('');
        return { runId, gateId };
      } finally {
        await c.close();
      }
    }

    it(CELLS.gates, async () => {
      const page = 'docs/guides/human-gates.md';
      const yaml = fence(page, 'id: announce');
      const steps = (parseYaml(yaml) as { steps: Record<string, Reply> }).steps;
      // The second block holding `when:` (the first is the workflow itself).
      const when = parseYaml(fence(page, 'when:', 1)) as Reply;
      // (a) red when step 4's `when` line is not the one on `send`; (b) prints both.
      expect(when['when']).toBe(steps['send']!['when']);
      loadWorkflowFromString(yaml);
      registered('announce', { 'workflow.yaml': `${yaml}\n` });
      const first = await atGate('first');
      const list = sh(fence(page, 'realm run list --status').trim());
      const fill = (line: string, at: { runId: string; gateId: string }) =>
        line
          .trim()
          .replace('64993bb2-6f65-47d9-801c-d008e9291a00', at.runId)
          .replace('39792a3a-f9c3-470a-b94c-c314fb254234', at.gateId);
      const respond = sh(fill(fence(page, '--choice send'), first));
      const second = await atGate('second');
      const byAlice = sh(fill(fence(page, '--by alice'), second));
      const inspect = sh(`realm run inspect ${second.runId}`);
      // (a) red when the list does not show the waiting run, either answer is refused, or --by is not
      //     recorded as the page says; (b) prints each exit and output.
      expect(
        {
          list: [list.code, list.out.includes(first.runId)],
          respond: [
            respond.code,
            respond.out.includes(`Responded: ${first.runId} | choice 'send'`),
          ],
          byAlice: [
            byAlice.code,
            inspect.out.includes('answered by alice (as stated, not verified)'),
          ],
        },
        list.out + respond.out + respond.err + byAlice.out + byAlice.err + inspect.out,
      ).toEqual({ list: [0, true], respond: [0, true], byAlice: [0, true] });
    });

    it(CELLS.gateTimeout, async () => {
      const page = 'docs/guides/human-gates.md';
      const yaml = fence(page, 'id: announce');
      const limit = fence(page, 'timeout_seconds:');
      // The review step's gate replaced by the page's: the gate block is the step's last key.
      const withLimit = (text: string) =>
        yaml.replace(/ {4}gate:\n[\s\S]*?(?=\n\n {2}send:)/, text.replace(/^/gm, '    '));
      loadWorkflowFromString(withLimit(limit));
      // For the drain, one second in place of a day, as the page's own test used two.
      registered('announce', {
        'workflow.yaml': `${withLimit(limit.replace('timeout_seconds: 86400', 'timeout_seconds: 1'))}\n`,
      });
      const at = await atGate('limited');
      await new Promise((r) => setTimeout(r, 1_500));
      const drain = sh(fence(page, 'realm run drain').trim());
      const after = await runStore.get(at.runId);
      // (a) red when the page's gate does not validate, or drain does not enact the expired gate with
      //     its default; (b) prints the exit, the output and the run.
      expect(
        {
          drain: [
            drain.code,
            drain.out.includes(`✓ ${at.runId}: gate enacted`),
            drain.out.includes('Drained 1/1 run(s).'),
          ],
          run: [after.run_phase, after.skipped_steps],
        },
        drain.out + drain.err,
      ).toEqual({ drain: [0, true, true], run: ['completed', ['send']] });
    });

    it(CELLS.idempotency, async () => {
      const page = 'docs/guides/idempotency-and-batches.md';
      registered('sync', {
        'workflow.yaml': [
          'id: sync',
          'name: Sync an order',
          'version: 1',
          'steps:',
          '  fetch:',
          '    description: Fetch the order.',
          '    execution: agent',
          '',
        ].join('\n'),
      });
      const c = await client('realm', ['mcp']);
      try {
        const args = JSON.parse(fence(page, '"idempotency_key": "order-4417" }')) as Reply;
        const one = await call(c, 'start_run', args);
        const two = await call(c, 'start_run', args);
        const batch = await call(c, 'start_run_batch', JSON.parse(fence(page, '"items"')) as Reply);
        const items = batch['started'] as Reply[] | undefined;
        // (a) red when a repeat starts a second run, or the batch does not return the existing run
        //     for its third key; (b) prints the replies.
        expect(
          {
            one: [one['status'], one['deduped']],
            two: [two['status'], two['deduped'], two['run_id'] === one['run_id']],
            batch: (items ?? []).map((i) => [i['deduped'], i['run_id'] === one['run_id']]),
          },
          JSON.stringify({ one, two, batch }),
        ).toEqual({
          one: ['ok', false],
          two: ['ok', true, true],
          batch: [
            [false, false],
            [false, false],
            [true, true],
          ],
        });
      } finally {
        await c.close();
      }
    });

    it(CELLS.operate, async () => {
      const page = 'docs/guides/operate-runs.md';
      const line = (marker: string) => fence(page, marker).trim();
      const handlers = 'docs/guides/step-handlers.md';
      registered('price', {
        'registry.mjs': `${fence(handlers, 'handlers: {')}\n`,
        'workflow.yaml': `${fence(handlers, 'id: price')}\n`,
      });
      registered('announce', {
        'workflow.yaml': `${fence('docs/guides/human-gates.md', 'id: announce')}\n`,
      });
      const owed = async (quantity: number) =>
        (await runStore.create({ workflowId: 'price', workflowVersion: 1, params: { quantity } }))
          .run.id;
      const ran: Record<string, unknown> = {};
      const exit = (name: string, r: Ran) => {
        ran[name] = r.code;
        return r;
      };
      const ok = await owed(4);
      exit('list', sh(line('realm run list')));
      exit('stuck', sh(line('realm run list --stuck')));
      exit('inspect', sh(line('realm run inspect <run-id>').replace('<run-id>', ok)));
      const at = await atGate('announce');
      exit(
        'respond',
        sh(
          line('realm run respond <run-id>')
            .replace('<run-id>', at.runId)
            .replace('<gate-id>', at.gateId)
            .replace('<choice>', 'send'),
        ),
      );
      exit('advance', sh(line('realm run advance <run-id>').replace('<run-id>', ok)));
      const agentHelp = sh('realm agent --help').out;
      const agentFlags = line('realm agent --run-id')
        .split(' ')
        .filter((w) => w.startsWith('--'))
        .filter((f) => !agentHelp.includes(f));
      const broken = await owed(-1);
      sh(`realm run advance ${broken}`);
      exit(
        'resume',
        sh(
          line('realm run resume <run-id>').replace('<run-id>', broken).replace('<step>', 'total'),
        ),
      );
      const open = await owed(4);
      exit('abandon', sh(line('realm run abandon <run-id>').replace('<run-id>', open)));
      exit('cleanup', sh(line('realm run cleanup')));
      exit('export', sh(line('realm run export <run-id>').replace('<run-id>', ok)));
      exit('purge', sh(line('realm run purge')));
      exit('gc', sh(line('realm run gc')));
      const runs = Object.fromEntries(
        await Promise.all(
          [
            ['ok', ok],
            ['answered', at.runId],
            ['resumed', broken],
            ['abandoned', open],
          ].map(async ([k, id]) => {
            const r = await runStore.get(id!);
            return [k, [r.run_phase, r.completed_steps]];
          }),
        ),
      );
      // (a) red when a line the guide gives exits non-zero on a run it fits, or does not do what the
      //     guide says it does; (b) prints the exits, the phases and the agent flags missing.
      expect({
        ran,
        runs,
        agentFlags,
        exported: existsSync(join(project, 'run-44df45a3.json')),
      }).toEqual({
        ran: {
          list: 0,
          stuck: 0,
          inspect: 0,
          respond: 0,
          advance: 0,
          resume: 0,
          abandon: 0,
          cleanup: 0,
          export: 0,
          purge: 0,
          gc: 0,
        },
        runs: {
          ok: ['running', ['total']],
          answered: ['running', ['draft', 'review']],
          resumed: ['running', []],
          abandoned: ['abandoned', []],
        },
        agentFlags: [],
        exported: true,
      });
    });

    it(CELLS.handlers, async () => {
      const page = 'docs/guides/step-handlers.md';
      const registry = fence(page, 'handlers: {');
      const yaml = fence(page, 'id: price');
      writeFileSync(join(project, 'registry.mjs'), `${registry}\n`);
      writeFileSync(join(project, 'workflow.yaml'), `${yaml}\n`);
      // `extensions` needs the file's folder, so the whole workflow is loaded from its file.
      loadWorkflowFromFile(join(project, 'workflow.yaml'));
      // The handler on its own: a result, a failure, and an abort.
      const direct = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          [
            `const { default: r } = await import(${JSON.stringify(pathToFileURL(join(project, 'registry.mjs')).href)});`,
            'const h = r.handlers.order_total;',
            'const run = async (q) => { try { return await h.execute({ params: { quantity: q } }, { config: { unit_price: 12.5 } }); } catch (e) { return { threw: e.message }; } };',
            'console.log(JSON.stringify([await run(4), await run(-1), await run(5000)]));',
          ].join('\n'),
        ],
        { encoding: 'utf8' },
      );
      const validate = sh(fence(page, 'realm workflow validate ./').trim());
      const register = sh(fence(page, 'realm workflow register ./').trim());
      const c = await client('realm', ['mcp']);
      const s = await call(c, 'start_run', {
        workflow_id: 'price',
        params: { quantity: 4 },
      }).finally(() => c.close());
      const total = (await runStore.get(s['run_id'] as string)).evidence.find(
        (e) => e.step_id === 'total',
      );
      // (a) red when the handler does not end the three ways the page says, validate does not load it,
      //     or the engine does not run it on start_run; (b) prints each output.
      expect(
        {
          direct: JSON.parse(direct.stdout || 'null') as unknown,
          validate: [validate.code, validate.out.split('\n').slice(0, 2)],
          register: register.code,
          total: total?.output_summary,
        },
        direct.stderr + validate.err + register.err + JSON.stringify(s),
      ).toEqual({
        direct: [
          { data: { total: 50 } },
          { threw: 'quantity must be a positive number, got -1' },
          { abort: { message: 'Orders over 1000 units are quoted by hand.' } },
        ],
        validate: [
          0,
          [
            'Valid: price v1 (2 steps)',
            'Extensions: ./registry.mjs (adapters: 0, handlers: 1, processors: 0)',
          ],
        ],
        register: 0,
        total: { total: 50 },
      });
    });

    it(CELLS.coreQuickStart, async () => {
      const dir = nodeProject();
      // The files its text names: my-workflow/workflow.yaml, with an agent step my_step.
      mkdirSync(join(dir, 'my-workflow'));
      writeFileSync(
        join(dir, 'my-workflow', 'workflow.yaml'),
        [
          'id: my-workflow',
          'name: My workflow',
          'version: 1',
          'steps:',
          '  my_step:',
          '    description: Answer.',
          '    execution: agent',
          '',
        ].join('\n'),
      );
      writeFileSync(
        join(dir, 'main.ts'),
        `${fence('packages/core/README.md', 'loadWorkflowFromFile, JsonFileStore')}\n`,
      );
      const r = spawnSync(process.execPath, ['main.ts'], {
        cwd: dir,
        env: env(),
        encoding: 'utf8',
      });
      const runs = await runStore.list();
      // (a) red when the program does not run as written (e.g. `const run = await store.create(…)`,
      //     whose reply is `{ run, created }`), or does not take my_step; (b) prints its stderr.
      expect(
        { code: r.status, out: r.stdout, runs: runs.map((x) => [x.run_phase, x.completed_steps]) },
        r.stderr,
      ).toEqual({ code: 0, out: 'ok\n', runs: [['completed', ['my_step']]] });
    });

    it(CELLS.coreAdapter, () => {
      const dir = nodeProject();
      const program = [
        fence('packages/core/README.md', 'registry.register('),
        '',
        '// The preamble: the one name the block uses and never defines.',
        'async function callMyApi(operation: string, params: Record<string, unknown>) {',
        '  return { operation, params };',
        '}',
        '// Then what its last comment says: pass registry to executeStep.',
        "import { JsonFileStore, loadWorkflowFromString } from '@sensigo/realm';",
        'const definition = loadWorkflowFromString(',
        "  'id: api\\nname: api\\nversion: 1\\nservices:\\n  api:\\n    adapter: my-adapter\\n    trust: engine_delivered\\n' +",
        "    'steps:\\n  get:\\n    description: Get.\\n    execution: auto\\n    uses_service: api\\n    operation: things\\n    input_map:\\n      q: run.params.q\\n',",
        ');',
        'const store = new JsonFileStore();',
        "const { run } = await store.create({ workflowId: 'api', workflowVersion: 1, params: { q: 'x' } });",
        "const response = await executeStep(store, definition, { runId: run.id, command: 'get', input: {}, registry });",
        'console.log(JSON.stringify([response.status, response.data]));',
        '',
      ].join('\n');
      writeFileSync(join(dir, 'adapter.ts'), program);
      const r = spawnSync(process.execPath, ['adapter.ts'], {
        cwd: dir,
        env: env(),
        encoding: 'utf8',
      });
      // (a) red when the block stops running with callMyApi supplied, or its adapter does not serve a
      //     step through executeStep; (b) prints stderr.
      expect([r.status, r.stdout], r.stderr).toEqual([
        0,
        `${JSON.stringify(['ok', { operation: 'things', params: { q: 'x' } }])}\n`,
      ]);
    });

    it(CELLS.embedded, async () => {
      const dir = nodeProject();
      writeFileSync(
        join(dir, 'server.ts'),
        `${fence('packages/mcp-server/README.md', 'createRealmMcpServer();')}\n`,
      );
      // (a) red when the program does not start a server that serves the 11 tools; (b) prints the count.
      expect(await toolCount(await client(process.execPath, ['server.ts'], dir))).toBe(11);
      // (a) red when the `realm-mcp` command the configurations start is not the server the package
      //     builds; (b) prints both paths.
      expect(binOf('mcp-server', 'realm-mcp')).toBe(resolveMcpServerEntry());
    });

    it(CELLS.provider, async () => {
      const page = 'packages/cli/README.md';
      const dir = nodeProject();
      const help = sh('realm agent --help').out;
      const missing = fence(page, 'OPENAI_API_KEY=')
        .split(/\s+/)
        .filter((w) => w.startsWith('--'))
        .filter((f) => !help.includes(f));
      // A local stand-in for Ollama: it answers every generate request with the step's answer.
      const asked: string[] = [];
      const ollama: Server = createServer((req, res) => {
        let body = '';
        req.on('data', (d: Buffer) => (body += d.toString()));
        req.on('end', () => {
          asked.push(`${req.method} ${req.url}`);
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ response: JSON.stringify({ answer: 'done' }) }));
        });
      });
      const port = await new Promise<number>((resolve) =>
        ollama.listen(0, '127.0.0.1', () => {
          const a = ollama.address();
          resolve(typeof a === 'object' && a !== null ? a.port : 0);
        }),
      );
      try {
        const module = fence(page, 'class OllamaProvider');
        // The file is the one its first line names.
        const file = /^\/\/ (\S+)/.exec(module)![1]!;
        writeFileSync(
          join(dir, file),
          `${module.replace('http://localhost:11434', `http://127.0.0.1:${port}`)}\n`,
        );
        mkdirSync(join(dir, 'my-workflow'));
        writeFileSync(
          join(dir, 'my-workflow', 'workflow.yaml'),
          [
            'id: my-workflow',
            'name: My workflow',
            'version: 1',
            'steps:',
            '  my_step:',
            '    description: Answer.',
            '    execution: agent',
            '    input_schema:',
            '      type: object',
            '      required: [answer]',
            '      properties:',
            '        answer:',
            '          type: string',
            '',
          ].join('\n'),
        );
        const r = await shAsync(fence(page, '--provider-module ./').trim(), dir);
        const runs = await runStore.list();
        // (a) red when the module does not load under the name the command gives, or does not drive
        //     the step through Ollama's generate endpoint; (b) prints the exit and stderr.
        expect(
          { missing, code: r.code, asked, runs: runs.map((x) => [x.run_phase, x.completed_steps]) },
          r.out + r.err,
        ).toEqual({
          missing: [],
          code: 0,
          asked: ['POST /api/generate'],
          runs: [['completed', ['my_step']]],
        });
      } finally {
        ollama.close();
      }
    });
  },
);
