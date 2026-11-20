// master-key-file-k2a1.test.ts — callback K2a-1 (R1.3): `placeMasterKeyFile`, the maker of the master
// key file `<home>/encryption.key`, tested on the function itself (POSIX), on real files in a scratch
// folder: placed whole and owner-only when nothing is there; nothing replaced or created when any
// entry is (a file, a dangling link); the system's error thrown when the folder cannot take it; no
// temporary file left in any of these; and 8 processes released at once onto an empty folder place
// exactly one file. The order of the writes (synced before the link) is
// `master-key-file-order-k2a1.test.ts`. A FIFO is never read or tested here: reading one hangs and no
// timeout can catch it (CB-K2A-AU-09); `link`'s EEXIST on a folder, a live link and a FIFO is the
// operating system's (executed once, CB-K2A-P-01).
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MASTER_KEY_FILE, resolveMasterKey } from './master-key.js';
import { placeMasterKeyFile } from './master-key-file.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    chmodSync(d, 0o700);
    rmSync(d, { recursive: true, force: true });
  }
});

/** A scratch root holding an empty home folder. */
function scratch(): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'realm-k2a1-maker-'));
  dirs.push(root);
  const home = join(root, '.realm');
  mkdirSync(home);
  return { root, home };
}

/** The folder's entries, sorted: a temporary file left behind shows here. */
const entries = (dir: string): string[] => readdirSync(dir).sort();

/** What the function did: its answer, or the `code` it threw. */
function outcome(homeDir: string): string {
  try {
    return placeMasterKeyFile(homeDir);
  } catch (err) {
    return `threw ${(err as NodeJS.ErrnoException).code ?? String(err)}`;
  }
}

const POSIX = process.platform !== 'win32';
const ROOT_USER = typeof process.getuid === 'function' && process.getuid() === 0;

describe.runIf(POSIX)('callback K2a-1 — the master key file maker', () => {
  it('absent: placed whole, owner-only, 64 lowercase hex and one newline, read back as found', () => {
    const { home } = scratch();
    const placed = outcome(home);
    const path = join(home, MASTER_KEY_FILE);
    const text = readFileSync(path, 'utf8');
    const resolved = resolveMasterKey({ env: {}, homeDir: home });
    // (1) red when the file is not placed, holds another form (upper case, no newline, 32 raw
    //     bytes), is readable by others, or a temporary file is left; (2) prints each fact.
    expect({
      placed,
      mode: (statSync(path).mode & 0o777).toString(8),
      bytes: statSync(path).size,
      form: /^[0-9a-f]{64}\n$/.test(text),
      entries: entries(home),
      resolved: { state: resolved.state, source: 'source' in resolved ? resolved.source : '-' },
      wide: 'mode_wider_than_owner' in resolved,
    }).toEqual({
      placed: 'placed',
      mode: '600',
      bytes: 65,
      form: true,
      entries: [MASTER_KEY_FILE],
      resolved: { state: 'found', source: 'home_file' },
      wide: false,
    });
  });

  it('a regular file there: exists, its bytes unchanged, nothing left', () => {
    const { home } = scratch();
    const path = join(home, MASTER_KEY_FILE);
    writeFileSync(path, 'not a key, kept as it is\n', { mode: 0o600 });
    // (1) red when an existing file is replaced or written to, or a temporary file is left;
    //     (2) prints the answer, the file's text and the folder.
    expect({
      placed: outcome(home),
      text: readFileSync(path, 'utf8'),
      entries: entries(home),
    }).toEqual({
      placed: 'exists',
      text: 'not a key, kept as it is\n',
      entries: [MASTER_KEY_FILE],
    });
  });

  it('a dangling link there: exists, and its target is still absent', () => {
    const { root, home } = scratch();
    const target = join(root, 'elsewhere.key');
    symlinkSync(target, join(home, MASTER_KEY_FILE));
    // (1) red when the maker looks with `existsSync` (false for a dangling link) and then writes
    //     the name, which creates the link's target; or when a temporary file is left;
    //     (2) prints the answer, whether the target exists, and the folder.
    expect({
      placed: outcome(home),
      targetCreated: existsSync(target),
      entries: entries(home),
    }).toEqual({ placed: 'exists', targetCreated: false, entries: [MASTER_KEY_FILE] });
  });

  it('a folder that does not exist: throws ENOENT, and nothing is made', () => {
    const { root } = scratch();
    const before = entries(root);
    // (1) red when the error is swallowed into an answer, or anything is made; (2) prints both.
    expect({ placed: outcome(join(root, 'missing')), entries: entries(root) }).toEqual({
      placed: 'threw ENOENT',
      entries: before,
    });
  });

  it.skipIf(ROOT_USER)('a folder that cannot be written: throws EACCES, nothing left', () => {
    const { home } = scratch();
    chmodSync(home, 0o500);
    const placed = outcome(home);
    chmodSync(home, 0o700);
    // (1) red when the error is swallowed, or a temporary file is left; (2) prints both.
    expect({ placed, entries: entries(home) }).toEqual({ placed: 'threw EACCES', entries: [] });
  });

  it('8 processes released together onto an empty folder: one placed, seven exist, one whole file', async () => {
    const { root, home } = scratch();
    const barrier = join(root, 'barrier');
    mkdirSync(barrier);
    const built = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../../dist/lib/callback/master-key-file.js',
    );
    // Each child loads the built maker, says it is ready, waits for the go file, then places.
    const child = [
      "import { existsSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "import { pathToFileURL } from 'node:url';",
      'const [built, home, barrier, n] = process.argv.slice(1);',
      'const { placeMasterKeyFile } = await import(pathToFileURL(built).href);',
      "writeFileSync(join(barrier, 'ready-' + n), '');",
      'const nap = new Int32Array(new SharedArrayBuffer(4));',
      "while (!existsSync(join(barrier, 'go'))) Atomics.wait(nap, 0, 0, 1);",
      'process.stdout.write(placeMasterKeyFile(home));',
    ].join('\n');
    const runs = Array.from({ length: 8 }, (_, n) => {
      const p = spawn(
        process.execPath,
        ['--input-type=module', '-e', child, built, home, barrier, String(n)],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let out = '';
      let err = '';
      p.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
      p.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
      return new Promise<string>((done) =>
        p.on('close', (code) => done(code === 0 ? out : `exit ${code}: ${err}`)),
      );
    });
    const by = Date.now() + 20_000;
    while (readdirSync(barrier).length < 8 && Date.now() < by)
      await new Promise((tick) => setTimeout(tick, 5));
    writeFileSync(join(barrier, 'go'), '');
    const answers = (await Promise.all(runs)).sort();
    const path = join(home, MASTER_KEY_FILE);
    // (1) red when two processes both place (an `existsSync` then a write), a partial file is
    //     seen, a temporary file is left, or a child fails; (2) prints every answer and the folder.
    expect({
      answers,
      entries: entries(home),
      whole: existsSync(path) && /^[0-9a-f]{64}\n$/.test(readFileSync(path, 'utf8')),
    }).toEqual({
      answers: ['exists', 'exists', 'exists', 'exists', 'exists', 'exists', 'exists', 'placed'],
      entries: [MASTER_KEY_FILE],
      whole: true,
    });
  }, 30_000);
});
