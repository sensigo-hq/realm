// Fenced-trio TCK conformance for JsonTraceBufferStore (issue #207).
//
// See json-trace-buffer-store.contract.test.ts (this directory, the #183 PerRunArtifactStore TCK
// for the same store) for why this lives in @sensigo/realm-cli rather than alongside
// JsonTraceBufferStore's own test suite in @sensigo/realm-mcp: keeping all fs-store TCK
// conformance tests co-located (this directory already depends on both @sensigo/realm and
// @sensigo/realm-mcp) is simpler than splitting across packages for no benefit.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JsonTraceBufferStore } from '@sensigo/realm-mcp';
import { fencedTraceBufferContract, type FencedTraceBufferLaw } from '@sensigo/realm-testing';

const LAWS: FencedTraceBufferLaw[] = [
  'STRUCTURAL',
  'FENCE_REFUSES',
  'CS_OCCUPANCY',
  'PER_KEY_INDEPENDENCE',
  'NO_SILENT_LOSS',
  // issue #197 PR-1: JsonTraceBufferStore declares both capability-ladder rungs — every one of
  // these five laws runs real (non-skip) cases here, INCLUDING the byte-exactness (bytesOracle)
  // and raw-byte (rawWalAccess) sub-cases the in-memory store's wiring test above leaves skipped
  // (a physical file's on-disk bytes ARE an independent ground truth to check against, unlike an
  // in-memory structure's own accounting).
  'CARRIAGE_ROUND_TRIP',
  'SEAL',
  'SEAL_BUDGET',
  'PER_WRITER_BUDGET',
  'VERBATIM',
];

/** Recomputes the exact on-disk WAL filename `JsonTraceBufferStore`'s private `walPath` uses —
 *  test-side only, mirroring the same helper in json-trace-buffer-store.test.ts. */
function walFileName(runId: string, stepId: string): string {
  return `trace-buffer-${runId}-${Buffer.from(stepId).toString('base64url')}.jsonl`;
}

/** Recomputes the exact on-disk sealed-artifact filename `JsonTraceBufferStore`'s private
 *  `sealedWalPath` uses (issue #197 PR-1) — test-side only. */
function sealedFileName(runId: string, stepId: string, seq: number): string {
  return `sealed-trace-${runId}-${Buffer.from(stepId).toString('base64url')}.${seq}.jsonl`;
}

/** Reads `path`, returning `undefined` on ENOENT (mirrors `readIfExists`'s absence convention) —
 *  test-side raw-bytes access, independent of the store's own internal `readWal`. */
async function readRawIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * Independently computes writer-partitioned count + bytes DIRECTLY from the raw on-disk WAL file
 * (issue #197 PR-1) — a genuinely separate code path from the store's own internal `readWal` +
 * `partitionStats` (fresh `readFile`, raw per-line text sliced straight from disk content rather
 * than re-serializing a parsed object), so this can catch a drift between what the store REPORTS
 * and what is ACTUALLY persisted. Mirrors the store's own byte-attribution rule (there is no more
 * primitive "ground truth" for "this writer's own bytes" than "sum of its own lines' bytes" and
 * "⊥ = the whole-file residual" — that rule IS the definition, not an incidental implementation
 * detail this oracle could sidestep).
 */
async function bytesOracle(
  dir: string,
  runId: string,
  stepId: string,
  writerNonce: string | undefined,
): Promise<{ count: number; bytes: number }> {
  const content = await readRawIfExists(join(dir, walFileName(runId, stepId)));
  if (content === undefined) return { count: 0, bytes: 0 };

  const fileBytes = Buffer.byteLength(content);
  let noncedBytes = 0;
  let bareCount = 0;
  let ownCount = 0;
  let ownBytes = 0;

  for (const raw of content.split('\n')) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    let parsed: { entries: unknown[]; nonce?: string };
    try {
      parsed = JSON.parse(trimmed) as { entries: unknown[]; nonce?: string };
    } catch {
      continue; // torn line — never attributable to any nonced partition (excluded here too)
    }
    const lineBytes = Buffer.byteLength(trimmed + '\n');
    if (parsed.nonce !== undefined) {
      noncedBytes += lineBytes;
      if (writerNonce !== undefined && parsed.nonce === writerNonce) {
        ownCount += parsed.entries.length;
        ownBytes += lineBytes;
      }
    } else if (writerNonce === undefined) {
      bareCount += parsed.entries.length;
    }
  }

  return writerNonce !== undefined
    ? { count: ownCount, bytes: ownBytes }
    : { count: bareCount, bytes: fileBytes - noncedBytes };
}

/**
 * A deliberately generous lock profile for this TCK's own store instance (issue #207) — the
 * default profile (~4s worst-case budget) is already ample for this suite's sub-second latch
 * durations, but the TCK's own latch-based laws briefly hold the CS open across several `await`s
 * (drain round-trips, `setImmediate`), so an inflated retry budget removes any risk of a
 * concurrent caller's lock acquisition giving up (ELOCKED) before the law's own observation
 * window completes on a loaded CI runner. Passed via the constructor-injectable lock-profile
 * parameter (issue #207); this is the "injectable generous lock profile" the adapter's own doc
 * requires for `guard-in-cs` stores.
 */
const GENEROUS_LOCK_PROFILE = {
  retries: { retries: 20, minTimeout: 20, maxTimeout: 200 },
  stale: 5000,
  realpath: false,
};

async function makeAdapter(): Promise<{
  adapter: Parameters<typeof fencedTraceBufferContract>[0];
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'json-trace-buffer-store-fenced-tck-'));
  const store = new JsonTraceBufferStore(dir, GENEROUS_LOCK_PROFILE);
  return {
    adapter: {
      store,
      makeKey: () => ({ runId: randomUUID(), stepId: 'fenced-tck-step' }),
      fenceForm: 'guard-in-cs',
      lockProfile: GENEROUS_LOCK_PROFILE,
      // issue #197 PR-1: a physical file's on-disk bytes are an independent ground truth (unlike
      // the in-memory store's own accounting) — see each helper's own doc above.
      bytesOracle: (runId, stepId, writerNonce) => bytesOracle(dir, runId, stepId, writerNonce),
      rawWalAccess: {
        readLiveRaw: (runId, stepId) => readRawIfExists(join(dir, walFileName(runId, stepId))),
        readSealedRaw: (runId, stepId, seq) =>
          readRawIfExists(join(dir, sealedFileName(runId, stepId, seq))),
      },
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

describe('JsonTraceBufferStore — fenced-trio TCK conformance (issue #207)', () => {
  for (const law of LAWS) {
    it(law, async () => {
      // Fresh adapter (fresh tmpdir) per law — CS_OCCUPANCY/NO_SILENT_LOSS mutate on-disk state
      // and a stale WAL file from an earlier law must never leak into a later one.
      const { adapter, cleanup } = await makeAdapter();
      try {
        const cases = fencedTraceBufferContract(adapter);
        const matching = cases.filter((c) => c.law === law);
        expect(matching.length, `no cases registered for law ${law}`).toBeGreaterThan(0);
        for (const c of matching) {
          await c.run();
        }
      } finally {
        await cleanup();
      }
    });
  }

  it('PER_KEY_INDEPENDENCE (short-timeout variant, for the mutation-probe)', async () => {
    const { adapter, cleanup } = await makeAdapter();
    try {
      const cases = fencedTraceBufferContract(adapter);
      const target = cases.find(
        (c) => c.law === 'PER_KEY_INDEPENDENCE' && c.name.includes('disjoint-run'),
      );
      expect(target).toBeDefined();
      await target!.run();
    } finally {
      await cleanup();
    }
  }, 3000);
});
