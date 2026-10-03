// Shared atomic-write primitive (issue #130 extraction — was module-private in
// json-file-store.ts). Used by every store/registry writer that must be torn-read-safe
// against a concurrent unlocked reader.
import { writeFile, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

/** How many temp names one write tries when the exclusive create finds the name taken. */
const TEMP_NAME_ATTEMPTS = 4;

/**
 * Torn-read-safe write for a JSON file (run records, key pointers, registry entries, …).
 *
 * POSIX (Linux/macOS): writes a unique sibling temp then rename(2)s it over the
 * target. rename-over-existing is atomic on POSIX within one filesystem, so any
 * concurrent unlocked reader (get/list/readPointer) sees the complete old file
 * XOR the complete new file — never a truncated buffer. The temp is a path
 * sibling (`${path}.<pid>.<8 hex>.tmp`), so it is guaranteed same-directory /
 * same-filesystem (rename never EXDEV) and is excluded from directory listings
 * that filter on a specific suffix (e.g. `.json`) — it ends in `.tmp`. The 8 hex
 * characters are random and the temp is created exclusively (`wx`): two writers of
 * one file — in one process or in two copies of realm loaded side by side — never
 * share a temp, whatever their counters or pids say (issue #620).
 *
 * Windows (win32): rename-over-an-open-file throws EPERM/EBUSY — exactly the
 * concurrent-reader case this helper exists for — so on win32 we fall back to the
 * pre-existing plain writeFile (status quo: racy but non-throwing). Real Windows
 * atomicity is deferred to a follow-up (write-file-atomic in its own PR).
 *
 * fsync is intentionally omitted: the bug this fixes is a live-process page-cache
 * truncation read, which rename fixes by construction; fsync would only add
 * power-loss durability, a contract this store does not hold (durable tier =
 * realm-cloud/Postgres). Add fsync(temp)+fsync(dir) here if durability ever
 * becomes a requirement.
 *
 * INVARIANT: every JSON file a caller reads without holding a lock (run/pointer files in
 * JsonFileStore, registry entries in JsonWorkflowStore, …) MUST be written through this
 * helper. A raw writeFile of such a file reintroduces the torn read. (Enforced by
 * structural tests in each writer's own test file.)
 */
export async function atomicWriteFile(path: string, data: string): Promise<void> {
  if (process.platform === 'win32') {
    await writeFile(path, data, 'utf8');
    return;
  }
  // The name is `<path>.<pid>.<8 random hex>.tmp` and the create is exclusive, so the name decides
  // nothing about who owns the file: a name that is already taken is another writer's file, never
  // ours — pick another and try again (at most TEMP_NAME_ATTEMPTS names, then the last error).
  // A module-level counter cannot do this job: each loaded copy of realm has its own, and two
  // copies at one pid count 0, 1, 2 … in step.
  let tmp: string;
  for (let attempt = 1; ; attempt++) {
    tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, data, { encoding: 'utf8', flag: 'wx' });
      break;
    } catch (err) {
      if (isNameTaken(err)) {
        // Another writer's file: leave it exactly as it is.
        if (attempt < TEMP_NAME_ATTEMPTS) continue;
        throw err;
      }
      // Any other failure may have happened after our own create (a full disk part-way through):
      // best-effort cleanup of the temp this call named. A create that failed for another reason
      // left nothing at this name, and an exclusive create never touches a file that exists.
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {}); // our own temp: the create above succeeded
    throw err;
  }
}

/** Whether the exclusive create found the name already taken. */
function isNameTaken(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'EEXIST';
}
