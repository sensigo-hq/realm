// redaction-printers.test.ts — GHSA-gxfq: the list of forms (`variantsOf`) hides every form the listed
// printers REALLY write. The fixture (`../test-support/printer-captures/printer-captures.json`, written
// by that folder's `generate.mjs`) holds each printer's real output on each FAKE case, run here or in a
// container pinned by digest, plus one SEPARATING row per member and structural part.
//
// Each row's output is hidden through core's PUBLIC law (#729 PR-3: `compileDisclosure`/`disclose`;
// the list of forms moved into core with the law), the row's value a declared secret (its parts too)
// at the declared tier, and the independent oracle (`leakedForms`, which imports no production code)
// then searches the hidden output, decoded, for each of the row's anchors and hand-written lines. P1
// runs a second time without parts (an environment value, every tier), on every row but the part
// printers' whose value is at or above the environment floor. P2 — the separating rows, which need
// the list's internal `omit` seam — lives beside the list, in core's `redaction-variants.test.ts`.
//
// A failure prints the printer, the case, the source, the runtime and the oracle's `{ path, decoders }`
// pairs per anchor or line — never a value, an anchor's text or a redaction set. Each cell names (a)
// the change that turns it red and (b) what it prints.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { compileDisclosure, disclose, DISCLOSURE_FLOORS, type DisclosureSet } from '@sensigo/realm';
import { leakedForms } from '../test-support/redaction-oracle.js';

interface Row {
  printer: string;
  case: string;
  value: string;
  output: string;
  source: string;
  runtime: string;
  anchors: string[];
  lines?: string[];
  member?: string;
}

const FIXTURE = JSON.parse(
  readFileSync(
    new URL('../test-support/printer-captures/printer-captures.json', import.meta.url),
    'utf8',
  ),
) as { rows: Row[] };
const ROWS = FIXTURE.rows;

/** How a row's value is expanded: as a declared secret (its parts too), or an environment value. */
interface Expand {
  readonly parts: boolean;
}
const DECLARED: Expand = { parts: true };

/** Each value's set, built once per value and expansion. */
const SETS = new Map<string, DisclosureSet>();
function hidden(row: Row, expand: Expand): string {
  const key = JSON.stringify([row.value, expand.parts]);
  let set = SETS.get(key);
  if (set === undefined) {
    set = compileDisclosure(
      [{ value: row.value, source: expand.parts ? 'declared:ROW' : 'env:ROW' }],
      { declared: 'resolved', audience: 'agent', environment: 'swept' },
    ).set;
    SETS.set(key, set);
  }
  // A declared value at the declared tier: the members alone, no pattern. An environment value
  // needs every tier (`all`), so a pattern can add hiding there — never remove it.
  return disclose(row.output, set, expand.parts ? 'declared' : 'all').text;
}

/** What a row's check prints: where it stands, whether the marker is there, and the oracle's pairs. */
function verdict(row: Row, expand: Expand = DECLARED) {
  const out = hidden(row, expand);
  const checks: Array<[string, string]> = [
    ...row.anchors.map((x, i): [string, string] => [`anchor ${i + 1}`, x]),
    ...(row.lines ?? []).map((x, i): [string, string] => [`line ${i + 1}`, x]),
  ];
  return {
    printer: row.printer,
    case: row.case,
    source: row.source,
    runtime: row.runtime,
    marker: out.includes('[REDACTED]'),
    leaks: checks.flatMap(([check, x]) => leakedForms(out, x).map((hit) => ({ check, ...hit }))),
  };
}
const HIDDEN = (row: Row) => ({
  printer: row.printer,
  case: row.case,
  source: row.source,
  runtime: row.runtime,
  marker: true,
  leaks: [],
});

describe('the printer captures (GHSA-gxfq correction)', () => {
  it('the fixture: every row executed, one row per printer and case', () => {
    const keys = ROWS.map((r) => `${r.printer} x ${r.case}`);
    // (a) red when a row is not executed or a printer/case pair appears twice (a generator fault).
    //     (b) prints the counts.
    expect({
      notExecuted: ROWS.filter((r) => r.source !== 'executed').length,
      duplicates: keys.length - new Set(keys).size,
      checkless: ROWS.filter((r) => r.anchors.length + (r.lines ?? []).length === 0).length,
    }).toEqual({ notExecuted: 0, duplicates: 0, checkless: 0 });
  });

  it("P1's positive control: the rows whose checks cannot see the value before hiding", () => {
    // On the UNREDACTED output, each row's anchors and lines must be visible to the oracle, or P1
    // on that row rests on the marker alone. These five cannot be seen, each for its reason:
    const UNSEEN = [
      // Perl writes `p@ss` as `p\@ss`, and `mixed`'s only anchor is `p@ss`.
      'perl.Dumper x mixed',
      'perl.Dumper_Useqq x mixed',
      // The part after `&` holds no `p@ss`.
      'gh.PowerShellPostAmpersandEscape x mixed',
      // The shift drops `p`, so the anchor's bytes no longer start a base64 group.
      'gh.Base64StringEscapeShift1 x mixed',
      'gh.Base64StringEscapeShift2 x mixed',
    ];
    const unseen = ROWS.filter((r) =>
      [...r.anchors, ...(r.lines ?? [])].every((x) => leakedForms(r.output, x).length === 0),
    ).map((r) => `${r.printer} x ${r.case}`);
    // (a) red when a row's checks stop seeing its own unredacted output (an anchor a printer
    //     rewrites, a decoder the oracle lost), or one of the five becomes visible. (b) prints the
    //     printer x case list.
    expect(unseen).toEqual(UNSEEN);
  }, 30_000);

  // P1 — every row is hidden: the marker is there, and no anchor or hand-written line is left in any
  // form the oracle decodes (raw, JSON, URL, base64, base64url, hex).
  // (a) red when the list lacks a form a printer writes for that value: delete one member (the row
  //     of that member's separating value goes red; see break-members.mjs), or take the shorter
  //     list of an earlier build of this fix. (b) prints the printer, the case, the source, the
  //     runtime and the oracle's pairs.
  // #729 PR-3: a declared value under the declared floor (4 characters) is `unmaskable` by design —
  // reported at load (I8), never hidden — so its rows (`boollike`'s `yes`) leave this cell.
  it.each(ROWS.filter((r) => r.value.length >= DISCLOSURE_FLOORS.declared))(
    'P1 — $printer x $case ($runtime)',
    (row) => {
      expect(verdict(row)).toEqual(HIDDEN(row));
    },
  );

  // P1 without parts — the same rows, each value expanded as an ENVIRONMENT value (no parts), but the
  // part printers' rows: they write a part, which only a declared secret's list holds.
  // (a) red when a member's form leaves the environment value's list while a part still hides the
  //     row's anchors with parts on: remove J4a, J5, J10, Q9b, Q10, X1 or X5 (their rows on `mixed`
  //     and `tdq` turn red here only). (b) prints the same verdict as P1.
  const PART_PRINTERS = new Set([
    'gh.TrimDoubleQuotes',
    'gh.PowerShellPreAmpersandEscape',
    'gh.PowerShellPostAmpersandEscape',
    'msu.UnescapeBackslashes',
    'jenkins.Bash.unquoted',
    'jenkins.Bash.all',
    'jenkins.Batch',
  ]);
  // #729 PR-3: an environment value under the floor (8 characters, the owner's Q2) is not swept at
  // all, so its rows leave this cell; the declared P1 above keeps every row.
  it.each(
    ROWS.filter(
      (r) => !PART_PRINTERS.has(r.printer) && r.value.length >= DISCLOSURE_FLOORS.environment,
    ),
  )('P1 without parts — $printer x $case ($runtime)', (row) => {
    expect(verdict(row, { parts: false })).toEqual(HIDDEN(row));
  });

  it('P3 — the JSON layers: Python repr inside JSON, and JSON inside JSON', () => {
    const row = (printer: string, kase: string): Row => {
      const found = ROWS.find((r) => r.printer === printer && r.case === kase);
      if (found === undefined) throw new Error(`fixture: no ${printer} x ${kase} row`);
      return found;
    };
    // (a) red when E1 is removed (the repr row), or E1 and E2 together (the json.dumps-twice row:
    //     E1 over the other members rebuilds E2's strings on this value). (b) prints both verdicts.
    expect([
      verdict(row('py.json_of_repr', 'dq_bs')),
      verdict(row('py.json_dumps_twice', 'e_acute')),
    ]).toEqual([
      HIDDEN(row('py.json_of_repr', 'dq_bs')),
      HIDDEN(row('py.json_dumps_twice', 'e_acute')),
    ]);
  });

  it('P4 — the lines: a multi-line value Node prints split into one literal per line', () => {
    const row = ROWS.find((r) => r.printer === 'node.inspect_obj' && r.case === 'multi');
    if (row === undefined) throw new Error('fixture: no node.inspect_obj x multi row');
    // Witness: util.inspect wrote the value as literals joined by `+`, one per line. (b) prints a
    //     boolean.
    expect(row.output.includes("' +\n")).toBe(true);
    // (a) red when LINES is removed: the middle line's escape-free fragment stays. (b) prints the
    //     verdict.
    expect(verdict(row)).toEqual(HIDDEN(row));
  });
});
