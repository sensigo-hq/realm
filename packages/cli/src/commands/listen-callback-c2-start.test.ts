// listen-callback-c2-start.test.ts — R1.3 callback C2: what `realm listen` does with its master key at
// start. `openListenHome` resolves the master key once (K1's four sources: a command source runs
// here), declares it to the writer, and opens the home with its sealer; with none or an invalid one it
// opens without, and every callback address is then refused `no_key`. Each cell runs the function on a
// real temp home with an `env` object, then serves the door over the home it opened. A source-text
// cell pins that the action calls it once and that nothing else in `listen.ts` opens the home. The
// last cell pastes the logged fix into bash and runs the BUILT `realm callback key` it names.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { spawnSync } from 'node:child_process';
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
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { createCallbackKeySealer } from '@sensigo/realm-store-sqlite';
import { parseCallbackEntry, type CallbackLists } from '../lib/callback/allow-list.js';
import * as writer from '../output/writer.js';
import { makeTempHome } from '../test-support/temp-home.js';
import {
  ENV,
  http,
  serve,
  sharedSecretTrigger,
  workflow,
} from '../test-support/listen-read-r11.js';
import { openListenHome } from './listen.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', 'dist', 'index.js');
const POSIX = process.platform !== 'win32';
const W = 'refunds';
const PATH = '/refunds';
const OPTED = workflow(
  W,
  sharedSecretTrigger(PATH, { approved: 'context.resources.review.approved' }),
);
const LABEL = 'hooks.example.com:443';
const URL_ = 'https://hooks.example.com/cb/CANARYc2start';
const KEY = 'cd'.repeat(32);
const A = 'a1'.repeat(32);
const B = 'b2'.repeat(32);
const fp = (hex: string): string =>
  createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex').slice(0, 8);
const LISTS: CallbackLists = {
  public: ['hooks.example.com', 'hooks.example.com:8443'].map((t) => {
    const p = parseCallbackEntry(t);
    if (!p.ok) throw new Error(t);
    return p.entry;
  }),
  private: [],
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'realm-c2-start-'));
  dirs.push(root);
  return root;
}

/** A home whose store holds a key for (refunds, `host`) sealed under `masterHex`, closed again. */
async function plantedHome(masterHex: string, host = LABEL): Promise<string> {
  const h = await makeTempHome({ sealer: createCallbackKeySealer(Buffer.from(masterHex, 'hex')) });
  dirs.push(h.root);
  await h.home.runStore.callbacks!.keys.make(W, host, KEY);
  await h.home.close();
  return h.path;
}

/** `openListenHome` on `home` with `env`, the door served over what it opened; closed after the cell. */
async function started(home: string, env: Record<string, string>) {
  const opened = await openListenHome({ env, home });
  onTestFinished(() => opened.home.close());
  const s = await serve([OPTED], {
    store: opened.home.runStore,
    over: { callbackLists: LISTS, callbackMasterFp: opened.masterFp },
  });
  const r = await http(
    s.port,
    'POST',
    PATH,
    {
      'content-type': 'application/json',
      'x-token': ENV['READ_SECRET']!,
      'realm-callback-url': URL_,
    },
    JSON.stringify({ id: 'evt-1' }),
  );
  const body = JSON.parse(r.body) as Record<string, unknown>;
  return {
    masterFp: opened.masterFp,
    status: r.status,
    answer: body['callback'] ?? body['reason'],
    line: s.logger.lines.find((l) => l.msg.startsWith('webhook: callback refused'))?.msg,
  };
}

describe('C2 — the sealer: openListenHome on a real home', () => {
  it('the master key in the environment opens the key sealed under it, and the door registers', async () => {
    const home = await plantedHome(A);
    // (1) red when the home is opened without the sealer (the key then reads unreadable: no_key);
    //     (2) prints the fingerprint, the reply and the line.
    expect(await started(home, { REALM_ENCRYPTION_KEY: A })).toEqual({
      masterFp: fp(A),
      status: 202,
      answer: 'registered',
      line: undefined,
    });
  });

  it('another master key, no master key, and an invalid one: the home opens, every address is no_key, nothing throws', async () => {
    const results = {
      other: await started(await plantedHome(A), { REALM_ENCRYPTION_KEY: B }),
      none: await started(await plantedHome(A), {}),
      invalid: await started(await plantedHome(A), { REALM_ENCRYPTION_KEY: 'nothex' }),
    };
    const fix = (has: string) =>
      `webhook: callback refused (no_key) — its key was sealed with encryption key ${fp(A)}; this process has ${has}; start realm listen with that encryption key, or make a new key with: realm callback key /tmp/r11-wf --host ${LABEL} --replace`;
    // (1) red when a missing or invalid master key throws (listen would not start), or the process's
    //     fingerprint is wrong in the fix; (2) prints each result.
    expect(results).toEqual({
      other: { masterFp: fp(B), status: 400, answer: 'no_key', line: fix(fp(B)) },
      none: { masterFp: null, status: 400, answer: 'no_key', line: fix('none') },
      invalid: { masterFp: null, status: 400, answer: 'no_key', line: fix('none') },
    });
  });

  it('the master key is declared to the writer in both cases, under two names; the callback key is not', async () => {
    const savedTTY = process.stdout.isTTY;
    process.stdout.isTTY = false;
    writer.installWriter('default');
    onTestFinished(() => {
      writer.writerTestSeams.reset();
      if (savedTTY === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY;
      else process.stdout.isTTY = savedTTY;
    });
    const master = 'a1b2'.repeat(16);
    const opened = await openListenHome({
      env: { REALM_ENCRYPTION_KEY: master },
      home: await plantedHome(master),
    });
    onTestFinished(() => opened.home.close());
    const shows = (text: string): boolean =>
      writer.writerTestSeams.visible(`v=${text};`).includes(text);
    // (1) red when the master key is not declared, one case is missing, both share one name, or the
    //     callback key is declared too; (2) prints the declared names and each text's fate.
    expect({
      names: (writer.writerSetFor('agent')?.sources ?? [])
        .filter((n) => n.includes('callback-master-key'))
        .sort(),
      lower: shows(master),
      upper: shows(master.toUpperCase()),
      callbackKey: shows(KEY),
    }).toEqual({
      names: [
        'declared:realm:callback-master-key:lowercase',
        'declared:realm:callback-master-key:uppercase',
      ],
      lower: false,
      upper: false,
      callbackKey: true,
    });
  });

  it('the action calls openListenHome once, and nothing else in listen.ts opens the home', () => {
    const code = readFileSync(join(HERE, 'listen.ts'), 'utf8')
      .split('\n')
      .map((line) => {
        const t = line.trim();
        return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
          ? ''
          : line.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""');
      });
    const start = code.findIndex((l) => l.startsWith('export async function openListenHome('));
    const end = code.findIndex((l, i) => i > start && l === '}');
    const at = (pattern: RegExp) => code.flatMap((l, i) => (pattern.test(l) ? [i] : []));
    const opens = at(/\bopenCliHome\(/);
    const calls = at(/\bopenListenHome\(/).filter((i) => i !== start);
    // (1) red when a bare openCliHome() is brought back, or the action opens the home twice or
    //     never through the function; (2) prints the lines (1-based) of each.
    expect({
      opensInside: opens.every((i) => i > start && i < end),
      opens: opens.length,
      calls: calls.map((i) => i + 1).length,
      callerIsTheAction: calls.every((i) => i > end),
    }).toEqual({ opensInside: true, opens: 2, calls: 1, callerIsTheAction: true });
  });
});

describe.runIf(POSIX)(
  'C2 — the command source at start, and the fix pasted',
  { timeout: 120_000 },
  () => {
    it('a command that prints the master key runs once and the door registers; a failing one opens no sealer and makes nothing', async () => {
      const root = scratch();
      const counter = join(root, 'counter');
      const script = (name: string, body: string): string => {
        const path = join(root, name);
        writeFileSync(path, `#!/bin/sh\nprintf 'x\\n' >> '${counter}'\n${body}\n`);
        chmodSync(path, 0o755);
        return `"${path}"`;
      };
      const runs = (): number =>
        existsSync(counter) ? readFileSync(counter, 'utf8').split('\n').length - 1 : 0;
      const prints = await started(await plantedHome(A), {
        REALM_ENCRYPTION_KEY_COMMAND: script('prints', `printf '%s\\n' ${A}`),
      });
      const afterPrints = runs();
      const failingHome = await plantedHome(A);
      const failing = await started(failingHome, {
        REALM_ENCRYPTION_KEY_COMMAND: script(
          'fails',
          "echo 'MARKERc2out'; echo 'MARKERc2err' >&2; exit 3",
        ),
      });
      const missing = await started(await plantedHome(A), {
        REALM_ENCRYPTION_KEY_COMMAND: join(root, 'nothing-here'),
      });
      // (1) red when the command runs per request (more than once), a failure is turned into a made
      //     master key, or a command's output reaches a line; (2) prints each result and the count.
      expect({
        prints: [prints.masterFp, prints.status, prints.answer],
        afterPrints,
        failing: [failing.masterFp, failing.answer, /MARKER/.test(failing.line ?? '')],
        missing: [missing.masterFp, missing.answer],
        masterFileMade: existsSync(join(failingHome, 'encryption.key')),
      }).toEqual({
        prints: [fp(A), 202, 'registered'],
        afterPrints: 1,
        failing: [null, 'no_key', false],
        missing: [null, 'no_key'],
        masterFileMade: false,
      });
    });

    it('the logged fix, pasted into bash, addresses the same workflow and host: a folder with a space, a host with a port', async () => {
      const root = scratch();
      const folder = join(root, 'my flows');
      mkdirSync(folder);
      writeFileSync(
        join(folder, 'workflow.yaml'),
        `id: ${W}\nname: ${W}\nversion: 1\ntrigger:\n  type: webhook\n  path: ${PATH}\n  auth:\n    mode: shared_secret\n    header: X-Token\n    secret_from: READ_SECRET\n  result_map:\n    approved: context.resources.review.approved\nsteps:\n  review:\n    description: Review.\n    execution: auto\n`,
      );
      const bin = join(root, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'realm'), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
      chmodSync(join(bin, 'realm'), 0o755);
      mkdirSync(join(root, 'home'));
      const h = await makeTempHome({ home: join(root, 'home', '.realm') });
      onTestFinished(() => h.home.close());
      const s = await serve([OPTED], {
        store: h.home.runStore,
        over: { callbackLists: LISTS, callbackMasterFp: null },
      });
      s.routes.get(PATH)!.workflowDir = folder;
      await http(
        s.port,
        'POST',
        PATH,
        {
          'content-type': 'application/json',
          'x-token': ENV['READ_SECRET']!,
          'realm-callback-url': 'https://hooks.example.com:8443/x',
        },
        JSON.stringify({ id: 'evt-1' }),
      );
      const line = s.logger.lines.find((l) => l.msg.includes('make a key with: '))?.msg ?? '';
      const command = line.slice(line.indexOf('make a key with: ') + 'make a key with: '.length);
      await h.home.close();
      const pasted = spawnSync('bash', ['-c', command], {
        cwd: root,
        env: {
          PATH: `${bin}:${process.env['PATH'] ?? ''}`,
          HOME: join(root, 'home'),
          NO_COLOR: '1',
          REALM_NO_NUDGE: '1',
        },
        encoding: 'utf8',
        timeout: 60_000,
      });
      // (1) red when the fix leaves out the folder, quotes it so that the shell splits it, drops the
      //     port, or ends in punctuation; (2) prints the command and what the pasted run said.
      expect({
        command: command.replace(root, '<root>'),
        code: pasted.status,
        said: pasted.stderr.split('\n').find((l) => l.startsWith('Made a key for')),
      }).toEqual({
        command: `realm callback key '<root>/my flows' --host hooks.example.com:8443`,
        code: 0,
        said: expect.stringMatching(
          /^Made a key for refunds → hooks\.example\.com:8443 \(key [0-9a-f]{8}\)/,
        ),
      });
    });
  },
);
