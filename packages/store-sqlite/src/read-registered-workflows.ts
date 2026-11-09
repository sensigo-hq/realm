// read-registered-workflows.ts — issue #616 PR-2c c10a-3b-i (DELTAS row 56): the store package's one
// read-only look at the registered workflows, for the separation check (`realm mcp --check`, `realm
// serve --check`), which runs as the login, starts no process and creates no store.
//
// It is two stated exceptions:
//   1. the second exception to one connection per home per process (the first is DELTAS 41 (3)): it
//      opens its OWN read-only connection, outside `openRealmHome`'s per-process cache, and closes it
//      before it returns, on every path; a handle open on the same home in the same process is neither
//      closed nor changed by it;
//   2. a read that runs the open's own guards and reads `realm.db` only: it opens through the check's
//      open (`openForCheck`, c8a1 and c8a3), which makes no folder, no fence and no file, and refuses
//      the old-store guard's home, as every command does; it never reads the old JSON folders.
//
// Before the open the file is looked at with `lstat`: no `realm.db`, or an empty one, is `no_store`
// and nothing is made. The check's open hands back the connection, every outcome of its checks, and
// one decided `usable`; the reader reads only through a usable connection and otherwise passes on the
// open's `blockedBy` (never `not_writable`) as the refusal's code, keeping no list of codes of its own.
// Per current copy it returns the id and three fields, each only when stored and of its type, never
// the definition's text. A copy that is not JSON, not an object or another Realm's shape is `{ id }`
// with whatever parses; the read classifies nothing. It never throws: every failure of the open or of
// the read is `unreadable`, with the error's code and SQLite's number when it has one.
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { realmHomePath, systemClock } from '@sensigo/realm';
import { DATABASE_FILE } from './home.js';
import { openForCheck, type CheckedFile } from './open-file.js';

/** One current registered copy, as the separation check reads it. */
export interface RegisteredWorkflow {
  readonly id: string;
  /** The deployment root it names: present when stored as a non-empty string. */
  readonly trust_root?: string;
  /** The folder its extensions resolve against: present when stored as a string. */
  readonly source_dir?: string;
  /** Its `extensions:` files: a stored string is one entry; a stored list keeps its string members. */
  readonly extensions?: readonly string[];
}

/** What {@link readRegisteredWorkflows} answers. */
export type RegisteredWorkflowsRead =
  /** The home holds no `realm.db`, or an empty one; nothing was made. */
  | { readonly state: 'no_store' }
  /** One entry per current registered copy (`[]` when none is registered). */
  | { readonly state: 'ok'; readonly workflows: readonly RegisteredWorkflow[] }
  /** The open or the read failed: the error's code, and SQLite's own number when it has one. */
  | { readonly state: 'unreadable'; readonly code: string; readonly errcode?: number };

/** Each current copy: the pointer's hash's text (a pointer with no version row reads NULL). */
const CURRENT_COPIES = `SELECT w.id AS id, v.definition AS definition
FROM workflows w LEFT JOIN workflow_versions v ON v.hash = w.current_hash AND v.id = w.id
ORDER BY w.id`;

/**
 * Reads, for the separation check, the registered workflows' ids with their `trust_root`,
 * `source_dir` and `extensions` where stored. Read-only: it writes nothing to the store file (SQLite
 * may create or update its two side files beside it, `realm.db-wal` and `realm.db-shm`), and answers
 * `no_store` or `unreadable` instead of throwing.
 */
export async function readRegisteredWorkflows(
  options: { readonly home?: string } = {},
): Promise<RegisteredWorkflowsRead> {
  let home: string;
  try {
    home = realmHomePath(options.home);
  } catch (err) {
    return unreadable(err);
  }
  // The look before the open: nothing is made on this path, and no guard runs, for a missing store.
  try {
    const entry = lstatSync(join(home, DATABASE_FILE));
    if (entry.isFile() && entry.size === 0) return { state: 'no_store' };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { state: 'no_store' };
    // Any other refusal (the home cannot be searched): a store may exist, so never `no_store`.
    return unreadable(err);
  }
  let file: CheckedFile;
  try {
    file = await openForCheck(home, { clock: systemClock });
  } catch (err) {
    // What the check's open still refuses (an unsearchable home, the old-store guard, a `realm.db`
    // that is not a regular file, …) comes back as its own refusal.
    return unreadable(err);
  }
  const db = file.db;
  if (!file.usable || db === undefined) {
    db?.close();
    // The open's own code for what made it unusable; SQLite's number copied from its outcome.
    const blocking = file.outcomes.find((o) => o.kind === file.blockedBy);
    const errcode = blocking?.kind === 'open_failed' ? blocking.errcode : undefined;
    return {
      state: 'unreadable',
      code: file.blockedBy ?? 'UNKNOWN',
      ...(errcode === undefined ? {} : { errcode }),
    };
  }
  try {
    const rows = await db.snapshot((c) => c.prepare(CURRENT_COPIES).all(), {
      takesReading: false,
    });
    return {
      state: 'ok',
      workflows: rows.map((row) => fieldsOf(String(row['id']), row['definition'])),
    };
  } catch (err) {
    return unreadable(err);
  } finally {
    db.close();
  }
}

/** The id and the three fields that parse, each only when of its type; never the text itself. */
function fieldsOf(id: string, text: unknown): RegisteredWorkflow {
  let definition: unknown;
  if (typeof text === 'string') {
    try {
      definition = JSON.parse(text);
    } catch {
      definition = undefined;
    }
  }
  if (typeof definition !== 'object' || definition === null || Array.isArray(definition)) {
    return { id };
  }
  const { trust_root, source_dir, extensions } = definition as Record<string, unknown>;
  const declared =
    typeof extensions === 'string'
      ? [extensions]
      : Array.isArray(extensions)
        ? extensions.filter((e): e is string => typeof e === 'string')
        : undefined;
  return {
    id,
    ...(typeof trust_root === 'string' && trust_root !== '' ? { trust_root } : {}),
    ...(typeof source_dir === 'string' ? { source_dir } : {}),
    ...(declared === undefined ? {} : { extensions: declared }),
  };
}

/** A failure as the reader answers it: the error's string code, else `UNKNOWN`, and SQLite's number. */
function unreadable(err: unknown): RegisteredWorkflowsRead {
  const code = (err as { code?: unknown } | null)?.code;
  const errcode = (err as { errcode?: unknown } | null)?.errcode;
  return {
    state: 'unreadable',
    code: typeof code === 'string' ? code : 'UNKNOWN',
    ...(typeof errcode === 'number' ? { errcode } : {}),
  };
}
