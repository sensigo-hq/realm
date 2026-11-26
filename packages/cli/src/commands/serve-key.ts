// serve-key.ts — #625 PR-2b, named keys unit 1: `realm serve key add <name> [--expires …]`,
// `realm serve key list` and `realm serve key remove <name>`, the commands that give each caller of
// `realm serve` its own key, cut one off, and show them.
//
// The keys live in `<home>/serve-keys.json` (`lib/serve-keys.ts`), which holds each key's SHA-256 and
// never its text. Unit 2: `add` also takes a key's limits (`--read-only`, `--allow <tools>`,
// `--workflows <ids>`), and `list` shows them. `add` prints the new key once: stdout is exactly the key's text and one newline;
// everything else goes to stderr. Exit 0 on success, 1 on every refusal, as `realm callback key`.
// `add` and `remove` hold the home's `serve-keys.lock` (`takeServeKeysLock`) for their whole
// read–change–write, so no change of two commands at once is lost. `add` and `list` read the home's
// clock, so they open the store as other commands do (which creates the home and `realm.db`); `remove`
// needs no clock and never opens the store, so a key can be cut off even when the store cannot open.
// The bodies are functions taking their collaborators, so a cell can inject them.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { realmHomePath } from '@sensigo/realm';
import {
  SERVE_KEYS_LOCK_FILE,
  takeServeKeysLock,
  type ServeKeysLockResult,
} from '@sensigo/realm-store-sqlite';
import { Command } from 'commander';
import { reportExpectedRefusal } from '../lib/expected-refusal.js';
import { openCliHome, type CliHome } from '../lib/home.js';
import {
  escapedKeyName,
  isKeyName,
  keyEnded,
  keyFileOpenWarning,
  keyFingerprint,
  keyInstant,
  keyPath,
  newServeKey,
  readServeKeys,
  SERVE_KEY_TOOLS,
  serveKeysPath,
  ServeKeysWriteRefused,
  writeServeKeys,
  type ServeKeyEntry,
  type ServeKeyLimits,
  type ServeKeysRead,
} from '../lib/serve-keys.js';

/** The collaborators the key commands take (the real ones are {@link SERVE_KEY_DEPS}). */
export interface ServeKeyDeps {
  /** The Realm home's folder. */
  readonly home: () => string;
  readonly openHome: () => Promise<CliHome>;
  readonly takeLock: (home: string) => Promise<ServeKeysLockResult>;
}

export const SERVE_KEY_DEPS: ServeKeyDeps = {
  home: () => realmHomePath(),
  openHome: () => openCliHome(),
  takeLock: (home) => takeServeKeysLock(home),
};

const NOTHING = 'No key was changed.';
const MAX_DAYS = 3650;
const DAY_MS = 24 * 60 * 60 * 1000;

/** What `--expires` gave: a number of days, a last day (`YYYY-MM-DD`), or no end. */
type Expires = { days: number } | { through: string } | { never: true };

function parseExpires(value: string | undefined): Expires | undefined {
  if (value === undefined || value === 'never') return { never: true };
  if (/^[0-9]+$/.test(value)) {
    const days = Number(value);
    return days >= 1 && days <= MAX_DAYS ? { days } : undefined;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const ms = Date.parse(`${value}T00:00:00.000Z`);
    if (Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value) {
      return { through: value };
    }
  }
  return undefined;
}

/** What `add`'s limit options gave (unit 2); each list as typed, comma-separated. */
export interface ServeKeyLimitFlags {
  readonly readOnly?: boolean;
  readonly allow?: string;
  readonly workflows?: string;
}

/** A comma-separated option's items, each trimmed, or `null` when one is empty. */
function itemsOf(value: string): string[] | null {
  const items = value.split(',').map((item) => item.trim());
  return items.some((item) => item === '') ? null : items;
}

/** The limits the options give (none: `{}`), or the refusal line. */
function limitsOfFlags(
  flags: ServeKeyLimitFlags,
): { limits?: ServeKeyLimits } | { refusal: string } {
  const readOnly = flags.readOnly === true;
  if (readOnly && flags.allow !== undefined) {
    return { refusal: `Error: --read-only and --allow cannot be used together. ${NOTHING}` };
  }
  const tools = flags.allow === undefined ? undefined : itemsOf(flags.allow);
  if (tools === null) return { refusal: `Error: --allow has an empty item. ${NOTHING}` };
  const workflows = flags.workflows === undefined ? undefined : itemsOf(flags.workflows);
  if (workflows === null) return { refusal: `Error: --workflows has an empty item. ${NOTHING}` };
  const unknown = tools?.find((tool) => !SERVE_KEY_TOOLS.includes(tool));
  if (unknown !== undefined) {
    return {
      refusal: `Error: --allow names '${escapedKeyName(unknown)}', which is not a tool realm serve offers. ${NOTHING} Its tools: ${SERVE_KEY_TOOLS.join(', ')}.`,
    };
  }
  // A key that could never call what its list names (the call is refused under --workflows).
  if (tools?.includes('create_workflow') === true && workflows !== undefined) {
    return {
      refusal: `Error: --allow names create_workflow, which a key with --workflows cannot use. ${NOTHING}`,
    };
  }
  if (!readOnly && tools === undefined && workflows === undefined) return {};
  return {
    limits: {
      ...(readOnly ? { read_only: true as const } : {}),
      ...(tools !== undefined ? { tools } : {}),
      ...(workflows !== undefined ? { workflows } : {}),
    },
  };
}

/** A key's limits as `list` prints them: `limits: read-only; workflows invoices`. */
function limitsWords(limits: ServeKeyLimits): string {
  const parts = [
    ...(limits.read_only === true ? ['read-only'] : []),
    ...(limits.tools !== undefined ? [`tools ${limits.tools.join(', ')}`] : []),
    ...(limits.workflows !== undefined
      ? [`workflows ${limits.workflows.map(escapedKeyName).join(', ')}`]
      : []),
  ];
  return `limits: ${parts.join('; ')}`;
}

/** The refusal for a key file that cannot be used (`list`'s form has no "No key was changed."). */
function cannotReadLine(path: string, cause: string, changing: boolean): string {
  return (
    `Error: ${keyPath(path)} cannot be read (${cause}).` +
    `${changing ? ` ${NOTHING}` : ''} Fix the file, or delete it to remove every key.`
  );
}

/** The refusal for a lock that could not be taken. */
function lockRefusal(
  home: string,
  path: string,
  lock: Exclude<ServeKeysLockResult, { taken: unknown }>,
): string {
  return 'busy' in lock
    ? `Error: another 'realm serve key' command is changing ${keyPath(path)}. ${NOTHING} Try again.`
    : `Error: ${keyPath(join(home, SERVE_KEYS_LOCK_FILE))} cannot be opened (${lock.failed}). ${NOTHING}`;
}

/** The mode warning, when the file is still open to other users as the command ends. */
function warnIfOpen(path: string, read: ServeKeysRead): void {
  if (read.state !== 'absent' && read.openMode !== undefined) {
    console.error(keyFileOpenWarning(path, read.openMode));
  }
}

/** Correction 1: the mode warning after a refusal that did not read the file, from a fresh read. */
function warnFileIfOpen(path: string): void {
  warnIfOpen(path, readServeKeys(path));
}

/** The same, for a refusal before the home is known: no warning when the home cannot be named. */
function warnHomeFileIfOpen(deps: ServeKeyDeps): void {
  let path: string;
  try {
    path = serveKeysPath(deps.home());
  } catch {
    return;
  }
  warnFileIfOpen(path);
}

/** The guard's refusal: a new file the reader would refuse was not written (correction 1). */
function writeRefusedLine(path: string, err: ServeKeysWriteRefused): string {
  return `Error: ${keyPath(path)} was not changed: the new key file would not be valid (${err.keyFileCause}). ${NOTHING}`;
}

/**
 * The home's store, or the house refusal printed (as the CLI's entry prints it) and the mode warning
 * after it (correction 1): `undefined` then. An unexpected error stays loud.
 */
async function openHomeOrRefuse(deps: ServeKeyDeps): Promise<CliHome | undefined> {
  try {
    return await deps.openHome();
  } catch (err) {
    if (!reportExpectedRefusal(err)) throw err;
    warnHomeFileIfOpen(deps);
    return undefined;
  }
}

/** Runs `realm serve key add` (see the module comment): the exit code, every line already printed. */
export async function serveKeyAdd(
  name: string,
  expiresFlag: string | undefined,
  deps: ServeKeyDeps = SERVE_KEY_DEPS,
  limitFlags: ServeKeyLimitFlags = {},
): Promise<0 | 1> {
  if (!isKeyName(name)) {
    console.error(
      `Error: '${escapedKeyName(name)}' is not a key name: use 1 to 64 characters from a-z, 0-9, '.', '_' and '-', starting with a letter or a digit. ${NOTHING}`,
    );
    warnHomeFileIfOpen(deps);
    return 1;
  }
  const expires = parseExpires(expiresFlag);
  const badExpires = `Error: --expires takes a number of days from 1 to ${MAX_DAYS}, a date after today and at most ${MAX_DAYS} days ahead (YYYY-MM-DD) or 'never'. ${NOTHING}`;
  if (expires === undefined) {
    console.error(badExpires);
    warnHomeFileIfOpen(deps);
    return 1;
  }
  const limited = limitsOfFlags(limitFlags);
  if ('refusal' in limited) {
    console.error(limited.refusal);
    warnHomeFileIfOpen(deps);
    return 1;
  }
  const home = await openHomeOrRefuse(deps);
  if (home === undefined) return 1;
  try {
    // The home's clock, read once: the key's making, and a last day judged on the UTC calendar: after
    // today, and at most MAX_DAYS days ahead (as many days as `--expires 3650`), so no date can make
    // an end the file's own rule refuses.
    const now = home.runStore.clock.now();
    const path = serveKeysPath(home.path);
    const today = now.toISOString().slice(0, 10);
    const horizon = new Date(Date.parse(`${today}T00:00:00.000Z`) + MAX_DAYS * DAY_MS)
      .toISOString()
      .slice(0, 10);
    if ('through' in expires && (expires.through <= today || expires.through > horizon)) {
      console.error(badExpires);
      warnFileIfOpen(path);
      return 1;
    }
    const lock = await deps.takeLock(home.path);
    if (!('taken' in lock)) {
      console.error(lockRefusal(home.path, path, lock));
      warnFileIfOpen(path);
      return 1;
    }
    let read: ServeKeysRead;
    let text: string;
    try {
      read = readServeKeys(path);
      if (read.state === 'invalid') {
        console.error(cannotReadLine(path, read.cause, true));
        warnIfOpen(path, read);
        return 1;
      }
      const keys = read.state === 'valid' ? read.keys : [];
      if (keys.some((k) => k.name === name)) {
        console.error(
          `Error: a key named '${name}' already exists. ${NOTHING} Remove it first with 'realm serve key remove ${name}', or choose another name.`,
        );
        warnIfOpen(path, read);
        return 1;
      }
      text = newServeKey();
      const entry: ServeKeyEntry = {
        name,
        sha256: keyFingerprint(text),
        created_at: now.toISOString(),
        expires_at:
          'days' in expires
            ? new Date(now.getTime() + expires.days * DAY_MS).toISOString()
            : 'through' in expires
              ? new Date(Date.parse(`${expires.through}T00:00:00.000Z`) + DAY_MS).toISOString()
              : null,
        ...(limited.limits !== undefined ? { limits: limited.limits } : {}),
      };
      try {
        writeServeKeys(home.path, [...keys, entry]);
      } catch (err) {
        if (!(err instanceof ServeKeysWriteRefused)) throw err;
        console.error(writeRefusedLine(path, err));
        warnFileIfOpen(path);
        return 1;
      }
      console.log(text);
      console.error(
        `Added key '${name}' to ${keyPath(path)}. It is shown only now: keep it where its caller can read it. ${
          entry.expires_at === null
            ? 'It does not end.'
            : `It works until ${keyInstant(entry.expires_at)}.`
        }`,
      );
      return 0;
    } finally {
      lock.taken.release();
    }
  } finally {
    await home.close();
  }
}

/** Runs `realm serve key list`: one line per key, in name order. */
export async function serveKeyList(deps: ServeKeyDeps = SERVE_KEY_DEPS): Promise<0 | 1> {
  const home = await openHomeOrRefuse(deps);
  if (home === undefined) return 1;
  try {
    const now = home.runStore.clock.now();
    const path = serveKeysPath(home.path);
    const read = readServeKeys(path);
    if (read.state === 'invalid') {
      console.error(cannotReadLine(path, read.cause, false));
      warnIfOpen(path, read);
      return 1;
    }
    const keys = read.state === 'valid' ? [...read.keys] : [];
    if (keys.length === 0) {
      console.log("No named keys. Add one with 'realm serve key add <name>'.");
    } else {
      keys.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const key of keys) {
        const end =
          key.expires_at === null
            ? 'does not end'
            : `works until ${keyInstant(key.expires_at)}${keyEnded(key, now) ? ' (ended)' : ''}`;
        const limits = key.limits !== undefined ? `  ${limitsWords(key.limits)}` : '';
        console.log(`${key.name}  made ${keyInstant(key.created_at)}  ${end}${limits}`);
      }
    }
    warnIfOpen(path, read);
    return 0;
  } finally {
    await home.close();
  }
}

/** Runs `realm serve key remove`: the key is refused from the next request on. */
export async function serveKeyRemove(
  name: string,
  deps: ServeKeyDeps = SERVE_KEY_DEPS,
): Promise<0 | 1> {
  const unknown = `Error: no key named '${escapedKeyName(name)}'. ${NOTHING} See the keys with 'realm serve key list'.`;
  const homeDir = deps.home();
  const path = serveKeysPath(homeDir);
  // No home folder or no key file: nothing to remove, and no lock is taken.
  if (!existsSync(homeDir) || !existsSync(path)) {
    console.error(unknown);
    return 1;
  }
  const lock = await deps.takeLock(homeDir);
  if (!('taken' in lock)) {
    console.error(lockRefusal(homeDir, path, lock));
    warnFileIfOpen(path);
    return 1;
  }
  try {
    const read = readServeKeys(path);
    if (read.state === 'invalid') {
      console.error(cannotReadLine(path, read.cause, true));
      warnIfOpen(path, read);
      return 1;
    }
    const keys = read.state === 'valid' ? read.keys : [];
    if (!keys.some((k) => k.name === name)) {
      console.error(unknown);
      warnIfOpen(path, read);
      return 1;
    }
    try {
      writeServeKeys(
        homeDir,
        keys.filter((k) => k.name !== name),
      );
    } catch (err) {
      if (!(err instanceof ServeKeysWriteRefused)) throw err;
      console.error(writeRefusedLine(path, err));
      warnFileIfOpen(path);
      return 1;
    }
    console.error(`Removed key '${name}'. A request with it is refused from now on.`);
    return 0;
  } finally {
    lock.taken.release();
  }
}

/** Adds `realm serve key …` to a `serve` command (realm's own; never the shared one realm-cloud adds). */
export function addServeKeyCommands(serve: Command): void {
  const key = serve
    .command('key')
    .description(
      "Manage the named keys callers of 'realm serve' send beside REALM_SERVE_TOKEN or in its place",
    );
  key
    .command('add <name>')
    .description('Make a key for one caller and print it once')
    .option(
      '--expires <when>',
      "when the key ends: a number of days (1 to 3650), a last day (YYYY-MM-DD) or 'never' (the default)",
    )
    .option('--read-only', 'the key may call only the reading tools')
    .option('--allow <tools>', 'the key may call only these tools (comma-separated)')
    .option(
      '--workflows <ids>',
      'the key may reach only these workflows and their runs (comma-separated)',
    )
    .action(
      async (
        name: string,
        opts: { expires?: string; readOnly?: boolean; allow?: string; workflows?: string },
      ) => {
        const flags: ServeKeyLimitFlags = {
          ...(opts.readOnly === true ? { readOnly: true } : {}),
          ...(opts.allow !== undefined ? { allow: opts.allow } : {}),
          ...(opts.workflows !== undefined ? { workflows: opts.workflows } : {}),
        };
        if ((await serveKeyAdd(name, opts.expires, SERVE_KEY_DEPS, flags)) === 1) process.exit(1);
      },
    );
  key
    .command('list')
    .description('Show each key: its name, when it was made, when it ends and its limits')
    .action(async () => {
      if ((await serveKeyList()) === 1) process.exit(1);
    });
  key
    .command('remove <name>')
    .description('Cut a key off: a request with it is refused from the next request on')
    .action(async (name: string) => {
      if ((await serveKeyRemove(name)) === 1) process.exit(1);
    });
}
