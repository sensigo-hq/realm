// evidence-hash.ts — issue #616 (unit 6c, by the design owner's ruling of 2026-11-05): the one hash of
// an evidence entry, the value stored beside it in `evidence.entry_sha256`. The write path stores it
// (unit 10), the schema ladder re-checks every entry against it after each step, and `realm db check`
// recomputes it; each imports it from here, so the three can never hash differently.
import { createHash } from 'node:crypto';

/** The sha256, in lowercase hex, of an evidence entry's text as stored (its UTF-8 bytes). */
export function evidenceEntrySha256(entryText: string): string {
  return createHash('sha256').update(entryText, 'utf8').digest('hex');
}
