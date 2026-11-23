// docs-callback-c3db.test.ts — R1.3 callback C3d-B: the sentences this unit added to the guide and the
// reading page, word for word (spaces folded), each with the cell that executes what it says. The
// Log lines rows and the How it stops sentence are pinned in docs-callback-c3c2 (cells 6 and 7); the
// `Callback:` blocks in docs-callback-c3c1 (cell 3) and delivery-pass-c3db (the built `inspect`).
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const GUIDE = 'docs/guides/webhooks.md';
const READING = 'docs/reference/cli/realm-run-reading.md';
const flat = (t: string): string => t.replace(/\s+/g, ' ');
/** (1) red when the page no longer holds the text word for word; (2) prints the text. */
function claim(page: string, text: string): void {
  expect(flat(readFileSync(join(ROOT, page), 'utf8')), `${page} no longer says: ${text}`).toContain(
    flat(text),
  );
}
const GLOSS =
  'After a try the line also says the attempt and, when the try got an answer, the last answer; a callback never tried says only when it fell due, and one that expired before a first try says `expired before its first try`.';

describe('C3d-B — the guide and the reading page', () => {
  it('the guide: after the cut try, what the stop says', () => {
    // Pinned by: listen-reminders-d3b 'C3d-B — the stop says what it waits for and what it cuts' (the wait line at the first signal; one cut line when the grace or a second signal ends the wait).
    claim(
      GUIDE,
      'ignore an id you have already handled. The stop says so: `waiting for <n> callback(s) to be sent` when it begins, and `<n> callback(s) were cut by the stop` if the grace or a second signal cuts a try.',
    );
  });
  it('the guide: the gloss of the Callback: lines gains the attempt, the answer, and the two never-tried forms', () => {
    // Pinned by: inspect-line-c3b1 'C3d-B — what a due callback waits for' (every form); delivery-pass-c3db 'the built `realm run inspect`' (a due row after a 503, a row the sweep ended before a try).
    claim(GUIDE, `an entry for the receiver. ${GLOSS}`);
  });
  it('the reading page: the same gloss sentence after the Callback: lines', () => {
    // Pinned by: as the guide's gloss.
    claim(READING, `\`waiting for the run to finish\` means the run has not ended. ${GLOSS}`);
  });
});
