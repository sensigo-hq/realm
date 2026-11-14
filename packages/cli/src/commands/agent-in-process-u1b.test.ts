// agent-in-process-u1b.test.ts — U1b Unit 1, prompt amendment A1 (cell (w)): `realm agent` run in a
// host that is not the realm program — this test's vitest worker, whose streams are not terminals
// and which has an IPC channel — runs in-process, as on the base: one process, no spawn. Only the
// realm program's entry declares itself (`declareRealmProgram`), so the relay never re-runs a host.
// `spawn` is replaced to record any call (and fail it, as the OS can); the step's handler writes the
// pid it ran in. Each assertion names (a) the break that turns it red and (b) what it prints.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

const spawned = vi.hoisted(() => ({ calls: 0 }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      spawned.calls += 1;
      void args;
      throw Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' });
    },
  };
});

const { agentCommand } = await import('./agent.js');

let root: string;
let h: TempHome & { readonly root: string };

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'realm-u1b-inproc-'));
  h = await makeTempHome();
  mkdirSync(join(root, 'wf'));
  writeFileSync(join(root, 'package.json'), '{ "type": "module" }\n', 'utf8');
  writeFileSync(
    join(root, 'ext.mjs'),
    `import { writeFileSync } from 'node:fs';
export default { handlers: { mark: { id: 'mark', execute: async () => { writeFileSync(process.env.U1B_PIDFILE, String(process.pid)); return { data: { note: 'marked' } }; } } } };
`,
    'utf8',
  );
  writeFileSync(
    join(root, 'wf', 'workflow.yaml'),
    [
      'id: u1b-in-process',
      'name: u1b in-process',
      'version: 1',
      'extensions: ../ext.mjs',
      'steps:',
      '  s:',
      '    description: One step.',
      '    execution: auto',
      '    handler: mark',
      '',
    ].join('\n'),
    'utf8',
  );
}, 60_000);

afterAll(async () => {
  await h.cleanup();
  rmSync(root, { recursive: true, force: true });
});

describe('U1b — (w) the command in a host that is not the realm program', () => {
  it('both streams not terminals, a channel present → one process, no spawn, the drive as on the base', async () => {
    const pidfile = join(root, 'pid');
    const saved = { ...process.env };
    process.env['HOME'] = h.root;
    process.env['ANTHROPIC_API_KEY'] = 'fake-u1b-key-0000';
    process.env['U1B_PIDFILE'] = pidfile;
    const exits: unknown[] = [];
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exits.push(code);
      throw new Error('exit');
    }) as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await agentCommand
        .parseAsync([
          'node',
          'realm',
          '--workflow',
          join(root, 'wf'),
          '--project',
          root,
          '--provider',
          'anthropic',
          '--model',
          'fake-model',
        ])
        .catch(() => undefined);
    } finally {
      vi.restoreAllMocks();
      process.env = saved;
    }
    // (a) red when the trigger ignores the declaration (it spawns: one call, then exit 1 with no
    //     drive); (b) prints the streams' kind, the spawn calls, the exit codes and the pid relation.
    expect({
      streams: [process.stdout.isTTY === true, process.stderr.isTTY === true],
      channel: typeof process.send,
      spawns: spawned.calls,
      exits,
      ranHere: readFileSync(pidfile, 'utf8') === String(process.pid),
    }).toEqual({
      streams: [false, false],
      channel: 'function',
      spawns: 0,
      exits: [0],
      ranHere: true,
    });
  }, 60_000);
});
