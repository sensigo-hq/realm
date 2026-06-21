// Dedup stores — at-least-once duplicate suppression for webhook events.
// FileDedupStore survives process restarts; InMemoryDedupStore does not.
import { createHash } from 'node:crypto';
import { mkdirSync, openSync, closeSync, statSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export interface DedupStore {
  /**
   * Returns true if the key has been seen within its TTL window.
   * `ttlMs` is required by FileDedupStore (it determines how many hour-buckets to
   * scan back); InMemoryDedupStore ignores it because expiry is stored at record
   * time. It is typed optional here so both implementations satisfy this contract.
   */
  check(key: string, ttlMs?: number): boolean;
  /** Records the key as seen for the given TTL. */
  record(key: string, ttlMs: number): void;
  /** Removes entries older than maxAgeMs. For InMemoryDedupStore, evicts expired entries. */
  cleanup(maxAgeMs: number): void;
}

const ONE_HOUR_MS = 3_600_000;

/**
 * File-backed dedup store. Records are empty files whose mtime is the only data.
 * Layout: <baseDir>/<workflowId>/<YYYYMMDDHH>/<sha256(key)[:32]>.
 *
 * Safe across concurrent `realm listen` processes via O_EXCL (openSync 'wx').
 *
 * Note: `check` requires `ttlMs` in practice — it scans floor(ttlMs/3_600_000)+2
 * hour buckets. It is declared with a default of 0 only to satisfy the DedupStore
 * interface (which types ttlMs as optional); real callers always pass the TTL.
 */
export class FileDedupStore implements DedupStore {
  private readonly dir: string;
  private lastCleanupErrorAt = 0;

  constructor(baseDir: string, workflowId: string) {
    this.dir = join(baseDir, workflowId);
  }

  private hashKey(key: string): string {
    return createHash('sha256').update(key).digest('hex').slice(0, 32);
  }

  private bucketName(ms: number): string {
    const d = new Date(ms);
    const year = String(d.getUTCFullYear()).padStart(4, '0');
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    const hour = String(d.getUTCHours()).padStart(2, '0');
    return `${year}${month}${day}${hour}`;
  }

  check(key: string, ttlMs = 0): boolean {
    const hash = this.hashKey(key);
    const now = Date.now();
    const buckets = Math.floor(ttlMs / ONE_HOUR_MS) + 2;
    for (let i = 0; i < buckets; i++) {
      const bucket = this.bucketName(now - i * ONE_HOUR_MS);
      const filePath = join(this.dir, bucket, hash);
      const stat = statSync(filePath, { throwIfNoEntry: false });
      if (stat !== undefined && now - stat.mtime.getTime() < ttlMs) {
        return true;
      }
    }
    return false;
  }

  record(key: string, _ttlMs: number): void {
    const hash = this.hashKey(key);
    const bucketDir = join(this.dir, this.bucketName(Date.now()));
    const filePath = join(bucketDir, hash);
    mkdirSync(bucketDir, { recursive: true });
    try {
      const fd = openSync(filePath, 'wx');
      closeSync(fd);
    } catch (err) {
      // Concurrent at-least-once delivery may race to create the same file.
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        return;
      }
      throw err;
    }
  }

  cleanup(maxAgeMs: number): void {
    try {
      const now = Date.now();
      let entries: string[];
      try {
        entries = readdirSync(this.dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return;
        }
        throw err;
      }
      for (const name of entries) {
        if (!/^\d{10}$/.test(name)) {
          continue;
        }
        const year = parseInt(name.slice(0, 4), 10);
        const month = parseInt(name.slice(4, 6), 10) - 1;
        const day = parseInt(name.slice(6, 8), 10);
        const hour = parseInt(name.slice(8, 10), 10);
        const bucketEndMs = new Date(Date.UTC(year, month, day, hour + 1)).getTime();
        if (bucketEndMs < now - maxAgeMs) {
          rmSync(join(this.dir, name), { recursive: true, force: true });
        }
      }
    } catch (err) {
      const now = Date.now();
      if (now - this.lastCleanupErrorAt >= 60_000) {
        this.lastCleanupErrorAt = now;
        console.error(`realm dedup cleanup error in ${this.dir}:`, err);
      }
    }
  }
}

export class InMemoryDedupStore implements DedupStore {
  private map: Map<string, number> = new Map(); // key → expiry timestamp

  check(key: string): boolean {
    this.evictExpired();
    const expiry = this.map.get(key);
    return expiry !== undefined && Date.now() < expiry;
  }

  record(key: string, ttlMs: number): void {
    this.map.set(key, Date.now() + ttlMs);
  }

  cleanup(_maxAgeMs: number): void {
    this.evictExpired();
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [k, expiry] of this.map) {
      if (now >= expiry) this.map.delete(k);
    }
  }
}
