// run advance command — runs the guards and automatic steps a run owes, from this shell (issue #625 PR-2a).
import { Command } from 'commander';
import type { RunStore, WorkflowRegistrar, ExtensionRegistry, Attributed } from '@sensigo/realm';
import {
  advanceRun,
  describePending,
  describeRunDriver,
  judgeProgramFit,
  owedList,
  getWorkflowForRun,
  deriveRunPhase,
  describeEndedBy,
  type PendingView,
  type ProgramFit,
} from '@sensigo/realm';
import { loadProjectExtensions } from '../extensions/load-project-extensions.js';
import { resolveProgramIdentity } from '../lib/program-identity.js';
import { BY_SOURCE_WORDS } from '../lib/holder-render.js';

/** How the project code of this program compares with the run's last record, in words. */
export const FIT_WORDS: Record<ProgramFit, string> = {
  same: "same as the run's last record",
  differs: "differs from the run's last record",
  not_comparable: "not comparable with the run's last record",
  none: 'neither side records project code',
};

/** `<by> (<class words>)` — this program's name in the house words. */
function identityWords(driver: Attributed | undefined): string {
  return driver === undefined
    ? 'no name could be recorded'
    : `${driver.by} (${BY_SOURCE_WORDS[driver.by_source]})`;
}

/** The last recorded driver, in words. */
function driverWords(run: Parameters<typeof describeRunDriver>[0]): string {
  const d = describeRunDriver(run);
  if (d.driver.by === null) return 'none recorded';
  const newer =
    d.newer_without_driver > 0 ? `; ${d.newer_without_driver} newer entries record no driver` : '';
  return `${d.driver.by} (${BY_SOURCE_WORDS[d.driver.by_source]}) at step '${d.step}', ${d.at}${newer}`;
}

/**
 * Why nothing more runs, from the record and the view (D4.4's `Stopped:` reasons, without running).
 * `undefined` only when something is still owed.
 */
export function stoppedReason(
  runId: string,
  run: Parameters<typeof deriveRunPhase>[0],
  pending: PendingView,
): string {
  if (run.terminal_state) return `the run has ended (${deriveRunPhase(run)})`;
  const gate = run.pending_gate;
  if (gate !== undefined) {
    return `a question is open — realm run respond ${runId} --gate ${gate.gate_id} --choice <one of: ${gate.choices.join(', ')}>`;
  }
  const refused = pending.engine_runnable.find((e) => e.runnable_here === false);
  if (refused !== undefined) {
    return `'${refused.step}' cannot run here (${refused.refused_by}): ${refused.refusal}`;
  }
  if (pending.agent_steps.length > 0) {
    return `agent steps are ready: ${pending.agent_steps.map((s) => `'${s}'`).join(', ')} — drive them with realm agent --run-id ${runId}`;
  }
  return 'nothing is ready to run now';
}

/** What `advanceRunCommand` returns to the action (and to tests). */
export interface AdvanceOutcome {
  lines: string[];
  exitCode: 0 | 1;
}

/**
 * Advances the run: prints the preview, runs what the engine owes, then says where it stopped.
 * Every line goes to stdout through `print` as it is produced (so `→ <step>` appears as it starts).
 */
export async function advanceRunFromShell(
  runId: string,
  opts: { project?: string; extensionsModule?: string },
  runStore: RunStore,
  workflowStore: WorkflowRegistrar,
  driver: Attributed | undefined,
  print: (line: string) => void,
  registryOverride?: ExtensionRegistry,
): Promise<0 | 1> {
  const run = await runStore.get(runId);
  const workflow = await getWorkflowForRun(workflowStore, run, {
    retryVerb: 'advance again',
    verb: 'advance',
  });
  const projectDir = opts.project ?? process.cwd();
  const registry =
    registryOverride ??
    (
      await loadProjectExtensions(workflow, {
        ...(opts.extensionsModule !== undefined ? { overrideModule: opts.extensionsModule } : {}),
        projectDir,
      })
    ).registry;

  const pending = describePending(workflow, run, registry);
  print(`Advancing run ${runId} (workflow '${workflow.id}') from ${projectDir}.`);
  print(
    `This program: ${identityWords(driver)} · project code: ${FIT_WORDS[judgeProgramFit(run, registry.identity)]}.`,
  );
  print(`Last recorded driver: ${driverWords(run)}.`);
  if (pending.act === undefined) {
    print(`Nothing is owed to the engine: ${stoppedReason(runId, run, pending)}.`);
    return 0;
  }
  print(`Owed to the engine: ${owedList(pending)}.`);

  let lastStep: string | undefined;
  const result = await advanceRun(runStore, workflow, {
    runId,
    command: 'advance',
    registry,
    ...(driver !== undefined ? { driver } : {}),
    onStep: (step) => {
      lastStep = step;
      print(`→ ${step}`);
    },
  });
  for (const line of describeEndedBy(result)) print(line);

  const after = await runStore.get(runId);
  const afterView = describePending(workflow, after, registry);
  let exitCode: 0 | 1 = 0;
  let reason: string;
  if (result.status === 'error') {
    exitCode = 1;
    reason = `'${lastStep ?? result.command}' failed: ${result.errors.join(', ')}`;
  } else if (result.status === 'blocked') {
    exitCode = 1;
    reason = `'${lastStep ?? result.command}' cannot run here: ${result.context_hint}`;
  } else {
    reason = stoppedReason(runId, after, afterView);
    if (afterView.engine_runnable.some((e) => e.runnable_here === false) && !after.terminal_state) {
      exitCode = 1;
    }
  }
  print(`Stopped: ${reason}`);
  print(`Run ${runId}: phase '${deriveRunPhase(after)}'`);
  return exitCode;
}

export const runAdvanceCommand = new Command('advance')
  .description(
    'Run the guards and automatic steps a run owes, from this shell — no model provider, no key',
  )
  .argument('<run-id>', 'ID of the run to advance')
  .option(
    '--project <dir>',
    'CONFIG anchor: deployment root whose realm.yaml applies to definitions without a stored trust_root (default: current directory)',
  )
  .option(
    '--extensions-module <path>',
    "CODE override: module that REPLACES the workflow's declared 'extensions' modules (repair tool)",
  )
  .action(async (runId: string, opts: { project?: string; extensionsModule?: string }) => {
    // The program's name is checked first: a name that cannot be used prints one line and exits 1
    // before any work.
    const driver = resolveProgramIdentity(
      'advance',
      'it is written as the program that ran the steps, and advance checks it before reading the run, so nothing was run',
    );
    const { JsonFileStore, JsonWorkflowStore } = await import('@sensigo/realm');
    const runStore = new JsonFileStore();
    const workflowStore = new JsonWorkflowStore();
    try {
      const code = await advanceRunFromShell(runId, opts, runStore, workflowStore, driver, (l) =>
        console.log(l),
      );
      process.exit(code);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
