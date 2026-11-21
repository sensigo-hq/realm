// listen-master-key-k1.test.ts — callback K1 (R1.3; the callback design rev 4 §1.5): an agent that
// `realm listen` starts never gets the master key the callback keys are sealed under, nor the path of
// its file, and gets every other variable; and the environment sweep hides the key's value from a log
// and from what an agent is shown, while the file's path (a setting) is shown.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails. The
// key below is fake.
import { EventEmitter } from 'node:events';
import type { SpawnOptions } from 'node:child_process';
import { buildDisclosureSet, disclose, tierFor } from '@sensigo/realm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSpawnAgent } from './listen.js';

// No real process is ever started here: the fake below is the only spawn defaultSpawnAgent may use.
vi.mock('node:child_process', () => ({
  spawn: () => {
    throw new Error('K1: the real spawn was called');
  },
}));

type SpawnFn = NonNullable<Parameters<typeof defaultSpawnAgent>[4]>;

const KEY = 'a1'.repeat(32);
const KEY_FILE = '/srv/realm-k1/encryption-master.key';

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A spawn that records the options it was given and starts nothing: a child that reports a pid. */
function recordingSpawn(): { spawnFn: SpawnFn; options: () => SpawnOptions | undefined } {
  let seen: SpawnOptions | undefined;
  const spawnFn = ((_cmd: string, _args: readonly string[], opts: SpawnOptions) => {
    seen = opts;
    const child = Object.assign(new EventEmitter(), { pid: 4242, unref: () => undefined });
    setImmediate(() => child.emit('spawn'));
    return child;
  }) as unknown as SpawnFn;
  return { spawnFn, options: () => seen };
}

describe('callback K1 — the environment an agent is started with', () => {
  it('neither the master key nor its file’s path reaches the agent; every other variable does, and listen keeps both', async () => {
    vi.stubEnv('REALM_ENCRYPTION_KEY', KEY);
    vi.stubEnv('REALM_ENCRYPTION_KEY_FILE', KEY_FILE);
    vi.stubEnv('K1_KEPT_VARIABLE', 'kept-value');
    const spawn = recordingSpawn();
    const result = await defaultSpawnAgent(
      'run-k1',
      process.cwd(),
      { model: 'm-k1' },
      () => {},
      spawn.spawnFn,
    );
    const env = spawn.options()?.env ?? {};
    // (1) red when the environment is passed whole (both names reach the agent), a name is left in,
    //     another variable is dropped, or the strip deletes the names from listen's own environment;
    //     (2) prints which names the agent got (never a value) and what listen still holds.
    expect({
      started: 'pid' in result,
      key: 'REALM_ENCRYPTION_KEY' in env,
      keyFile: 'REALM_ENCRYPTION_KEY_FILE' in env,
      kept: env['K1_KEPT_VARIABLE'],
      path: env['PATH'] === process.env['PATH'],
      deprecationsSaid: 'REALM_DEPRECATIONS_SAID' in env,
      listenKeepsKey: process.env['REALM_ENCRYPTION_KEY'] === KEY,
      listenKeepsFile: process.env['REALM_ENCRYPTION_KEY_FILE'] === KEY_FILE,
    }).toEqual({
      started: true,
      key: false,
      keyFile: false,
      kept: 'kept-value',
      path: true,
      deprecationsSaid: true,
      listenKeepsKey: true,
      listenKeepsFile: true,
    });
  });
});

describe('callback K1 — the environment sweep', () => {
  it('a log and an agent never see the master key’s value; the file’s path is a setting and is shown', () => {
    const env = { REALM_ENCRYPTION_KEY: KEY, REALM_ENCRYPTION_KEY_FILE: KEY_FILE };
    const text = `key ${KEY} file ${KEY_FILE}`;
    const shown = (audience: 'log' | 'agent') => {
      const { set } = buildDisclosureSet({
        env,
        declared: {},
        declaredState: 'resolved',
        audience,
      });
      const out = disclose(text, set, tierFor(audience)).text;
      return { keyHidden: !out.includes(KEY), fileShown: out.includes(KEY_FILE) };
    };
    // (1) red when the key's name is placed among the settings (its value is then shown), or the
    //     file's name is not (its path is then hidden); (2) prints, per audience, whether the key is
    //     hidden and the path shown (never the text).
    expect({ log: shown('log'), agent: shown('agent') }).toEqual({
      log: { keyHidden: true, fileShown: true },
      agent: { keyHidden: true, fileShown: true },
    });
  });
});

// Callback K2b: the third name, `REALM_ENCRYPTION_KEY_COMMAND` (a command that prints the master key;
// its words may hold a token), is a credential: stripped from every agent and hidden by the sweep.
const COMMAND = 'op read x --token FAKE-TOKEN-0001';

describe('callback K2b — the master key’s command, a third name', () => {
  it('none of the three names reaches the agent; every other variable does', async () => {
    vi.stubEnv('REALM_ENCRYPTION_KEY', KEY);
    vi.stubEnv('REALM_ENCRYPTION_KEY_FILE', KEY_FILE);
    vi.stubEnv('REALM_ENCRYPTION_KEY_COMMAND', COMMAND);
    vi.stubEnv('K2B_KEPT_VARIABLE', 'kept-value');
    const spawn = recordingSpawn();
    await defaultSpawnAgent('run-k2b', process.cwd(), { model: 'm-k2b' }, () => {}, spawn.spawnFn);
    const env = spawn.options()?.env ?? {};
    // (1) red when the command's name is not stripped, or another variable is dropped; (2) prints
    //     which names the agent got (never a value).
    expect({
      names: [
        'REALM_ENCRYPTION_KEY',
        'REALM_ENCRYPTION_KEY_FILE',
        'REALM_ENCRYPTION_KEY_COMMAND',
      ].filter((n) => n in env),
      kept: env['K2B_KEPT_VARIABLE'],
      listenKeepsCommand: process.env['REALM_ENCRYPTION_KEY_COMMAND'] === COMMAND,
    }).toEqual({ names: [], kept: 'kept-value', listenKeepsCommand: true });
  });

  it('a log and an agent never see the command’s value', () => {
    const text = `ran ${COMMAND}`;
    const hidden = (audience: 'log' | 'agent') => {
      const { set } = buildDisclosureSet({
        env: { REALM_ENCRYPTION_KEY_COMMAND: COMMAND },
        declared: {},
        declaredState: 'resolved',
        audience,
      });
      return !disclose(text, set, tierFor(audience)).text.includes('FAKE-TOKEN-0001');
    };
    // (1) red when the name is placed among the settings (its value is then shown whole on a log);
    //     (2) prints, per audience, whether the token is hidden.
    expect({ log: hidden('log'), agent: hidden('agent') }).toEqual({ log: true, agent: true });
  });
});
