// docs-sweep-963.test.ts — U3b (#963) (guardrail 7(f), 9): the sentence on `realm listen`'s page about
// what `--sweep-expired-gates` does, and the CHANGELOG line, quoted word for word and asserted to be
// there; the sentence they replace is asserted gone. Each clause is executed in the cell named beside
// it (`commands/listen-sweep-one-pass-963.test.ts` C1–C6; `commands/listen-serve-values-944.test.ts`,
// the built CLI's first pass one period after the start). Each assertion names (a) the change that
// turns it red and (b) what it prints: the page and the text.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const LISTEN = 'docs/reference/cli/realm-listen.md';
const flat = (t: string): string => t.replace(/\s+/g, ' ');
const read = (page: string): string => readFileSync(join(ROOT, page), 'utf8');
/** (a) red when the page no longer holds the text word for word; (b) prints the page and the text. */
function claim(page: string, text: string): void {
  expect(flat(read(page)), `${page} no longer says: ${text}`).toContain(flat(text));
}
/** (a) red when a text this unit made false is back on the page; (b) prints the page and the text. */
function gone(page: string, text: string): void {
  expect(flat(read(page)), `${page} says again: ${text}`).not.toContain(flat(text));
}

describe('U3b (#963) — realm-listen.md and the CHANGELOG', () => {
  it('the `--sweep-expired-gates` sentence', () => {
    // C1 (only the runs at a gate), the #944 built-CLI cell and C2 (once per interval, the first
    // one period after the start), C4a (a gate it has read is carried out when its time arrives),
    // C6 (a gate opened since is read at the next interval), C2 (one read at a time, one more after).
    claim(
      LISTEN,
      'With this flag, `realm listen` reads the runs in the store that are waiting at a gate, once per interval (the first time one interval after it starts), whether or not it started those runs, and carries out the gates whose time has passed. A gate it has read is carried out when its time arrives; a gate opened since, by any process, is read at the next interval, up to one interval late. It reads once at a time: a read still under way when the next is due is followed by one more read, not by several. This changed after version 0.49.0. When it carries out a gate, it logs:',
    );
    gone(LISTEN, 'looks through every run in the store at the given interval');
  });

  it('the CHANGELOG line under Fixed', () => {
    const all = read('CHANGELOG.md');
    const unreleased = all.slice(all.indexOf('## [Unreleased]'), all.indexOf('\n## [0.49.0]'));
    const fixed = unreleased.slice(unreleased.indexOf('### Fixed'));
    // C1, C2, C4a.
    expect(flat(fixed), 'the CHANGELOG no longer says the #963 line under Fixed').toContain(
      flat(
        "- **`realm listen --sweep-expired-gates` reads only the runs waiting at a gate, one pass at a time (issue #963).** Before, every pass read every run in the store, a pass started at each interval whether or not the last had ended, and each gate not yet due had a waiter of its own. Now a pass reads only the runs at a gate, a pass still running when the next is due is followed by one more, and one waiter on the store's clock wakes the sweeper at the earliest deadline it has read.",
      ),
    );
  });
});
