// late-lag-625.test.ts — issue #625 PR-2a, the last prompt's F1: the CLI says how late, in seconds under
// a minute. `realm run respond`'s `⚠` line (recomposed from the reply's typed `overdue_ms`) and
// `realm run drain` (core's one formatter in place of its own copy, which said `0m`) — each run as the
// built `realm` (a child process, a fresh HOME), each page example quoted and compared with it.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JsonFileStore,
  JsonWorkflowStore,
  executeStep,
  loadWorkflowFromString,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { zOf } from '../test-support/instant.js';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../../..');
const CLI = join(HERE, '../../dist/index.js');
const ACTING = 'docs/reference/cli/realm-run-acting.md';
const GATES = 'docs/reference/workflow/gates.md';

/** The page's line that starts with `prefix` (one, exactly) — `<no line>` when there is none. */
function pageLine(page: string, prefix: string): string {
  const lines = readFileSync(join(ROOT, page), 'utf8')
    .split('\n')
    .filter((l) => l.startsWith(prefix));
  return lines.length === 1 ? lines[0]! : `<${lines.length} lines start with ${prefix}>`;
}

/** `approve` (a question, default as given), the guard `only_if_shipping`, then the agent step `ship`. */
const shipping = (dflt: 'ship' | 'hold'): WorkflowDefinition =>
  loadWorkflowFromString(
    [
      `id: lag-${dflt}`,
      `name: lag-${dflt}`,
      'version: 1',
      'steps:',
      '  approve:',
      '    description: Approve.',
      '    execution: auto',
      '    trust: human_confirmed',
      '    gate:',
      '      choices: [ship, hold]',
      '      timeout_seconds: 3600',
      '      on_expiry: settle_default',
      `      default_choice: ${dflt}`,
      '  only_if_shipping:',
      '    description: Ship only when approved.',
      '    execution: guard',
      '    depends_on: [approve]',
      `    abort_unless: ["approve.choice == 'ship'"]`,
      '    abort_message: The order was held.',
      '  ship:',
      '    description: Ship.',
      '    execution: agent',
      '    depends_on: [only_if_shipping]',
      '',
    ].join('\n'),
  );

describe(
  '#625 PR-2a, F1 — the CLI says how late, in seconds under a minute',
  { timeout: 60_000 },
  () => {
    let h: TempHome & { readonly root: string };
    let home: string;
    let runStore: JsonFileStore;
    let workflowStore: JsonWorkflowStore;

    beforeEach(async () => {
      h = await makeTempHome();
      home = h.root;
      runStore = h.home.runStore;
      workflowStore = h.home.workflowStore;
    });
    afterEach(async () => {
      await h.cleanup();
    });

    /** Runs the built `realm` with this HOME; its exit, its lines and the window it ran in. */
    function realm(...args: string[]) {
      const t0 = Date.now();
      const r = spawnSync(process.execPath, [CLI, ...args], {
        cwd: home,
        env: { PATH: process.env['PATH'] ?? '', HOME: home, NO_COLOR: '1' },
        encoding: 'utf8',
        timeout: 60_000,
      });
      return {
        code: r.status,
        out: r.stdout.split('\n'),
        err: r.stderr.split('\n'),
        window: [t0, Date.now()] as const,
      };
    }

    /** A run at its question, whose time was up `ago` ms before now. */
    async function lateQuestion(def: WorkflowDefinition, ago: number) {
      await workflowStore.register(def);
      const { record: run } = await runStore.create({
        workflowId: def.id,
        workflowVersion: 1,
        params: {},
      });
      await executeStep(runStore, def, {
        runId: run.id,
        command: 'approve',
        input: {},
        dispatcher: async () => ({}),
      });
      const { record: record } = await runStore.get(run.id);
      const expiresAt = Date.now() - ago;
      await runStore.update({
        ...record,
        pending_gate: {
          ...record.pending_gate!,
          opened_at: new Date(expiresAt - 3_600_000).toISOString(),
          expires_at: new Date(expiresAt).toISOString(),
        },
      });
      return { id: run.id, gateId: record.pending_gate!.gate_id, expiresAt };
    }

    /** Every whole-second lag a call in `window` could print for a question that expired at `at`. */
    const seconds = (at: number, window: readonly [number, number]): string[] => {
      const out: string[] = [];
      for (
        let s = Math.floor((window[0] - at) / 1000);
        s <= Math.floor((window[1] - at) / 1000);
        s++
      )
        out.push(`${s}s`);
      return out;
    };

    it('realm run respond: the ⚠ line says the lag in seconds (the reply’s overdue_ms, written by core’s one formatter)', async () => {
      const q = await lateQuestion(shipping('ship'), 15_000);
      const r = realm('run', 'respond', q.id, '--gate', q.gateId, '--choice', 'ship');
      const lag = /had expired (\S+) before this call/.exec(r.out[0] ?? '')?.[1];
      // (a) red when the line has no lag, says `0m`, or a lag the call could not have measured;
      //     (b) prints the first line and the lags the call's window allows.
      expect({
        first: r.out[0],
        lagFits: seconds(q.expiresAt, r.window).includes(lag ?? ''),
      }).toEqual({
        first: `⚠ gate '${q.gateId}' on 'approve' had expired ${lag ?? '<no lag>'} before this call (deadline ${zOf(q.expiresAt)}) — this respond call first carried out its declared settle_default: the default choice 'ship' was recorded (enacted_via: respond).`,
        lagFits: true,
      });
    });

    it('realm run drain <id> --expired: the page’s line, in seconds — `gate expired 18s ago`, never `0m`', async () => {
      const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8').replace(/\s+/g, ' ');
      // (a) red when the CHANGELOG no longer says drain's lag is in seconds; (b) prints the sentence.
      expect(changelog).toContain(
        '`realm run drain` says how long ago a gate expired in seconds under a minute (`gate expired 12s ago`; it printed `0m`).',
      );
      const page = pageLine(ACTING, "Run '0e0ace7e-e57c-400c-a63a-eaf685688d19': gate EXPIRED ");
      // (a) red when the page's example says minutes (`0m ago`) or another sentence; (b) prints it.
      expect(page).toBe(
        "Run '0e0ace7e-e57c-400c-a63a-eaf685688d19': gate EXPIRED 18s ago (2026-10-09T09:14:00Z) — would enact settle_default 'hold'; guard 'only_if_shipping' would then abort the run (The order was held.) on --force.",
      );
      // (a) red when gates.md's copy of the example differs; (b) prints it.
      expect(pageLine(GATES, "Run '0e0ace7e-e57c-400c-a63a-eaf685688d19': gate EXPIRED ")).toBe(
        page,
      );
      expect(pageLine(ACTING, "Run '230b0939-9c61-40e4-8b6f-910594a81e92': gate EXPIRED ")).toBe(
        "Run '230b0939-9c61-40e4-8b6f-910594a81e92': gate EXPIRED 17s ago (2026-10-09T09:14:01Z) — would enact settle_default 'ship'; guard 'only_if_shipping' would pass on --force.",
      );
      const hold = await lateQuestion(shipping('hold'), 18_000);
      const ship = await lateQuestion(shipping('ship'), 17_000);
      for (const [q, example] of [
        [hold, page],
        [ship, pageLine(ACTING, "Run '230b0939-9c61-40e4-8b6f-910594a81e92': gate EXPIRED ")],
      ] as const) {
        const r = realm('run', 'drain', q.id, '--expired');
        const lag = /gate EXPIRED (\S+) ago/.exec(r.out[0] ?? '')?.[1] ?? '<no lag>';
        // (a) red when drain says `0m` (its own formatter), or its line is not the page's with this
        //     run's id and lag; (b) prints the line and the example as this run would print it.
        expect({ line: r.out[0], lagFits: seconds(q.expiresAt, r.window).includes(lag) }).toEqual({
          line: example
            .replace(/^Run '[0-9a-f-]+'/, `Run '${q.id}'`)
            // #715 (b) (03 §B.2 B3): the words through the one formatter, the deadline beside them.
            .replace(
              /gate EXPIRED \d+s ago \(\S+Z\)/,
              `gate EXPIRED ${lag} ago (${zOf(q.expiresAt)})`,
            ),
          lagFits: true,
        });
      }
    });

    it('realm run drain --all --expired and a run not yet ended: the page’s lines, in seconds', async () => {
      const listed = [
        '962cb7f0-a894-4592-aadc-a4907ef14c9c',
        'ce8296d1-c5d3-4ea6-b62c-7dc0f795fb09',
      ].map((id) => pageLine(ACTING, `  • ${id}: gate EXPIRED `));
      const notEnded = pageLine(
        ACTING,
        "Run '94bf33c8-3933-47c4-ad50-556d0b298e6c' is not terminal",
      );
      // (a) red when an example says `0m ago`; (b) prints the three lines.
      expect({ listed, notEnded }).toEqual({
        listed: [
          '  • 962cb7f0-a894-4592-aadc-a4907ef14c9c: gate EXPIRED 41s ago (2026-10-09T09:13:37Z) — would enact settle_default',
          '  • ce8296d1-c5d3-4ea6-b62c-7dc0f795fb09: gate EXPIRED 40s ago (2026-10-09T09:13:38Z) — would enact settle_default',
        ],
        notEnded:
          "Run '94bf33c8-3933-47c4-ad50-556d0b298e6c' is not terminal (phase: 'gate_waiting') — nothing to drain. Its gate EXPIRED 25s ago (2026-10-09T09:13:53Z). To see what the expiry will do: realm run drain 94bf33c8-3933-47c4-ad50-556d0b298e6c --expired",
      });
      const q = await lateQuestion(shipping('ship'), 41_000);
      const all = realm('run', 'drain', '--all', '--expired');
      const row = all.out.find((l) => l.startsWith(`  • ${q.id}: `)) ?? '<no row>';
      const rowLag = /gate EXPIRED (\S+) ago/.exec(row)?.[1] ?? '<no lag>';
      // (a) red when the list says `0m`; (b) prints the row.
      expect({ row, lagFits: seconds(q.expiresAt, all.window).includes(rowLag) }).toEqual({
        row: listed[0]!
          .replace('962cb7f0-a894-4592-aadc-a4907ef14c9c', q.id)
          .replace(
            /gate EXPIRED \d+s ago \(\S+Z\)/,
            `gate EXPIRED ${rowLag} ago (${zOf(q.expiresAt)})`,
          ),
        lagFits: true,
      });
      const one = realm('run', 'drain', q.id);
      const line = one.out[0] ?? '<no line>';
      const lag = /Its gate EXPIRED (\S+) ago/.exec(line)?.[1] ?? '<no lag>';
      // (a) red when the not-ended line says `0m`; (b) prints the line.
      expect({ line, lagFits: seconds(q.expiresAt, one.window).includes(lag) }).toEqual({
        line: notEnded
          .split('94bf33c8-3933-47c4-ad50-556d0b298e6c')
          .join(q.id)
          .replace(
            /Its gate EXPIRED \d+s ago \(\S+Z\)/,
            `Its gate EXPIRED ${lag} ago (${zOf(q.expiresAt)})`,
          ),
        lagFits: true,
      });
    });
  },
);
