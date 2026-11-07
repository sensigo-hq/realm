// workflow-store.ts — issue #616 PR-1b B3: THE WORKFLOW REGISTRY ON SQLITE. `SqliteWorkflowStore`
// implements core's `WorkflowRegistrar` (`register`, `get`, `list`) on the home's database, in the
// three tables core's schema constant declares (`workflow_versions`, `workflow_registrations`,
// `workflows`; their guards are the design):
//   - each distinct definition text is stored once, under the lowercase hex sha256 of its UTF-8
//     bytes. The text is `JSON.stringify(definition)`, keys in their own order: key order is meaning
//     in Realm (finalizers run in declaration order; an output schema's property order steers the
//     model), so the same keys in another order are another text;
//   - one pointer per workflow names its current text, and every move of the pointer is recorded,
//     in order, as a registration row (the history #493 reads; nothing here reads it);
//   - an identical re-register writes nothing.
// One `immediate` write does a register; one `snapshot` does a read. The store reads no clock: every
// time it stores is the reading the primitive hands the write's body. No error is caught and dropped
// in a write. The package's entry does not export the class: a host reaches it as `workflowStore` on
// the home (`openRealmHome`).
import { createHash } from 'node:crypto';
import {
  brandClass,
  classifyRegisteredCopy,
  legacyCopyError,
  newerCopyError,
  storedCopyFaultError,
  workflowNotFoundError,
  WorkflowError,
  type WorkflowDefinition,
  type WorkflowRegistrar,
} from '@sensigo/realm';
import { REALM_STORE_SQLITE_BRAND } from './brand.js';
import type { RealmDb } from './connection.js';
import type { DatabaseLike } from './driver.js';

/** The pointer of one workflow with the version it names, matched on hash AND id. */
const CURRENT_COPY = `SELECT w.id AS id, v.definition AS definition
FROM workflows w LEFT JOIN workflow_versions v ON v.hash = w.current_hash AND v.id = w.id`;
const POINTER = 'SELECT current_hash FROM workflows WHERE id = ?';
const VERSION_TEXT = 'SELECT definition FROM workflow_versions WHERE hash = ?';
const NEWEST_REGISTRATION =
  'SELECT seq, hash, registered_at FROM workflow_registrations WHERE id = ? ORDER BY seq DESC LIMIT 1';
const REGISTRATION_AT =
  'SELECT hash, registered_at FROM workflow_registrations WHERE id = ? AND seq = ?';
const VERSION_OF = 'SELECT definition FROM workflow_versions WHERE hash = ? AND id = ?';
const INSERT_VERSION =
  'INSERT INTO workflow_versions (hash, id, definition, first_registered_at) VALUES (?, ?, ?, ?)';
const INSERT_REGISTRATION =
  'INSERT INTO workflow_registrations (id, seq, hash, registered_at) VALUES (?, ?, ?, ?)';
const INSERT_POINTER = 'INSERT INTO workflows (id, current_hash, registered_at) VALUES (?, ?, ?)';
const MOVE_POINTER = 'UPDATE workflows SET current_hash = ?, registered_at = ? WHERE id = ?';

/**
 * What a register's body did: nothing, or a write: whether it added the version, and the history row
 * it appended (its number and time), if any.
 */
type Registered =
  | { readonly wrote: false }
  | {
      readonly wrote: true;
      readonly versionAdded: boolean;
      readonly appended: { readonly seq: number; readonly at: string } | undefined;
    };

/** The newest registration row of a workflow. */
interface Registration {
  readonly seq: number;
  readonly hash: string;
  readonly registered_at: string;
}

/**
 * The refusal of a pointer whose version is missing or is not JSON text. Only a writer that removed
 * the file's guards can leave one; a read never answers "not found" for it, and a listing never
 * leaves it out. Code, category, action and retry as `storedCopyFaultError`'s.
 */
function damagedPointerError(workflowId: string): WorkflowError {
  return new WorkflowError(
    `The registered copy of workflow '${workflowId}' is missing from the store or is not JSON: ` +
      'something other than Realm changed the database. Register the workflow again from its ' +
      'source; if this message comes back, restore the database from a backup.',
    {
      code: 'RESOURCE_FORMAT_INVALID',
      category: 'RESOURCE',
      agentAction: 'stop',
      retryable: false,
      details: { workflowId },
    },
  );
}

/**
 * Judges a current copy as read: a definition, or `'skip'` for a copy an older or a later Realm
 * registered (the listing leaves those out), or a throw. `definition` is what the read returned for
 * the version the pointer names: `null` when no version of that workflow has that hash, otherwise
 * the stored value (text, unless a writer that is not Realm stored something else).
 */
function judge(
  workflowId: string,
  definition: unknown,
  older: 'throw' | 'skip',
): WorkflowDefinition | 'skip' {
  if (typeof definition !== 'string') throw damagedPointerError(workflowId);
  let parsed: unknown;
  try {
    parsed = JSON.parse(definition);
  } catch {
    throw damagedPointerError(workflowId);
  }
  // B2's one judge, the JSON registry's: a copy is read the same way by both registries.
  const copy = classifyRegisteredCopy(parsed);
  switch (copy.verdict) {
    case 'readable':
      return copy.definition;
    case 'damaged':
      throw storedCopyFaultError(workflowId, copy.fault);
    case 'legacy':
      if (older === 'skip') return 'skip';
      throw legacyCopyError(workflowId);
    case 'newer':
      if (older === 'skip') return 'skip';
      throw newerCopyError(workflowId, copy.schema_version);
  }
}

/** Core's registrar on a Realm home's database (see the module comment). */
export class SqliteWorkflowStore implements WorkflowRegistrar {
  readonly #db: RealmDb;

  constructor(db: RealmDb) {
    this.#db = db;
  }

  /**
   * Registers `definition` as its workflow's current text. Nothing is written when the pointer
   * already names this text. Otherwise, in one write and in this order (the pointer's guard reads
   * the other two): the version, when this text is new; a history row, when the workflow's newest
   * one names another text; the pointer, inserted or moved. A version stored under this text's hash
   * whose text differs is refused (only a writer that removed the file's guards can leave one).
   */
  async register(definition: WorkflowDefinition): Promise<void> {
    const id = definition.id;
    const text = JSON.stringify(definition);
    const hash = createHash('sha256').update(text, 'utf8').digest('hex');
    await this.#db.immediate(
      (db, reading): Registered => {
        const pointer = db.prepare(POINTER).get(id) as { current_hash: unknown } | undefined;
        const stored = db.prepare(VERSION_TEXT).get(hash) as { definition: unknown } | undefined;
        if (stored !== undefined && stored.definition !== text) throw damagedPointerError(id);
        if (stored !== undefined && pointer?.current_hash === hash) return { wrote: false };
        const at = reading.toISOString();
        const versionAdded = stored === undefined;
        if (versionAdded) db.prepare(INSERT_VERSION).run(hash, id, text, at);
        const newest = db.prepare(NEWEST_REGISTRATION).get(id) as Registration | undefined;
        let appended: { seq: number; at: string } | undefined;
        if (newest?.hash !== hash) {
          appended = { seq: newest === undefined ? 0 : newest.seq + 1, at };
          db.prepare(INSERT_REGISTRATION).run(id, appended.seq, hash, at);
        }
        // The pointer's time is its newest history row's: this write's, when it appended one.
        const since = appended?.at ?? (newest as Registration).registered_at;
        if (pointer === undefined) db.prepare(INSERT_POINTER).run(id, hash, since);
        else db.prepare(MOVE_POINTER).run(hash, since, id);
        return { wrote: true, versionAdded, appended };
      },
      (db, registered) => landed(db, id, hash, text, registered),
    );
  }

  /** The workflow's current definition, read in one snapshot. */
  async get(workflowId: string): Promise<WorkflowDefinition> {
    const row = await this.#db.snapshot(
      (db) =>
        db.prepare(`${CURRENT_COPY} WHERE w.id = ?`).get(workflowId) as
          { definition: unknown } | undefined,
    );
    if (row === undefined) throw workflowNotFoundError(workflowId);
    return judge(workflowId, row.definition, 'throw') as WorkflowDefinition;
  }

  /**
   * Every workflow's current definition, ordered by id, read in one snapshot. A copy an older or a
   * later Realm registered is left out, as the JSON registry's `list()` leaves it out; a damaged
   * copy or a damaged pointer throws (never skipped), and a read that fails rejects (never `[]`).
   */
  async list(): Promise<WorkflowDefinition[]> {
    const rows = await this.#db.snapshot(
      (db) =>
        db.prepare(`${CURRENT_COPY} ORDER BY w.id`).all() as Array<{
          id: string;
          definition: unknown;
        }>,
    );
    const definitions: WorkflowDefinition[] = [];
    for (const row of rows) {
      const copy = judge(row.id, row.definition, 'skip');
      if (copy !== 'skip') definitions.push(copy);
    }
    return definitions;
  }
}

/**
 * A register's content check, run by the COMMIT outcome protocol after an error at COMMIT: whether
 * this write's own rows are in the file. When it appended a history row: that row, found by its
 * number, names `hash` with this write's time, and the version `hash` holds `text` under `id`. When
 * it added the version and appended no row: the version. When it wrote nothing: true.
 *
 * Its answer is definite (never "cannot tell", so a write is never fenced for want of one), and stays
 * so only while these three hold, which a later change must not break:
 *   (1) the rows it reads are append-only on every Realm path (the file's guards G5 and G7; no Realm
 *       deletion or purge removes them), so another writer since cannot have changed them;
 *   (2) it never reads the pointer, which moves on every register: a write that landed and was then
 *       superseded by another writer's register is still answered "landed". The one exception is a
 *       write whose only change was the pointer, which happens only after a writer removed the
 *       file's guards (its newest history row already named `hash`): the pointer is all it wrote;
 *   (3) a register that wrote nothing answers true without reading.
 */
function landed(
  db: DatabaseLike,
  id: string,
  hash: string,
  text: string,
  registered: Registered,
): boolean {
  if (!registered.wrote) return true;
  const version = (): boolean => {
    const stored = db.prepare(VERSION_OF).get(hash, id) as { definition: unknown } | undefined;
    return stored?.definition === text;
  };
  if (registered.appended !== undefined) {
    const row = db.prepare(REGISTRATION_AT).get(id, registered.appended.seq) as
      { hash: unknown; registered_at: unknown } | undefined;
    return row?.hash === hash && row.registered_at === registered.appended.at && version();
  }
  if (registered.versionAdded) return version();
  const pointer = db.prepare(POINTER).get(id) as { current_hash: unknown } | undefined;
  return pointer?.current_hash === hash;
}

brandClass(
  SqliteWorkflowStore,
  Symbol.for('@sensigo/realm-store-sqlite/SqliteWorkflowStore'),
  REALM_STORE_SQLITE_BRAND,
);
