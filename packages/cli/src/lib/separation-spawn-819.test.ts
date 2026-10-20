// separation-spawn-819.test.ts — #819 (C2, item 2): only #790's runner starts a process, shown at
// run time. The process module is mocked under both of its names (`node:child_process` and
// `child_process`), so nothing really runs and every call to it is recorded; the switch-path readers
// then run on this host's real files through `systemProbes()`, with the runner wrapped to record each
// argv it was asked and did not refuse. The two lists must be one for one: a reader that starts a
// process itself shows up as a call the runner never made.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: argvs
// (tool paths, rail-1 arguments, this check's pid) — never an environment, a token or a key.
import { describe, expect, it, vi } from 'vitest';

/** Every call the mocked process module saw, as `[fn, file, ...args]`; the module's stand-in (hoisted
 *  with `vi.mock`, which runs before the imports). */
const { calls, fakeModule } = vi.hoisted(() => {
  const calls: string[][] = [];
  const fakeModule = async () => {
    const { EventEmitter } = await import('node:events');
    /** A child that ends at once with exit 1 and no output, so no call waits out the runner's limit. */
    const child = () => {
      const c = new EventEmitter() as InstanceType<typeof EventEmitter> & {
        stdout: InstanceType<typeof EventEmitter>;
        stderr: InstanceType<typeof EventEmitter>;
        kill: () => boolean;
      };
      c.stdout = new EventEmitter();
      c.stderr = new EventEmitter();
      c.kill = () => true;
      setImmediate(() => c.emit('close', 1, null));
      return c;
    };
    const record =
      (fn: string) =>
      (file: unknown, args?: unknown): unknown => {
        calls.push([fn, String(file), ...(Array.isArray(args) ? args.map(String) : [])]);
        return fn === 'spawn' || fn === 'fork' || fn === 'exec' || fn === 'execFile'
          ? child()
          : { status: 1, signal: null, stdout: '', stderr: '', output: [], pid: 0 };
      };
    const api = {
      spawn: record('spawn'),
      spawnSync: record('spawnSync'),
      exec: record('exec'),
      execSync: record('execSync'),
      execFile: record('execFile'),
      execFileSync: record('execFileSync'),
      fork: record('fork'),
    };
    return { ...api, default: api };
  };
  return { calls, fakeModule };
});
vi.mock('node:child_process', fakeModule);
vi.mock('child_process', fakeModule);

const { measureSwitchPaths } = await import('./separation/index.js');
const { systemProbes } = await import('./separation-check.js');

describe('#819 C2 — only the runner starts a process, at run time', () => {
  it("the process module's calls are, one for one, the argvs the runner made (svc 'daemon', this host's real files)", async () => {
    const probes = systemProbes();
    const made: string[][] = [];
    const run = probes.run;
    probes.run = async (argv) => {
      const r = await run(argv);
      // The runner refuses an argv that is not one of rail 1's, never starting it.
      if (!('refused' in r)) made.push(argv[0] === 'LC_ALL=C' ? argv.slice(1) : [...argv]);
      return r;
    };
    calls.length = 0;
    await measureSwitchPaths({ probes, svc: 'daemon' });
    // (a) red when a reader starts a process itself (named break: a direct `spawnSync` of a rail-1
    //     argv in sudo.ts) — the module sees a call the runner did not make — or when the runner
    //     stops going through `spawn`; and when the readers made no call at all (a cell that saw
    //     nothing proves nothing: every Linux host has getent, and `getent passwd daemon` is asked);
    //     (b) prints both lists of argvs.
    expect({
      module: calls.map(([fn, ...argv]) => `${fn} ${argv.join(' ')}`),
      madeAny: made.length > 0,
    }).toEqual({ module: made.map((argv) => `spawn ${argv.join(' ')}`), madeAny: true });
  });
});
