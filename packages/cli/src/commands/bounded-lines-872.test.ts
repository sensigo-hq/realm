// bounded-lines-872.test.ts — #872 (b1) correction 1 HC2 (H2), core's sentences the CLI prints too:
// the cleanup sentence and `pendingCleanupLine` (names at most ten, then how many more), the resume
// command's `<one of: …>` placeholder (ten values, then how many more, still one token for the
// tokenizer and one line in `realm run inspect`), and the gate's `--choice` placeholder (unchanged:
// every choice). Beside each: (a) the change that turns it red; (b) what it prints on failure — the
// lines (the names are fake), never a value.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  ExtensionRegistry,
  JsonFileStore,
  JsonWorkflowStore,
  advanceRun,
  endsWithCommand,
  oneOf,
  pendingCleanupLine,
  pendingCleanupSentence,
  resumeWay,
  type RunRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { CLI_COMMANDS, writerHost } from './ways-renderer.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '../../dist/index.js');
const named = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(2, '0')}`);
const quoted = (ids: readonly string[]) => ids.map((s) => `'${s}'`).join(', ');

describe('#872 (b1) correction 1 HC2 (H2) — core’s sentences the CLI prints: at most ten names, then how many more', () => {
  it('the cleanup sentence and pendingCleanupLine at 11 pending cleanup steps', () => {
    const steps = named('t', 11);
    const run = {
      id: 'r-872',
      terminal_state: true,
      finalizer_ledger: Object.fromEntries(
        steps.map((s, i) => [s, { status: 'pending', rank: i }]),
      ),
    } as unknown as Pick<RunRecord, 'id' | 'terminal_state' | 'finalizer_ledger'>;
    const now = new Date('2026-10-28T00:00:00.000Z');
    const words = `${quoted(steps.slice(0, 10))} and 1 more`;
    // (a) red when the bound is removed at either site (eleven names), or "them" follows the names
    //     shown; (b) prints both texts.
    expect({
      sentence: pendingCleanupSentence(run, now),
      line: pendingCleanupLine(run, now),
    }).toEqual({
      sentence: ` Cleanup steps left pending: ${words} — 'realm run drain r-872 --force' runs them with code that has their handlers.`,
      line: `Cleanup steps left pending: ${words} — to run them with code that has their handlers: realm run drain r-872 --force`,
    });
  });

  it('the resume command at 11 failed steps: ten values then "and 1 more" inside one placeholder — one token for the tokenizer', () => {
    const steps = named('f', 11);
    const way = resumeWay(
      {
        id: 'r-872',
        terminal_state: true,
        failed_steps: steps,
        terminal_reason: 'A step failed.',
        sealed_by: { arm: 'step_failed', step: 'f10' },
      } as unknown as RunRecord,
      { steps: Object.fromEntries(steps.map((s) => [s, { execution: 'auto' }])) },
    );
    // (a) red when the bound is removed (eleven values), or the placeholder is no longer one token
    //     (the command then does not end the sentence); (b) prints the command.
    expect({
      command: way?.command,
      steps: way?.steps.length,
      oneToken: endsWithCommand(`To make the failed steps runnable again: ${way?.command ?? ''}`),
    }).toEqual({
      command: `realm run resume r-872 --from <one of: ${steps.slice(0, 10).join(', ')} and 1 more>`,
      steps: 11,
      oneToken: true,
    });
  });

  it('the gate’s --choice placeholder at 11 choices is unchanged: every choice', () => {
    const choices = named('c', 11);
    const line = CLI_COMMANDS.respond(
      {
        verb: 'respond',
        run_id: 'r-872',
        gate_id: 'g',
        step: 's',
        choice: { one_of: choices },
        conditions: [],
      } as never,
      undefined,
      writerHost(),
    );
    // (a) red when the --choice placeholder is bounded too (a choice an operator must type would
    //     be hidden); (b) prints the line.
    expect({ line: String(line).includes(oneOf(choices)), all: oneOf(choices) }).toEqual({
      line: true,
      all: `<one of: ${choices.join(', ')}>`,
    });
  });
});

describe(
  '#872 (b1) correction 1 HC2 (H2) — realm run inspect’s Resumable: line, on the build',
  { timeout: 60_000 },
  () => {
    let home: string;
    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'realm-hc2-872-'));
      mkdirSync(join(home, '.realm', 'workflows'), { recursive: true });
      mkdirSync(join(home, '.realm', 'runs'), { recursive: true });
    });
    afterEach(() => rmSync(home, { recursive: true, force: true }));

    it('a run with 11 failed steps: the line holds the bounded placeholder and stays one line', async () => {
      const steps = named('f', 11);
      const def: WorkflowDefinition = {
        id: 'hc2-fail',
        name: 'hc2-fail',
        version: 1,
        schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
        steps: Object.fromEntries(
          steps.map((s) => [s, { description: 'F.', execution: 'auto', handler: 'boom' }]),
        ),
      } as WorkflowDefinition;
      await new JsonWorkflowStore(join(home, '.realm', 'workflows')).register(def);
      const store = new JsonFileStore(join(home, '.realm', 'runs'));
      const registry = new ExtensionRegistry();
      registry.register('handler', 'boom', {
        id: 'boom',
        execute: async () => {
          throw new Error('fake failure');
        },
      });
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      for (let i = 0; i < 20 && !(await store.get(run.id)).terminal_state; i += 1) {
        await advanceRun(store, def, { runId: run.id, registry }).catch(() => undefined);
      }
      const r = spawnSync(process.execPath, [CLI, 'run', 'inspect', run.id], {
        cwd: home,
        env: { PATH: process.env['PATH'] ?? '', HOME: home, NO_COLOR: '1' },
        encoding: 'utf8',
      });
      const lines = r.stdout.split('\n').filter((l) => l.startsWith('Resumable: '));
      // (a) red when the placeholder holds every step, or breaks the line in two; (b) prints the
      //     phase and the line.
      expect({
        phase: (await store.get(run.id)).terminal_state,
        lines: lines.length,
        bounded: lines[0]?.includes(`--from <one of: ${steps.slice(0, 10).join(', ')} and 1 more>`),
      }).toEqual({ phase: true, lines: 1, bounded: true });
    });
  },
);
