// listen-switch-c2c.test.ts — R1.3 callback C2c (the switch), on the BUILT `realm listen` (`dist`): a
// start without the allow-list flags is as before (no master key read, no command run); the two
// flags, their guard and every refusal of an entry; and every start line, each from a real start on a
// scratch home. Each start runs as `sh -c '… 2>&1'`, so standard output and standard error arrive in
// the order they were written; the server is stopped with SIGTERM once it says `realm listen on`.
// Keys are made first with the built `realm callback key`. No line may show a key, a master key, a
// URL's path or a typed password: canaries prove it.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { openForeignConnection } from '@sensigo/realm-store-sqlite/test-support';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', 'dist', 'index.js');
const POSIX = process.platform !== 'win32';
const A = 'a1'.repeat(32);
const B = 'b2'.repeat(32);
const SECRET = 'c2c-secret-0123456789';
const PREFIX = 'listen: callbacks: ';
const fp = (hex: string): string =>
  createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex').slice(0, 8);
const keyFp = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);
const yaml = (id: string, path: string, takes: boolean) =>
  `id: ${id}\nname: ${id}\nversion: 1\ntrigger:\n  type: webhook\n  path: ${path}\n  auth:\n    mode: shared_secret\n    header: X-Token\n    secret_from: C2C_SECRET\n${takes ? '  result_map:\n    approved: context.resources.record.approved\n' : ''}steps:\n  record:\n    description: Record.\n    execution: auto\n`;
const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A scratch: a HOME, the workflow folders `wf` (refunds, takes callbacks) and `plain`, and runners. */
function bench() {
  const root = mkdtempSync(join(tmpdir(), 'realm-c2c-'));
  dirs.push(root);
  const home = join(root, 'home');
  mkdirSync(home);
  const realm = join(home, '.realm');
  for (const [dir, id, path, takes] of [
    ['wf', 'refunds', '/refunds', true],
    ['plain', 'plainflow', '/plain', false],
    ['wf2', 'orders', '/orders', true],
  ] as const) {
    mkdirSync(join(root, dir));
    writeFileSync(join(root, dir, 'workflow.yaml'), yaml(id, path, takes));
  }
  const baseEnv = {
    PATH: process.env['PATH'] ?? '',
    HOME: home,
    NO_COLOR: '1',
    REALM_NO_NUDGE: '1',
    C2C_SECRET: SECRET,
  };
  /** `realm callback key <folder> --host <host>` with `env`: the key printed. */
  const key = (folder: string, host: string, env: Record<string, string> = {}): string => {
    const r = spawnSync(process.execPath, [CLI, 'callback', 'key', folder, '--host', host], {
      cwd: root,
      env: { ...baseEnv, ...env },
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (r.status !== 0) throw new Error(`callback key failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  /**
   * `realm listen <args> --model m --port 0`, both streams merged in order. When it says `realm listen
   * on`, `during(port)` runs, then SIGTERM. A start that is refused returns at its exit.
   */
  const listen = (
    args: readonly string[],
    env: Record<string, string> = {},
    during?: (port: number) => Promise<unknown>,
  ): Promise<{ code: number | null; lines: string[]; text: string; result?: unknown }> =>
    new Promise((resolve, reject) => {
      const command = `exec ${shq(process.execPath)} ${shq(CLI)} listen ${args.map(shq).join(' ')} --model m --port 0 2>&1`;
      const child = spawn('sh', ['-c', command], { cwd: root, env: { ...baseEnv, ...env } });
      let text = '';
      let result: unknown;
      let asked = false;
      const timer = setTimeout(() => child.kill('SIGKILL'), 45_000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d: string) => {
        text += d;
        const m = /realm listen on 127\.0\.0\.1:(\d+)/.exec(text);
        if (m !== null && !asked) {
          asked = true;
          void (during === undefined ? Promise.resolve(undefined) : during(Number(m[1])))
            .then((r) => {
              result = r;
            })
            .catch(reject)
            .finally(() => child.kill('SIGTERM'));
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        const lines = text
          .split('\n')
          .filter((l) => l !== '' && !l.startsWith('listen: shutting down'));
        resolve({ code, lines, text, result });
      });
    });
  /** A POST naming `url` as the callback address: the status and the body's callback or reason. */
  const ask = (
    port: number,
    url: string,
    id: string,
    path = '/refunds',
  ): Promise<[number, unknown]> =>
    new Promise((resolve, reject) => {
      const body = JSON.stringify({ id });
      const req = request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path,
          headers: {
            'content-type': 'application/json',
            'x-token': SECRET,
            'realm-callback-url': url,
            'content-length': Buffer.byteLength(body),
          },
        },
        (res) => {
          let t = '';
          res.setEncoding('utf8');
          res.on('data', (d: string) => (t += d));
          res.on('end', () => {
            const j = JSON.parse(t) as Record<string, unknown>;
            resolve([res.statusCode ?? 0, j['callback'] ?? j['reason'] ?? j['error']]);
          });
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  const callbackLines = (lines: string[]) =>
    lines.filter((l) => l.startsWith(PREFIX)).map((l) => l.slice(PREFIX.length));
  return { root, home, realm, key, listen, ask, callbackLines };
}

describe.runIf(POSIX)('C2c — without the flags, a start is as before', { timeout: 120_000 }, () => {
  it('the same lines as the base (AU-01), and a master key command is not run; with a flag it runs once', async () => {
    const b = bench();
    const counter = join(b.root, 'counter');
    const script = join(b.root, 'printkey');
    writeFileSync(script, `#!/bin/sh\nprintf 'x\\n' >> '${counter}'\nprintf '%s\\n' ${A}\n`);
    chmodSync(script, 0o755);
    const env = { REALM_ENCRYPTION_KEY_COMMAND: script };
    const plainStart = await b.listen(['wf', 'plain'], env);
    const runsWithout = existsSync(counter)
      ? readFileSync(counter, 'utf8').split('\n').length - 1
      : 0;
    await b.listen(['wf', 'plain', '--callback-allow', 'hooks.example.com'], env);
    const runsWith = readFileSync(counter, 'utf8').split('\n').length - 1;
    // (1) red when the master key is resolved without a flag (the command then runs), or a line is
    //     added or changed; (2) prints the lines and the counts.
    expect({
      lines: plainStart.lines.map((l) =>
        l.replace(/:\d+ —/, ':<port> —').replace(/\{"anthropic".*$/, '{…}'),
      ),
      runsWithout,
      runsWith,
    }).toEqual({
      lines: [
        'listen: mounted {"workflow":"refunds","path":"/refunds","mode":"shared_secret"}',
        'listen: mounted {"workflow":"plainflow","path":"/plain","mode":"shared_secret"}',
        'listen: caching {…}',
        'realm listen on 127.0.0.1:<port> — 2 workflow(s) mounted',
      ],
      runsWithout: 0,
      runsWith: 1,
    });
  });
});

describe.runIf(POSIX)('C2c — the flags and their refusals', { timeout: 300_000 }, () => {
  it('the guard: a flag swallowed as an entry is refused, for both flags, and nothing starts', async () => {
    const b = bench();
    const pub = await b.listen(['wf', '--callback-allow', '--send-reminders']);
    const priv = await b.listen(['wf', '--callback-allow-private', '--send-reminders']);
    const guard = (flag: string) => [
      `error: option '${flag} <entry>' argument is ambiguous: '--send-reminders' looks like a flag.`,
      `Did you forget to specify the option argument for '${flag}'? To specify an option argument starting with a dash use '${flag}=-XYZ'.`,
    ];
    // (1) red when the guard still skips an array (the flag is taken as an entry and listen
    //     starts); (2) prints the codes and lines.
    expect({ pub: [pub.code, pub.lines], priv: [priv.code, priv.lines] }).toEqual({
      pub: [1, guard('--callback-allow')],
      priv: [1, guard('--callback-allow-private')],
    });
  });

  it('each of the nine refusal words, the exact line, exit 1, nothing before it; a typed password or token never echoed', async () => {
    const b = bench();
    const give =
      'Give a host name, with a port if it is not 443: hooks.example.com, or http://hooks.example.com:8080 for plain http.';
    const line = (quoted: string, phrase: string) =>
      `Error: --callback-allow${quoted} is not an address Realm can allow: ${phrase}. ${give}`;
    const cases: [string, string, string][] = [
      [
        'hooks.example.com/webhook/CANARYTOKEN?x=1',
        ' "hooks.example.com"',
        'it has a path, query or fragment',
      ],
      ['user:CANARYPW@hooks.example.com/x', '', 'it has a path, query or fragment'],
      ['user:CANARYPW@hooks.example.com', '', 'it has a user name or password'],
      ['*.example.com', ' "*.example.com"', 'it has a wildcard'],
      ['[::1]', ' "[::1]"', 'it has brackets (IPv6 addresses are not accepted)'],
      ['a:b:c', ' "a:b:c"', 'it has a stray colon'],
      [
        'hooks.example.com:99999',
        ' "hooks.example.com:99999"',
        'its port is not a whole number from 1 to 65535',
      ],
      ['https://hooks.example.com', ' "https://hooks.example.com"', 'only http:// may start it'],
      [':443', ' ":443"', 'it has no host'],
      ['bad host', ' "bad host"', 'it is not a valid host name'],
    ];
    const got: unknown[] = [];
    for (const [entry] of cases) {
      const r = await b.listen(['wf', '--callback-allow', entry]);
      got.push([r.code, r.lines]);
    }
    // (1) red when a word's phrase is another's, the quote rule is applied on one word only, or a
    //     line echoes the password or the path's token; (2) prints each answer.
    expect({
      got,
      leaked: JSON.stringify(got).match(/CANARY[A-Z]+/g) ?? [],
    }).toEqual({
      got: cases.map(([, quoted, phrase]) => [1, [line(quoted, phrase)]]),
      leaked: [],
    });
  });

  it('two bad entries: the first, public list first; a repeated entry once; the two that can never work', async () => {
    const b = bench();
    const first = await b.listen([
      'wf',
      '--callback-allow-private',
      'a/b',
      '--callback-allow',
      'c/d',
    ]);
    const repeated = await b.listen(
      ['wf', '--callback-allow', 'hooks.example.com', '--callback-allow', 'HOOKS.example.com'],
      { REALM_ENCRYPTION_KEY: A },
    );
    const publicOnly = await b.listen(['wf', '--callback-allow', '10.0.0.5']);
    const never = await b.listen(['wf', '--callback-allow-private', '169.254.169.254']);
    const neverPublic = await b.listen(['wf', '--callback-allow', '169.254.169.254']);
    // (1) red when the lists are read in the wrong order, a repeated entry is listed twice, or an
    //     entry that can never be used is listed; (2) prints each answer.
    expect({
      first: [first.code, first.lines],
      repeated: b.callbackLines(repeated.lines)[0],
      publicOnly: [publicOnly.code, publicOnly.lines],
      never: [never.code, never.lines],
      neverPublic: neverPublic.lines,
    }).toEqual({
      first: [
        1,
        [
          'Error: --callback-allow "c" is not an address Realm can allow: it has a path, query or fragment. Give a host name, with a port if it is not 443: hooks.example.com, or http://hooks.example.com:8080 for plain http.',
        ],
      ],
      repeated: 'allowed hosts: hooks.example.com:443; workflows that take callbacks: refunds',
      publicOnly: [
        1,
        [
          'Error: --callback-allow "10.0.0.5" can never be used: it is a private, local or shared address, which this flag does not allow, so every callback to it would be refused (address). List it with --callback-allow-private only.',
        ],
      ],
      never: [
        1,
        [
          'Error: --callback-allow-private "169.254.169.254" can never be used: it is an address Realm never sends a callback to, whichever flag lists it, so every callback to it would be refused (address). Remove it.',
        ],
      ],
      neverPublic: [
        'Error: --callback-allow "169.254.169.254" can never be used: it is an address Realm never sends a callback to, whichever flag lists it, so every callback to it would be refused (address). Remove it.',
      ],
    });
  });

  it('realm callback key --host: a typed password and a path token are not echoed either', () => {
    const b = bench();
    const run = (host: string) =>
      spawnSync(process.execPath, [CLI, 'callback', 'key', 'wf', '--host', host], {
        cwd: b.root,
        env: { PATH: process.env['PATH'] ?? '', HOME: b.home, NO_COLOR: '1' },
        encoding: 'utf8',
        timeout: 60_000,
      }).stderr;
    const got = [
      run('user:CANARYPW@hooks.example.com/x'),
      run('hooks.example.com/webhook/CANARYTOKEN'),
    ];
    // (1) red when the key command keeps quoting the whole entry; (2) prints both lines.
    expect({ got, leaked: got.join('').match(/CANARY[A-Z]+/g) ?? [] }).toEqual({
      got: [
        'Error: --host is not a receiver address: it has a path, query or fragment. Give a host name or address, with a port if it is not 443: n8n.example.com, or http://n8n.lan:5678 for a receiver on plain http.\n',
        'Error: --host "hooks.example.com" is not a receiver address: it has a path, query or fragment. Give a host name or address, with a port if it is not 443: n8n.example.com, or http://n8n.lan:5678 for a receiver on plain http.\n',
      ],
      leaked: [],
    });
  });

  it('an entry that begins with / or ?: no quote, by realm listen and by realm callback key (correction 1)', async () => {
    const b = bench();
    const folder = await b.listen(['wf', '--callback-allow', '/srv/wf']);
    const query = await b.listen(['wf', '--callback-allow', '?token=CANARY']);
    const key = spawnSync(process.execPath, [CLI, 'callback', 'key', 'wf', '--host', '/srv/wf'], {
      cwd: b.root,
      env: { PATH: process.env['PATH'] ?? '', HOME: b.home, NO_COLOR: '1' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    const listenLine =
      'Error: --callback-allow is not an address Realm can allow: it has a path, query or fragment. Give a host name, with a port if it is not 443: hooks.example.com, or http://hooks.example.com:8080 for plain http.';
    // (1) red when the empty-text check is dropped (each line then says `""`, which reads as an
    //     empty value); (2) prints each answer.
    expect({
      folder: [folder.code, folder.lines],
      query: [query.code, query.lines],
      key: [key.status, key.stdout, key.stderr],
      leaked: JSON.stringify(query.lines).match(/CANARY/g) ?? [],
    }).toEqual({
      folder: [1, [listenLine]],
      query: [1, [listenLine]],
      key: [
        1,
        '',
        'Error: --host is not a receiver address: it has a path, query or fragment. Give a host name or address, with a port if it is not 443: n8n.example.com, or http://n8n.lan:5678 for a receiver on plain http.\n',
      ],
      leaked: [],
    });
  });

  it('a real process: --callback-allow-private 10.0.0.5 and a key made first; a request for https://10.0.0.5/x registers; another host is not allowed', async () => {
    const b = bench();
    b.key('wf', '10.0.0.5', { REALM_ENCRYPTION_KEY: A });
    const r = await b.listen(
      ['wf', '--callback-allow-private', '10.0.0.5'],
      { REALM_ENCRYPTION_KEY: A },
      async (port) => [
        await b.ask(port, 'https://10.0.0.5/x', 'evt-1'),
        await b.ask(port, 'https://10.0.0.6/x', 'evt-2'),
      ],
    );
    // (1) red when the private list is dropped or swapped with the public one (10.0.0.5 is then
    //     refused `address`), or an entry is dropped; (2) prints the answers.
    expect(r.result).toEqual([
      [202, 'registered'],
      [400, 'not_allowed'],
    ]);
  });
});

describe.runIf(POSIX)('C2c — the start lines, each from a real start', { timeout: 600_000 }, () => {
  const ALLOW = ['--callback-allow', 'hooks.example.com'];
  it('the master key from each of the four sources (the command’s output never shown); the reminder at every start, also for a hand-placed file', async () => {
    const b = bench();
    const named = join(b.root, 'master.key');
    writeFileSync(named, `${A}\n`, { mode: 0o600 });
    const script = join(b.root, 'printkey');
    writeFileSync(script, `#!/bin/sh\necho CANARYSTDERR >&2\nprintf '%s\\n' ${A}\n`);
    chmodSync(script, 0o755);
    const second = (r: { lines: string[] }) => b.callbackLines(r.lines)[1];
    const env = await b.listen(['wf', ...ALLOW], { REALM_ENCRYPTION_KEY: A });
    const file = await b.listen(['wf', ...ALLOW], { REALM_ENCRYPTION_KEY_FILE: named });
    const command = await b.listen(['wf', ...ALLOW], { REALM_ENCRYPTION_KEY_COMMAND: script });
    b.key('wf', 'hooks.example.com');
    const made = readFileSync(join(b.realm, 'encryption.key'), 'utf8').trim();
    const home1 = await b.listen(['wf', ...ALLOW]);
    const home2 = await b.listen(['wf', ...ALLOW]);
    const h = bench();
    mkdirSync(h.realm);
    writeFileSync(join(h.realm, 'encryption.key'), `${B}\n`, { mode: 0o600 });
    const byHand = await h.listen(['wf', ...ALLOW]);
    const reminder =
      'encryption.key in the Realm home is the master key: keep a copy of it somewhere else; without it the callback keys stored in realm.db cannot be read';
    // (1) red when a source is named as another, the reminder is said only once (or for another
    //     source), or the command's output is shown; (2) prints the lines.
    expect({
      env: second(env),
      file: second(file),
      command: second(command),
      commandShown: command.text.includes('CANARYSTDERR'),
      home1: b.callbackLines(home1.lines).slice(1, 3),
      home2: b.callbackLines(home2.lines).slice(1, 3),
      byHand: h.callbackLines(byHand.lines).slice(1, 3),
      envReminder: env.text.includes(reminder),
    }).toEqual({
      env: `encryption key ${fp(A)} from REALM_ENCRYPTION_KEY`,
      file: `encryption key ${fp(A)} from the file REALM_ENCRYPTION_KEY_FILE names`,
      command: `encryption key ${fp(A)} from REALM_ENCRYPTION_KEY_COMMAND`,
      commandShown: false,
      home1: [`encryption key ${fp(made)} from encryption.key in the Realm home`, reminder],
      home2: [`encryption key ${fp(made)} from encryption.key in the Realm home`, reminder],
      byHand: [`encryption key ${fp(B)} from encryption.key in the Realm home`, reminder],
      envReminder: false,
    });
  });

  it('a setting that differs from encryption.key, and a key file open to other users: the key command’s own words', async () => {
    const b = bench();
    mkdirSync(b.realm);
    writeFileSync(join(b.realm, 'encryption.key'), `${B}\n`, { mode: 0o600 });
    const differs = await b.listen(['wf', ...ALLOW], { REALM_ENCRYPTION_KEY: A });
    const wide = join(b.root, 'wide.key');
    writeFileSync(wide, `${A}\n`);
    chmodSync(wide, 0o644);
    const w = bench();
    const open = await w.listen(['wf', ...ALLOW], { REALM_ENCRYPTION_KEY_FILE: wide });
    // (1) red when the clash or the mode warning is worded apart from the key command's, or left
    //     out; (2) prints the lines.
    expect({
      differs: b.callbackLines(differs.lines).slice(1, 3),
      open: w.callbackLines(open.lines).slice(1, 3),
    }).toEqual({
      differs: [
        `encryption key ${fp(A)} from REALM_ENCRYPTION_KEY`,
        `REALM_ENCRYPTION_KEY gives encryption key ${fp(A)}, but [REDACTED]/.realm/encryption.key holds encryption key ${fp(B)}.`,
      ],
      open: [
        `encryption key ${fp(A)} from the file REALM_ENCRYPTION_KEY_FILE names`,
        `${wide} is open to other users (mode 0644). Fix that with: chmod 600 ${wide}`,
      ],
    });
  });

  it('an invalid source (a command exiting 3, a malformed setting, a relative file): one line, the server starts, no key lines; allowed is no_key, another not_allowed', async () => {
    const b = bench();
    b.key('wf', 'hooks.example.com', { REALM_ENCRYPTION_KEY: A });
    const script = join(b.root, 'fails');
    writeFileSync(script, '#!/bin/sh\necho CANARYOUT\nexit 3\n');
    chmodSync(script, 0o755);
    const probe = async (port: number) => [
      await b.ask(port, 'https://hooks.example.com/x', `evt-${port}-1`),
      await b.ask(port, 'https://other.example.com/x', `evt-${port}-2`),
    ];
    const results = {
      command: await b.listen(['wf', ...ALLOW], { REALM_ENCRYPTION_KEY_COMMAND: script }, probe),
      malformed: await b.listen(['wf', ...ALLOW], { REALM_ENCRYPTION_KEY: 'nothex' }, probe),
      relative: await b.listen(
        ['wf', ...ALLOW],
        { REALM_ENCRYPTION_KEY_FILE: 'master.key' },
        probe,
      ),
    };
    const shown = Object.fromEntries(
      Object.entries(results).map(([k, r]) => [
        k,
        {
          lines: b.callbackLines(r.lines),
          started: r.text.includes('realm listen on'),
          asked: r.result,
        },
      ]),
    );
    const allowed = 'allowed hosts: hooks.example.com:443; workflows that take callbacks: refunds';
    const tail = 'Every allowed host stays refused (no_key) until it is fixed.';
    const asked = [
      [400, 'no_key'],
      [400, 'not_allowed'],
    ];
    // (1) red when an invalid source prints key lines (or "make a key", which would fail), the
    //     openssl advice, the command's output, or stops the server; (2) prints each start.
    expect({ shown, leaked: JSON.stringify(results).includes('CANARYOUT') }).toEqual({
      shown: {
        command: {
          lines: [
            allowed,
            `REALM_ENCRYPTION_KEY_COMMAND did not give a master key: its command exited with status 3. Run the command by hand to see why. ${tail}`,
          ],
          started: true,
          asked,
        },
        malformed: {
          lines: [
            allowed,
            `REALM_ENCRYPTION_KEY is not a master key: it is not 64 hexadecimal characters. A master key is 64 hexadecimal characters. ${tail}`,
          ],
          started: true,
          asked,
        },
        relative: {
          lines: [
            allowed,
            `the file REALM_ENCRYPTION_KEY_FILE names is not a master key: its path is not absolute. A master key is 64 hexadecimal characters. ${tail}`,
          ],
          started: true,
          asked,
        },
      },
      leaked: false,
    });
  });

  it('per host: readable, sealed under another master, damaged, no key with a master, no key with no master', async () => {
    const b = bench();
    const readable = b.key('wf', 'hooks.example.com', { REALM_ENCRYPTION_KEY: A });
    b.key('wf', 'other.example.com', { REALM_ENCRYPTION_KEY: B });
    b.key('wf', 'damaged.example.com', { REALM_ENCRYPTION_KEY: A });
    const c = await openForeignConnection(b.realm);
    try {
      c.prepare(
        "UPDATE callback_keys SET sealed = x'00' WHERE host = 'damaged.example.com:443'",
      ).run();
    } finally {
      c.close();
    }
    const hosts = [
      'hooks.example.com',
      'other.example.com',
      'damaged.example.com',
      'none.example.com',
    ].flatMap((h) => ['--callback-allow', h]);
    const withMaster = await b.listen(['wf', ...hosts], { REALM_ENCRYPTION_KEY: A });
    const n = bench();
    const noMaster = await n.listen(['wf', '--callback-allow', 'none.example.com']);
    const cmd = (root: string, host: string) => `realm callback key ${root}/wf --host ${host}`;
    // (1) red when a state's text is another's (a key's fingerprint for a master's, the restart
    //     text with a master), or a key is shown; (2) prints the lines.
    expect({
      withMaster: b.callbackLines(withMaster.lines).slice(2),
      noMaster: n.callbackLines(noMaster.lines).slice(1),
      keyShown: withMaster.text.includes(readable),
    }).toEqual({
      withMaster: [
        `refunds → hooks.example.com:443: key ${keyFp(readable)}`,
        `refunds → other.example.com:443: its key was sealed with encryption key ${fp(B)}; this process has ${fp(A)}; start realm listen with that encryption key, or make a new key with: ${cmd(b.root, 'other.example.com:443')} --replace`,
        `refunds → damaged.example.com:443: the stored key cannot be read; make a new key with: ${cmd(b.root, 'damaged.example.com:443')} --replace`,
        `refunds → none.example.com:443: make a key with: ${cmd(b.root, 'none.example.com:443')}`,
      ],
      noMaster: [
        `refunds → none.example.com:443: this process has no encryption key; restart realm listen after you make a key with: ${cmd(n.root, 'none.example.com:443')}`,
      ],
      keyShown: false,
    });
  });

  it('stale keys (one; six), a workflow without result_map that holds keys (not named), no workflow that takes callbacks, the order of the lines', async () => {
    const b = bench();
    const env = { REALM_ENCRYPTION_KEY: A };
    b.key('wf', 'hooks.example.com', env);
    for (let i = 1; i <= 6; i += 1) b.key('wf2', `s${i}.example.com`, env);
    b.key('wf', 'gone.example.com', env);
    // A workflow that took callbacks once keeps its key after its result_map is taken away.
    writeFileSync(join(b.root, 'plain', 'workflow.yaml'), yaml('plainflow', '/plain', true));
    b.key('plain', 'plainhost.example.com', env);
    writeFileSync(join(b.root, 'plain', 'workflow.yaml'), yaml('plainflow', '/plain', false));
    const both = await b.listen(['wf', 'wf2', 'plain', ...ALLOW], env);
    const none = await b.listen(['plain', ...ALLOW], env);
    const at = (lines: string[], prefix: string) => lines.findIndex((l) => l.startsWith(prefix));
    // (1) red when a stale host is not named, more than five are listed, a workflow that takes no
    //     callbacks is named, the no-workflow warning is missing, or a line is out of place;
    //     (2) prints the lines.
    expect({
      lines: b.callbackLines(both.lines),
      none: b.callbackLines(none.lines),
      order: [
        at(both.lines, 'listen: caching') < at(both.lines, PREFIX),
        at(both.lines, 'realm listen on') === both.lines.length - 1,
      ],
    }).toEqual({
      lines: [
        'allowed hosts: hooks.example.com:443; workflows that take callbacks: refunds, orders',
        `encryption key ${fp(A)} from REALM_ENCRYPTION_KEY`,
        expect.stringMatching(/^refunds → hooks\.example\.com:443: key [0-9a-f]{8}$/),
        expect.stringMatching(
          /^orders → hooks\.example\.com:443: make a key with: realm callback key .+\/wf2 --host hooks\.example\.com:443$/,
        ),
        'refunds: a key is kept for 1 host(s) that are not allowed: gone.example.com:443',
        'orders: a key is kept for 6 host(s) that are not allowed: s1.example.com:443, s2.example.com:443, s3.example.com:443, s4.example.com:443, s5.example.com:443 and 1 more',
      ],
      none: [
        'allowed hosts: hooks.example.com:443; no mounted workflow takes callbacks (a workflow takes them when its trigger has a result_map), so every request that names a callback address is refused callback_not_enabled',
        `encryption key ${fp(A)} from REALM_ENCRYPTION_KEY`,
      ],
      order: [true, true],
    });
  });

  it('no master key: no master line, and no key or master key in any line of any start above', async () => {
    const b = bench();
    const none = await b.listen(['wf', ...ALLOW]);
    // (1) red when a master line is printed for none, or a master key's text reaches a line;
    //     (2) prints the lines.
    expect({
      lines: b.callbackLines(none.lines).filter((l) => l.startsWith('encryption key')),
      masters: [A, A.toUpperCase(), B, B.toUpperCase()].filter((m) => none.text.includes(m)),
    }).toEqual({ lines: [], masters: [] });
  });
});
