// expected-refusal.ts — #715 (a) correction 1 (C-6): the one place the CLI's entry prints an EXPECTED
// typed refusal that a command raised: one `Error: <message>` line on stderr, exit code 1, no stack
// trace. npm, pip and Cargo do this at one catch at their entry, and keep the stack for unexpected
// errors; so does this.
//
// The list: a run store opened on a copy of a test location; a home that cannot be used (#616 PR-2a
// (i): HOME empty or not an absolute path, or no home at all); the refusals of `realm db backup`
// (#616 PR-2c c6) — its own two and those of the store's open that its maintenance entry can meet —
// of `realm db migrate` (c7): its own two, and the store busy beyond its budget, which every
// command that meets it now prints as one line too; and of `realm db check` (c8a2): its one.
// Every other error keeps escaping loud, a `WorkflowError` included — "bugs stay loud" (`validate.ts`,
// #123); the writer's fatal handler prints those with their stack. The code is read from the error's
// fields, never by `instanceof`: the CLI and the library it loads can be separate copies.

/** The codes printed as one line. Each is a refusal an operator meets and can act on from its text. */
const EXPECTED_CODES: ReadonlySet<string> = new Set([
  'STATE_TEST_CLOCK_FOREIGN',
  'STATE_HOME_UNUSABLE',
  // `realm db backup`: a target inside the home, where anything exists, or that cannot be created;
  // a home with no store file, or an empty one.
  'STATE_STORE_BACKUP_REFUSED',
  // `realm db backup`: the copy fails SQLite's quick check; the store file may be damaged.
  'STATE_STORE_BACKUP_UNVERIFIED',
  // `realm db migrate`: a home with no store file, or an empty one.
  'STATE_STORE_MIGRATE_REFUSED',
  // `realm db migrate`: a schema step failed; the line names the version the file is at.
  'STATE_STORE_MIGRATE_FAILED',
  // `realm db check`: a home with no store file, or an empty one.
  'STATE_STORE_CHECK_REFUSED',
  // The store busy beyond its budget: `realm db migrate`'s re-stamp met it (the batches committed
  // stay). Every command whose busy refusal reaches the entry prints it as one line.
  'STATE_RUN_BUSY',
  // The store's open, through the maintenance entry: this Node has no usable built-in SQLite.
  'STATE_STORE_DRIVER_UNAVAILABLE',
  // The store's open: the home is on a network or unrecognised filesystem.
  'STATE_STORE_FILESYSTEM_REFUSED',
  // The store's open: the home still holds the old JSON store's folders.
  'STATE_HOME_HOLDS_LEGACY_STORE',
  // The store's open: the home, or the store file, cannot be written.
  'STATE_STORE_READONLY',
  // The store's open: the file is not a Realm store this Realm can use (not SQLite, damaged, other
  // settings).
  'STATE_STORE_SETTINGS_REFUSED',
  // The store's open: the file's tables are not what Realm writes for its version.
  'STATE_STORE_SCHEMA_TAMPERED',
  // The store's open: the file is older than any version this Realm holds a schema for.
  'STATE_STORE_VERSION_OLDER',
  // The store's open: a newer Realm migrated the file.
  'STATE_STORE_VERSION_NEWER',
  // The disk is full: the store's write refused.
  'STATE_STORE_FULL',
  // Writes fenced: the store refused a write after a failure.
  'STATE_STORE_WRITES_FENCED',
]);

/**
 * When `err` carries a code in the list: writes `Error: <message>` to stderr, sets the exit code to 1,
 * and returns `true`. Anything else: writes nothing and returns `false`, so the caller rethrows it.
 *
 * The line goes through `process.stderr`, which the CLI's writer masks for its audience; the process
 * is not exited here, so the stream is flushed before it ends.
 */
export function reportExpectedRefusal(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== 'string' || !EXPECTED_CODES.has(code)) return false;
  const message = (err as { message?: unknown }).message;
  process.stderr.write(`Error: ${typeof message === 'string' ? message : code}\n`);
  process.exitCode = 1;
  return true;
}
