// callback-disclosure-b1b.test.ts — callback B1b (R1.3): with a signing key made and a run registered
// with a callback, the built `realm` never shows the key or the address. A home is filled through the
// library (no command makes a key or registers a callback yet), then `realm run inspect`, `realm run
// list`, `realm run export`, `realm db check` (text and JSON) and `realm run purge` (the preview and
// the receipt) run on it, and the messages the store throws (a held webhook id, a home without a
// sealer) are read: none holds the key's text, its 32 raw bytes or the callback's address.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { abandonRun } from '@sensigo/realm';
import { openRealmHome, type CallbackKeySealer } from '@sensigo/realm-store-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_CLI = join(HERE, '..', '..', 'dist', 'index.js');

const WF = 'wf-disclose';
const HOST = 'hooks.example:443';
const KEY = '5e'.repeat(32);
const URL = 'https://hooks.example/callback/b1b-address-marker';

/** A sealer for the cell: each byte of the text XOR 0x5a after a header naming the slot. */
const sealer: CallbackKeySealer = {
  masterFp: 'c0ffee01',
  seal(text, ctx) {
    const head = Buffer.from(`sealed:${ctx.workflow_id}:${ctx.host}:${ctx.slot}\n`, 'utf8');
    return new Uint8Array(Buffer.concat([head, Buffer.from(text, 'utf8').map((b) => b ^ 0x5a)]));
  },
  unseal(blob, ctx) {
    const head = Buffer.from(`sealed:${ctx.workflow_id}:${ctx.host}:${ctx.slot}\n`, 'utf8');
    const bytes = Buffer.from(blob);
    if (!bytes.subarray(0, head.length).equals(head)) return undefined;
    return Buffer.from(bytes.subarray(head.length).map((b) => b ^ 0x5a)).toString('utf8');
  },
};

let root = '';
let base = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'realm-b1b-disclose-'));
  base = mkdtempSync(join(tmpdir(), 'realm-b1b-disclose-cwd-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
});

/** Runs the built `realm` with HOME set to the scratch root; stdout and stderr together. */
function realm(args: string[]): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [DIST_CLI, ...args], {
    cwd: base,
    env: { PATH: process.env['PATH'] ?? '', HOME: root, REALM_NO_NUDGE: '1' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    killSignal: 'SIGKILL',
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** What a text shows of the secrets: the key's text, its raw bytes, the address. */
function shows(text: string): { key: boolean; raw: boolean; address: boolean } {
  return {
    key: text.toLowerCase().includes(KEY),
    raw: Buffer.from(text, 'utf8').includes(Buffer.from(KEY, 'hex')),
    address: text.includes(URL),
  };
}

const NONE = { key: false, raw: false, address: false };

// Each command starts the built CLI (a cold start each time), so the describe carries its own budget.
describe(
  'callback B1b — the built realm shows neither a signing key nor a callback address',
  { timeout: 120_000 },
  () => {
    it('inspect, list, export, db check (text and JSON), the purge preview and receipt, and the thrown messages', async () => {
      const home = join(root, '.realm');
      const h = await openRealmHome({ home, sealer });
      await h.runStore.keys.make(WF, HOST, KEY);
      const webhook = '00000000-0000-4000-8000-000000000001';
      const { record } = await h.runStore.create({
        workflowId: WF,
        workflowVersion: 1,
        params: {},
        callback: { url: URL, host: HOST, webhook_id: webhook },
      });
      const held = await h.runStore
        .create({
          workflowId: WF,
          workflowVersion: 1,
          params: {},
          callback: { url: URL, host: HOST, webhook_id: webhook },
        })
        .then(
          () => 'created',
          (err: Error) => err.message,
        );
      await abandonRun(h.runStore, record.id);
      h.close();
      const bare = await openRealmHome({ home });
      const noSealer = await bare.runStore.keys.make(WF, 'other.example:443', KEY).then(
        () => 'made',
        (err: Error) => err.message,
      );
      bare.close();
      const exported = join(base, 'run.json');
      const runs = {
        inspect: realm(['run', 'inspect', record.id]),
        list: realm(['run', 'list']),
        export: realm([
          'run',
          'export',
          record.id,
          '--out',
          exported,
          '--accept-partial-disclosure',
        ]),
        check: realm(['db', 'check']),
        checkJson: realm(['db', 'check', '--json']),
        preview: realm(['run', 'purge', record.id]),
        purge: realm(['run', 'purge', record.id, '--force']),
      };
      const bundle = existsSync(exported) ? readFileSync(exported, 'utf8') : 'no bundle';
      // (1) red when a command, the export bundle or a thrown message prints the key's text, its raw
      //     bytes or the address (a row or a key slot rendered whole); (2) prints which command showed
      //     which, with each command's exit code.
      expect({
        ...Object.fromEntries(Object.entries(runs).map(([name, r]) => [name, shows(r.out)])),
        bundle: shows(bundle),
        held: shows(held),
        noSealer: shows(noSealer),
      }).toEqual({
        inspect: NONE,
        list: NONE,
        export: NONE,
        check: NONE,
        checkJson: NONE,
        preview: NONE,
        purge: NONE,
        bundle: NONE,
        held: NONE,
        noSealer: NONE,
      });
      // (1) red when a command did not run on the home (the searches above would pass on nothing);
      //     (2) prints each command's exit code and its first line.
      expect(
        Object.fromEntries(
          Object.entries(runs).map(([name, r]) => [
            name,
            { code: r.code, said: r.out.split('\n')[0] !== '' },
          ]),
        ),
      ).toEqual({
        inspect: { code: 0, said: true },
        list: { code: 0, said: true },
        export: { code: 0, said: true },
        check: { code: 0, said: true },
        checkJson: { code: 0, said: true },
        preview: { code: 0, said: true },
        purge: { code: 0, said: true },
      });
      expect({ bundle: bundle !== 'no bundle', held, noSealer }).toEqual({
        bundle: true,
        held: 'This `callback.webhook_id` is already registered; no run was created.',
        noSealer:
          'This Realm home was opened without a callback key sealer, so it cannot write a signing key.',
      });
    });
  },
);
