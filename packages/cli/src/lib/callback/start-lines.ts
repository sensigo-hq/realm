// start-lines.ts — R1.3 callback C2c (the switch): what `realm listen` started with an allow-list flag
// says at start (prefix `listen: callbacks: `, printed by the action after `listen: caching` and before
// `realm listen on`). `callbackStartLines` is pure and returns DATA: a line that ends with a command
// (a pair with no usable key) carries the verdict, the workflow's folder and the host label, and the
// action builds its words with `noKeyFix` and the command inside the print call (lint L-2). In order:
//   1. the allowed hosts and the workflows that take callbacks (a warning when none does);
//   2. the master key's fingerprint and source; 3. the reminder to keep `encryption.key` (every start);
//   4. a setting that differs from `encryption.key`, a key file open to other users;
//   5. an invalid source (then nothing more: no key can be read);
//   6. per workflow that takes callbacks and allowed host, its key or what to do;
//   7. per such workflow, the hosts it keeps keys for that are not allowed;
//   8. a listing that could not be read (instead of 6 and 7).
// No line shows a key, a master key or an address: host labels, workflow ids and fingerprints only.
// `listenMasterSummary` reads what lines 2 to 5 need (two files at most); a read that fails leaves
// its clause out: a start never fails for a line.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CallbackKeyListing } from '@sensigo/realm';
import { masterKeyFingerprint } from '@sensigo/realm-store-sqlite';
import type { CallbackLists } from './allow-list.js';
import type { CallbackKeyVerdict } from './door.js';
import { callbackEntryLabel } from './host-label.js';
import {
  MASTER_KEY_FILE,
  parseMasterKey,
  type MasterKeyResolution,
  type MasterKeySource,
} from './master-key.js';
import { invalidMasterKeyWords, masterKeyClash, masterKeyOpenWarning } from './master-key-words.js';

/** What the start lines know of the master key; never its bytes. */
export type ListenMasterSummary =
  | {
      readonly state: 'found';
      readonly source: MasterKeySource;
      readonly fp: string;
      readonly differs?: { readonly homeFile: string; readonly homeFp: string };
      readonly wide?: { readonly path: string; readonly mode: string };
    }
  | { readonly state: 'none' }
  | { readonly state: 'invalid'; readonly head: string; readonly closing: string };

/** One start line: its words, or a pair with no usable key (its words built at the print call). */
export type CallbackStartLine =
  | { readonly kind: 'text'; readonly level: 'info' | 'warn'; readonly text: string }
  | {
      readonly kind: 'no_key';
      readonly workflow: string;
      readonly label: string;
      readonly folder: string;
      readonly verdict: Exclude<CallbackKeyVerdict, { ok: true }>;
    };

export interface CallbackStartInput {
  readonly lists: CallbackLists;
  /** The mounted workflows, in mount order: their id, folder, and whether they take callbacks. */
  readonly workflows: readonly {
    readonly id: string;
    readonly folder: string;
    readonly takes: boolean;
  }[];
  readonly master: ListenMasterSummary;
  /** The key store's one listing, or why it could not be read; absent when it was not read. */
  readonly keys?: { readonly listing: readonly CallbackKeyListing[] } | { readonly error: string };
}

const SOURCE: Readonly<Record<MasterKeySource, string>> = {
  env: 'REALM_ENCRYPTION_KEY',
  env_file: 'the file REALM_ENCRYPTION_KEY_FILE names',
  command: 'REALM_ENCRYPTION_KEY_COMMAND',
  home_file: 'encryption.key in the Realm home',
};

/** The start lines (see the module comment). */
export function callbackStartLines(input: CallbackStartInput): CallbackStartLine[] {
  const out: CallbackStartLine[] = [];
  const say = (level: 'info' | 'warn', text: string): void => {
    out.push({ kind: 'text', level, text });
  };
  const publicLabels = input.lists.public.map(callbackEntryLabel);
  const privateLabels = input.lists.private.map(callbackEntryLabel);
  const shown = [...publicLabels, ...privateLabels.map((l) => `${l} (private)`)].join(', ');
  const hosts = [...new Set([...publicLabels, ...privateLabels])];
  const taking = input.workflows.filter((w) => w.takes);
  if (taking.length > 0) {
    say(
      'info',
      `allowed hosts: ${shown}; workflows that take callbacks: ${taking.map((w) => w.id).join(', ')}`,
    );
  } else {
    say(
      'warn',
      `allowed hosts: ${shown}; no mounted workflow takes callbacks (a workflow takes them when its ` +
        'trigger has a result_map), so every request that names a callback address is refused ' +
        'callback_not_enabled',
    );
  }
  const master = input.master;
  if (master.state === 'invalid') {
    say(
      'warn',
      `${master.head}. ${master.closing} Every allowed host stays refused (no_key) until it is fixed.`,
    );
    return out;
  }
  if (master.state === 'found') {
    say('info', `encryption key ${master.fp} from ${SOURCE[master.source]}`);
    if (master.source === 'home_file') {
      say(
        'warn',
        'encryption.key in the Realm home is the master key: keep a copy of it somewhere else; ' +
          'without it the callback keys stored in realm.db cannot be read',
      );
    }
    if (master.differs !== undefined) {
      say(
        'warn',
        `${masterKeyClash(master.source, master.fp, master.differs.homeFile, master.differs.homeFp)}.`,
      );
    }
    if (master.wide !== undefined)
      say('warn', masterKeyOpenWarning(master.wide.path, master.wide.mode));
  }
  const keys = input.keys;
  if (keys === undefined) return out;
  if ('error' in keys) {
    say('warn', `could not read the stored callback keys: ${keys.error}`);
    return out;
  }
  for (const w of taking) {
    for (const host of hosts) {
      const current = keys.listing.find((e) => e.workflow_id === w.id && e.host === host)?.current;
      if (current?.state === 'readable') {
        say('info', `${w.id} → ${host}: key ${current.key_fp}`);
      } else {
        out.push({
          kind: 'no_key',
          workflow: w.id,
          label: host,
          folder: w.folder,
          verdict:
            current === undefined
              ? { ok: false, state: 'none' }
              : { ok: false, state: 'unreadable', master_fp: current.master_fp },
        });
      }
    }
  }
  for (const w of taking) {
    const stale = keys.listing
      .filter((e) => e.workflow_id === w.id && !hosts.includes(e.host))
      .map((e) => e.host);
    if (stale.length === 0) continue;
    const more = stale.length > 5 ? ` and ${stale.length - 5} more` : '';
    say(
      'info',
      `${w.id}: a key is kept for ${stale.length} host(s) that are not allowed: ${stale.slice(0, 5).join(', ')}${more}`,
    );
  }
  return out;
}

/** A read that may fail: its value, or nothing (its clause is then left out). */
function safely<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** What lines 2 to 5 need of a resolved master key (see the module comment). */
export function listenMasterSummary(
  res: MasterKeyResolution,
  env: Readonly<Record<string, string | undefined>>,
  homeDir: string,
): ListenMasterSummary {
  const homeFile = join(homeDir, MASTER_KEY_FILE);
  if (res.state === 'none') return { state: 'none' };
  if (res.state === 'invalid') {
    const { head, closing } = invalidMasterKeyWords(res, env, homeFile);
    return { state: 'invalid', head, closing: closing[0]! };
  }
  const differs =
    res.differs_from_home_file === true
      ? safely(() => {
          const key = parseMasterKey(readFileSync(homeFile, 'utf8'));
          if (key === undefined) throw new Error('no key');
          return { homeFile, homeFp: masterKeyFingerprint(key) };
        })
      : undefined;
  const path = res.source === 'env_file' ? env['REALM_ENCRYPTION_KEY_FILE'] : homeFile;
  const wide =
    res.mode_wider_than_owner === true && path !== undefined
      ? safely(() => ({ path, mode: (statSync(path).mode & 0o7777).toString(8).padStart(4, '0') }))
      : undefined;
  return {
    state: 'found',
    source: res.source,
    fp: res.fp,
    ...(differs !== undefined ? { differs } : {}),
    ...(wide !== undefined ? { wide } : {}),
  };
}
