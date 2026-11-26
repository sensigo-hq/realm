// serve-keys.ts — #625 PR-2b, named keys unit 1: the key file `<home>/serve-keys.json`, which
// `realm serve key` writes and `realm serve` reads on every request the shared token does not settle.
//
// The file holds each key's name, the SHA-256 of its text, when it was made and when it ends; never
// the key's text, nor any part of it. Unit 2: a key may also carry its limits; then the file is
// format 2, and while no key has a limit it stays format 1, byte for byte as unit 1 wrote it. It is
// written whole, at 0600: a temporary file in the home, synced, then renamed over the old one, so a
// reader sees the old file or the new one, never a part.
// A file that breaks any rule below is invalid as a whole, and is described by a fixed cause word,
// never by the parser's message (which quotes the file's text).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { escapeShownString } from '@sensigo/realm';
import { writerCtx } from '../output/writer.js';
import { typedWord } from './callback/master-key-words.js';

/** The key file's name in a Realm home. */
export const SERVE_KEYS_FILE = 'serve-keys.json';

/** The key file of the Realm home `home`. */
export function serveKeysPath(home: string): string {
  return join(home, SERVE_KEYS_FILE);
}

/**
 * A key's limits (unit 2), a closed set: `read_only` (the reading tools only) or `tools` (only these
 * tools), and `workflows` (only these workflows and their runs). At least one member.
 */
export interface ServeKeyLimits {
  readonly read_only?: true;
  readonly tools?: readonly string[];
  readonly workflows?: readonly string[];
}

/** One key, as the file holds it. `expires_at` is `null` for a key with no end. */
export interface ServeKeyEntry {
  readonly name: string;
  readonly sha256: string;
  readonly created_at: string;
  readonly expires_at: string | null;
  /** Only in a format 2 file; absent for a key with no limit. */
  readonly limits?: ServeKeyLimits;
}

/**
 * The tools `realm serve` offers (`submit_human_response` under `--gate-answers permitted` only): the
 * names a key's `tools` may hold, in the order the refusals print them.
 */
export const SERVE_KEY_TOOLS: readonly string[] = [
  'list_workflows',
  'get_workflow_protocol',
  'start_run',
  'start_run_batch',
  'execute_step',
  'advance_run',
  'submit_human_response',
  'get_run_state',
  'abandon_run',
  'create_workflow',
  'append_trace',
];

/**
 * What a read of the key file found: no file; a file that cannot be used, with its cause word; or its
 * keys. `openMode` is the file's mode as four octal digits when it is open to other users (POSIX only).
 */
export type ServeKeysRead =
  | { readonly state: 'absent' }
  | { readonly state: 'invalid'; readonly cause: string; readonly openMode?: string }
  | {
      readonly state: 'valid';
      readonly keys: readonly ServeKeyEntry[];
      readonly openMode?: string;
    };

/** A key name: 1–64 characters from `a-z 0-9 . _ -`, starting with a letter or a digit. */
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const ENTRY_FIELDS = ['created_at', 'expires_at', 'name', 'sha256'];
const LIMITS_FIELDS = ['read_only', 'tools', 'workflows'];

/** Whether `name` passes the key-name rule. */
export function isKeyName(name: string): boolean {
  return NAME.test(name);
}

function isInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !INSTANT.test(value)) return false;
  const ms = Date.parse(value);
  // A date that does not exist (`2026-02-31`) parses to another day: refused.
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === value.slice(0, 19);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The system's error code (`EACCES`), or a fixed word when the error carries none. */
function codeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : 'unknown error';
}

/** The file's mode as four octal digits, when it is open to group or others (POSIX only). */
function openModeOf(path: string): string | undefined {
  if (process.platform === 'win32') return undefined;
  try {
    const mode = statSync(path).mode & 0o7777;
    return (mode & 0o077) !== 0 ? mode.toString(8).padStart(4, '0') : undefined;
  } catch {
    return undefined;
  }
}

/** A non-empty list of non-empty strings, each passing `ok`, or undefined. */
function listOf(value: unknown, ok: (item: string) => boolean): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.every((item) => typeof item === 'string' && item !== '' && ok(item))
    ? [...(value as string[])]
    : undefined;
}

/** A key's `limits` as the reader keeps it, or undefined when it breaks the closed set's rules. */
function limitsOf(value: unknown): ServeKeyLimits | undefined {
  if (!isObject(value)) return undefined;
  const fields = Object.keys(value);
  if (fields.length === 0 || fields.some((f) => !LIMITS_FIELDS.includes(f))) return undefined;
  const { read_only, tools, workflows } = value;
  if (read_only !== undefined && (read_only !== true || tools !== undefined)) return undefined;
  const toolList =
    tools === undefined ? undefined : listOf(tools, (t) => SERVE_KEY_TOOLS.includes(t));
  const workflowList = workflows === undefined ? undefined : listOf(workflows, () => true);
  if (
    (tools !== undefined && toolList === undefined) ||
    (workflows !== undefined && workflowList === undefined)
  ) {
    return undefined;
  }
  return {
    ...(read_only === true ? { read_only: true as const } : {}),
    ...(toolList !== undefined ? { tools: toolList } : {}),
    ...(workflowList !== undefined ? { workflows: workflowList } : {}),
  };
}

/** The cause word of a file's text that is not a valid key file, or the file's keys. */
function judge(text: string): { cause: string } | { keys: ServeKeyEntry[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { cause: 'not JSON' };
  }
  if (!isObject(parsed)) return { cause: 'not a key file' };
  const format = parsed['format'];
  if (format !== 1 && format !== 2) {
    return typeof format === 'number' && Number.isInteger(format)
      ? { cause: `format ${format}, which this Realm does not know` }
      : { cause: 'not a key file' };
  }
  const entries = parsed['keys'];
  if (!Array.isArray(entries)) return { cause: 'not a key file' };
  const names = new Set<string>();
  const hashes = new Set<string>();
  const keys: ServeKeyEntry[] = [];
  for (const [i, entry] of entries.entries()) {
    const bad = { cause: `entry ${i + 1} is not a valid key entry` };
    if (!isObject(entry)) return bad;
    // Format 2: an entry may also carry `limits`; format 1 never does.
    const fields = Object.keys(entry)
      .filter((f) => format === 1 || f !== 'limits')
      .sort();
    if (fields.length !== ENTRY_FIELDS.length || fields.some((f, j) => f !== ENTRY_FIELDS[j]))
      return bad;
    const { name, sha256, created_at, expires_at } = entry;
    const limits = entry['limits'] === undefined ? undefined : limitsOf(entry['limits']);
    if (entry['limits'] !== undefined && limits === undefined) return bad;
    if (typeof name !== 'string' || !isKeyName(name)) return bad;
    if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) return bad;
    if (!isInstant(created_at)) return bad;
    if (expires_at !== null && !isInstant(expires_at)) return bad;
    // A name twice, or one fingerprint under two names (a hand-copied entry would get a request
    // recorded under the other entry's name): the later entry is the invalid one.
    if (names.has(name) || hashes.has(sha256)) return bad;
    names.add(name);
    hashes.add(sha256);
    keys.push({
      name,
      sha256,
      created_at,
      expires_at,
      ...(limits !== undefined ? { limits } : {}),
    });
  }
  return { keys };
}

/** Reads the key file at `path`. Never throws. */
export function readServeKeys(path: string): ServeKeysRead {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (codeOf(err) === 'ENOENT') return { state: 'absent' };
    const openMode = openModeOf(path);
    return {
      state: 'invalid',
      cause: codeOf(err),
      ...(openMode !== undefined ? { openMode } : {}),
    };
  }
  const openMode = openModeOf(path);
  const judged = judge(text);
  return 'cause' in judged
    ? { state: 'invalid', cause: judged.cause, ...(openMode !== undefined ? { openMode } : {}) }
    : { state: 'valid', keys: judged.keys, ...(openMode !== undefined ? { openMode } : {}) };
}

/**
 * #625 PR-2b 1b, correction 1: a write refused because the new file would break the reader's rules
 * (`keyFileCause` is the reader's cause word). The old file is unchanged and the temporary file gone.
 */
export class ServeKeysWriteRefused extends Error {
  constructor(readonly keyFileCause: string) {
    super(`the new key file would not be valid (${keyFileCause})`);
    this.name = 'ServeKeysWriteRefused';
  }
}

/**
 * Writes `keys` as the whole key file of `home` — format 2 when any key has a limit, else format 1 —
 * at 0600: a temporary file in the home (exclusive, owner-only, synced), checked with the reader's
 * own rules, then renamed over the old file. A new file the reader would refuse is never renamed:
 * {@link ServeKeysWriteRefused}. Throws the system's error otherwise; the temporary file is removed
 * in every outcome but the rename.
 */
export function writeServeKeys(home: string, keys: readonly ServeKeyEntry[]): void {
  const target = serveKeysPath(home);
  const temp = join(
    home,
    `.${SERVE_KEYS_FILE}-${process.pid}-${randomBytes(6).toString('hex')}.tmp`,
  );
  const fd = openSync(temp, 'wx', 0o600);
  let renamed = false;
  try {
    try {
      fchmodSync(fd, 0o600); // whatever the umask
      const format = keys.some((key) => key.limits !== undefined) ? 2 : 1;
      writeFileSync(fd, `${JSON.stringify({ format, keys }, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // The file as written, judged as `readServeKeys` judges it (an end past year 9999, for one).
    const judged = judge(readFileSync(temp, 'utf8'));
    if ('cause' in judged) throw new ServeKeysWriteRefused(judged.cause);
    renameSync(temp, target);
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        unlinkSync(temp);
      } catch {
        // Only this call made the temporary file; if it cannot be removed, it is left behind.
      }
    }
  }
}

/** A new key's text: `realm_key_` and 32 random bytes as 64 lowercase hex characters. */
export function newServeKey(): string {
  return `realm_key_${randomBytes(32).toString('hex')}`;
}

/** The SHA-256 of a key's text, as 64 lowercase hex characters: what the file holds. */
export function keyFingerprint(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The key in `keys` whose fingerprint is the SHA-256 of `presented`, or undefined. Only hashes are
 * compared, each as two 32-byte digests in constant time, and every entry is compared (no early
 * return on a match), so the time taken does not depend on where the digests differ.
 */
export function findServeKey(
  keys: readonly ServeKeyEntry[],
  presented: string,
): ServeKeyEntry | undefined {
  const digest = createHash('sha256').update(presented, 'utf8').digest();
  let found: ServeKeyEntry | undefined;
  for (const key of keys) {
    if (timingSafeEqual(digest, Buffer.from(key.sha256, 'hex')) && found === undefined) found = key;
  }
  return found;
}

/** Whether `key` has ended at the instant `now` (the home's clock). */
export function keyEnded(key: ServeKeyEntry, now: Date): boolean {
  return key.expires_at !== null && now.getTime() >= Date.parse(key.expires_at);
}

/** An instant as the key words print it: `YYYY-MM-DD HH:MM UTC`. */
export function keyInstant(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * A path as the key words print it: quoted as a typed word (`typedWord`), and printed whole, a path
 * under HOME included, as a path the reader acts on (the writer's command span).
 */
export function keyPath(path: string): string {
  return writerCtx().cmd(typedWord(path));
}

/**
 * A typed key name (or a key's workflow id) as a line shows it: JSON's escaping of the string, then
 * the house's shown-string escapes (core's one copy, #625 named keys 2b correction 1), so every
 * control character, and each character that overrides or isolates the text's direction, is written
 * out, never the raw character.
 */
export function escapedKeyName(name: string): string {
  return escapeShownString(JSON.stringify(name).slice(1, -1));
}

/**
 * The house warning that the key file is open to other users, with its fix: the words of
 * `masterKeyOpenWarning` (callback C2c), each path printed by {@link keyPath}.
 */
export function keyFileOpenWarning(path: string, mode: string): string {
  const shown = keyPath(path);
  return `Warning: ${shown} is open to other users (mode ${mode}). Fix that with: chmod 600 ${shown}`;
}
