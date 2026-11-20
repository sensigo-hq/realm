// callback-key-seams-k2a2.test.ts — callback K2a-2 (R1.3): `realm callback key`'s body, `callbackKey`,
// called directly with its collaborators injected, where only an injection can reach a branch: the
// master key file maker answers 'exists' because another process made the file first (a valid file is
// used, a malformed one is reported and never replaced), or the system refuses it (EACCES). A real
// home in a scratch `HOME`; the writer installed first, as a command's `preAction` hook does (a
// declaration made with no writer is lost); the lines read from `console.*` as the command wrote them.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { callbackKeyFingerprint } from '@sensigo/realm';
import {
  createCallbackKeySealer,
  masterKeyFingerprint,
  openRealmHome,
} from '@sensigo/realm-store-sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installWriter, writerTestSeams } from '../output/writer.js';
import { openCliHome } from '../lib/home.js';
import { CALLBACK_KEY_DEPS, callbackKey, type CallbackKeyDeps } from './callback-key.js';

const WORKFLOW = `id: refunds\nname: refunds\nversion: 1\ntrigger:\n  type: webhook\n  path: /refunds\n  auth:\n    mode: shared_secret\n    header: X-Token\n    secret_from: K2A2_SECRET\n  params_map:\n    approved: body.approved\n  result_map:\n    approved: context.resources.record.approved\nsteps:\n  record:\n    description: Record.\n    execution: auto\n`;
const MASTER = 'c3'.repeat(32);
const fpOfMaster = (hex: string): string =>
  createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex').slice(0, 8);

let root: string;
let savedHome: string | undefined;
let savedTTY: boolean | undefined;
let said: { out: string[]; err: string[] };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'realm-k2a2-seams-'));
  mkdirSync(join(root, 'home'));
  mkdirSync(join(root, 'wf'));
  writeFileSync(join(root, 'wf', 'workflow.yaml'), WORKFLOW);
  savedHome = process.env['HOME'];
  process.env['HOME'] = join(root, 'home');
  savedTTY = process.stdout.isTTY;
  process.stdout.isTTY = false;
  installWriter('default');
  said = { out: [], err: [] };
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void said.out.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation(
    (...a: unknown[]) => void said.err.push(a.join(' ')),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  writerTestSeams.reset();
  if (savedTTY === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY;
  else process.stdout.isTTY = savedTTY;
  if (savedHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = savedHome;
  rmSync(root, { recursive: true, force: true });
});

const realm = (): string => join(root, 'home', '.realm');
const masterFile = (): string => join(realm(), 'encryption.key');

/** The real collaborators, with the maker replaced. */
const withMaker = (placeMasterKeyFile: CallbackKeyDeps['placeMasterKeyFile']): CallbackKeyDeps => ({
  ...CALLBACK_KEY_DEPS,
  placeMasterKeyFile,
});

/** The pairs the home holds, listed without a sealer. */
async function listed(): Promise<unknown[]> {
  const handle = await openRealmHome({ home: realm() });
  try {
    return [...(await handle.runStore.keys.list())];
  } finally {
    handle.close();
  }
}

const args = () => ({ workflow: join(root, 'wf'), host: 'n8n.example.com' });

describe("callback K2a-2 — the master key file another process made first ('exists')", () => {
  it('a valid file is read again and used: the key is sealed with its fingerprint', async () => {
    const maker = vi.fn((homeDir: string) => {
      writeFileSync(join(homeDir, 'encryption.key'), `${MASTER}\n`, { mode: 0o600 });
      return 'exists' as const;
    });
    const code = await callbackKey(args(), withMaker(maker), {});
    // (1) red when the command does not read the master key again after 'exists' (it then has no
    //     sealer and cannot make the key), says it made the file, or seals with another key;
    //     (2) prints the lines the command wrote.
    expect({
      code,
      maker: maker.mock.calls.length,
      err: said.err,
      out: said.out.map((l) => /^[0-9a-f]{64}$/.test(l)),
      file: readFileSync(masterFile(), 'utf8'),
      pairs: (await listed()).length,
    }).toEqual({
      code: 0,
      maker: 1,
      err: [
        expect.stringMatching(
          new RegExp(
            `^Made a key for refunds → n8n\\.example\\.com:443 \\(key [0-9a-f]{8}\\), sealed with encryption key ${fpOfMaster(MASTER)}\\.$`,
          ),
        ),
      ],
      out: [true],
      file: `${MASTER}\n`,
      pairs: 1,
    });
  });

  it('a malformed file is reported (Words 5) and left as it is; no key is made', async () => {
    const maker = vi.fn((homeDir: string) => {
      writeFileSync(join(homeDir, 'encryption.key'), 'nothex\n', { mode: 0o600 });
      return 'exists' as const;
    });
    const code = await callbackKey(args(), withMaker(maker), {});
    // (1) red when a malformed file another process made is replaced or used, or a key is made;
    //     (2) prints the lines and the file.
    expect({
      code,
      err: said.err,
      out: said.out,
      file: readFileSync(masterFile(), 'utf8'),
      pairs: await listed(),
    }).toEqual({
      code: 1,
      err: [
        `Error: ${masterFile()} is not a master key: it is not 64 hexadecimal characters. No key was changed. A master key is 64 hexadecimal characters. Make one with: openssl rand -hex 32`,
      ],
      out: [],
      file: 'nothex\n',
      pairs: [],
    });
  });
});

describe('callback K2a-2 — the master key file cannot be made', () => {
  it('a refusal of the system is said with its code (Words 13); no key is made', async () => {
    const maker = vi.fn((): 'placed' => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });
    const code = await callbackKey(args(), withMaker(maker), {});
    // (1) red when the error escapes unworded, names no code, or a key is made anyway; (2) prints
    //     the lines.
    expect({ code, err: said.err, out: said.out, pairs: await listed() }).toEqual({
      code: 1,
      err: [
        `Error: could not make the master key file ${masterFile()}: EACCES. No key was changed.`,
      ],
      out: [],
      pairs: [],
    });
  });
});

describe('callback K2a-2 — another process makes the master key and a pair while this one runs', () => {
  it('a pair listed with no master key read: the master key is read once more, and used', async () => {
    // Another process A, between this process's read of the master key (none) and its listing: A
    // places the master file, then commits its own pair (A places the file BEFORE it commits any
    // pair). The injected opener does what A does, on its first open; the pair goes in on a
    // foreign connection, sealed with A's master key.
    const master = Buffer.from(MASTER, 'hex');
    let first = true;
    const openHome: CallbackKeyDeps['openHome'] = async (options) => {
      const home = await openCliHome(options);
      if (first) {
        first = false;
        writeFileSync(masterFile(), `${MASTER}\n`, { mode: 0o600 });
        const text = 'd4'.repeat(32);
        const ctx = {
          workflow_id: 'other-flow',
          host: 'h.example.com:443',
          slot: 'current' as const,
        };
        const db = new DatabaseSync(join(realm(), 'realm.db'));
        try {
          db.prepare(
            'INSERT INTO callback_keys (workflow_id, host, slot, sealed, key_fp, master_fp, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)',
          ).run(
            ctx.workflow_id,
            ctx.host,
            ctx.slot,
            createCallbackKeySealer(master).seal(text, ctx),
            callbackKeyFingerprint(text),
            masterKeyFingerprint(master),
            '2026-11-20T00:00:00.000Z',
          );
        } finally {
          db.close();
        }
      }
      return home;
    };
    const maker = vi.fn((): 'placed' => 'placed');
    const code = await callbackKey(
      args(),
      { ...CALLBACK_KEY_DEPS, openHome, placeMasterKeyFile: maker },
      {},
    );
    // (1) red when the command, seeing another process's pair with no master key read, does not
    //     read the master key again (it then refuses with Words 4, "this shell has no master key"),
    //     or makes a second master file; (2) prints the lines the command wrote.
    expect({
      code,
      maker: maker.mock.calls.length,
      err: said.err,
      out: said.out.map((l) => /^[0-9a-f]{64}$/.test(l)),
      pairs: (await listed()).length,
    }).toEqual({
      code: 0,
      maker: 0,
      err: [
        expect.stringMatching(
          new RegExp(
            `^Made a key for refunds → n8n\\.example\\.com:443 \\(key [0-9a-f]{8}\\), sealed with encryption key ${fpOfMaster(MASTER)}\\.$`,
          ),
        ),
      ],
      out: [true],
      pairs: 2,
    });
  });
});
