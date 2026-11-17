// Fix 1, the `default` piece — a bare number or true/false given to `| default` keeps its type, so
// `{{ amount | default: 0 | round: 2 }}` with `amount` missing renders `0.00`; in quotes the fallback
// stays text. One parse carries a per-argument quote flag to every reader (`renderTemplate`, `display`,
// the 3a-i and 3a-ii-a checks); a direct `applyFilter` call with no flags keeps today's result.
//
// Each cell names the break that turns it red (prompts/ai-authoring-fix1-default-typed.md).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyFilter, renderTemplate } from './render-template.js';
import { renderDisplay } from './question-view.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const flat = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8').replace(/\s+/g, ' ');

/** A strict render of `template` over the run's params. */
function render(template: string, runParams: Record<string, unknown> = {}): string {
  return renderTemplate(template, { evidenceByStep: {}, runParams }, { strict: true });
}

describe('fix 1, the default piece — a bare number or true/false keeps its type', () => {
  it('check 1: the refund example — `| default: 0 | round: 2` with the value missing gives 0.00, in a render and in display', () => {
    // (1) red when the quote flags are dropped (every argument read as quoted: round gets "0"); (2)
    // prints both.
    expect({
      render: render('Refund {{ run.params.amount | default: 0 | round: 2 }}'),
      display: renderDisplay('Refund {{ amount | default: 0 | round: 2 }}', {}),
    }).toEqual({ render: 'Refund 0.00', display: 'Refund 0.00' });
  });

  it('check 2: a quoted fallback stays text — the placeholder is left as written', () => {
    // (1) red when quotes are ignored (the quoted 0 typed); (2) prints both renders.
    expect({
      single: render("R {{ run.params.amount | default: '0' | round: 2 }}"),
      double: render('R {{ run.params.amount | default: "0" | round: 2 }}'),
    }).toEqual({
      single: "R {{ run.params.amount | default: '0' | round: 2 }}",
      double: 'R {{ run.params.amount | default: "0" | round: 2 }}',
    });
  });

  it('check 3: the literal set — JSON numbers and true/false typed; 007, null and abc stay text', () => {
    // (1) red when a non-JSON number is typed (`007` read as 7) or `null` typed (the placeholder
    // left); (2) prints each render.
    expect({
      trueRaw: render('{{ run.params.x | default: true }}'),
      trueGoesOn: render('{{ run.params.x | default: true | yesno: "on", "off" }}'),
      falseGoesOn: render('{{ run.params.x | default: false | yesno: "on", "off" }}'),
      oneFifty: render('{{ run.params.x | default: 1.50 }}'),
      twoE3: render('{{ run.params.x | default: 2e3 }}'),
      minusThree: render('{{ run.params.x | default: -3 }}'),
      zeroPadded: render('{{ run.params.x | default: 007 }}'),
      zeroPaddedIsText: render('{{ run.params.x | default: 007 | round: 2 }}'),
      nullIsText: render('{{ run.params.x | default: null | upper }}'),
      abcIsText: render('{{ run.params.x | default: abc | upper }}'),
    }).toEqual({
      trueRaw: 'true',
      trueGoesOn: 'on',
      falseGoesOn: 'off',
      oneFifty: '1.5',
      twoE3: '2000',
      minusThree: '-3',
      zeroPadded: '007',
      zeroPaddedIsText: '{{ run.params.x | default: 007 | round: 2 }}',
      nullIsText: 'NULL',
      abcIsText: 'ABC',
    });
  });

  it('check 4: a value that is there is used, never the fallback', () => {
    // (1) red when the fallback is used with the value present; (2) prints the render.
    expect(render('{{ run.params.amount | default: 0 | round: 2 }}', { amount: 1.239 })).toBe(
      '1.24',
    );
  });

  it('check 6: no other filter reads types — an unquoted `join` separator stays text', () => {
    // (1) red when every filter's unquoted arguments are typed (`1.50` read as 1.5: `a1.5b`); (2)
    // prints the render.
    expect(render('{{ run.params.tags | join: 1.50 }}', { tags: ['a', 'b'] })).toBe('a1.50b');
  });

  it('check 7: a direct applyFilter call with no flags keeps today’s result (the fallback is text)', () => {
    // (1) red when absent flags are read as unquoted; (2) prints the results.
    expect({
      noFlags: applyFilter(undefined, 'default', ['0']),
      unquoted: applyFilter(undefined, 'default', ['0'], 'stored', [false]),
      quoted: applyFilter(undefined, 'default', ['0'], 'stored', [true]),
    }).toEqual({
      noFlags: { ok: true, value: '0' },
      unquoted: { ok: true, value: 0 },
      quoted: { ok: true, value: '0' },
    });
  });

  it('check 9: the words — the templates page, the CHANGELOG line and Upgrading item 13', () => {
    const page = flat('docs/reference/workflow/input-map-and-templates.md');
    const log = flat('CHANGELOG.md');
    // (1) red when a sentence is missing or changed, or the old "take its text" stays; (2) prints them.
    expect({
      page: page.includes(
        'An argument that contains a space or a comma goes in quotes. Written without quotes, a number (`0`, `-3`, `1.5`, `2e3`; `007` stays text), `true` or `false` given to `default` keeps its type, so `| default: 0 | round: 2` gives `0.00`; in quotes it is text. Quote a long code: a whole number of more than 15 digits can lose its last digits.',
      ),
      value: page.includes('the filters after it take its value'),
      oldText: [page, log, flat('docs/reference/workflow/loader-diagnostics.md')].some((t) =>
        t.includes('the filters after it take its text'),
      ),
      changed: log.includes(
        "- **`| default: 0` gives the number 0, and `| default: true` the value true, so a filter that needs a number can follow it**; in quotes the fallback stays text, as before, and so does a leading-zero spelling such as `007`. A bare number prints the way that number prints: `default: 1.50` prints `1.5`, `default: 2e3` prints `2000`, and a whole number of more than 15 digits can lose its last digits, so quote a long code. A text filter after a bare number or true/false (`default: 0 | upper`) no longer applies; `realm workflow validate` reports it in an approval question, `display`, a prompt or step instructions where the workflow declares the path's shape.",
      ),
      upgrading: log.includes(
        "**13. A bare number or true/false given to `| default` keeps its type, in stored workflows too.** If a template follows one with a filter that takes only text, quote the fallback (`default: '0' | upper`). `realm workflow validate` (`--registered <id>` for a stored one) names such a chain in an approval question, `display`, a prompt or step instructions when the workflow declares the path's shape; look for one yourself in paths it lists as not checked.",
      ),
    }).toEqual({ page: true, value: true, oldText: false, changed: true, upgrading: true });
  });
});
