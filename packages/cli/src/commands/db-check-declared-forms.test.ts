// db-check-declared-forms.test.ts — the filter-mask fix, PR 2: `realm db check --project <dir>` as an
// operator runs it after the upgrade, on the BUILT `realm` (tests run after the build), with PATH, HOME
// and REALM_NO_NUDGE only, in a scratch working folder. The project is a scratch folder with its own
// `realm.yaml` and `.env`, declaring a value made up for these cells; a run whose open question holds
// the value upper-cased (as a template's `| upper` stored it before the fix) is made through the store
// package's own run store. The cells check what the command prints, its exit code and its JSON; the
// store's cells (`packages/store-sqlite/src/store-check-declared-forms.test.ts`) pin each kind and
// column. The value is never printed: a failure prints the output with it replaced by `<FAKE>`.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails. The
// describe that starts the built CLI carries its own budget (spawn-budget-guard.test.ts).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRealmHome } from '@sensigo/realm-store-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_CLI = join(HERE, '..', '..', 'dist', 'index.js');

/** A made-up declared value, mixed case, never printed. */
const VALUE = ['Fake', 'Scan', 'Cli', 'Value', '77'].join('-');

let root = '';
let base = '';
let home = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'realm-fm-scan-home-'));
  base = mkdtempSync(join(tmpdir(), 'realm-fm-scan-cwd-'));
  home = join(root, '.realm');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
});

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function realm(args: string[]): Run {
  const r = spawnSync(process.execPath, [DIST_CLI, ...args], {
    cwd: base,
    env: { PATH: process.env['PATH'] ?? '', HOME: root, REALM_NO_NUDGE: '1' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    killSignal: 'SIGKILL',
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** The value's forms a leak would show: itself, upper-cased, lower-cased, its 8-character start. */
const FORMS = [VALUE, VALUE.toUpperCase(), VALUE.toLowerCase(), VALUE.slice(0, 8)];
/** `text` with every form of the value written `<FAKE>`, for a failure's print. */
const scrubbed = (text: string): string => FORMS.reduce((t, f) => t.split(f).join('<FAKE>'), text);
const leaks = (run: Run): boolean => FORMS.some((f) => `${run.stdout}${run.stderr}`.includes(f));

/** A project folder under the working folder: its `realm.yaml` declares `SCAN_KEY` from `.env`. */
function project(env: string, manifest?: string): string {
  const dir = join(base, 'project');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'realm.yaml'),
    manifest ??
      [
        'version: 1',
        'secrets:',
        '  sources: [dotenv]',
        'handlers:',
        '  fetch:',
        '    use: ./handlers.mjs#fetch',
        '    config:',
        "      key: '${secret:SCAN_KEY}'",
        '',
      ].join('\n'),
  );
  writeFileSync(join(dir, '.env'), env);
  return dir;
}

/** A store with one run whose open question holds the value upper-cased, its preview the raw value. */
async function storeWithTheForm(): Promise<string> {
  const h = await openRealmHome({ home });
  try {
    const { record } = await h.runStore.create({
      workflowId: 'scan',
      workflowVersion: 1,
      params: {},
      extensionIdentity: [],
    });
    await h.runStore.update({
      ...record,
      pending_gate: {
        gate_id: 'g-scan',
        step_name: 'review',
        preview: { note: VALUE },
        choices: ['approve', 'reject'],
        opened_at: record.created_at,
        resolved_message: `Ship ${VALUE.toUpperCase()}?`,
      },
    });
    return record.id;
  } finally {
    h.close();
  }
}

describe(
  'the filter-mask fix, PR 2 — `realm db check --project <dir>`',
  { timeout: 60_000 },
  () => {
    it('(1, 2) names the run and the field that hold the upper-cased form, exits 1, carries it in --json, and prints the value in no form; the raw value in the preview is no finding', async () => {
      // (1) red when the form is not found, a second finding is printed for the raw value, the exit
      //     code is 0, the JSON lacks the run, the field or the kind, or any form of the value is
      //     printed; (2) prints both outputs, the value written `<FAKE>`.
      const id = await storeWithTheForm();
      const dir = project(`SCAN_KEY=${VALUE}\n`);
      const text = realm(['db', 'check', '--project', dir]);
      const json = realm(['db', 'check', '--json', '--project', dir]);
      const report = JSON.parse(json.stdout) as {
        findings: Array<Record<string, unknown>>;
        not_checked: Array<{ check: string }>;
      };
      expect(
        {
          code: text.code,
          found: text.stdout.split('\n').filter((l) => l.startsWith('✗ ')),
          summary: text.stdout.includes('\n1 finding.\n'),
          jsonCode: json.code,
          jsonFindings: report.findings.map(({ check, code, run_id, path, kind }) => ({
            check,
            code,
            run_id,
            path,
            kind,
          })),
          notChecked: report.not_checked
            .map((n) => n.check)
            .filter((c) => c.startsWith('declared')),
          leaks: leaks(text) || leaks(json),
        },
        scrubbed(`${text.stdout}${text.stderr}\n${json.stdout}${json.stderr}`),
      ).toEqual({
        code: 1,
        found: [
          `✗ run ${id}: pending_gate.resolved_message holds the upper-cased form of a declared value — rotate it and purge the run`,
        ],
        summary: true,
        jsonCode: 1,
        jsonFindings: [
          {
            check: 'declared_forms',
            code: 'changed_form_of_declared_value',
            run_id: id,
            path: 'pending_gate.resolved_message',
            kind: 'upper-cased',
          },
        ],
        notChecked: ['declared_forms_short', 'declared_forms_replace_split'],
        leaks: false,
      });
    });

    it('(4) without --project, on the same store: no `declared_forms` entry anywhere, in the text or the JSON; exit 0', async () => {
      // (1) red when the check, its code or its two entries are printed without the flag, or the flag's
      //     absence changes the exit code; (2) prints both outputs, the value written `<FAKE>`.
      await storeWithTheForm();
      const text = realm(['db', 'check']);
      const json = realm(['db', 'check', '--json']);
      const all = `${text.stdout}${text.stderr}${json.stdout}${json.stderr}`;
      expect(
        {
          codes: [text.code, json.code],
          mentions: ['declared_forms', 'changed_form', 'declared value', 'replace or split'].filter(
            (w) => all.includes(w),
          ),
        },
        scrubbed(all),
      ).toEqual({ codes: [0, 0], mentions: [] });
    });

    it('(5) a folder with no realm.yaml, and a manifest whose secret cannot be resolved: one `Error:` line, exit 1, nothing scanned, no value', async () => {
      // (1) red when either is not refused, the store is checked anyway (a report on stdout), the
      //     unresolved reference is not named, or a value is printed; (2) prints the outputs.
      await storeWithTheForm();
      const empty = join(base, 'empty');
      mkdirSync(empty);
      const none = realm(['db', 'check', '--project', empty]);
      const dir = project(
        `OTHER_KEY=${VALUE}\n`,
        [
          'version: 1',
          'secrets:',
          '  sources: [dotenv]',
          'handlers:',
          '  fetch:',
          '    use: ./handlers.mjs#fetch',
          '    config:',
          "      key: '${secret:MISSING_KEY}'",
          '',
        ].join('\n'),
      );
      const unresolved = realm(['db', 'check', '--project', dir]);
      expect(
        {
          none: { code: none.code, stdout: none.stdout, stderr: none.stderr },
          unresolved: {
            code: unresolved.code,
            stdout: unresolved.stdout,
            first: unresolved.stderr.split('\n')[0],
            names: unresolved.stderr.includes('${secret:MISSING_KEY}'),
            last: unresolved.stderr.trimEnd().split('\n').at(-1),
          },
          leaks: leaks(unresolved),
        },
        scrubbed(`${unresolved.stdout}${unresolved.stderr}`),
      ).toEqual({
        none: {
          code: 1,
          stdout: '',
          stderr: `Error: realm db check --project: no realm.yaml in ${empty}.\n`,
        },
        unresolved: {
          code: 1,
          stdout: '',
          first: 'Error: realm db check --project: Deployment manifest: 1 secret(s) unresolved:',
          names: true,
          last: 'Nothing was scanned.',
        },
        leaks: false,
      });
    });
  },
);
