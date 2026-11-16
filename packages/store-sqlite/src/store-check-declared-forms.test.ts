// store-check-declared-forms.test.ts — the filter-mask fix, PR 2: the check's `declared_forms` check
// (`check({ declaredValues })`, `store-check-forms.ts`). Each stored place that holds a CHANGED form of
// a declared value (upper-cased, lower-cased, capitalised, title-cased, or `<prefix>…` from `truncate`)
// is one `changed_form_of_declared_value` finding naming the run, the field and the kind, never the
// value; the raw value, a bare prefix and a value under 8 characters are never a hit; without the
// option nothing of the check is in the report.
//
// The home is made by the store package's own open, its runs by its run store; the rows of the other
// tables are planted on a second connection. The values are made up for these cells and are never
// printed: a failure prints the findings, which carry none.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type DatabaseLike } from './driver.js';
import { openRealmHome, openRealmHomeForMaintenance } from './index.js';
import { openMaintenance } from './maintenance.js';
import type { CheckOptions, CheckReport } from './store-check.js';
import { openForeignConnection } from './test-support/foreign-connection.js';

/** Made-up declared values: mixed case, a lower-case start, one with spaces, one too short. */
const MIXED = ['Fake', 'Scan', 'Value', 'Alpha', '01'].join('-');
const LOWER_START = ['fake', 'scan', 'value', 'beta', '02'].join('-');
const SPACED = ['fake', 'scan', 'value', 'gamma'].join(' ');
const SHORT = 'shrt7xy';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A home with `runs` runs made by the store's own run store; their ids. */
async function homeWith(runs: number): Promise<{ home: string; ids: string[] }> {
  const root = mkdtempSync(join(tmpdir(), 'realm-fm-scan-'));
  roots.push(root);
  const home = join(root, '.realm');
  const h = await openRealmHome({ home });
  const ids: string[] = [];
  try {
    for (let i = 0; i < runs; i += 1) {
      const { record } = await h.runStore.create({
        workflowId: 'scan',
        workflowVersion: 1,
        params: {},
        extensionIdentity: [],
      });
      ids.push(record.id);
    }
  } finally {
    h.close();
  }
  return { home, ids };
}

/** Sets a run's open question through the run store: `resolved_message` and `preview` as given. */
async function question(
  home: string,
  id: string,
  resolved: string,
  preview: Record<string, unknown>,
): Promise<void> {
  const h = await openRealmHome({ home });
  try {
    const { record } = await h.runStore.get(id);
    await h.runStore.update({
      ...record,
      pending_gate: {
        gate_id: 'g-scan',
        step_name: 'review',
        preview,
        choices: ['approve', 'reject'],
        opened_at: record.created_at,
        resolved_message: resolved,
      },
    });
  } finally {
    h.close();
  }
}

/** Plants rows on a second connection, in one transaction. */
async function plant(
  home: string,
  ...statements: ReadonlyArray<[string, unknown[]]>
): Promise<void> {
  const c = await openForeignConnection(home);
  try {
    c.exec('BEGIN');
    for (const [sql, params] of statements) c.prepare(sql).run(...params);
    c.exec('COMMIT');
  } finally {
    c.close();
  }
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

async function report(home: string, options?: CheckOptions): Promise<CheckReport> {
  const h = await openRealmHomeForMaintenance({ home, verb: 'check' });
  try {
    return await h.check(options);
  } finally {
    h.close();
  }
}

/** The report's `declared_forms` findings, without their message (checked once, below). */
const declared = (r: CheckReport): Array<Record<string, unknown>> =>
  r.findings
    .filter((f) => f.check === 'declared_forms')
    .map(({ run_id, path, kind, code }) => ({ run_id, path, kind, code }));

/** Every place the report names the check or its two `not_checked` entries. */
const mentions = (r: CheckReport): string[] =>
  [
    ...r.findings.map((f) => f.check),
    ...r.not_run.map((n) => n.check),
    ...r.not_checked.map((n) => n.check),
  ].filter((id) => id.startsWith('declared_forms'));

/** Whether `text` holds a value, or its upper-case, lower-case or 8-character start, in any case. */
const holdsAValue = (text: string): boolean =>
  [MIXED, LOWER_START, SPACED].some((value) =>
    [value, value.toUpperCase(), value.toLowerCase(), value.slice(0, 8)].some((form) =>
      text.includes(form),
    ),
  );

describe('the filter-mask fix, PR 2 — `declared_forms`: the runs that hold a changed form of a declared value', () => {
  it('(1, 2) the upper-cased form in the open question is one finding naming the run, the field and the kind; the raw value in its preview is none', async () => {
    // (1) red when the upper-cased form is not found, the raw form is counted (a second finding), or
    //     the finding names a value; (2) prints the findings.
    const { home, ids } = await homeWith(1);
    await question(home, ids[0]!, `Ship ${MIXED.toUpperCase()}?`, { note: MIXED });
    const r = await report(home, { declaredValues: [MIXED] });
    const found = r.findings.filter((f) => f.check === 'declared_forms');
    expect({
      found: declared(r),
      message: found[0]?.message,
      leaks: holdsAValue(JSON.stringify(r)),
    }).toEqual({
      found: [
        {
          run_id: ids[0],
          path: 'pending_gate.resolved_message',
          kind: 'upper-cased',
          code: 'changed_form_of_declared_value',
        },
      ],
      message: `run ${ids[0]}: pending_gate.resolved_message holds the upper-cased form of a declared value — rotate it and purge the run`,
      leaks: false,
    });
  });

  it('(3) each kind in each column: lower-cased in evidence, capitalised in the trace buffer, title-cased in a sealed trace, truncated in a refused answer, upper-cased in a write-once field', async () => {
    // (1) red when a column is not scanned, a kind is misread (title-cased read as capitalised on a
    //     value with spaces), or a place is named in another grammar; (2) prints the findings.
    const { home, ids } = await homeWith(1);
    const id = ids[0]!;
    const evidence = JSON.stringify({
      kind: 'gate_response',
      gate_message: `Was ${MIXED.toLowerCase()} right?`,
    });
    const capitalised = LOWER_START.charAt(0).toUpperCase() + LOWER_START.slice(1);
    const titled = SPACED.replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1));
    await plant(
      home,
      [
        'INSERT INTO evidence (run_id, seq, entry, entry_sha256) VALUES (?, ?, ?, ?)',
        [id, 1, evidence, sha(evidence)],
      ],
      [
        'INSERT INTO trace_buffer (run_id, step_id, line_seq, ts, nonce, entries, entry_count, bytes) VALUES (?, ?, ?, ?, NULL, ?, 1, 10)',
        [id, 'step-a', 1, 0, JSON.stringify([{ tool: 'x', said: capitalised }])],
      ],
      [
        'INSERT INTO trace_sealed (run_id, step_id, seal_seq, lines, bytes) VALUES (?, ?, ?, ?, 10)',
        [id, 'step-b', 1, JSON.stringify([JSON.stringify({ said: titled })])],
      ],
      [
        'INSERT INTO failed_attempts (run_id, seq, line) VALUES (?, ?, ?)',
        [id, 1, JSON.stringify({ error: `too long: ${MIXED.slice(0, 10)}…` })],
      ],
      [
        'INSERT INTO run_blobs (run_id, name, value) VALUES (?, ?, ?)',
        [id, 'fm_probe', JSON.stringify({ shown: MIXED.toUpperCase() })],
      ],
    );
    const r = await report(home, { declaredValues: [MIXED, LOWER_START, SPACED] });
    expect(declared(r).map(({ path, kind }) => `${String(path)} — ${String(kind)}`)).toEqual([
      'evidence seq 1: gate_message — lower-cased',
      'run_blobs fm_probe — upper-cased',
      'trace_buffer step-a line 1 — capitalised',
      'trace_sealed step-b seal 1 — title-cased',
      'failed_attempts seq 1 — truncated',
    ]);
  });

  it('(3) never a hit: a bare 10-character prefix without the marker, the raw value, and a value under 8 characters (which makes no form); the two `not_checked` entries are listed', async () => {
    // (1) red when a bare prefix or the raw value is reported, or a short value makes forms, or the
    //     two entries are missing while the check ran; (2) prints the findings and the entries.
    const { home, ids } = await homeWith(1);
    await question(home, ids[0]!, `Prefix ${MIXED.slice(0, 10)} and ${SHORT.toUpperCase()}`, {
      note: MIXED,
    });
    const r = await report(home, { declaredValues: [MIXED, SHORT] });
    expect({
      found: declared(r),
      notChecked: r.not_checked.filter((n) => n.check.startsWith('declared_forms')),
    }).toEqual({
      found: [],
      notChecked: [
        {
          check: 'declared_forms_short',
          why: 'A declared value shorter than 8 characters is not looked for in a changed form.',
        },
        {
          check: 'declared_forms_replace_split',
          why: 'A part of a declared value made by the replace or split filter is not looked for: such parts cannot be listed.',
        },
      ],
    });
  });

  it('a truncated case form (`upper | truncate`) is truncated; a form equal to another is named once, under the first kind', async () => {
    // (1) red when an upper-cased start with the marker is not found, or a value without spaces is
    //     reported both capitalised and title-cased; (2) prints the findings.
    const { home, ids } = await homeWith(2);
    await question(home, ids[0]!, `${MIXED.toUpperCase().slice(0, 12)}…`, {});
    const capitalised = LOWER_START.charAt(0).toUpperCase() + LOWER_START.slice(1);
    await question(home, ids[1]!, capitalised, {});
    const r = await report(home, { declaredValues: [MIXED, LOWER_START] });
    expect(
      declared(r).map(({ run_id, kind }) => [run_id === ids[0] ? 'first' : 'second', kind]),
    ).toEqual([
      ['first', 'truncated'],
      ['second', 'capitalised'],
    ]);
  });

  it('(4) without declared values: nothing of the check anywhere in the report, which is as it was', async () => {
    // (1) red when the check, its code or its two entries appear without the option, or the option
    //     changes another part of the report; (2) prints the mentions.
    const { home, ids } = await homeWith(1);
    await question(home, ids[0]!, MIXED.toUpperCase(), {});
    const without = await report(home);
    const withIt = await report(home, { declaredValues: [MIXED] });
    // Everything but the check's own entries, and the status they set.
    const rest = (r: CheckReport) => ({
      ...r,
      status: undefined,
      facts: { ...r.facts, wal_frames: 0, wal_frames_copied: 0, wal_bytes: 0 },
      findings: r.findings.filter((f) => f.check !== 'declared_forms'),
      not_checked: r.not_checked.filter((n) => !n.check.startsWith('declared_forms')),
    });
    expect({
      without: mentions(without),
      status: without.status,
      sameOtherwise: JSON.stringify(rest(without)) === JSON.stringify(rest(withIt)),
    }).toEqual({ without: [], status: 'ok', sameOtherwise: true });
  });

  it('the data checks stopped (a file an older Realm wrote): `declared_forms` is not run, because of the same finding', async () => {
    // (1) red when the check runs on a file whose data checks are stopped, or is left out of
    //     `not_run`; (2) prints `not_run`.
    const { home } = await homeWith(1);
    const c = await openForeignConnection(home);
    try {
      c.exec('PRAGMA user_version = 1');
    } finally {
      c.close();
    }
    const r = await report(home, { declaredValues: [MIXED] });
    const records = r.not_run.find((n) => n.check === 'records');
    expect({
      records: records?.because,
      declared: r.not_run.find((n) => n.check === 'declared_forms')?.because,
      found: declared(r),
    }).toEqual({ records: 'older_version', declared: 'older_version', found: [] });
  });
  it('correction 1 (1): a file the check cannot open (`open_failed`, `header_damaged`) lists `declared_forms` under not_run once with the option, and not at all without it', async () => {
    // (1) red when the derived lists of an open's or a header's failure name the check (present
    //     without the option, twice with it); (2) prints each report's not_run checks.
    const { home } = await homeWith(1);
    let error: unknown;
    try {
      openDatabase(join(home, 'absent.db'), { readOnly: true });
    } catch (err) {
      error = err;
    }
    const openFile = (): DatabaseLike => {
      throw error;
    };
    const opened = async (options?: CheckOptions): Promise<CheckReport> => {
      const m = await openMaintenance({ home, verb: 'check' }, { openFile });
      try {
        return await m.check(options);
      } finally {
        m.close();
      }
    };
    const junk = join(mkdtempSync(join(tmpdir(), 'realm-fm-scan-junk-')), '.realm');
    roots.push(dirname(junk));
    mkdirSync(junk);
    writeFileSync(join(junk, 'realm.db'), Buffer.alloc(8192, 0x41));
    const named = (r: CheckReport): string[] =>
      r.not_run.filter((n) => n.check === 'declared_forms').map((n) => n.because);
    expect({
      openWithout: named(await opened()),
      openWith: named(await opened({ declaredValues: [MIXED] })),
      headerWithout: named(await report(junk)),
      headerWith: named(await report(junk, { declaredValues: [MIXED] })),
    }).toEqual({
      openWithout: [],
      openWith: ['open_failed'],
      headerWithout: [],
      headerWith: ['header_damaged'],
    });
  });

  it("correction 1 (2): a key is not searched, and a key that is a declared value is written `[key]` in a hit's path; no finding holds the value in any form", async () => {
    // (1) red when keys are searched (the key that is the upper-cased value is a hit), or a hit's
    //     path is built from a key that holds the value (the message and the path carry it); (2)
    //     prints the findings with the value written `<FAKE>`.
    const { home, ids } = await homeWith(1);
    const id = ids[0]!;
    const keyed = JSON.stringify({ [MIXED.toUpperCase()]: 'a plain value' });
    const under = JSON.stringify({ tokens: { [MIXED]: `Ship ${MIXED.toLowerCase()}?` } });
    await plant(
      home,
      [
        'INSERT INTO evidence (run_id, seq, entry, entry_sha256) VALUES (?, ?, ?, ?)',
        [id, 1, keyed, sha(keyed)],
      ],
      [
        'INSERT INTO evidence (run_id, seq, entry, entry_sha256) VALUES (?, ?, ?, ?)',
        [id, 2, under, sha(under)],
      ],
    );
    const r = await report(home, { declaredValues: [MIXED] });
    const found = r.findings.filter((f) => f.check === 'declared_forms');
    const shown = JSON.stringify(found);
    expect(
      {
        found: declared(r).map(({ path, kind }) => `${String(path)} — ${String(kind)}`),
        leaks: holdsAValue(shown),
      },
      [MIXED, MIXED.toUpperCase(), MIXED.toLowerCase()].reduce(
        (t, f) => t.split(f).join('<FAKE>'),
        shown,
      ),
    ).toEqual({ found: ['evidence seq 2: tokens.[key] — lower-cased'], leaks: false });
  });
});
