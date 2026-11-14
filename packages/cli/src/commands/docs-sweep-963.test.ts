// docs-sweep-963.test.ts — U3b (#963) (guardrail 7(f), 9): the sentence on `realm listen`'s page about
// what `--sweep-expired-gates` does, and the CHANGELOG line, quoted word for word and asserted to be
// there; the sentence they replace is asserted gone. Each clause is executed in the cell named beside
// it (`commands/listen-sweep-one-pass-963.test.ts` C1–C5, T1–T3; `commands/listen-serve-values-944.test.ts`,
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
    // one period after the start), C4a and T1 (a gate it has read is carried out when its time
    // arrives, an earlier one too), T1b (the store cannot be read then: the next interval), the
    // ELOCKED cell in `listen-sweep-expired-gates.test.ts` (another writer holds the run: skipped),
    // T2 (a gate opened after a read: the next interval, late), T3 (a workflow not registered here:
    // skipped at every pass), C2 (one read at a time, one more after).
    claim(
      LISTEN,
      'With this flag, `realm listen` reads the runs in the store that are waiting at a gate, once per interval (the first time one interval after it starts), whether or not it started those runs, and carries out the gates whose time has passed. A gate it has read is carried out when its time arrives, provided the store can be read then and no other writer is holding its run; otherwise it is carried out at the next interval. A gate that another process opens after a read is read at the next interval, so it can be up to one interval late. A gate whose workflow is not registered in this store is skipped at every pass. It reads once at a time: a read still under way when the next is due is followed by one more read, not by several. This changed after version 0.49.0. When it carries out a gate, it logs:',
    );
    gone(LISTEN, 'looks through every run in the store at the given interval');
    gone(LISTEN, 'a gate opened since, by any process');
  });

  it('the CHANGELOG line under Fixed', () => {
    const all = read('CHANGELOG.md');
    const unreleased = all.slice(all.indexOf('## [Unreleased]'), all.indexOf('\n## [0.49.0]'));
    const fixed = unreleased.slice(unreleased.indexOf('### Fixed'));
    // C1 (only the runs waiting at a gate), C2 (one more pass, not several), C4a (carried out when
    // its time arrives).
    expect(flat(fixed), 'the CHANGELOG no longer says the #963 line under Fixed').toContain(
      flat(
        '- **`realm listen --sweep-expired-gates` is lighter and its passes no longer overlap (issue #963).** Before, every pass read every run in the store, and a pass could start before the last one had ended. Now a pass reads only the runs waiting at a gate, and a pass that is still running when the next is due is followed by one more, not by several. A gate a pass has read is still carried out when its time arrives.',
      ),
    );
    expect(flat(fixed), 'the CHANGELOG says again the waiter wording').not.toContain(
      "one waiter on the store's clock wakes the sweeper",
    );
  });
});
