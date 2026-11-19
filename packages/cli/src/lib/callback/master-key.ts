// master-key.ts — callback K1 (R1.3; the callback design rev 4 §1.5, owner 896326ed): the master key
// the callback signing keys are sealed under, and where it is read from. READ-ONLY: it never writes or
// creates a file and never prints a key (generating `<home>/encryption.key` is unit K2's).
//
// Its text form is 64 hexadecimal characters (32 bytes), never a passphrase: a copied file would let a
// passphrase be guessed offline. The sources, in order, the first that is SET winning; a set source
// that is invalid does not fall through:
//   1. `REALM_ENCRYPTION_KEY` (an empty or all-whitespace value counts as unset);
//   2. the file `REALM_ENCRYPTION_KEY_FILE` names (an absolute path; the same rule for its value);
//   3. `<home>/encryption.key`, absent exactly when it has no directory entry (`lstat` answers
//      ENOENT): an entry that cannot be read, a dangling link included, is not absent.
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { masterKeyFingerprint } from '@sensigo/realm-store-sqlite';

/** The master key file in the Realm home. */
export const MASTER_KEY_FILE = 'encryption.key';

/** The closed words an invalid source is reported with (K2 prints them). */
export const MASTER_KEY_INVALID_REASONS = ['malformed', 'empty', 'unreadable_file'] as const;
export type MasterKeyInvalidReason = (typeof MASTER_KEY_INVALID_REASONS)[number];

export type MasterKeySource = 'env' | 'env_file' | 'home_file';

/** What the resolver found. A `found` result's `key` is not enumerable: a log of it never carries it. */
export type MasterKeyResolution =
  | {
      readonly state: 'found';
      readonly key: Uint8Array;
      readonly source: MasterKeySource;
      readonly fp: string;
      /** The home file exists, parses and has another fingerprint (the source is the environment). */
      readonly differs_from_home_file?: true;
      /** POSIX: the file the key came from can be read by others than its owner. */
      readonly mode_wider_than_owner?: true;
    }
  | { readonly state: 'none' }
  | {
      readonly state: 'invalid';
      readonly source: MasterKeySource;
      readonly reason: MasterKeyInvalidReason;
    };

/**
 * A master key's text form, parsed: exactly 64 hexadecimal characters (either case), after removing
 * one trailing `\n` or `\r\n`; anything else is `undefined`.
 */
export function parseMasterKey(text: string): Uint8Array | undefined {
  const body = text.endsWith('\r\n')
    ? text.slice(0, -2)
    : text.endsWith('\n')
      ? text.slice(0, -1)
      : text;
  return /^[0-9a-fA-F]{64}$/.test(body) ? new Uint8Array(Buffer.from(body, 'hex')) : undefined;
}

/** A file's text, or why it cannot be had. */
type FileRead = { readonly text: string } | { readonly unreadable: true };

function readKeyFile(path: string): FileRead {
  try {
    return { text: readFileSync(path, 'utf8') };
  } catch {
    return { unreadable: true };
  }
}

/** The key a file's text holds, or why it does not hold one. */
function keyOfFile(read: FileRead): Uint8Array | MasterKeyInvalidReason {
  if ('unreadable' in read) return 'unreadable_file';
  if (read.text === '' || read.text === '\n' || read.text === '\r\n') return 'empty';
  return parseMasterKey(read.text) ?? 'malformed';
}

const isSet = (value: string | undefined): value is string =>
  value !== undefined && value.trim() !== '';

/** Whether a file can be read by others than its owner (POSIX only). */
function widerThanOwner(path: string): boolean {
  if (process.platform === 'win32') return false;
  try {
    return (statSync(path).mode & 0o077) !== 0;
  } catch {
    return false;
  }
}

/** The home file's text, or `undefined` when it has no directory entry. */
function readHomeFile(path: string): FileRead | undefined {
  try {
    lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return { unreadable: true };
  }
  return readKeyFile(path);
}

/** A `found` result whose `key` is a non-enumerable property. */
function found(
  key: Uint8Array,
  source: MasterKeySource,
  extra: { differs?: boolean; wide?: boolean },
): MasterKeyResolution {
  const result = {
    state: 'found' as const,
    source,
    fp: masterKeyFingerprint(key),
    ...(extra.differs === true ? { differs_from_home_file: true as const } : {}),
    ...(extra.wide === true ? { mode_wider_than_owner: true as const } : {}),
  };
  Object.defineProperty(result, 'key', { value: key, enumerable: false });
  return result as MasterKeyResolution;
}

/**
 * Resolves the master key (see the module comment). Reads the environment and at most two files;
 * writes nothing.
 */
export function resolveMasterKey(o: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
}): MasterKeyResolution {
  const homePath = join(o.homeDir, MASTER_KEY_FILE);
  /** Whether the home file holds a key of another fingerprint (anything else sets nothing). */
  const homeDiffers = (fp: string): boolean => {
    const home = readHomeFile(homePath);
    const key = home === undefined ? undefined : keyOfFile(home);
    return key instanceof Uint8Array && masterKeyFingerprint(key) !== fp;
  };
  const value = o.env['REALM_ENCRYPTION_KEY'];
  if (isSet(value)) {
    const key = parseMasterKey(value);
    if (key === undefined) return { state: 'invalid', source: 'env', reason: 'malformed' };
    return found(key, 'env', { differs: homeDiffers(masterKeyFingerprint(key)) });
  }
  const named = o.env['REALM_ENCRYPTION_KEY_FILE'];
  if (isSet(named)) {
    if (!isAbsolute(named)) return { state: 'invalid', source: 'env_file', reason: 'malformed' };
    const key = keyOfFile(readKeyFile(named));
    if (!(key instanceof Uint8Array)) return { state: 'invalid', source: 'env_file', reason: key };
    return found(key, 'env_file', {
      differs: homeDiffers(masterKeyFingerprint(key)),
      wide: widerThanOwner(named),
    });
  }
  const home = readHomeFile(homePath);
  if (home === undefined) return { state: 'none' };
  const key = keyOfFile(home);
  if (!(key instanceof Uint8Array)) return { state: 'invalid', source: 'home_file', reason: key };
  return found(key, 'home_file', { wide: widerThanOwner(homePath) });
}
