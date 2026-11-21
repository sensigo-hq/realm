// callback-key-grounding-c2c.test.ts — callback C2c, GROUNDING (they pass on the base, 6dbcc598, before
// the master key sentences move to `master-key-words.ts`): the two sentences of the BUILT `realm
// callback key` that no cell pinned word for word. (1) The clash clause when the setting is the file
// `REALM_ENCRYPTION_KEY_FILE` names and `encryption.key` holds another key (Words 9 on print, Words 7
// on make). (2) The "open to other users" warning when the master key is `encryption.key` in the Realm
// home. The move must leave both byte-identical. Streams are piped, so HOME's value prints as
// `[REDACTED]`.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', 'dist', 'index.js');
const POSIX = process.platform !== 'win32';
const W = 'refunds';
const MASTER_A = 'a1'.repeat(32);
const MASTER_B = 'b2'.repeat(32);
const NOTHING = 'No key was changed.';
const fpOfKey = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);
const fpOfMaster = (hex: string): string =>
  createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex').slice(0, 8);
const takes = `id: ${W}\nname: ${W}\nversion: 1\ntrigger:\n  type: webhook\n  path: /${W}\n  auth:\n    mode: shared_secret\n    header: X-Token\n    secret_from: K2C_SECRET\n  result_map:\n    approved: context.resources.record.approved\nsteps:\n  record:\n    description: Record.\n    execution: auto\n`;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function bench() {
  const root = mkdtempSync(join(tmpdir(), 'realm-c2c-ground-'));
  dirs.push(root);
  const home = join(root, 'home');
  mkdirSync(home);
  mkdirSync(join(root, 'wf'));
  writeFileSync(join(root, 'wf', 'workflow.yaml'), takes);
  const masterFile = join(home, '.realm', 'encryption.key');
  const key = (host: string, env: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [CLI, 'callback', 'key', 'wf', '--host', host], {
      cwd: root,
      env: { PATH: process.env['PATH'] ?? '', HOME: home, NO_COLOR: '1', ...env },
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const shown = (path: string): string => path.split(home).join('[REDACTED]');
  return { root, masterFile, key, shown };
}

describe.runIf(POSIX)(
  'C2c GROUNDING — two sentences of realm callback key, before the move',
  { timeout: 120_000 },
  () => {
    it('the clash clause for the file REALM_ENCRYPTION_KEY_FILE names: Words 9 on print, Words 7 on make', () => {
      const b = bench();
      const named = join(b.root, 'master.key');
      writeFileSync(named, `${MASTER_A}\n`, { mode: 0o600 });
      const env = { REALM_ENCRYPTION_KEY_FILE: named };
      const made = b.key('n8n.example.com', env);
      const k = made.out.trim();
      writeFileSync(b.masterFile, `${MASTER_B}\n`, { mode: 0o600 });
      const print = b.key('n8n.example.com', env);
      const make = b.key('new.example.com', env);
      const clash = `the file REALM_ENCRYPTION_KEY_FILE names gives encryption key ${fpOfMaster(MASTER_A)}, but ${b.shown(b.masterFile)} holds encryption key ${fpOfMaster(MASTER_B)}`;
      // (1) red when the moved clause names another source or changes a word; (2) prints both answers.
      expect({ made: made.code, print, make }).toEqual({
        made: 0,
        print: {
          code: 0,
          out: `${k}\n`,
          err: `Warning: ${clash}.\nKey for ${W} → n8n.example.com:443: key ${fpOfKey(k)}, sealed with encryption key ${fpOfMaster(MASTER_A)}.\n`,
        },
        make: {
          code: 1,
          out: '',
          err: `Error: ${clash}. Keys written now would be unreadable to a process that uses the file. ${NOTHING} Unset the setting or make the file match, then run this command again.\n`,
        },
      });
    });

    it('the open-to-others warning when the master key is encryption.key in the Realm home', () => {
      const b = bench();
      const made = b.key('n8n.example.com');
      chmodSync(b.masterFile, 0o644);
      const print = b.key('n8n.example.com');
      const k = made.out.trim();
      const m = readFileSync(b.masterFile, 'utf8').trim();
      // (1) red when the moved warning names another path or mode, or changes a word; (2) prints the
      //     answer.
      expect({ made: made.code, print }).toEqual({
        made: 0,
        print: {
          code: 0,
          out: `${k}\n`,
          err: `Warning: ${b.shown(b.masterFile)} is open to other users (mode 0644). Fix that with: chmod 600 ${b.shown(b.masterFile)}\nKey for ${W} → n8n.example.com:443: key ${fpOfKey(k)}, sealed with encryption key ${fpOfMaster(m)}.\n`,
        },
      });
    });
  },
);
