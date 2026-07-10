// Shared atomic-write primitive (issue #130 extraction — was module-private in
// json-file-store.ts). Used by every store/registry writer that must be torn-read-safe
// against a concurrent unlocked reader.
import { writeFile, rename, unlink } from 'node:fs/promises';

let atomicWriteCounter = 0;

/**
 * Torn-read-safe write for a JSON file (run records, key pointers, registry entries, …).
 *
 * POSIX (Linux/macOS): writes a unique sibling temp then rename(2)s it over the
 * target. rename-over-existing is atomic on POSIX within one filesystem, so any
 * concurrent unlocked reader (get/list/readPointer) sees the complete old file
 * XOR the complete new file — never a truncated buffer. The temp is a path
 * sibling (`${path}.<pid>.<counter>.tmp`), so it is guaranteed same-directory /
 * same-filesystem (rename never EXDEV) and is excluded from directory listings
 * that filter on a specific suffix (e.g. `.json`) — it ends in `.tmp`.
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
  // pid separates processes; atomicWriteCounter separates concurrent in-process
  // writers (counter++ is atomic in the single-threaded event loop — no await
  // between read and increment). Sufficient for uniqueness; no randomBytes.
  const tmp = `${path}.${process.pid}.${atomicWriteCounter++}.tmp`;
  try {
    await writeFile(tmp, data, 'utf8');
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {}); // best-effort cleanup of our own temp only
    throw err;
  }
}
