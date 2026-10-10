// cleanup-held-625.test.ts — issue #625 PR-2a, the last prompt's F12 (review G3-1, G2-R4, G7-13): a
// cleanup step under another drainer's lease is said as held — the lease and its deadline, and the
// command for after it — and never as if the command would run it now; never "has no pending
// finalizers". realm cannot tell whether that drainer is still running, and says so. Each surface
// with a live lease (it has not passed) and an expired one (the command then runs the step).
//
// `realm run inspect` and `realm run drain --force` from the built `realm` (a child process, a fresh
// HOME, the workflow's project folder holding the cleanup step's handler); `realm run advance` in
// process, its drain meeting another program's lease.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JsonFileStore,
  JsonWorkflowStore,
  ExtensionRegistry,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  advanceRun,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { advanceRunFromShell } from './run-advance.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../../..');
const CLI = join(HERE, '../../dist/index.js');
const ACTING = 'docs/reference/cli/realm-run-acting.md';
const READING = 'docs/reference/cli/realm-run-reading.md';

/** (a) red when the page no longer holds the sentence word for word; (b) prints it. */
function claim(page: string, sentence: string): void {
  const flat = (t: string) => t.replace(/\s+/g, ' ');
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

const HELD = (until: string, id: string) =>
  `Cleanup step left pending: 'tidy' — held by another drainer's lease until ${until} (realm cannot tell whether it is still running) — after ${until}: realm run drain ${id} --force`;
const NOT_HELD = (id: string) =>
  `Cleanup step left pending: 'tidy' — to run it with code that has its handler: realm run drain ${id} --force`;

type Lease = 'live' | 'expired';

describe(
  '#625 PR-2a, F12 — a cleanup step under another drainer’s lease is said as held',
  { timeout: 60_000 },
  () => {
    let home: string;
    let runs: JsonFileStore;
    let workflows: JsonWorkflowStore;

    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'realm-cleanup-held-625-'));
      mkdirSync(join(home, '.realm', 'workflows'), { recursive: true });
      mkdirSync(join(home, '.realm', 'runs'), { recursive: true });
      runs = new JsonFileStore(join(home, '.realm', 'runs'));
      workflows = new JsonWorkflowStore(join(home, '.realm', 'workflows'));
    });
    afterEach(() => rmSync(home, { recursive: true, force: true }));

    function realm(...args: string[]) {
      const r = spawnSync(process.execPath, [CLI, ...args], {
        cwd: home,
        env: { PATH: process.env['PATH'] ?? '', HOME: home, NO_COLOR: '1' },
        encoding: 'utf8',
        timeout: 60_000,
      });
      return { code: r.status, out: r.stdout.split('\n').filter((l) => l !== ''), err: r.stderr };
    }

    /**
     * A completed run whose cleanup step `tidy` was left pending (the call that completed it had no
     * handler), then leased by another drainer — the lease `live` (300 s) or `expired`. The workflow is
     * registered from its project folder, whose module has the handler, so `realm run drain` can run it.
     */
    async function heldRun(lease: Lease) {
      const proj = join(home, 'proj');
      mkdirSync(proj, { recursive: true });
      writeFileSync(
        join(proj, 'ext.mjs'),
        "export default { handlers: { cleanup: { id: 'cleanup', async execute() { return { data: {} }; } } } };\n",
      );
      writeFileSync(
        join(proj, 'workflow.yaml'),
        [
          `id: held-${lease}`,
          'name: held',
          'version: 1',
          'extensions: ./ext.mjs',
          'steps:',
          '  s:',
          '    description: S.',
          '    execution: auto',
          '  tidy:',
          '    description: Tidy.',
          '    execution: finalizer',
          '    handler: cleanup',
          '    on_outcome: always',
          '',
        ].join('\n'),
      );
      const reg = realm('workflow', 'register', proj);
      expect(reg.code, `fixture: register — ${reg.err}`).toBe(0);
      const def = (await workflows.get(`held-${lease}`)) as WorkflowDefinition;
      const { run } = await runs.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      await advanceRun(runs, def, { runId: run.id, registry: new ExtensionRegistry() });
      await runs.settleStep!(
        run.id,
        {
          kind: 'lease_finalizer',
          finalizer: 'tidy',
          leaseToken: 'other-drain',
          leaseSeconds: 300,
        },
        def,
      );
      if (lease === 'expired') await pastDeadline(run.id);
      const tidy = (await runs.get(run.id)).finalizer_ledger!['tidy']!;
      expect({ status: tidy.status, token: tidy.lease_token }, 'fixture').toEqual({
        status: 'pending',
        token: 'other-drain',
      });
      return { id: run.id, until: tidy.lease_deadline!, def };
    }

    /** Moves `tidy`'s lease deadline a minute into the past (the other drainer's lease has passed). */
    async function pastDeadline(id: string) {
      const r = await runs.get(id);
      await runs.update({
        ...r,
        finalizer_ledger: {
          ...r.finalizer_ledger,
          tidy: {
            ...r.finalizer_ledger!['tidy']!,
            lease_deadline: new Date(Date.now() - 60_000).toISOString(),
          },
        },
      });
    }

    it.each(['live', 'expired'] as const)(
      'realm run inspect, %s lease: the held line while it has not passed; the command after',
      async (lease) => {
        claim(
          READING,
          "While another drainer's lease on one of them has not passed: `— held by another drainer's lease until <time> (realm cannot tell whether it is still running) — after <time>: realm run drain <id> --force` (added after version 0.46.0).",
        );
        const r = await heldRun(lease);
        // (a) red when inspect offers the drain command as if it ran the step now under a live lease
        //     (G3-1), or says held once the lease has passed; (b) prints the cleanup line.
        expect(
          realm('run', 'inspect', r.id).out.find((l) => l.startsWith('Cleanup step left pending')),
        ).toBe(lease === 'live' ? HELD(r.until, r.id) : NOT_HELD(r.id));
      },
    );

    it.each(['live', 'expired'] as const)(
      'realm run drain --force, %s lease: held — the ⚠ line and the held line, exit 1, never "no pending finalizers"; expired — it runs the step',
      async (lease) => {
        claim(
          ACTING,
          "With `--force` while that lease has not passed, the pass stops at that step and runs nothing more: it prints `⚠ finalizer '<name>' left pending — held by another drainer's lease until <time> (realm cannot tell whether it is still running)`, then `Cleanup step left pending: '<name>' — held by another drainer's lease until <time> (realm cannot tell whether it is still running) — after <time>: realm run drain <id> --force`, and exits 1 — never `has no pending finalizers`.",
        );
        const r = await heldRun(lease);
        const d = realm('run', 'drain', r.id, '--force');
        // (a) red when the drain says "has no pending finalizers. Nothing to drain." and exits 0 under a
        //     live lease (G2-R4), or does not run the step once the lease has passed; (b) prints the
        //     command's lines, its exit code and the step's status after.
        expect({
          code: d.code,
          out: d.out,
          status: (await runs.get(r.id)).finalizer_ledger!['tidy']!.status,
        }).toEqual(
          lease === 'live'
            ? {
                code: 1,
                out: [
                  `  ⚠ finalizer 'tidy' left pending — held by another drainer's lease until ${r.until} (realm cannot tell whether it is still running)`,
                  HELD(r.until, r.id),
                ],
                status: 'pending',
              }
            : { code: 0, out: [`Drained run '${r.id}'.`], status: 'completed' },
        );
      },
    );

    it.each(['live', 'expired'] as const)(
      'realm run advance, %s lease: its drain meets another drainer’s lease — the ⚠ line above `pending` and the held line; expired — this call runs it',
      async (lease) => {
        claim(
          ACTING,
          "While another drainer's lease on one of them has not passed, the line is `Cleanup step left pending: '<name>' — held by another drainer's lease until <time> (realm cannot tell whether it is still running) — after <time>: realm run drain <id> --force`, and a `⚠ finalizer '<name>' left pending — held by another drainer's lease until <time> (realm cannot tell whether it is still running)` line above says why it is `pending` (added after version 0.46.0).",
        );
        const def: WorkflowDefinition = {
          id: `adv-held-${lease}`,
          name: 'adv-held',
          version: 1,
          schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
          steps: {
            s: { description: 'S.', execution: 'auto', depends_on: [] },
            tidy: {
              description: 'Tidy.',
              execution: 'finalizer',
              handler: 'cleanup',
              on_outcome: 'always',
            },
          },
        };
        await workflows.register(def);
        const { run } = await runs.create({ workflowId: def.id, workflowVersion: 1, params: {} });
        let fired = false;
        // Another program leases `tidy` the moment this call's drain tries to.
        const racing = new Proxy(runs, {
          get(target, prop) {
            if (prop === 'settleStep') {
              return async (...a: Parameters<NonNullable<JsonFileStore['settleStep']>>) => {
                if (a[1].kind === 'lease_finalizer' && !fired) {
                  fired = true;
                  await target.settleStep!(
                    a[0],
                    {
                      kind: 'lease_finalizer',
                      finalizer: 'tidy',
                      leaseToken: 'other-drain',
                      leaseSeconds: 300,
                    },
                    def,
                  );
                  if (lease === 'expired') await pastDeadline(a[0]);
                }
                return target.settleStep!(...a);
              };
            }
            const v = Reflect.get(target, prop, target) as unknown;
            return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
          },
        });
        const registry = new ExtensionRegistry();
        registry.register('handler', 'cleanup', {
          id: 'cleanup',
          execute: async () => ({ data: {} }),
        });
        const lines: string[] = [];
        await advanceRunFromShell(
          run.id,
          { project: home },
          racing,
          workflows,
          undefined,
          (l) => lines.push(l),
          registry,
        );
        const tidy = (await runs.get(run.id)).finalizer_ledger!['tidy']!;
        const from = lines.findIndex((l) => l.startsWith('→ s'));
        // (a) red when the drain halts at the held lease with no `⚠` line and the cleanup line offers the
        //     command as if it ran the step now (G7-13); (b) prints the lines after the step.
        expect({ fired, lines: lines.slice(from + 1, -1) }).toEqual({
          fired: true,
          lines:
            lease === 'live'
              ? [
                  `⚠ finalizer 'tidy' left pending — held by another drainer's lease until ${tidy.lease_deadline} (realm cannot tell whether it is still running)`,
                  "finalizer 'tidy': pending",
                  HELD(tidy.lease_deadline!, run.id),
                ]
              : ["finalizer 'tidy': completed"],
        });
      },
    );
  },
);
