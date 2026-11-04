// dedup-store.ts — #616 B1: the store `realm listen` asks whether it has already seen a webhook
// (at-least-once delivery: the same event can arrive twice). The interface lives in the core so a
// store in another package (SQLite) implements it; the CLI's file and in-memory stores implement it.
// Every method returns a promise: a store that reads a database answers later, never in the call.

export interface DedupStore {
  /**
   * Resolves true if the key has been seen within its TTL window. `ttlMs` is required by the file
   * store (it determines how many hour-buckets to scan back); the in-memory store ignores it because
   * expiry is stored at record time. It is typed optional here so both implementations satisfy this
   * contract.
   */
  check(key: string, ttlMs?: number): Promise<boolean>;
  /** Records the key as seen for the given TTL; resolves when recorded. */
  record(key: string, ttlMs: number): Promise<void>;
  /** Removes entries older than maxAgeMs; resolves when done. */
  cleanup(maxAgeMs: number): Promise<void>;
}
