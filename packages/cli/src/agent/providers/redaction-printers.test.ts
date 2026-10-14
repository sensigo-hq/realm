// redaction-printers.test.ts — GHSA-gxfq: the list of forms (`variantsOf`) hides every form the listed
// printers REALLY write. The fixture (`../test-support/printer-captures/printer-captures.json`, written
// by that folder's `generate.mjs`) holds each printer's real output on each FAKE case, run here or in a
// container pinned by digest, plus one SEPARATING row per member and structural part.
//
// Each row's output is hidden with the row's value expanded as a declared secret (`parts: true`), and
// the independent oracle (`leakedForms`, which imports no production code) then searches the hidden
// output, decoded, for each of the row's anchors and hand-written lines. P1 runs a second time
// without parts (an environment value), on every row but the part printers'.
//
// A failure prints the printer, the case, the source, the runtime and the oracle's `{ path, decoders }`
// pairs per anchor or line — never a value, an anchor's text or a redaction set. Each cell names (a)
// the change that turns it red and (b) what it prints.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { redactWith, variantsOf } from './redaction-variants.js';
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

/** How a row's value is expanded: as a declared secret (`parts`), and with one member or layer left out. */
interface Expand {
  readonly parts: boolean;
  readonly omit?: string;
}
const DECLARED: Expand = { parts: true };

/** Each value's list, longest-first, built once per value and expansion. */
const SETS = new Map<string, string[]>();
function hidden(row: Row, expand: Expand): string {
  const key = JSON.stringify([row.value, expand.parts, expand.omit ?? null]);
  let set = SETS.get(key);
  if (set === undefined) {
    set = variantsOf(row.value, expand).sort((a, b) => b.length - a.length);
    SETS.set(key, set);
  }
  return redactWith(row.output, set);
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
/** Whether a verdict is the hidden one. */
const equalsHidden = (v: ReturnType<typeof verdict>, row: Row): boolean =>
  JSON.stringify(v) === JSON.stringify(HIDDEN(row));

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
  });

  // P1 — every row is hidden: the marker is there, and no anchor or hand-written line is left in any
  // form the oracle decodes (raw, JSON, URL, base64, base64url, hex).
  // (a) red when the list lacks a form a printer writes for that value: delete one member (the row
  //     of that member's separating value goes red; see break-members.mjs), or take the shorter
  //     list of an earlier build of this fix. (b) prints the printer, the case, the source, the
  //     runtime and the oracle's pairs.
  it.each(ROWS)('P1 — $printer x $case ($runtime)', (row) => {
    expect(verdict(row)).toEqual(HIDDEN(row));
  });

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
  it.each(ROWS.filter((r) => !PART_PRINTERS.has(r.printer)))(
    'P1 without parts — $printer x $case ($runtime)',
    (row) => {
      expect(verdict(row, { parts: false })).toEqual(HIDDEN(row));
    },
  );

  // The member ids, read from `MEMBERS` in the source with break-members.mjs's own pattern, and the
  // layers outside it: E1, E2, LINES and D.
  const SOURCE = readFileSync(new URL('./redaction-variants.ts', import.meta.url), 'utf8');
  const MEMBERS_BLOCK = SOURCE.slice(
    SOURCE.indexOf('const MEMBERS'),
    SOURCE.indexOf('};', SOURCE.indexOf('const MEMBERS')),
  );
  const MEMBER_IDS = [
    ...[...MEMBERS_BLOCK.matchAll(/^ {2}(\w+): \w+,$/gm)].map((m) => m[1]!),
    ...['E1', 'E2', 'LINES', 'D'],
  ];
  const SEPARATING_ROWS = ROWS.filter((r) => r.member !== undefined);

  it('P2 — one separating row per member and per layer, the members read from MEMBERS', () => {
    const rowMembers = SEPARATING_ROWS.map((r) => r.member!);
    // (a) red when a member is added to MEMBERS (or a layer here) without a separating row, when a
    //     row names a member that is no longer there, or when a member has two rows or a row that is
    //     not executed. (b) prints the sorted id lists and the members without exactly one row.
    expect({
      members: [...MEMBER_IDS].sort(),
      rows: [...new Set(rowMembers)].sort(),
      notOne: MEMBER_IDS.filter(
        (m) =>
          SEPARATING_ROWS.filter((r) => r.member === m && r.source === 'executed').length !== 1,
      ),
    }).toEqual({ members: [...MEMBER_IDS].sort(), rows: [...MEMBER_IDS].sort(), notOne: [] });
  });

  // P2's property in CI: each separating row is NOT hidden once its own member (or layer) is left out
  // of the list (the `omit` seam). A member that makes another redundant turns its row red here.
  // (a) red when another member, a layer or a part starts writing the left-out member's form on its
  //     separating value. (b) prints the member, the printer and the verdict without the member.
  it.each(SEPARATING_ROWS)('P2 — $member separates: $printer x $case', (row) => {
    const without = verdict(row, { parts: true, omit: row.member! });
    expect({ member: row.member, separates: !equalsHidden(without, row) }).toEqual({
      member: row.member,
      separates: true,
    });
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
