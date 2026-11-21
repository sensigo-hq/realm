// deprecations.ts — CP-W: the deprecation channel's data. The table of every retired flag, key,
// command or reply field, with an identifier that never changes, and one record per process of the
// ids already said. Data only: core prints nothing (R19). The two doors that print — the CLI's
// (`packages/cli/src/output/deprecations.ts`) and the MCP server's
// (`packages/mcp-server/src/deprecations.ts`) — read this table and share this record, so an id
// raised by both in one process (`realm mcp`, `realm serve`) is said once.

/**
 * One retired thing. The four clauses are the inert-config policy's, in their deprecation variant,
 * each a sentence: what you used · what it means now · what to write instead · when it goes away.
 */
export interface DeprecationEntry {
  /** `REALM-D` + three digits (`REALM-D001`, …): never reused or renumbered. */
  readonly id: string;
  /** The release that first warns, `X.Y.Z`. */
  readonly since: string;
  /** The release it goes away in, `X.Y.Z`, or `not scheduled`. */
  readonly removal: string;
  readonly used: string;
  readonly means: string;
  readonly instead: string;
  readonly when: string;
}

const ID = /^REALM-D\d{3}$/;
const RELEASE = /^\d+\.\d+\.\d+$/;
const CLAUSES = ['used', 'means', 'instead', 'when'] as const;

/**
 * Refuses a table with a duplicate id, an id out of order (ids ascend in the array's order), an id
 * not of the form `REALM-Dnnn`, a missing clause (empty, or more than one line), or a bad release.
 * Each refusal names the id.
 */
export function validateDeprecations(entries: readonly DeprecationEntry[]): void {
  const seen = new Set<string>();
  let previous: string | undefined;
  for (const [i, entry] of entries.entries()) {
    const id = typeof entry?.id === 'string' ? entry.id : `entry ${i}`;
    if (!ID.test(id)) throw new Error(`deprecations: ${id} is not an id of the form REALM-Dnnn`);
    if (seen.has(id)) throw new Error(`deprecations: ${id} is used twice`);
    if (previous !== undefined && id < previous)
      throw new Error(`deprecations: ${id} comes after ${previous}; ids are listed in order`);
    seen.add(id);
    previous = id;
    for (const clause of CLAUSES) {
      const text = entry[clause];
      if (typeof text !== 'string' || text.trim() === '' || /[\r\n]/.test(text))
        throw new Error(`deprecations: ${id} has no "${clause}" clause on one line`);
    }
    if (typeof entry.since !== 'string' || !RELEASE.test(entry.since))
      throw new Error(`deprecations: ${id} since ${JSON.stringify(entry.since)} is not a release`);
    if (
      typeof entry.removal !== 'string' ||
      (entry.removal !== 'not scheduled' && !RELEASE.test(entry.removal))
    )
      throw new Error(
        `deprecations: ${id} removal ${JSON.stringify(entry.removal)} is not a release or "not scheduled"`,
      );
  }
}

/** Every retired thing, in id order. */
export const DEPRECATIONS: readonly DeprecationEntry[] = Object.freeze([
  // The gate-answers default (PR #1167 correction 1, item 11): `offered`, now called `permitted`.
  // The bins raise it from their own reading of the flag and the variable; the library's option
  // raises nothing (its TSDoc says it).
  {
    id: 'REALM-D001',
    since: '0.50.0',
    removal: 'not scheduled',
    used: 'The gate-answers value offered was given.',
    means: 'It is now called permitted, and works the same.',
    instead: 'Write permitted in its place.',
    when: 'offered keeps working: no removal is scheduled.',
  },
  // Q1 (#592) unit e1: `run_version: 0` on a refusal that names no run's state. The MCP door raises
  // it at those refusals' sites; the field leaves them in 0.52.0 (unit e2).
  {
    id: 'REALM-D002',
    since: '0.51.0',
    removal: '0.52.0',
    used: "A refusal that named no run's state carried run_version 0.",
    means: "The 0 is not the run's version; a new run is also at version 0.",
    instead: 'Read the version from an ok reply or from basis.',
    when: 'run_version leaves these refusals in 0.52.0.',
  },
]);
validateDeprecations(DEPRECATIONS);

/** The one line a door prints for `entry`: `Warning: [<id>] <used> <means> <instead> <when>`. */
export function deprecationLine(entry: DeprecationEntry): string {
  return `Warning: [${entry.id}] ${entry.used} ${entry.means} ${entry.instead} ${entry.when}`;
}

const said = new Set<string>();

/** Records `id` as said in this process: true the first time, false after. */
export function markSaid(id: string): boolean {
  if (said.has(id)) return false;
  said.add(id);
  return true;
}

/** The ids said in this process (seeded ones included), in the order they were recorded. */
export function saidIds(): string[] {
  return [...said];
}

/** Records ids another process of the same command already said (the relay's or `realm listen`'s). */
export function seedSaid(ids: readonly string[]): void {
  for (const id of ids) said.add(id);
}
