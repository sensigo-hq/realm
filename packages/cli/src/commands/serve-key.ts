// serve-key.ts — #625 PR-2b, named keys unit 1: `realm serve key add <name> [--expires …]`,
// `realm serve key list` and `realm serve key remove <name>`, the commands that give each caller of
// `realm serve` its own key, cut one off, and show them.
//
// The keys live in `<home>/serve-keys.json` (`lib/serve-keys.ts`), which holds each key's SHA-256 and
// never its text. `add` prints the new key once: stdout is exactly the key's text and one newline;
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
  serveKeysPath,
  writeServeKeys,
  type ServeKeyEntry,
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

/** Runs `realm serve key add` (see the module comment): the exit code, every line already printed. */
export async function serveKeyAdd(
  name: string,
  expiresFlag: string | undefined,
  deps: ServeKeyDeps = SERVE_KEY_DEPS,
): Promise<0 | 1> {
  if (!isKeyName(name)) {
    console.error(
      `Error: '${escapedKeyName(name)}' is not a key name: use 1 to 64 characters from a-z, 0-9, '.', '_' and '-', starting with a letter or a digit. ${NOTHING}`,
    );
    return 1;
  }
  const expires = parseExpires(expiresFlag);
  const badExpires = `Error: --expires takes a number of days from 1 to ${MAX_DAYS}, a date after today (YYYY-MM-DD) or 'never'. ${NOTHING}`;
  if (expires === undefined) {
    console.error(badExpires);
    return 1;
  }
  const home = await deps.openHome();
  try {
    // The home's clock: the key's making, and a last day judged against today, UTC.
    const now = home.runStore.clock.now();
    if ('through' in expires && expires.through <= now.toISOString().slice(0, 10)) {
      console.error(badExpires);
      return 1;
    }
    const path = serveKeysPath(home.path);
    const lock = await deps.takeLock(home.path);
    if (!('taken' in lock)) {
      console.error(lockRefusal(home.path, path, lock));
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
      };
      writeServeKeys(home.path, [...keys, entry]);
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
  const home = await deps.openHome();
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
        console.log(`${key.name}  made ${keyInstant(key.created_at)}  ${end}`);
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
    writeServeKeys(
      homeDir,
      keys.filter((k) => k.name !== name),
    );
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
      "Manage the named keys callers of 'realm serve' send in place of REALM_SERVE_TOKEN",
    );
  key
    .command('add <name>')
    .description('Make a key for one caller and print it once')
    .option(
      '--expires <when>',
      "when the key ends: a number of days (1 to 3650), a last day (YYYY-MM-DD) or 'never' (the default)",
    )
    .action(async (name: string, opts: { expires?: string }) => {
      if ((await serveKeyAdd(name, opts.expires)) === 1) process.exit(1);
    });
  key
    .command('list')
    .description('Show each key: its name, when it was made and when it ends')
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
