// forged-lines-625.test.ts — issue #625 PR-2a, the last prompt's F5 (review A2-3, RED): a step-output value
// that a precondition refusal names is rendered escaped and on one line, so it can neither forge a line of
// the screen (`Phase: completed`) nor write a terminal escape. The reviewer's injection
// (`review-final/probes/a2/inject.sh`), from the built `realm` (a child process, a fresh HOME): `realm run
// inspect` and `realm run advance`.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JsonFileStore,
  JsonWorkflowStore,
  advanceRun,
  loadWorkflowFromString,
} from '@sensigo/realm';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '../../dist/index.js');

/** The reviewer's workflow (`probes/a2/wf3`): `seed` records the run's params; `check`'s precondition reads them. */
const INJECT = loadWorkflowFromString(
  [
    'id: inject',
    'name: precondition value on the read surfaces',
    'version: 1',
    'steps:',
    '  seed:',
    '    description: Seed (bare auto, records the run params).',
    '    execution: auto',
    '  check:',
    '    description: Check.',
    '    execution: auto',
    '    depends_on: [seed]',
    `    preconditions: ["seed.v == 'ok'"]`,
    '',
  ].join('\n'),
);
/** The reviewer's value: two forged screen lines and a terminal escape. */
const VALUE = 'bad\nPhase: completed\nSealed by: workflow_complete\u001b[31m RED';
const RENDERED = '"bad\\nPhase: completed\\nSealed by: workflow_complete\\u001b[31m RED"';

describe(
  '#625 PR-2a, F5 — a step-output value never forges lines or writes terminal escapes',
  { timeout: 60_000 },
  () => {
    let home: string;
    let runId: string;

    beforeEach(async () => {
      home = mkdtempSync(join(tmpdir(), 'realm-forge-625-'));
      mkdirSync(join(home, '.realm', 'workflows'), { recursive: true });
      mkdirSync(join(home, '.realm', 'runs'), { recursive: true });
      const runStore = new JsonFileStore(join(home, '.realm', 'runs'));
      await new JsonWorkflowStore(join(home, '.realm', 'workflows')).register(INJECT);
      const { run } = await runStore.create({
        workflowId: INJECT.id,
        workflowVersion: 1,
        params: { v: VALUE },
      });
      runId = run.id;
      // `seed` records the params; `check` is then refused by its precondition, which names the value.
      await advanceRun(runStore, INJECT, { runId });
    });
    afterEach(() => rmSync(home, { recursive: true, force: true }));

    function realm(...args: string[]) {
      const r = spawnSync(process.execPath, [CLI, ...args], {
        cwd: home,
        env: { PATH: process.env['PATH'] ?? '', HOME: home, NO_COLOR: '1' },
        encoding: 'utf8',
        timeout: 60_000,
      });
      return { code: r.status, out: r.stdout.split('\n'), err: r.stderr.split('\n') };
    }

    it.each([
      ['realm run inspect', ['run', 'inspect']],
      ['realm run advance', ['run', 'advance']],
    ] as const)(
      '%s: the refusal names the value escaped, on one line; no forged line, no raw ESC',
      (_name, args) => {
        const changelog = readFileSync(join(HERE, '../../../../CHANGELOG.md'), 'utf8').replace(
          /\s+/g,
          ' ',
        );
        // (a) red when the CHANGELOG stops saying it; (b) prints the sentence.
        expect(changelog).toContain(
          'names the value it read as JSON on one line, its control characters escaped (`Resolved value: "bad\\nPhase: completed"`); a newline in the value started a line of its own, and an escape character reached the terminal.',
        );
        const r = realm(...args, runId);
        const lines = [...r.out, ...r.err];
        const refusal =
          lines.find((l) => l.includes("Precondition failed: 'seed.v == 'ok''")) ?? '<none>';
        // (a) red when the value is printed raw (its newline starts `Phase: completed` as a line of its
        //     own, its ESC reaches the terminal); (b) prints the refusal line and the forged lines found.
        expect({
          refusal: refusal.slice(refusal.indexOf('Resolved value: ')),
          forged: lines.filter((l) => /^(Phase: completed|Sealed by: workflow_complete)/.test(l)),
          escapes: lines.filter((l) => l.includes('\u001b')).length,
        }).toEqual({
          refusal: expect.stringMatching(
            new RegExp(`^Resolved value: ${RENDERED.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`),
          ),
          forged: [],
          escapes: 0,
        });
      },
    );
  },
);
