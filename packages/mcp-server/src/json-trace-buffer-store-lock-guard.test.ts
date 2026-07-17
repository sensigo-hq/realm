// Source-text guard (issue #207, store-fs-guard.test.ts-style — see packages/cli/src/commands/
// store-fs-guard.test.ts for the established convention this mirrors): exactly ONE
// `lockfile.lock(` call site may exist in json-trace-buffer-store.ts — the `lockWal` private
// helper. This is the cheapest forcing mechanism for two guarantees that matter across every
// critical-section acquisition in this file: (1) the shared base lock options (`stale`/
// `realpath`, and the per-path `retries` override) are pinned in exactly one place, so a future
// edit can't accidentally acquire a lock with a different, un-reviewed options shape; (2) every
// acquisition passes an explicit `onCompromised` handler (a loud `console.warn`), never
// `proper-lockfile`'s own default handler, which THROWS inside a timer callback and crashes the
// process — a second, bare `lockfile.lock(` call site would bypass both guarantees silently.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'json-trace-buffer-store.ts');

/** Every non-comment line containing a `lockfile.lock(` call. Deliberately conservative — see
 *  store-fs-guard.test.ts's own RAW_UNLINK_CALL doc for why a false positive (one extra line to
 *  check by hand) is preferable to a false negative here. */
const LOCKFILE_LOCK_CALL = /\blockfile\.lock\s*\(/;

function findLockCalls(source: string): number[] {
  const lines = source.split('\n');
  const hits: number[] = [];
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
    if (LOCKFILE_LOCK_CALL.test(trimmed)) hits.push(i + 1);
  });
  return hits;
}

describe('json-trace-buffer-store — exactly one lockfile.lock( call site (issue #207)', () => {
  it('the file exists and is scanned (the guard is wired correctly)', () => {
    const source = readFileSync(FILE_PATH, 'utf8');
    expect(source.length).toBeGreaterThan(0);
  });

  it('exactly one lockfile.lock( call site exists — the lockWal helper', () => {
    const source = readFileSync(FILE_PATH, 'utf8');
    const hits = findLockCalls(source);
    expect(
      hits,
      `expected exactly one lockfile.lock( call site (inside the lockWal helper), found ` +
        `${hits.length} at line(s): ${hits.join(', ')}. Every critical-section acquisition ` +
        '(append/appendFenced/read/delete/deleteFenced/deleteAllForRun/deleteAllForRunFenced) ' +
        'must go through the single lockWal chokepoint — route any new acquisition through it ' +
        'instead of calling lockfile.lock( directly.',
    ).toHaveLength(1);
  });

  it('the one call site is inside the lockWal helper specifically (not some other method)', () => {
    const source = readFileSync(FILE_PATH, 'utf8');
    const lines = source.split('\n');
    const [hitLine] = findLockCalls(source);
    expect(hitLine, 'no lockfile.lock( call site found at all').toBeDefined();
    // Walk backwards from the call site to the nearest preceding method signature and confirm
    // it's `lockWal`.
    let ownerMethod: string | undefined;
    for (let i = hitLine! - 1; i >= 0; i--) {
      const match = /private\s+async\s+(\w+)\s*\(/.exec(lines[i]!);
      if (match) {
        ownerMethod = match[1];
        break;
      }
    }
    expect(ownerMethod).toBe('lockWal');
  });

  it('lockWal always passes an explicit onCompromised handler (sanity — proves the matcher call site really is the guarded helper)', () => {
    const source = readFileSync(FILE_PATH, 'utf8');
    const helperMatch = /private async lockWal\([\s\S]*?\n {2}\}\n/.exec(source);
    expect(helperMatch, 'could not locate the lockWal helper body').not.toBeNull();
    expect(helperMatch![0]).toMatch(/onCompromised\s*:/);
  });
});
