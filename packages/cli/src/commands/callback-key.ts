// callback-key.ts — callback K2a-2 (R1.3; the callback design rev 4 §1.1–§1.6; the owner's yeses
// 896326ed and eaa442b9): `realm callback key [workflow] --host <entry>`, the command an operator makes,
// prints, rotates, replaces and deletes the signing key of one (workflow, receiver host) with.
//
// The pair is the workflow's id and the entry's host label (`host:port`). Printing, making, rotating
// and replacing need the workflow to take callbacks (a `result_map` on its trigger) and the master key
// the keys are sealed under; `--end-previous` alone and `--delete` need neither: they open the home
// without a sealer, never read the master key and never make its file. The master key file
// `<home>/encryption.key` is made only when this home holds no key at all (or to `--replace` an
// unreadable key with no master key anywhere), and never over anything: a second master key would
// leave every stored key unreadable.
//
// Output: on success, stdout is exactly the key's text (or its `whsec_` form) and one newline;
// everything else goes to stderr. The master key is declared to the writer, so no line shows it; the
// callback key is never declared. Exit 0 on success and on a "nothing to do" result, 1 on every
// refusal. The body is `callbackKey`, a function taking its collaborators, so a cell can inject them.
import { randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  loadWorkflowFromFile,
  realmHomePath,
  shellWord,
  type CallbackKeySlot,
  type CallbackKeyStore,
} from '@sensigo/realm';
import { createCallbackKeySealer, masterKeyFingerprint } from '@sensigo/realm-store-sqlite';
import { Command, InvalidArgumentError } from 'commander';
import { openCliHome, type CliHome } from '../lib/home.js';
import { parseCallbackEntry } from '../lib/callback/allow-list.js';
import { declareMasterKey } from '../lib/callback/declare-master-key.js';
import { entryRefusalPhrase } from '../lib/callback/entry-words.js';
import { callbackEntryLabel } from '../lib/callback/host-label.js';
import { placeMasterKeyFile } from '../lib/callback/master-key-file.js';
import {
  MASTER_KEY_FILE,
  parseMasterKey,
  resolveMasterKey,
  type MasterKeyResolution,
} from '../lib/callback/master-key.js';
import { resolveWorkflowFile } from './listen.js';

/** What the command line gave. */
export interface CallbackKeyArgs {
  readonly workflow?: string;
  readonly host: string;
  readonly whsec?: boolean;
  readonly rotate?: boolean;
  readonly keep?: number;
  readonly endPrevious?: boolean;
  readonly replace?: boolean;
  readonly delete?: boolean;
}

/** The collaborators `callbackKey` takes (the real ones are {@link CALLBACK_KEY_DEPS}). */
export interface CallbackKeyDeps {
  readonly placeMasterKeyFile: (homeDir: string) => 'placed' | 'exists';
  readonly openHome: (options: {
    sealer?: ReturnType<typeof createCallbackKeySealer>;
  }) => Promise<CliHome>;
  /** A new key's text: 32 random bytes as 64 lowercase hex. */
  readonly randomKey: () => string;
}

export const CALLBACK_KEY_DEPS: CallbackKeyDeps = {
  placeMasterKeyFile,
  openHome: (options) => openCliHome(options),
  randomKey: () => randomBytes(32).toString('hex'),
};

const KEEP_DEFAULT_HOURS = 24;
const KEEP_MAX_HOURS = 168;
const NOTHING = 'No key was changed.';

/** `--keep <hours>`: a whole number from 1 to 168, checked when the command line is read. */
function parseKeepHours(value: string): number {
  const n = /^[0-9]+$/.test(value) ? Number(value) : Number.NaN;
  if (!(n >= 1 && n <= KEEP_MAX_HOURS))
    throw new InvalidArgumentError(
      `--keep must be a whole number of hours from 1 to ${KEEP_MAX_HOURS}.`,
    );
  return n;
}

/**
 * A word a person typed, as a printed command carries it: through `shellWord`, and quoted when it
 * would end the line in a full stop (`n8n.example.com.` is its own host, and a closing dot reads as
 * the sentence's).
 */
function typed(value: string): string {
  const word = shellWord(value);
  return word.endsWith('.') && !word.startsWith("'") ? `'${value}'` : word;
}

/** The clause naming where an invalid master key came from. */
function sourceName(source: 'env' | 'env_file' | 'home_file', homeFile: string): string {
  if (source === 'env') return 'REALM_ENCRYPTION_KEY';
  if (source === 'env_file') return 'the file REALM_ENCRYPTION_KEY_FILE names';
  return homeFile;
}

/** Words 5: an invalid master key source, with its own reason. */
function invalidLine(
  res: Extract<MasterKeyResolution, { state: 'invalid' }>,
  env: Readonly<Record<string, string | undefined>>,
  homeFile: string,
): string {
  const named = env['REALM_ENCRYPTION_KEY_FILE'];
  const reason =
    res.source === 'env_file' && named !== undefined && !isAbsolute(named)
      ? 'its path is not absolute'
      : res.reason === 'empty'
        ? 'it is empty'
        : res.reason === 'unreadable_file'
          ? 'it cannot be read'
          : 'it is not 64 hexadecimal characters';
  return (
    `Error: ${sourceName(res.source, homeFile)} is not a master key: ${reason}. ${NOTHING} ` +
    'A master key is 64 hexadecimal characters. Make one with: openssl rand -hex 32'
  );
}

/** The fingerprint of the master key the home file holds (it parses: the resolver said so). */
function homeFileFp(homeFile: string): string {
  const key = parseMasterKey(readFileSync(homeFile, 'utf8'));
  if (key === undefined) throw new Error(`${homeFile} stopped holding a master key while this ran`);
  return masterKeyFingerprint(key);
}

/** Runs `realm callback key` (see the module comment): the exit code, every line already printed. */
export async function callbackKey(
  args: CallbackKeyArgs,
  deps: CallbackKeyDeps = CALLBACK_KEY_DEPS,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<0 | 1> {
  const say = (line: string): void => console.error(line);
  const fail = (line: string): 1 => {
    console.error(line);
    return 1;
  };

  // ---- the flag checks, in order; the first that applies is the only one said ----
  if ([args.rotate, args.replace, args.delete].filter((f) => f === true).length > 1)
    return fail('Error: --rotate, --replace and --delete cannot be used together; give one.');
  if (args.endPrevious === true && (args.replace === true || args.delete === true))
    return fail(
      'Error: --end-previous goes with --rotate, or alone; it cannot be used with --replace or --delete.',
    );
  if (args.keep !== undefined && args.rotate !== true)
    return fail('Error: --keep is used with --rotate only.');
  const dropOnly = args.delete === true || (args.endPrevious === true && args.rotate !== true);
  if (args.whsec === true && dropOnly)
    return fail(
      'Error: --whsec chooses how a key is printed; --delete and --end-previous print no key.',
    );

  // ---- the entry, the workflow, and whether it takes callbacks ----
  const parsed = parseCallbackEntry(args.host);
  if (!parsed.ok) {
    const quoted = parsed.word === 'userinfo' ? '' : ` ${JSON.stringify(args.host)}`;
    return fail(
      `Error: --host${quoted} is not a receiver address: ${entryRefusalPhrase(parsed.word)}. ` +
        'Give a host name or address, with a port if it is not 443: n8n.example.com, or ' +
        'http://n8n.lan:5678 for a receiver on plain http.',
    );
  }
  const H = callbackEntryLabel(parsed.entry);
  const filePath = resolveWorkflowFile(args.workflow ?? '.');
  let W: string;
  let takesCallbacks: boolean;
  try {
    const definition = loadWorkflowFromFile(filePath);
    W = definition.id;
    takesCallbacks = definition.trigger?.result_map !== undefined;
  } catch (err) {
    return fail(
      `Error: failed to load workflow '${filePath}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const cmd =
    'realm callback key' +
    (args.workflow !== undefined ? ` ${typed(args.workflow)}` : '') +
    ` --host ${typed(args.host)}`;
  const pair = `${W} → ${H}`;
  if (!dropOnly && !takesCallbacks)
    return fail(
      `Error: workflow '${W}' does not take callbacks: its trigger has no result_map, and Realm ` +
        'answers a callback address only for a workflow that has one, so a key for it would never ' +
        `be used. ${NOTHING} Add a result_map to its trigger, then run this command again. A key ` +
        `made earlier is removed with: ${cmd} --delete`,
    );

  const keysOf = (home: CliHome): CallbackKeyStore | undefined => home.runStore.callbacks?.keys;
  const noKeys = "Error: this Realm home's store keeps no callback keys.";

  // ---- --end-previous alone and --delete: no master key, no sealer, no opt-in ----
  if (dropOnly) {
    const home = await deps.openHome({});
    try {
      const keys = keysOf(home);
      if (keys === undefined) return fail(noKeys);
      if (args.delete === true) {
        const { had_current } = await keys.delete(W, H);
        say(
          had_current
            ? `Deleted the keys for ${pair}.`
            : `There were no keys for ${pair}; nothing changed.`,
        );
      } else {
        const ended = await keys.endPrevious(W, H);
        say(
          ended.ended
            ? `Ended the previous key for ${pair}.`
            : `No previous key was in use for ${pair}; nothing changed.`,
        );
      }
      return 0;
    } finally {
      await home.close();
    }
  }

  // ---- the master key: found, none or invalid ----
  const homeDir = realmHomePath();
  const homeFile = join(homeDir, MASTER_KEY_FILE);
  let res = resolveMasterKey({ env, homeDir });
  if (res.state === 'invalid') return fail(invalidLine(res, env, homeFile));
  let sealer: ReturnType<typeof createCallbackKeySealer> | undefined;
  /** Takes a found master key: declared to the writer, one sealer for every open, Words 8 once. */
  const take = (found: Extract<MasterKeyResolution, { state: 'found' }>): void => {
    declareMasterKey(found.key);
    sealer = createCallbackKeySealer(found.key);
    if (found.mode_wider_than_owner === true) {
      const path = found.source === 'env_file' ? env['REALM_ENCRYPTION_KEY_FILE']! : homeFile;
      const mode = (statSync(path).mode & 0o7777).toString(8).padStart(4, '0');
      say(
        `Warning: ${path} is open to other users (mode ${mode}). Fix that with: chmod 600 ${typed(path)}`,
      );
    }
  };
  if (res.state === 'found') take(res);
  /** Words 7 / 9: the setting and the home file hold different master keys. */
  const disagree = (): string | undefined => {
    if (res.state !== 'found' || res.differs_from_home_file !== true) return undefined;
    const src =
      res.source === 'env' ? 'REALM_ENCRYPTION_KEY' : 'the file REALM_ENCRYPTION_KEY_FILE names';
    return `${src} gives encryption key ${res.fp}, but ${homeFile} holds encryption key ${homeFileFp(homeFile)}.`;
  };
  const refuseDisagree = (): 1 | undefined => {
    const clash = disagree();
    if (clash === undefined) return undefined;
    return fail(
      `Error: ${clash.slice(0, -1)}. Keys written now would be unreadable to a process that uses ` +
        `the file. ${NOTHING} Unset the setting or make the file match, then run this command again.`,
    );
  };
  /** Words 6c / 6d / damaged: the current key cannot be read. */
  const unreadableLine = (slot: Extract<CallbackKeySlot, { state: 'unreadable' }>): string => {
    if (res.state !== 'found')
      return (
        `Error: the key for ${pair} was sealed with encryption key ${slot.master_fp}; this shell has ` +
        `no master key. ${NOTHING} Set the master key it was sealed with, or run this command with ` +
        `--replace to make a new key and a new master key file ${homeFile} (the receiver then needs ` +
        'the new key).'
      );
    if (slot.master_fp === res.fp)
      return (
        `Error: the key for ${pair} cannot be read although it was sealed with this encryption key ` +
        `(${res.fp}); it is damaged. ${NOTHING} Run this command with --replace to make a new key ` +
        '(the receiver then needs the new key).'
      );
    return (
      `Error: the key for ${pair} was sealed with encryption key ${slot.master_fp}; this process has ` +
      `${res.fp}. ${NOTHING} Set the master key it was sealed with, or run this command with ` +
      '--replace to make a new key (the receiver then needs the new key).'
    );
  };
  /** Prints a key on stdout, as given or in its `whsec_` form. */
  const printKey = (text: string): 0 => {
    console.log(
      args.whsec === true ? `whsec_${Buffer.from(text, 'utf8').toString('base64')}` : text,
    );
    return 0;
  };

  let home = await deps.openHome(sealer !== undefined ? { sealer } : {});
  try {
    let keys = keysOf(home);
    if (keys === undefined) return fail(noKeys);
    /** Takes the master key just found, and reopens the home with its sealer (one per home). */
    const reopenWith = async (found: Extract<MasterKeyResolution, { state: 'found' }>) => {
      take(found);
      await home.close();
      home = await deps.openHome({ sealer: sealer! });
      keys = keysOf(home);
    };
    /** Step 4: makes the master key file (never over anything), then reopens with its sealer. */
    const makeMaster = async (): Promise<1 | undefined> => {
      let placed: 'placed' | 'exists';
      try {
        placed = deps.placeMasterKeyFile(homeDir);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? 'unknown error';
        return fail(`Error: could not make the master key file ${homeFile}: ${code}. ${NOTHING}`);
      }
      if (placed === 'placed')
        say(
          `Made the master key file ${homeFile}. Keep a copy of it somewhere safe: 'realm db backup' ` +
            'does not copy it, and a backup without it cannot read the stored keys.',
        );
      // 'placed' or 'exists' (another process made it first): read what is there, never replace it.
      res = resolveMasterKey({ env, homeDir });
      if (res.state === 'invalid') return fail(invalidLine(res, env, homeFile));
      if (res.state !== 'found')
        throw new Error(`${homeFile} was placed but reads as no master key`);
      await reopenWith(res);
      return keys === undefined ? fail(noKeys) : undefined;
    };
    const sealedWith = (): string => (res.state === 'found' ? res.fp : '?');

    let first = await keys!.read(W, H);
    // Correction 1: another process may have made the master key and this pair's key since step 2.
    // It places the file before it commits any pair, so a key here that cannot be read, with no
    // master key read, means the master key is read once more; found, the pair is read again.
    if (res.state === 'none' && first.current?.state === 'unreadable') {
      res = resolveMasterKey({ env, homeDir });
      if (res.state === 'invalid') return fail(invalidLine(res, env, homeFile));
      if (res.state === 'found') {
        await reopenWith(res);
        if (keys === undefined) return fail(noKeys);
        first = await keys!.read(W, H);
      }
    }
    const current = first.current;

    // ---- --rotate ----
    if (args.rotate === true) {
      const noneToRotate = `Error: there is no key for ${pair} to rotate. ${NOTHING} Make one first with: ${cmd}`;
      if (current === undefined) return fail(noneToRotate);
      if (current.state === 'unreadable') return fail(unreadableLine(current));
      const clash = refuseDisagree();
      if (clash !== undefined) return clash;
      const r = await keys!.rotate(W, H, {
        candidate: deps.randomKey(),
        keepSeconds: (args.keep ?? KEEP_DEFAULT_HOURS) * 3600,
        ...(args.endPrevious === true ? { endPrevious: true } : {}),
      });
      if (!r.applied) {
        if (r.reason !== 'previous_live') {
          // A race since the read: the current is gone, or now cannot be read.
          const now = (await keys!.read(W, H)).current;
          return fail(now?.state === 'unreadable' ? unreadableLine(now) : noneToRotate);
        }
        const until = first.previous?.expires_at;
        return fail(
          until !== undefined
            ? `Error: the previous key for ${pair} is still valid until ${until} (UTC); rotating now ` +
                `would end it. ${NOTHING} Wait for that, or add --end-previous to end it now.`
            : `Error: the previous key for ${pair} is still in its overlap; rotating now would end ` +
                `it. ${NOTHING} Wait for it to end, or add --end-previous to end it now.`,
        );
      }
      if (r.current.state !== 'readable' || r.previous.state !== 'readable')
        throw new Error('a rotated key reads back unreadable');
      say(
        `Rotated the key for ${pair}: new key ${r.current.key_fp}, sealed with encryption key ` +
          `${sealedWith()}. Receivers that still hold the old key (${r.previous.key_fp}) keep working ` +
          `until ${r.previous.expires_at} (UTC) if they check every signature in the header. To end ` +
          `that sooner, run: ${cmd} --end-previous`,
      );
      return printKey(r.current.key);
    }

    // ---- --replace ----
    if (args.replace === true) {
      const none = `Error: there is no key for ${pair} to replace. ${NOTHING} Make one with: ${cmd}`;
      const readable =
        `Error: the key for ${pair} can be read, so it was not replaced (--replace is for a key ` +
        `that cannot be read). ${NOTHING} To change a working key, use --rotate.`;
      if (current === undefined) return fail(none);
      if (current.state === 'readable') return fail(readable);
      if (res.state !== 'found') {
        const stop = await makeMaster();
        if (stop !== undefined) return stop;
      }
      const clash = refuseDisagree();
      if (clash !== undefined) return clash;
      const r = await keys!.replace(W, H, deps.randomKey());
      if (!r.applied) return fail(r.reason === 'no_current' ? none : readable);
      if (r.key.state !== 'readable') throw new Error('a replaced key reads back unreadable');
      say(
        `Replaced the key for ${pair}, which could not be read: new key ${r.key.key_fp}, sealed with ` +
          `encryption key ${sealedWith()}. Paste the new key into the receiver.`,
      );
      return printKey(r.key.key);
    }

    // ---- print, or make ----
    if (current?.state === 'readable') {
      const clash = disagree();
      if (clash !== undefined) say(`Warning: ${clash}`);
      say(`Key for ${pair}: key ${current.key_fp}, sealed with encryption key ${sealedWith()}.`);
      return printKey(current.key);
    }
    if (current?.state === 'unreadable') return fail(unreadableLine(current));
    if (res.state !== 'found') {
      const listing = await keys!.list();
      if (listing.length > 0) {
        // Another process may have placed the master key since: it places the file before it
        // commits any pair, so a pair listed with no master key here is read once more.
        res = resolveMasterKey({ env, homeDir });
        if (res.state === 'invalid') return fail(invalidLine(res, env, homeFile));
        if (res.state === 'found') {
          await reopenWith(res);
          if (keys === undefined) return fail(noKeys);
        } else {
          const fps = [
            ...new Set(
              listing.flatMap((e) =>
                [e.current, e.previous].flatMap((s) =>
                  s?.state === 'unreadable' ? [s.master_fp] : [],
                ),
              ),
            ),
          ];
          const shown = listing.slice(0, 5).map((e) => `${e.workflow_id} → ${e.host}`);
          const more = listing.length > 5 ? ` and ${listing.length - 5} more` : '';
          const first = listing[0]!;
          return fail(
            `Error: this shell has no master key, and this home holds keys sealed with encryption ` +
              `key ${fps.join(', ')}: ${shown.join(', ')}${more}. Set REALM_ENCRYPTION_KEY or ` +
              `REALM_ENCRYPTION_KEY_FILE to the key they were sealed with, or restore ${homeFile}. If ` +
              'it is lost, make a new master key by running this command with --replace for one of ' +
              `them (the workflow file whose id is ${first.workflow_id}, if it still takes callbacks, ` +
              `with --host ${first.host}), or remove them with --delete; every key made under the old ` +
              `one then needs its own --replace. ${NOTHING}`,
          );
        }
      } else {
        const stop = await makeMaster();
        if (stop !== undefined) return stop;
      }
    }
    const clash = refuseDisagree();
    if (clash !== undefined) return clash;
    const made = await keys!.make(W, H, deps.randomKey());
    if (made.key.state === 'unreadable') return fail(unreadableLine(made.key));
    say(
      made.created
        ? `Made a key for ${pair} (key ${made.key.key_fp}), sealed with encryption key ${sealedWith()}.`
        : `Key for ${pair}: key ${made.key.key_fp}, sealed with encryption key ${sealedWith()}.`,
    );
    return printKey(made.key.key);
  } finally {
    await home.close();
  }
}

export const callbackKeyCommand = new Command('key')
  .description(
    'Print the key a receiver checks a callback signature with, making it first when there is none; or rotate, replace or delete it',
  )
  .argument('[workflow]', 'the workflow file, or its folder (default: .)')
  .requiredOption(
    '--host <entry>',
    'the receiver: its host name or address, with a port if it is not 443 (http:// for plain http)',
  )
  .option('--whsec', 'print the key as whsec_ and the base64 of its text')
  .option('--rotate', 'make a new key; the old one stays valid for --keep hours')
  .option(
    '--keep <hours>',
    'with --rotate: how long the old key stays valid, 1 to 168 (default 24)',
    parseKeepHours,
  )
  .option('--end-previous', 'end the old key now (alone, or with --rotate)')
  .option('--replace', 'make a new key when the stored one cannot be read')
  .option('--delete', 'remove the keys')
  .action(async (workflow: string | undefined, opts: Omit<CallbackKeyArgs, 'workflow'>) => {
    const code = await callbackKey({ ...opts, ...(workflow !== undefined ? { workflow } : {}) });
    if (code === 1) process.exit(1);
  });
