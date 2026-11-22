// failure-text-iv-b1.test.ts — gap 2, unit (iv-b1): `realm mcp` and `realm serve` take the
// failure-text setting (`--failure-text`, `REALM_MCP_FAILURE_TEXT`) as the server will read it.
//
// The cells run the built `realm` command with a fresh HOME: `--check` prints the value beside the
// gate-answers value; a bad value refuses the start in each command; each command hands the flag and
// the variable to its server (read back as the `realm/failure_text` capability over stdio and over
// HTTP); under `hidden` one more start line, on `realm mcp`'s stderr and on `realm serve`'s stdout,
// and none under `shown`; `realm run inspect` keeps a failure's words. Every assertion carries (a)
// the change that turns it red and (b) what it prints: lines, exit codes and capabilities — never an
// environment.
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  executeStep,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const MCP_PAGE = 'docs/reference/cli/realm-mcp-and-serve.md';
const ENV_PAGE = 'docs/reference/environment-and-files.md';

/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. Each
 *  sentence is pinned in the cell that executes it. */
function claim(page: string, sentence: string): void {
  const flat = (t: string): string => t.replace(/\s+/g, ' ');
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

const homes: TempHome[] = [];
afterEach(async () => {
  for (const h of homes.splice(0).reverse()) await h.cleanup();
});

/** The built `realm` with a fresh HOME and only the variables named. */
function realm(args: string[], extra: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'realm-failure-text-cli-'));
  const env: Record<string, string> = { PATH: process.env['PATH'] ?? '', HOME: home, ...extra };
  return spawnSync(process.execPath, [CLI, ...args], {
    env,
    encoding: 'utf8',
    timeout: 60_000,
    input: '',
  });
}

const HIDDEN_LINE = (from: string) =>
  `Failure text over MCP: hidden (${from}). In get_run_state an assistant sees the step and its code, category or class, not the failure's words; realm run inspect still shows them.`;

/** `realm mcp` over stdio: the capability its server advertises and its stderr lines. */
async function mcpSession(args: string[], extra: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'realm-failure-text-stdio-'));
  let stderr = '';
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'mcp', ...args],
    env: { PATH: process.env['PATH'] ?? '', HOME: home, ...extra },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
  const client = new Client({ name: 'failure-text-stdio', version: '0' });
  await client.connect(transport);
  const capability = client.getServerCapabilities()?.experimental?.['realm/failure_text'];
  await client.close();
  return { capability, lines: stderr.trim().split('\n') };
}

/** A free local port. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** `realm serve --dev`: the capability one request reads, and its stdout lines. */
async function serveSession(args: string[], extra: Record<string, string> = {}) {
  const port = await freePort();
  const home = mkdtempSync(join(tmpdir(), 'realm-failure-text-serve-'));
  const child = spawn(process.execPath, [CLI, 'serve', '--dev', '--port', String(port), ...args], {
    env: { PATH: process.env['PATH'] ?? '', HOME: home, ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('serve never printed its lines')), 30_000);
      const check = (): void => {
        if (out.includes('Gate answers over MCP:')) {
          clearTimeout(timer);
          setTimeout(resolve, 200);
        }
      };
      child.stdout.on('data', check);
      child.on('close', () => reject(new Error('serve exited')));
    });
    const client = new Client({ name: 'failure-text-http', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/`),
      ) as unknown as Parameters<Client['connect']>[0],
    );
    const capability = client.getServerCapabilities()?.experimental?.['realm/failure_text'];
    await client.close();
    return { capability, lines: out.trim().split('\n') };
  } finally {
    child.kill();
  }
}

describe('gap 2 (iv-b1), check 1 — each command reads the flag and the variable as its server will', () => {
  it('realm mcp: the flag and the variable each reach the server, with their start line; none under shown', async () => {
    claim(
      MCP_PAGE,
      "| `--failure-text <value>` | `shown` | Whether an assistant sees a failure's words in `get_run_state`: `shown`, or `hidden`, which shows the step, its code, category or class where the record has them, and in place of the words their length (`‹string, N characters›`). With `REALM_MCP_FAILURE_TEXT` also set, `hidden` wins. Added after version 0.50.0. |",
    );
    claim(
      MCP_PAGE,
      "Under the failure-text value `hidden`, the start line is followed by one more: `Failure text over MCP: hidden (from --failure-text). In get_run_state an assistant sees the step and its code, category or class, not the failure's words; realm run inspect still shows them.`, naming where the value came from as the gate-answers line does; under `shown` there is none. Added after version 0.50.0.",
    );
    const flag = await mcpSession(['--failure-text', 'hidden']);
    const env = await mcpSession([], { REALM_MCP_FAILURE_TEXT: 'hidden' });
    const unset = await mcpSession([]);
    // The line right after the gate-answers start line, and every failure-text line (the client
    // shows no forms, so the no-forms line follows when it connects).
    const seen = (lines: string[]) => ({
      next: lines[1]?.startsWith('Failure text over MCP:') === true ? lines[1] : 'none',
      all: lines.filter((l) => l.startsWith('Failure text over MCP:')).length,
    });
    // (a) red when the command does not pass its flag to the server, the server does not read the
    //     variable, or the line is missing under hidden or printed under shown; (b) prints each
    //     capability, the line after the start line and the count of failure-text lines.
    expect({
      flag: [flag.capability, seen(flag.lines)],
      env: [env.capability, seen(env.lines)],
      unset: [unset.capability, seen(unset.lines)],
    }).toEqual({
      flag: [
        { value: 'hidden', source_kind: 'flag' },
        { next: HIDDEN_LINE('from --failure-text'), all: 1 },
      ],
      env: [
        { value: 'hidden', source_kind: 'env' },
        { next: HIDDEN_LINE('from REALM_MCP_FAILURE_TEXT'), all: 1 },
      ],
      unset: [
        { value: 'shown', source_kind: 'default' },
        { next: 'none', all: 0 },
      ],
    });
  }, 90_000);

  it('realm serve: the flag and the variable each reach every request’s server; the line is on stdout', async () => {
    claim(
      MCP_PAGE,
      '| `--failure-text <value>` | `shown` | As for `realm mcp`. Added after version 0.50.0. |',
    );
    claim(
      MCP_PAGE,
      'Under the failure-text value `hidden`, it also prints the failure-text line shown for `realm mcp`, on standard output, after the gate-answers value (added after version 0.50.0).',
    );
    const flag = await serveSession(['--failure-text', 'hidden']);
    const env = await serveSession([], { REALM_MCP_FAILURE_TEXT: 'hidden' });
    const unset = await serveSession([]);
    const after = (lines: string[]) =>
      lines.slice(lines.findIndex((l) => l.startsWith('Gate answers over MCP:')) + 1);
    // (a) red when serve does not pass its flag to each request's server, or the line is missing
    //     under hidden or printed under shown; (b) prints each capability and the stdout lines after
    //     the gate-answers line.
    expect({
      flag: [flag.capability, after(flag.lines)],
      env: [env.capability, after(env.lines)],
      unset: [unset.capability, after(unset.lines)],
    }).toEqual({
      flag: [{ value: 'hidden', source_kind: 'flag' }, [HIDDEN_LINE('from --failure-text')]],
      env: [{ value: 'hidden', source_kind: 'env' }, [HIDDEN_LINE('from REALM_MCP_FAILURE_TEXT')]],
      unset: [{ value: 'shown', source_kind: 'default' }, []],
    });
  }, 120_000);

  it('a bad value refuses the start in each command: one line naming where it was set, exit 1', () => {
    claim(
      MCP_PAGE,
      'So does a failure-text value other than `shown` or `hidden` (added after version 0.50.0).',
    );
    const mcp = realm(['mcp', '--failure-text', 'hiden']);
    const serve = realm(['serve', '--dev'], { REALM_MCP_FAILURE_TEXT: 'nope' });
    // (a) red when a misspelt value starts a server (it would show the words); (b) prints the exits
    //     and the lines.
    expect({
      mcp: [mcp.status, mcp.stderr.trim()],
      serve: [serve.status, serve.stderr.trim()],
    }).toEqual({
      mcp: [
        1,
        "realm mcp: invalid --failure-text value 'hiden': expected shown or hidden — refused at start: this server does not start while it is set, because a misspelt value would show an assistant a failure's words when you believe they are hidden. Fix the value or remove it. The server starts as soon as it is valid.",
      ],
      serve: [
        1,
        "realm serve: invalid REALM_MCP_FAILURE_TEXT value 'nope': expected shown or hidden — refused at start: this server does not start while it is set, because a misspelt value would show an assistant a failure's words when you believe they are hidden. Fix the value or remove it. The server starts as soon as it is valid.",
      ],
    });
  }, 90_000);
});

describe('gap 2 (iv-b1) — a flag-like word after --failure-text is refused by its own check (#920 C-2)', () => {
  it('realm mcp --failure-text --check and realm serve --failure-text --check: refused as an invalid value, exit 1', () => {
    const mcp = realm(['mcp', '--failure-text', '--check']);
    const serve = realm(['serve', '--failure-text', '--check']);
    // (a) red when the word after the flag is read as --check (the server's value then unchecked), or
    //     the flag is classed GUARDED without a check of its own; (b) prints the exits and the
    //     refusals' openings.
    expect({
      mcp: [mcp.status, mcp.stderr.split(':').slice(0, 2).join(':')],
      serve: [serve.status, serve.stderr.split(':').slice(0, 2).join(':')],
    }).toEqual({
      mcp: [1, "realm mcp: invalid --failure-text value '--check'"],
      serve: [1, "realm serve: invalid --failure-text value '--check'"],
    });
  }, 60_000);
});

describe('gap 2 (iv-b1), check 9 — --check, --help and the environment table', () => {
  it('--check prints the failure-text value after the gate-answers value; hidden wins over the flag’s shown', () => {
    claim(
      MCP_PAGE,
      '| `--check` | Off | Prints the gate-answers and failure-text values the server would start with and the separation check, then exits without starting. Added after version 0.47.0; the failure-text value after version 0.50.0. |',
    );
    const mcp = realm(['mcp', '--check', '--failure-text', 'hidden']);
    const serve = realm(['serve', '--check', '--failure-text', 'shown'], {
      REALM_MCP_FAILURE_TEXT: 'hidden',
    });
    const unset = realm(['mcp', '--check']);
    // (a) red when --check leaves the value out, loses its source, or lets shown win; (b) prints the
    //     exits and each second line.
    expect({
      mcp: [mcp.status, mcp.stdout.split('\n')[1]],
      serve: [serve.status, serve.stdout.split('\n')[1]],
      unset: [unset.status, unset.stdout.split('\n')[1]],
    }).toEqual({
      mcp: [
        0,
        "Failure text over MCP: hidden (from --failure-text) — as read from this shell's environment and flags.",
      ],
      serve: [
        0,
        "Failure text over MCP: hidden (from REALM_MCP_FAILURE_TEXT; also set: --failure-text = shown — the most restrictive value wins) — as read from this shell's environment and flags.",
      ],
      unset: [
        0,
        "Failure text over MCP: shown (from the default) — as read from this shell's environment and flags.",
      ],
    });
  }, 90_000);

  it("each command's --help names the flag in the gate-answers flag's style", () => {
    const flagLine = (text: string): string =>
      text
        .split('\n\n')
        .flatMap((block) => block.split(/\n(?=\s{2}-)/))
        .find((l) => l.trimStart().startsWith('--failure-text'))
        ?.replace(/\s+/g, ' ')
        .trim() ?? '';
    const mcp = realm(['mcp', '--help']);
    const serve = realm(['serve', '--help']);
    const words =
      "--failure-text <value> Whether the assistant sees a failure's words in get_run_state: shown (the default) or hidden. The most restrictive of this flag and REALM_MCP_FAILURE_TEXT wins.";
    // (a) red when a command lacks the flag or its help says otherwise; (b) prints both lines.
    expect({ mcp: flagLine(mcp.stdout), serve: flagLine(serve.stdout) }).toEqual({
      mcp: words,
      serve: words,
    });
  }, 60_000);

  it('the CHANGELOG line names the flag, the variable, the option and the capability', () => {
    // Executed by this file's cells (the flag, the variable, the start line, --check) and the MCP
    // package's (the option, the fields, the receipt, the capability).
    claim(
      'CHANGELOG.md',
      "- **An operator can keep a failure's words from an assistant in `get_run_state`.** `realm mcp --failure-text` and `realm serve --failure-text` take `shown` or `hidden` (`--failure-text <shown|hidden>`); `REALM_MCP_FAILURE_TEXT` sets it for them, for the `realm-mcp` command and for a program's `createRealmMcpServer`, and a program can pass it in `RealmMcpServerOptions` (`RealmMcpServerOptions.failureText`); `hidden` wins, and the default is `shown`.",
    );
    // Correction 1: what is shaped and what stays — executed by the MCP package's field cells (Realm's
    // words inside failures[].message shaped with the rest), its terminal_reason and drive_failing
    // cells (Realm's sentence kept), and this file's load-warning cells.
    claim(
      'CHANGELOG.md',
      "in `failures[].message`, `drive_failures.entries[].message`, the `drive_failing` reason, a handler's abort message, `terminal_reason` and the warning that the project's code could not be loaded, with the step and its code, category or class kept, and Realm's sentence around the failure in `terminal_reason`, the `drive_failing` reason and that warning;",
    );
  });

  it('the environment table names the variable and where it is read', () => {
    // Executed by check 1's cells: the variable on realm mcp, realm serve, the realm-mcp bin (the
    // MCP package's cells) and createRealmMcpServer (the embedder cell).
    claim(
      ENV_PAGE,
      "| `REALM_MCP_FAILURE_TEXT` | `realm mcp`, `realm serve`, the `realm-mcp` command, a program's `createRealmMcpServer` | Whether an assistant sees a failure's words in `get_run_state`: `shown` (the default) or `hidden`. See [Run state and health](mcp/run-state-and-health.md#failure-text). Added after version 0.50.0. |",
    );
  });
});

/** Correction 1 — a run whose workflow's code module throws when it is imported: registered from its
 *  folder with `realm workflow register` (so the folder is its project), the run created in the same
 *  home; then `get_run_state` over `realm mcp`'s stdio, with the given failure-text value. */
async function loadFailureState(failureText: 'shown' | 'hidden') {
  const h = await makeTempHome();
  homes.push(h);
  const project = mkdtempSync(join(tmpdir(), 'realm-failure-text-project-'));
  writeFileSync(
    join(project, 'workflow.yaml'),
    [
      'id: ft-load-failed',
      'name: ft-load-failed',
      'version: 1',
      'extensions: ./registry.mjs',
      'steps:',
      '  a:',
      '    description: A.',
      '    execution: agent',
      '',
    ].join('\n'),
  );
  // Registered with a module that loads (register imports it), then the module changed so that it
  // throws at import, as code that reads a missing setting at load does on the server.
  writeFileSync(join(project, 'registry.mjs'), 'export default { handlers: {} };\n');
  const env = { PATH: process.env['PATH'] ?? '', HOME: h.root! };
  const registered = spawnSync(
    process.execPath,
    [CLI, 'workflow', 'register', join(project, 'workflow.yaml')],
    { env, encoding: 'utf8', timeout: 60_000 },
  );
  if (registered.status !== 0) throw new Error(`fixture: register exited ${registered.status}`);
  writeFileSync(join(project, 'registry.mjs'), `throw new Error(${JSON.stringify(LOAD_WORDS)});\n`);
  const { record } = await h.home.runStore.create({
    workflowId: 'ft-load-failed',
    workflowVersion: 1,
    params: {},
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'mcp', '--failure-text', failureText],
    env,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'failure-text-load', version: '0' });
  await client.connect(transport);
  const raw = (await client.callTool({
    name: 'get_run_state',
    arguments: { run_id: record.id },
  })) as {
    content: Array<{ text?: string }>;
  };
  await client.close();
  const text = raw.content[0]?.text ?? '{}';
  const reply = JSON.parse(text) as Record<string, unknown>;
  const warning = ((reply['warnings'] as string[] | undefined) ?? []).find((w) =>
    w.startsWith('this server could not load the project code'),
  );
  return { text, reply, warning };
}

/** A fake string no masking pattern catches (an email would be masked by pattern under shown too). */
const LOAD_WORDS = 'Config for tenant acme-test card 4111-1111-1111-1111 missing';

describe('gap 2 (iv-b1) correction 1 — the project-code load warning', () => {
  it('check 1 — under hidden: Realm’s sentence and the code kept, the loader’s message a shape, its path in the receipt', async () => {
    claim(
      'docs/reference/mcp/run-state-and-health.md',
      "| The warning that this server could not load the project's code (in `warnings`) | Realm's sentence, with the code's message as its shape: `this server could not load the project code for workflow '<workflow>' (<code>): ‹string, N characters›; …` | The workflow and the error code |",
    );
    const shown = await loadFailureState('shown');
    const hidden = await loadFailureState('hidden');
    const head = "this server could not load the project code for workflow 'ft-load-failed' (";
    const tail = '; no step can be run or advanced from this server until it loads.';
    // The loader's message, as the shown warning carries it (JSON-quoted, as `escapedBoundedValue`
    // writes it): between the code's `): ` and the tail; N is its length as thrown.
    const shownMessage = shown.warning?.slice(shown.warning.indexOf('): ') + 3, -tail.length);
    const thrown = JSON.parse(shownMessage ?? '""') as string;
    const receipt = hidden.reply['disclosure'] as Record<string, unknown>;
    // (a) red when the warning is built as today under hidden (the loader's words reach the
    //     assistant); (b) prints the warning shown, the receipt's word and paths, and whether the
    //     fake string is anywhere in the reply.
    expect({
      starts: hidden.warning?.startsWith(head),
      warning: hidden.warning,
      word: receipt['failure_text'],
      paths: receipt['shaped'],
      words: hidden.text.includes('4111-1111-1111-1111'),
    }).toEqual({
      starts: true,
      warning: shown.warning?.replace(
        `): ${shownMessage}${tail}`,
        `): ‹string, ${thrown.length} characters›${tail}`,
      ),
      word: 'withheld',
      paths: ['warnings'],
      words: false,
    });
  }, 120_000);

  it('check 2 — under shown: the warning as on the base, the loader’s words in it, no receipt word', async () => {
    const shown = await loadFailureState('shown');
    const receipt = shown.reply['disclosure'] as Record<string, unknown>;
    // (a) red when the shape is applied whatever the setting; (b) prints whether the warning holds
    //     the module's words, its close, and the receipt's word.
    expect({
      words: shown.warning?.includes(LOAD_WORDS),
      closes: shown.warning?.endsWith(
        '; no step can be run or advanced from this server until it loads.',
      ),
      word: receipt['failure_text'],
    }).toEqual({ words: true, closes: true, word: undefined });
  }, 120_000);
});

describe('gap 2 (iv-b1) — realm run inspect keeps a failure’s words whatever the setting', () => {
  it('a failed run’s inspect shows the handler’s words with REALM_MCP_FAILURE_TEXT=hidden set', async () => {
    const h = await makeTempHome();
    homes.push(h);
    const def: WorkflowDefinition = {
      id: 'ft-inspect',
      name: 'ft-inspect',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: { a: { description: 'A.', execution: 'agent', depends_on: [] } },
    } as WorkflowDefinition;
    await h.home.workflowStore.register(def);
    const { record } = await h.home.runStore.create({
      workflowId: def.id,
      workflowVersion: 1,
      params: {},
    });
    const words = 'the customer card 4242 is on fire';
    await executeStep(h.home.runStore, def, {
      runId: record.id,
      command: 'a',
      input: {},
      dispatcher: async () => {
        throw new Error(words);
      },
    });
    const r = spawnSync(process.execPath, [CLI, 'run', 'inspect', record.id], {
      env: { PATH: process.env['PATH'] ?? '', HOME: h.root!, REALM_MCP_FAILURE_TEXT: 'hidden' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    // (a) red when the setting reaches inspect (the person loses the words); (b) prints the exit
    //     and whether the output holds them.
    expect({ code: r.status, words: r.stdout.includes(words) }).toEqual({ code: 0, words: true });
  }, 60_000);
});
