// docs-filter-mask-scan.test.ts — the filter-mask fix, PR 2 (guardrails 7(f) and 9): every sentence the
// scan's PR writes is quoted here word for word and asserted to be on its page, read from the
// repository, with the cell that executes what it says named beside it. Each assertion names (1) the
// change that turns it red and (2) what it prints when it fails.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const PAGE = 'docs/reference/cli/realm-db.md';
const flat = (t: string): string => t.replace(/\s+/g, ' ');
const read = (page: string): string => readFileSync(join(ROOT, page), 'utf8');
/** (1) red when the page no longer holds the sentence word for word; (2) prints the sentence. */
function claim(page: string, sentence: string): void {
  expect(flat(read(page)), `${page} no longer says: ${sentence}`).toContain(flat(sentence));
}
/** The CHANGELOG's `[Unreleased]` section. */
function unreleased(): string {
  const text = read('CHANGELOG.md');
  const start = text.indexOf('## [Unreleased]');
  return text.slice(start, text.indexOf('\n## [', start + 1));
}
function claimChangelog(sentence: string): void {
  expect(flat(unreleased()), `the CHANGELOG no longer says: ${sentence}`).toContain(flat(sentence));
}

describe('the filter-mask fix, PR 2 — the words of `realm db check --project`', () => {
  it('the CHANGELOG: the Upgrading item and the Added line', () => {
    // db-check-declared-forms "(1, 2)" (the run and the field named), "(5)" (a secret that cannot be
    // resolved); store-check-declared-forms "(3)" (each kind, the `evidence seq <n>: gate_message`
    // grammar; the short value and replace/split not looked for); AA-FM-AUD2-11 (abandon, then
    // purge --force, deletes); correction 1: the walk (AA-FM-WALK2-*: a run waiting at its question
    // refuses abandon and purge until it is answered; the answered question's `gate_message` holds
    // the form until the purge), re-run by MA 1's lane as W6; the stored columns (AA-FM-AUD2-07, -13:
    // a provider's prompt and a Slack post are not stored).
    claimChangelog(
      "**8. If a template showed a declared secret through a filter, find the runs that hold it, then rotate it.** If a workflow template showed a declared secret through a filter (`upper`, `lower`, `capitalize`, `title`, `truncate`) before this version, the filtered form reached the question or the prompt (see Fixed). After item 4's migration, run `realm db check --project <your project folder>`: it names each stored run that holds such a form, and the field that holds it. Rotate those secrets and purge those runs: a run still waiting at its question is answered first (`realm run respond <id> --gate <gate id> --choice reject`; `realm run inspect <id>` shows the gate id, and the stored question as it was opened — the filtered form included), a run still in progress is abandoned first (`realm run abandon <id>`), then `realm run purge <id> --force`; until the run is purged the scan names the same form again, at the answered question's `evidence seq <n>: gate_message`. Run it before you rotate: it looks for your current declared values. Values under 8 characters, and forms made by `replace` or `split`, are not found. A form sent to a model provider or posted to Slack is not stored here: if such a template ran as an agent step's prompt or a Slack-notified gate, rotate that secret regardless.",
    );
    // The inventory row `realm db check --project — option, takes a value` (kept-surface-changelog).
    claimChangelog(
      '- **`realm db check --project`** `<dir>`: names the stored runs that hold a changed form of a declared value.',
    );
  });

  it('realm-db.md: the synopsis, what the flag scans and does not, its refusals, the JSON fields, the two entries', () => {
    // The command's own option (kept-surface inventory).
    claim(PAGE, '`realm db check [--json] [--project <dir>]`');
    // store-check-declared-forms "(1, 2)", "(3)" (each kind in each column), "a truncated case form".
    claim(
      PAGE,
      "With `--project <dir>`, it also names each stored run that holds, in a changed form, a secret that `<dir>/realm.yaml` declares: upper-cased, lower-cased, capitalised, title-cased, or its first 8 or more characters followed by `…` as the `truncate` filter cuts, in a run's record, its evidence, its write-once fields, its trace or its refused answers.",
    );
    // db-check-declared-forms "(1, 2)" (no form of the value printed; the raw value no finding);
    // store-check-declared-forms "(3) never a hit"; the scaffold's `use:` module does not exist and
    // the check runs (no project code).
    claim(
      PAGE,
      'It never prints the value, runs no project code, and does not look for a value under 8 characters, for a part made by the `replace` or `split` filter, or for the value itself, which every run that handled it holds by design.',
    );
    // db-check-declared-forms "(5)" (no realm.yaml; a secret that cannot be resolved); the invalid
    // manifest's refusal was met on the way (a manifest without `version`).
    claim(
      PAGE,
      'It refuses a folder with no `realm.yaml`, a `realm.yaml` that cannot be read or is invalid, and one that names a secret it cannot resolve, before it opens the store: nothing is scanned.',
    );
    // Correction 1: db-check-declared-forms "(5)" (the unresolved secret: the `Error:` line, then the
    // resolver's lines naming `${secret:MISSING_KEY}`, no value, then "Nothing was scanned.").
    claim(
      PAGE,
      "nothing on standard output — the `--project` refusal for a secret that cannot be resolved follows its `Error:` line with the resolver's lines naming each `${secret:NAME}`, never a value.",
    );
    // db-check-declared-forms "(1, 2)" (the JSON's run_id, path, kind).
    claim(
      PAGE,
      'A `changed_form_of_declared_value` finding also carries `run_id`, `path` (the field that holds the form) and `kind` (`upper-cased`, `lower-cased`, `capitalised`, `title-cased` or `truncated`), so a script can purge by `run_id`; none of them holds the value.',
    );
    // store-check-declared-forms "(3) never a hit" (the two entries, word for word).
    claim(
      PAGE,
      'With `--project`, two more: - A declared value shorter than 8 characters is not looked for in a changed form. - A part of a declared value made by the replace or split filter is not looked for: such parts cannot be listed.',
    );
    // The page's code table follows the store's list (db-check-616 "the page's code table").
    claim(
      PAGE,
      '| `changed_form_of_declared_value` | declared_forms | `run <id>: <path> holds the <kind> form of a declared value — rotate it and purge the run` | nothing |',
    );
  });
});
