// gate-answers-default-programs.test.ts — the gate-answers default (2026-11-14), the programs' half:
// the built `realm mcp`, `realm serve` and `realm-mcp`, spawned with a fresh HOME.
//
// - AC5: the start line under each value, per program, word for word.
// - AC6: the connect line — once for an `asked` session whose client shows no forms on `realm mcp`
//   and `realm-mcp`; never for a client that shows forms, or under `permitted` or `withheld`.
// - PR #1167 correction 1, item 2: when a flag or the variable set `asked`, the start line's and the
//   connect line's remedy names each place that holds it.
// - AC7: dev mode's warning on `realm serve`, under `permitted` only.
// - Correction 1, item 5: both commands' `--help` name the three values (the CHANGELOG says it changed).
// - AC3 (programs' half): `offered` given as the flag or the variable prints the old name's line
//   once, on stderr, and every read-back says `permitted` (the start line, `--check`'s value lines);
//   the form-wait refusal says `permitted (given as offered)` (correction 1, item 6).
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: the
// lines a program printed and its exit code — never an environment.
import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const REALM_MCP = fileURLToPath(new URL('../../../mcp-server/dist/bin.js', import.meta.url));

type Program = 'realm mcp' | 'realm-mcp' | 'realm serve';

/** A fresh HOME, the PATH, and only the variables named. */
function envOf(extra: Record<string, string> = {}): Record<string, string> {
  const home = mkdtempSync(join(tmpdir(), 'realm-gad-programs-'));
  return { PATH: process.env['PATH'] ?? '', HOME: home, ...extra };
}

/** `realm mcp` or `realm-mcp`, its input closed at once: what it printed, and its exit code. */
function stdioStart(program: 'realm mcp' | 'realm-mcp', args: string[], extra = {}) {
  const r = spawnSync(
    process.execPath,
    program === 'realm mcp' ? [CLI, 'mcp', ...args] : [REALM_MCP, ...args],
    { env: envOf(extra), input: '', encoding: 'utf8', timeout: 60_000 },
  );
  return { stdout: r.stdout, stderr: r.stderr, code: r.status };
}

/**
 * `realm mcp` or `realm-mcp` with one client session: `initialize` (declaring forms or not) and
 * `notifications/initialized`, then its input closed once the reply came. Its stderr's lines.
 */
async function stdioSession(
  program: 'realm mcp' | 'realm-mcp',
  args: string[],
  forms: boolean,
  extra: Record<string, string> = {},
): Promise<string[]> {
  const child = spawn(
    process.execPath,
    program === 'realm mcp' ? [CLI, 'mcp', ...args] : [REALM_MCP, ...args],
    { env: envOf(extra), stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: forms ? { elicitation: { form: {} } } : {},
        clientInfo: { name: 'gad-programs', version: '0' },
      },
    })}\n`,
  );
  const deadline = Date.now() + 60_000;
  while (!stdout.includes('"id":1') && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  // The notification is handled in its own turn; then the input closes and the program ends.
  await new Promise((r) => setTimeout(r, 300));
  child.stdin.end();
  await exited;
  return stderr.split('\n').filter((l) => l !== '');
}

/**
 * `realm serve` on a free port, until its gate-answers line is out. Its stdout and stderr lines; the
 * process is then stopped.
 */
async function serveLines(
  args: string[],
  extra: Record<string, string> = {},
): Promise<{ stdout: string[]; stderr: string[] }> {
  const child = spawn(process.execPath, [CLI, 'serve', '--port', '0', ...args], {
    env: envOf({ REALM_SERVE_TOKEN: 'gad-programs-token', ...extra }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const deadline = Date.now() + 60_000;
  while (!stdout.includes('Gate answers over MCP:') && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  child.kill('SIGTERM');
  await exited;
  return {
    stdout: stdout.split('\n').filter((l) => l !== ''),
    stderr: stderr.split('\n').filter((l) => l !== ''),
  };
}

const gateLine = (lines: string[]) => lines.find((l) => l.startsWith('Gate answers over MCP: '));

/** A command's --help with its wrapping undone: one space for every run of white space. */
const flatHelp = (text: string) => text.replace(/\s+/g, ' ');

const TERMINAL =
  'a person runs, in a terminal on this machine as the user that runs this server: realm run inspect <run_id>, then realm run respond <run_id> --gate <gate_id> --choice <choice>; the agent tells the user the run id. Another Realm server or CLI on the same store can still record answers.';
const ASKED_STDIO = (remedy: string, source = 'the default') =>
  `Gate answers over MCP: asked (${source}). The agent gets no tool on this server that records a gate answer. In chat apps that show forms, questions go to the person in the app's own form. In apps without forms, ${TERMINAL} To let the agent answer, set ${remedy}.`;
const ASKED_SERVE = `Gate answers over MCP: asked (the default). No tool on this server records a gate answer, and this server sends no forms. To answer a waiting question, ${TERMINAL} To let the agent answer, set --gate-answers permitted.`;
const PERMITTED = (from: string) =>
  `Gate answers over MCP: permitted (from ${from}; the default is asked). Any client of this server, the agent included, can record a gate answer; it is recorded as arriving through the MCP answer tool.`;
const WITHHELD = (from: string) =>
  `Gate answers over MCP: withheld (from ${from}). No tool on this server records a gate answer, and its replies name no way to answer. To answer a waiting question, a person runs, in a terminal on this machine as the user that runs this server: realm run inspect <run_id> (shows the question, its gate id and its choices), then realm run respond <run_id> --gate <gate_id> --choice <choice>. The agent tells the user the run id. Another Realm server or CLI on the same store can still record answers.`;
const CONNECT = (remedy: string) =>
  `Gate answers over MCP: this app shows no forms, so the agent cannot answer gates on this server and the person cannot answer in the app. A person answers in a terminal on this machine with realm run respond; to let the agent answer, set ${remedy}.`;
const DEV_WARNING =
  "Warning: dev mode — authentication is disabled: any process on this machine can call this server's tools, the gate answer tool included.";

describe('the gate-answers default — the start lines, per value and program (AC5)', () => {
  it('realm mcp and realm-mcp: asked, permitted and withheld, word for word', () => {
    const lines: Record<string, string | undefined> = {};
    for (const [label, program, args, env] of [
      ['mcp asked', 'realm mcp', [], {}],
      ['mcp permitted', 'realm mcp', ['--gate-answers', 'permitted'], {}],
      ['mcp withheld', 'realm mcp', ['--gate-answers', 'withheld'], {}],
      ['realm-mcp asked', 'realm-mcp', [], {}],
      ['realm-mcp permitted', 'realm-mcp', [], { REALM_MCP_GATE_ANSWERS: 'permitted' }],
      ['realm-mcp withheld', 'realm-mcp', [], { REALM_MCP_GATE_ANSWERS: 'withheld' }],
    ] as const) {
      const r = stdioStart(program, [...args], env);
      lines[label] = `${r.code} ${gateLine(r.stderr.split('\n'))}`;
    }
    // (a) red when asked keeps the old words (the agent keeps the answer tool in apps without forms;
    //     the withheld remedy), permitted is named offered, or realm-mcp's remedy names a flag it
    //     refuses; (b) prints each program's exit code and line.
    expect(lines).toEqual({
      'mcp asked': `0 ${ASKED_STDIO('--gate-answers permitted')}`,
      'mcp permitted': `0 ${PERMITTED('--gate-answers')}`,
      'mcp withheld': `0 ${WITHHELD('--gate-answers')}`,
      'realm-mcp asked': `0 ${ASKED_STDIO('REALM_MCP_GATE_ANSWERS=permitted')}`,
      'realm-mcp permitted': `0 ${PERMITTED('REALM_MCP_GATE_ANSWERS')}`,
      'realm-mcp withheld': `0 ${WITHHELD('REALM_MCP_GATE_ANSWERS')}`,
    });
  }, 120_000);

  it('realm serve: asked, permitted and withheld, word for word, on stdout', async () => {
    const line = async (args: string[]) => gateLine((await serveLines(args)).stdout);
    // (a) red when serve's asked line keeps "every client keeps the answer tool", or permitted is
    //     named offered; (b) prints each line.
    expect({
      asked: await line([]),
      permitted: await line(['--gate-answers', 'permitted']),
      withheld: await line(['--gate-answers', 'withheld']),
    }).toEqual({
      asked: ASKED_SERVE,
      permitted: PERMITTED('--gate-answers'),
      withheld: WITHHELD('--gate-answers'),
    });
  }, 120_000);
});

describe('the gate-answers default — the line for an app without forms (AC6)', () => {
  it('once for an asked session whose client shows no forms, on realm mcp and realm-mcp; never with forms, under permitted or withheld', async () => {
    const count = async (
      program: 'realm mcp' | 'realm-mcp',
      args: string[],
      forms: boolean,
      env: Record<string, string> = {},
    ) => {
      const remedy =
        program === 'realm-mcp' ? 'REALM_MCP_GATE_ANSWERS=permitted' : '--gate-answers permitted';
      const stderr = await stdioSession(program, args, forms, env);
      return stderr.filter((l) => l === CONNECT(remedy)).length;
    };
    // (a) red when the line is missing, printed twice, printed for a client that shows forms, or
    //     printed under permitted or withheld; (b) prints each session's count.
    expect({
      mcpNoForms: await count('realm mcp', [], false),
      mcpForms: await count('realm mcp', [], true),
      mcpPermitted: await count('realm mcp', ['--gate-answers', 'permitted'], false),
      mcpWithheld: await count('realm mcp', ['--gate-answers', 'withheld'], false),
      realmMcpNoForms: await count('realm-mcp', [], false),
      realmMcpForms: await count('realm-mcp', [], true),
      realmMcpPermitted: await count('realm-mcp', [], false, {
        REALM_MCP_GATE_ANSWERS: 'permitted',
      }),
    }).toEqual({
      mcpNoForms: 1,
      mcpForms: 0,
      mcpPermitted: 0,
      mcpWithheld: 0,
      realmMcpNoForms: 1,
      realmMcpForms: 0,
      realmMcpPermitted: 0,
    });
  }, 180_000);
});

describe('the gate-answers default — the remedy names where asked was set (correction 1, item 2)', () => {
  it('the variable sets asked and the flag permitted: the start and connect lines name the variable; both set asked: both named', async () => {
    const lines = async (args: string[]) => {
      const stderr = await stdioSession('realm mcp', args, false, {
        REALM_MCP_GATE_ANSWERS: 'asked',
      });
      return {
        start: gateLine(stderr),
        connect: stderr.filter((l) => l.includes('this app shows no forms')),
      };
    };
    // (a) red when the remedy names --gate-answers permitted whatever the source (setting it then
    //     changes nothing: asked outranks permitted), or misses a place that holds asked; (b) prints
    //     each session's start and connect lines.
    expect({
      envAskedFlagPermitted: await lines(['--gate-answers', 'permitted']),
      bothAsked: await lines(['--gate-answers', 'asked']),
    }).toEqual({
      envAskedFlagPermitted: {
        start: ASKED_STDIO(
          'permitted in place of asked in REALM_MCP_GATE_ANSWERS',
          'from REALM_MCP_GATE_ANSWERS; also set: --gate-answers = permitted — the most restrictive value wins; the default is also asked',
        ),
        connect: [CONNECT('permitted in place of asked in REALM_MCP_GATE_ANSWERS')],
      },
      bothAsked: {
        start: ASKED_STDIO(
          'permitted in place of asked in --gate-answers and REALM_MCP_GATE_ANSWERS',
          'from --gate-answers; also set: REALM_MCP_GATE_ANSWERS = asked — the most restrictive value wins; the default is also asked',
        ),
        connect: [
          CONNECT('permitted in place of asked in --gate-answers and REALM_MCP_GATE_ANSWERS'),
        ],
      },
    });
  }, 120_000);
});

describe('the gate-answers default — both commands’ --help (correction 1, item 5: the CHANGELOG names it)', () => {
  it('realm mcp --help and realm serve --help name asked (the default), permitted or withheld', () => {
    const help = (command: string) =>
      flatHelp(
        spawnSync(process.execPath, [CLI, command, '--help'], {
          env: envOf(),
          encoding: 'utf8',
          timeout: 60_000,
        }).stdout,
      );
    const said =
      'How this server handles gate answers: asked (the default), permitted or withheld. The most restrictive of this flag and REALM_MCP_GATE_ANSWERS wins.';
    // (a) red when either command's --help keeps offered, or drops the value list; (b) prints whether
    //     each says it.
    expect({ mcp: help('mcp').includes(said), serve: help('serve').includes(said) }).toEqual({
      mcp: true,
      serve: true,
    });
  }, 120_000);
});

describe('the gate-answers default — dev mode’s warning (AC7)', () => {
  it('realm serve --dev warns that the answer tool is open under permitted only', async () => {
    const warned = async (args: string[]) =>
      (await serveLines(['--dev', ...args])).stderr.includes(DEV_WARNING);
    // (a) red when the warning prints under asked (no answer tool is listed there now) or withheld,
    //     or not under permitted; (b) prints each.
    expect({
      asked: await warned([]),
      permitted: await warned(['--gate-answers', 'permitted']),
      withheld: await warned(['--gate-answers', 'withheld']),
    }).toEqual({ asked: false, permitted: true, withheld: false });
  }, 120_000);
});

describe('the gate-answers default — offered is permitted, and says so (AC3, programs’ half)', () => {
  const ALIAS = (program: Program, given: string) =>
    `${program}: ${given} is now called permitted; offered still works.`;

  it('the flag and the variable: the old name’s line once on stderr; the start line and --check read permitted', async () => {
    const mcpFlag = stdioStart('realm mcp', ['--check', '--gate-answers', 'offered']);
    const mcpEnv = stdioStart('realm mcp', ['--check'], { REALM_MCP_GATE_ANSWERS: 'offered' });
    const serveFlag = spawnSync(
      process.execPath,
      [CLI, 'serve', '--check', '--gate-answers', 'offered'],
      { env: envOf(), encoding: 'utf8', timeout: 60_000 },
    );
    const realmMcpEnv = stdioStart('realm-mcp', [], { REALM_MCP_GATE_ANSWERS: 'offered' });
    const aliasLines = (stderr: string) =>
      stderr.split('\n').filter((l) => l.includes('is now called permitted'));
    const valueLines = (stdout: string) =>
      stdout
        .split('\n')
        .filter(
          (l) => l.startsWith('Gate answers over MCP: ') || l.includes('The gate-answers value:'),
        )
        .map((l) => l.trim().split(' — as read from')[0]);
    // (a) red when offered is refused, reads back as offered, or its line is missing or doubled;
    //     (b) prints each program's old-name lines and read-backs.
    expect({
      mcpFlag: [mcpFlag.code, aliasLines(mcpFlag.stderr), valueLines(mcpFlag.stdout)],
      mcpEnv: [mcpEnv.code, aliasLines(mcpEnv.stderr), valueLines(mcpEnv.stdout)],
      serveFlag: [serveFlag.status, aliasLines(serveFlag.stderr), valueLines(serveFlag.stdout)],
      realmMcpEnv: [
        realmMcpEnv.code,
        aliasLines(realmMcpEnv.stderr),
        gateLine(realmMcpEnv.stderr.split('\n')),
      ],
    }).toEqual({
      mcpFlag: [
        0,
        [ALIAS('realm mcp', '--gate-answers offered')],
        [
          'Gate answers over MCP: permitted (from --gate-answers)',
          'The gate-answers value: permitted (from --gate-answers) — the agent keeps an answer way.',
        ],
      ],
      mcpEnv: [
        0,
        [ALIAS('realm mcp', 'REALM_MCP_GATE_ANSWERS=offered')],
        [
          'Gate answers over MCP: permitted (from REALM_MCP_GATE_ANSWERS)',
          'The gate-answers value: permitted (from REALM_MCP_GATE_ANSWERS) — the agent keeps an answer way.',
        ],
      ],
      serveFlag: [
        0,
        [ALIAS('realm serve', '--gate-answers offered')],
        [
          'Gate answers over MCP: permitted (from --gate-answers)',
          'The gate-answers value: permitted (from --gate-answers) — the agent keeps an answer way.',
        ],
      ],
      realmMcpEnv: [
        0,
        [ALIAS('realm-mcp', 'REALM_MCP_GATE_ANSWERS=offered')],
        PERMITTED('REALM_MCP_GATE_ANSWERS'),
      ],
    });
  }, 120_000);

  it('the form-wait refusal reads permitted, given as offered, for offered (correction 1, item 6); the bad-value refusal lists asked, permitted or withheld', () => {
    const wait = stdioStart('realm mcp', [
      '--gate-answers',
      'offered',
      '--form-wait-seconds',
      '60',
    ]);
    const permittedWait = stdioStart('realm mcp', [
      '--gate-answers',
      'permitted',
      '--form-wait-seconds',
      '60',
    ]);
    const bad = stdioStart('realm mcp', ['--gate-answers', 'open']);
    const refusal = (value: string) =>
      `realm mcp: --form-wait-seconds has no effect under gate answers ${value}: this server sends no forms then — refused at start: this server does not start while it is set, because the setting would claim a wait that never happens. Remove it, or set gate answers to asked. The server starts as soon as it is removed or gate answers is asked.`;
    // (a) red when the refusal names offered alone, or names permitted without "given as offered"
    //     for offered, or says "given as offered" for permitted; or the bad-value list keeps offered;
    //     (b) prints each program's stderr and exit code.
    expect({
      wait: [wait.code, wait.stderr.trim()],
      permittedWait: [permittedWait.code, permittedWait.stderr.trim()],
      bad: [bad.code, bad.stderr.trim()],
    }).toEqual({
      wait: [1, refusal('permitted (given as offered)')],
      permittedWait: [1, refusal('permitted')],
      bad: [
        1,
        "realm mcp: invalid --gate-answers value 'open': expected asked, permitted or withheld — refused at start: this server does not start while it is set, because a misspelt value would leave gate answers handled differently from what you believe. Fix the value or remove it. The server starts as soon as it is valid.",
      ],
    });
  }, 120_000);
});
