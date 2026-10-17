// gate-answers-door-627.test.ts — #627 W, Part A on the bins: `--gate-answers` and
// `--form-wait-seconds` read as the server will read them; a bad value refuses the start (W-s4,
// W-s8); the form wait on `realm serve` refuses it (W-s9); the start lines (W-s1, W-s3, W-s7; cell 12);
// dev mode's W-s5 iff the value is not withheld (cell 19); `--check` (W-s6) prints the value and its
// source and exits 0, or W-s4 and exit 1 (cell 4's bin half).
//
// The `--check` and dev-mode cells run the built `realm` command with a fresh HOME. Every assertion
// carries (a) the change that turns it red and (b) what it prints on failure: lines and exit codes —
// never an environment.
import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeGateAnswers } from '@sensigo/realm';
import {
  DEV_MODE_ANSWER_WARNING,
  gateAnswersStartLine,
  readBinDoorSettings,
} from './gate-answers-door.js';

const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

/** The built `realm` with a fresh HOME and only the variables named. */
function realm(args: string[], extra: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'realm-door-627-cli-'));
  const env: Record<string, string> = { PATH: process.env['PATH'] ?? '', HOME: home, ...extra };
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 60_000 });
}

const setting = (input: Parameters<typeof judgeGateAnswers>[0]) => {
  const r = judgeGateAnswers(input);
  if (!r.ok) throw new Error('fixture: a valid value');
  return r.setting;
};

describe('#627 W — the bins read the two settings as the server will', () => {
  it('a bad value refuses the start: W-s4 (flag, env), W-s8 (10, 3601), W-s9 on realm serve (flag, env)', () => {
    const line = (
      bin: 'mcp' | 'serve',
      flags: Parameters<typeof readBinDoorSettings>[1],
      env: Record<string, string> = {},
    ) => {
      const r = readBinDoorSettings(bin, flags, env);
      return r.ok ? 'starts' : r.line;
    };
    // (a) red when a misspelt value or an out-of-bounds wait starts the server, or serve accepts a
    //     wait it never uses; (b) prints each line.
    expect({
      flag: line('mcp', { gateAnswers: 'witheld' }),
      env: line('serve', {}, { REALM_MCP_GATE_ANSWERS: 'open' }),
      low: line('mcp', { formWaitSeconds: '10' }),
      high: line('mcp', {}, { REALM_MCP_FORM_WAIT_SECONDS: '3601' }),
      serveFlag: line('serve', { formWaitSeconds: '60' }),
      serveEnv: line('serve', {}, { REALM_MCP_FORM_WAIT_SECONDS: '60' }),
      ok: line('mcp', { gateAnswers: 'withheld', formWaitSeconds: '30' }),
    }).toEqual({
      flag: "realm mcp: invalid --gate-answers value 'witheld': expected asked, offered or withheld — refused at start: this server does not start while it is set, because a misspelt value would leave gate answers handled differently from what you believe. Fix the value or remove it. The server starts as soon as it is valid.",
      env: "realm serve: invalid REALM_MCP_GATE_ANSWERS value 'open': expected asked, offered or withheld — refused at start: this server does not start while it is set, because a misspelt value would leave gate answers handled differently from what you believe. Fix the value or remove it. The server starts as soon as it is valid.",
      low: "realm mcp: invalid --form-wait-seconds value '10': expected a whole number of seconds from 30 to 3600 — refused at start: this server does not start while it is set, because a form must not wait less than a person needs, and the bound keeps a mistyped value from holding a call for hours. Fix the value or remove it; the default is 240. The server starts as soon as it is valid.",
      high: "realm mcp: invalid REALM_MCP_FORM_WAIT_SECONDS value '3601': expected a whole number of seconds from 30 to 3600 — refused at start: this server does not start while it is set, because a form must not wait less than a person needs, and the bound keeps a mistyped value from holding a call for hours. Fix the value or remove it; the default is 240. The server starts as soon as it is valid.",
      serveFlag:
        "realm serve: --form-wait-seconds has no effect on this server: its clients get no forms until Realm's HTTP server can hold a form open — refused at start: this server does not start while it is set, because the setting would claim a wait that never happens. Remove it. The server starts as soon as it is removed.",
      serveEnv:
        "realm serve: REALM_MCP_FORM_WAIT_SECONDS has no effect on this server: its clients get no forms until Realm's HTTP server can hold a form open — refused at start: this server does not start while it is set, because the setting would claim a wait that never happens. Remove it. The server starts as soon as it is removed.",
      ok: 'starts',
    });
  });

  it('correction 1 (E1, E2): an empty --gate-answers flag refuses (W-s4); an empty variable stays unset; on serve a bad wait gets W-s9, never W-s8', () => {
    const line = (
      bin: 'mcp' | 'serve',
      flags: Parameters<typeof readBinDoorSettings>[1],
      env: Record<string, string> = {},
    ) => {
      const r = readBinDoorSettings(bin, flags, env);
      return r.ok ? `starts ${r.answers.value}` : r.line;
    };
    // (a) red when an empty flag starts the default, an empty variable refuses, or serve judges a
    //     wait it never uses with W-s8; (b) prints each line.
    expect({
      emptyFlag: line('mcp', { gateAnswers: '' }),
      emptyEnv: line('mcp', {}, { REALM_MCP_GATE_ANSWERS: '' }),
      serveBadWait: line('serve', { formWaitSeconds: '10' }),
    }).toEqual({
      emptyFlag:
        "realm mcp: invalid --gate-answers value '': expected asked, offered or withheld — refused at start: this server does not start while it is set, because a misspelt value would leave gate answers handled differently from what you believe. Fix the value or remove it. The server starts as soon as it is valid.",
      emptyEnv: 'starts asked',
      serveBadWait:
        "realm serve: --form-wait-seconds has no effect on this server: its clients get no forms until Realm's HTTP server can hold a form open — refused at start: this server does not start while it is set, because the setting would claim a wait that never happens. Remove it. The server starts as soon as it is removed.",
    });
  });

  it('cell 12 — the start lines: W-s1 and W-s7 hold `realm run respond <run_id>` literally (W-s7’s HTTP clause on serve); W-s3 names no command', () => {
    const withheld = gateAnswersStartLine(setting({ flag: 'withheld', env: 'asked' }), false);
    const askedMcp = gateAnswersStartLine(setting({}), false);
    const askedServe = gateAnswersStartLine(setting({ env: 'asked' }), true);
    const offered = gateAnswersStartLine(setting({ option: 'offered' }), false);
    // (a) red when a placeholder is filled, the HTTP clause prints on stdio, or W-s3 gains a command;
    //     (b) prints each line.
    expect({ withheld, askedMcp, askedServe, offered }).toEqual({
      withheld:
        'Gate answers over MCP: withheld (from --gate-answers; also set: REALM_MCP_GATE_ANSWERS = asked — the most restrictive value wins). No tool on this server records a gate answer, and its replies name no way to answer. To answer a waiting question, a person runs, in a terminal on this machine as the user that runs this server: realm run inspect <run_id> (shows the question, its gate id and its choices), then realm run respond <run_id> --gate <gate_id> --choice <choice>. The agent tells the user the run id. Another Realm server or CLI on the same store can still record answers.',
      askedMcp:
        "Gate answers over MCP: asked (the default). In chat apps that show forms, questions go to the person in the app's own form, and the agent gets no tool that records a gate answer. In apps without forms, the agent keeps the answer tool, and the app is asked to have the person approve each call; some apps and settings skip that. To keep the agent from answering in every app, set --gate-answers withheld. To answer from a terminal: realm run inspect <run_id>, then realm run respond <run_id> --gate <gate_id> --choice <choice>.",
      askedServe:
        'Gate answers over MCP: asked (the default; from REALM_MCP_GATE_ANSWERS). On this server no chat app gets forms: under `asked` every client keeps the answer tool, and the app is asked to have the person approve each call; some apps and settings skip that. To keep the agent from answering in every app, set --gate-answers withheld. To answer from a terminal: realm run inspect <run_id>, then realm run respond <run_id> --gate <gate_id> --choice <choice>.',
      offered:
        'Gate answers over MCP: offered (from the program that started this server (gateAnswers option); the default is asked). Any client of this server, the agent included, can record a gate answer; it is recorded as arriving through the MCP answer tool.',
    });
    expect(offered.includes('realm run')).toBe(false);
  });

  it('cell 4 (bin half) — `realm mcp --check` prints W-s6 with the winning source and exits 0; a bad value prints W-s4 and exits 1; nothing starts', () => {
    const ok = realm(['mcp', '--check', '--gate-answers', 'withheld'], {
      REALM_MCP_GATE_ANSWERS: 'offered',
    });
    const bad = realm(['serve', '--check'], { REALM_MCP_GATE_ANSWERS: 'nope' });
    // (a) red when the check starts a server, loses the source, or exits 0 on a bad value; (b)
    //     prints the first line and the exit codes.
    expect({
      ok: [ok.status, ok.stdout.split('\n')[0]],
      bad: [bad.status, bad.stderr.trim()],
    }).toEqual({
      ok: [
        0,
        "Gate answers over MCP: withheld (from --gate-answers; also set: REALM_MCP_GATE_ANSWERS = offered — the most restrictive value wins) — as read from this shell's environment and flags. A server started another way (your MCP client's config, launchd, systemd, or a program that embeds Realm) reads its own environment: run --check with that same environment, or read that server's start line or its embedder's log of effectiveGateAnswers(). Nothing was started.",
      ],
      bad: [
        1,
        "realm serve: invalid REALM_MCP_GATE_ANSWERS value 'nope': expected asked, offered or withheld — refused at start: this server does not start while it is set, because a misspelt value would leave gate answers handled differently from what you believe. Fix the value or remove it. The server starts as soon as it is valid.",
      ],
    });
  }, 60_000);

  it('`REALM_MCP_GATE_ANSWERS=withheld realm serve --check` prints the value line as configured, not enforced, and never the "cannot record" claim (the "may still" form naming the value is pinned on a fixture machine: separation-check-627)', () => {
    const r = realm(['serve', '--check'], { REALM_MCP_GATE_ANSWERS: 'withheld' });
    const lines = r.stdout.split('\n');
    // (a) red when the shell's value is trusted as measured; (b) prints the value line and the header.
    expect({
      status: r.status,
      value: lines.find((l) => l.trim().startsWith('The gate-answers value:'))?.trim(),
      claims: lines[1]?.includes('cannot record'),
    }).toEqual({
      status: 0,
      value:
        "The gate-answers value: withheld, configured, not enforced by Realm — from REALM_MCP_GATE_ANSWERS; the running server's value is not read.",
      claims: false,
    });
  }, 60_000);
});

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

/** `realm serve --dev` until it prints its start line; its stdout and stderr. */
async function serveOutput(extraArgs: string[]): Promise<{ out: string; err: string }> {
  const port = await freePort();
  const home = mkdtempSync(join(tmpdir(), 'realm-door-627-serve-'));
  const child = spawn(
    process.execPath,
    [CLI, 'serve', '--dev', '--port', String(port), ...extraArgs],
    {
      env: { PATH: process.env['PATH'] ?? '', HOME: home },
    },
  );
  let out = '';
  let err = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr.on('data', (d: Buffer) => (err += d.toString()));
  await new Promise<void>((resolve) => {
    const deadline = setTimeout(resolve, 20_000);
    child.stdout.on('data', () => {
      if (out.includes('Gate answers over MCP:')) {
        setTimeout(() => {
          clearTimeout(deadline);
          resolve();
        }, 200);
      }
    });
  });
  child.kill('SIGTERM');
  return { out, err };
}

describe('#627 W — cell 19: dev mode warns that the answer tool is open, iff the value is not withheld', () => {
  it('W-s5 under the default; none under withheld; the start line on stdout', async () => {
    const asked = await serveOutput([]);
    const withheld = await serveOutput(['--gate-answers', 'withheld']);
    // (a) red when W-s5 prints under withheld, or not at all in dev mode; (b) prints whether each
    //     output holds it.
    expect({
      asked: [
        asked.err.includes(DEV_MODE_ANSWER_WARNING),
        asked.out.includes('Gate answers over MCP: asked'),
      ],
      withheld: [
        withheld.err.includes(DEV_MODE_ANSWER_WARNING),
        withheld.out.includes('Gate answers over MCP: withheld'),
      ],
    }).toEqual({ asked: [true, true], withheld: [false, true] });
  }, 60_000);
});
