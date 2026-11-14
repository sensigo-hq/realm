// slack-post-file.ts — #729 PR-6b (B): where Realm's Slack question post is, kept as the Slack door's
// own delivery state (never in the run's record): one small file per open question under
// `<home>/slack-posts/`, keyed by run id and gate id, holding the post's channel and `ts` and which
// process wrote it. A `realm agent` restarted while the question is open finds the post through it
// and uses it again instead of posting the question a second time.
//
// The file holds no token and no secret. Every operation is best effort: a failure returns `false`
// (or "not usable"), never throws, and never fails the gate, the run, or `realm agent`.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { drivePid } from '../../output/writer.js';

/** What the file holds: where the post is, and the process that wrote it. */
export interface SlackPostRecord {
  readonly channel: string;
  readonly ts: string;
  readonly pid: number;
  readonly host: string;
  /** A random id made once per process, so a later process that got the same pid is told apart. */
  readonly id: string;
}

/** The file as this agent found it before posting (B.11). */
export type SlackPostFileFound =
  | { readonly kind: 'none' }
  | { readonly kind: 'not_usable' }
  | { readonly kind: 'running' }
  | { readonly kind: 'stopped'; readonly record: SlackPostRecord; readonly bytes: string };

let processIdOnce: string | undefined;

/** This process's writer fields; the random id is made at the first call and kept. */
function thisWriter(): Pick<SlackPostRecord, 'pid' | 'host' | 'id'> {
  processIdOnce ??= randomUUID();
  return { pid: drivePid(), host: hostname(), id: processIdOnce };
}

/** One id as a file-name part: `encodeURIComponent`, and `*` too (not allowed in a Windows name).
 *  Neither leaves a `+`, so the `+` between the two ids keeps every pair's name its own. */
function namePart(id: string): string {
  return encodeURIComponent(id).replace(/\*/g, '%2A');
}

/** The file for one question: `<home>/slack-posts/<run id>+<gate id>.json`. */
export function slackPostPath(home: string, runId: string, gateId: string): string {
  return join(home, 'slack-posts', `${namePart(runId)}+${namePart(gateId)}.json`);
}

function bytesOf(channel: string, ts: string): string {
  const record: SlackPostRecord = { channel, ts, ...thisWriter() };
  return `${JSON.stringify(record)}\n`;
}

function parse(bytes: string): SlackPostRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const text = (x: unknown): x is string => typeof x === 'string' && x !== '';
  if (!text(v['channel']) || !text(v['ts']) || !text(v['host']) || !text(v['id'])) return undefined;
  if (typeof v['pid'] !== 'number' || !Number.isSafeInteger(v['pid']) || v['pid'] <= 0) {
    return undefined;
  }
  return { channel: v['channel'], ts: v['ts'], pid: v['pid'], host: v['host'], id: v['id'] };
}

/** Whether a process with this pid is running on this host (`kill(pid, 0)`; `EPERM` means it runs
 *  under another user). */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Whether the record names this process. */
function namesThisProcess(record: SlackPostRecord): boolean {
  const me = thisWriter();
  return record.pid === me.pid && record.host === me.host && record.id === me.id;
}

/**
 * Reads the file, if any, and sorts it (B.11): one that cannot be read, is not this shape, or names
 * another host is not usable; one whose writer runs (another process, or this one by its id) is
 * running, whatever its channel; any other is stopped, and a stopped one naming another channel than
 * `channel` is not usable.
 */
export async function readSlackPostFile(
  path: string,
  channel: string,
): Promise<SlackPostFileFound> {
  let bytes: string;
  try {
    bytes = await readFile(path, 'utf8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'none' }
      : { kind: 'not_usable' };
  }
  const record = parse(bytes);
  if (record === undefined || record.host !== hostname()) return { kind: 'not_usable' };
  const running = record.pid === drivePid() ? record.id === thisWriter().id : isRunning(record.pid);
  if (running) return { kind: 'running' };
  if (record.channel !== channel) return { kind: 'not_usable' };
  return { kind: 'stopped', record, bytes };
}

/** Writes `bytes` at `path` only when no file is there (an exclusive create); `false` when one is,
 *  or the write failed. */
async function createExclusive(path: string, bytes: string): Promise<boolean> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

async function removeQuietly(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Best effort: a file left here is never read (only `<run id>+<gate id>.json` is).
  }
}

/** Records a new post in a new file, created exclusively (B.10); `false` when another agent created
 *  it first, or the write failed — that agent's file is left alone. */
export function createSlackPostFile(path: string, channel: string, ts: string): Promise<boolean> {
  return createExclusive(path, bytesOf(channel, ts));
}

/** Replaces a file that was not usable with this agent's new post (B.14); `false` when the write
 *  failed. */
export async function replaceSlackPostFile(
  path: string,
  channel: string,
  ts: string,
): Promise<boolean> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temp, bytesOf(channel, ts), 'utf8');
    await rename(temp, path);
    return true;
  } catch {
    await removeQuietly(temp);
    return false;
  }
}

/**
 * Takes a stopped writer's file over (B.12): the file is moved aside under a name of this process's
 * own (a rename, so of two agents taking one file over at once exactly one moves it), checked to be
 * the file that was read, then written again naming this process, created exclusively. `false` when
 * another agent moved it first, it changed since it was read, or a write failed.
 */
export async function takeOverSlackPostFile(
  path: string,
  found: Extract<SlackPostFileFound, { kind: 'stopped' }>,
): Promise<boolean> {
  // A name of this call's own: two takeovers never share one.
  const aside = `${path}.${randomUUID()}.taken`;
  try {
    await rename(path, aside);
  } catch {
    return false;
  }
  let moved: string | undefined;
  try {
    moved = await readFile(aside, 'utf8');
  } catch {
    moved = undefined;
  }
  if (moved !== found.bytes) {
    // Another file took its place after it was read: put that one back, untouched.
    if (moved !== undefined) await createExclusive(path, moved);
    await removeQuietly(aside);
    return false;
  }
  const taken = await createExclusive(path, bytesOf(found.record.channel, found.record.ts));
  await removeQuietly(aside);
  return taken;
}

/** Deletes the file when it still names this process (B.15); never one another process holds. */
export async function releaseSlackPostFile(path: string): Promise<void> {
  let bytes: string;
  try {
    bytes = await readFile(path, 'utf8');
  } catch {
    return;
  }
  const record = parse(bytes);
  if (record !== undefined && namesThisProcess(record)) await removeQuietly(path);
}
