// reclaim command — detect or recover an after-claim wedge (issue #101).
//
// Phase 1 (per-step): `realm run reclaim <run-id>` is a DRY-RUN; `--step <name> --force` reclaims one
// named claim (the ONLY way to override an unknown-age / non-idempotent / healthy claim, by explicit
// human judgment). Phase 2 (batch): `realm run reclaim --all [...]` auto-reclaims — DRY-RUN by
// default, `--force` to act — ONLY claims that are provably safe: author-declared `idempotent`,
// carrying a concrete past-deadline (`claim_stale`), non-gated. Everything else stays per-step-only.
import { Command } from 'commander';
import { cliCommandOf, heldEntriesOf, heldWayLines, writerHost } from './ways-renderer.js';
import type {
  ClaimState,
  ComposedWays,
  HeldState,
  RunRecord,
  RunStore,
  StepDefinition,
  InProgressClaimInfo,
  ReclaimResult,
  Snapshot,
  TraceBufferStore,
  Unavailable,
  WorkflowDefinition,
  WorkflowRegistrar,
} from '@sensigo/realm';
import { parseDuration } from '../lib/parse-duration.js';
import { RUN_PHASE_WORDS, writerCtx } from '../output/writer.js';
import {
  WorkflowError,
  classifyInProgressClaims,
  composeWaysAt,
  composeWaysOn,
  definitionAbsenceOf,
  formatInstantWords,
  getWorkflowForRun,
  heldStateOf,
  overdueOf,
  reclaimConditionWords,
  reclaimRefusalWords,
  reclaimStep,
  respondWayOfGate,
} from '@sensigo/realm';
import { openCliHome } from '../lib/home.js';

/**
 * Pure outcome→(glyph, message) renderer (issue #221 [M4]) — the SINGLE source of both reclaim
 * CLI messages, shared by batch mode (`--all`) and per-step mode. Extracted (the `isAutoReclaimable`
 * precedent above) because the `.action` handler opens the real home and is not
 * unit-reachable; this function IS. `✓` marks the one MUTATING outcome (`reclaimed`); every other
 * outcome — including the new `no_active_claim` — gets the NEUTRAL glyph `•` (the house
 * informational bullet: purge.ts:419, reclaim.ts's own dry-run listing above). The
 * `no_active_claim` message text is EXACT (never "still eligible" — unverifiable without the
 * definition, which this command does not load).
 */
export function renderReclaimOutcome(
  result: Pick<ReclaimResult, 'step' | 'outcome' | 'priorState'>,
): { glyph: string; message: string } {
  switch (result.outcome) {
    case 'reclaimed':
      return {
        glyph: '✓',
        message: `Reclaimed '${result.step}' (was ${result.priorState}). It is eligible again — the next driver will re-drive it.`,
      };
    case 'taken_over':
      return {
        glyph: '•',
        message: `'${result.step}' was re-claimed by a live driver during reclaim — left untouched (not stomped).`,
      };
    case 'already_settled':
      return {
        glyph: '•',
        message: `'${result.step}' is already settled — no active claim to reclaim.`,
      };
    case 'no_active_claim':
      return {
        glyph: '•',
        message: `no active claim on '${result.step}' and it is not settled — nothing to reclaim. If its dependencies are satisfied, driving the run will execute it.`,
      };
  }
}

/**
 * #922 (P1 items 8, 12): what a judged per-step reclaim prints once admitted — each condition its
 * `force` discharged, in its words, then the outcome. A step the definition read here does not name
 * (renamed by a newer definition) says so. A step not held says so (exit 0, as before).
 */
export function reclaimResultLines(
  result: Pick<
    ReclaimResult,
    'step' | 'outcome' | 'priorState' | 'conditionsDischarged' | 'refusal'
  >,
  runId: string,
  definition: Pick<WorkflowDefinition, 'steps'> | undefined,
): string[] {
  const step = result.step;
  if (result.outcome === 'already_settled' || result.outcome === 'no_active_claim') {
    // correction 1: the words, then the run's ways on (the judged entry's remedy)
    if (result.refusal !== undefined) {
      return [reclaimRefusalText(reclaimRefusalWords(result.refusal)!, result.refusal)];
    }
    return [
      reclaimRefusalWords({
        verb: 'reclaim',
        step,
        code: 'not_held',
        facts: { step },
        remedy: [],
      })!,
    ];
  }
  if (result.outcome !== 'reclaimed') return [renderReclaimOutcome(result).message];
  const words = (result.conditionsDischarged ?? []).flatMap((c) => reclaimConditionWords(c) ?? []);
  const renamed = definition !== undefined && definition.steps[step] === undefined;
  return [
    ...words,
    renamed
      ? `Reclaimed step '${step}' of run ${runId}. The workflow definition read here has no step named '${step}'.`
      : `Reclaimed step '${step}' of run ${runId}: it can run again.`,
  ];
}

/**
 * #922 (P1 item 12): a judged refusal — core's fact, then its act through the CLI's one renderer: a
 * fence names each condition, then the command to reclaim the claim shown; a changed claim, where to
 * read it; any other, its ways on.
 */
export function reclaimRefusalText(message: string, refusal: Unavailable): string {
  const host = writerHost();
  const lines = refusal.remedy.flatMap((way) => {
    const command = cliCommandOf(way, undefined, host);
    if (command === null) return [];
    if (way.verb === 'reclaim') {
      const words = way.conditions.flatMap((c) => reclaimConditionWords(c) ?? []);
      return [[...words, `To reclaim this claim, run: ${command}`].join(' ')];
    }
    if (way.verb === 'respond') return [`To go on, answer its question first: ${command}`];
    return [way.verb === 'inspect' ? `See: ${command}` : `To go on: ${command}`];
  });
  // correction 1: one line per command (two agent steps render the same `realm agent` command)
  return [message, ...new Set(lines)].join(' ');
}

/**
 * The SAFETY-CRITICAL selection rule for `--all` auto-reclaim (issue #101 Phase 2, §3).
 * A claim is auto-reclaimable IFF ALL hold:
 *  1. the run is non-terminal;
 *  2. the step is an in-progress claim (guaranteed — `claim` comes from classifyInProgressClaims);
 *  3. the claim carries a CONCRETE deadline that has passed — i.e. state === 'claim_stale'
 *     (never 'claim_unknown_age' [null/absent deadline] and never 'healthy' [within deadline]);
 *  4. if `--older-than` is set, additionally (now − deadline) ≥ the grace margin;
 *  5. the step is author-declared `idempotent: true` in the workflow definition;
 *  6. the step is NOT the open gate.
 * `--force` acts on exactly this set — it NEVER widens it to unknown-age / non-idempotent / healthy /
 * gated claims (those remain per-step `--step <S> --force` only). A null/absent deadline is never
 * past-deadline, so the finalizer crash-wedge (deadline: null ⇒ claim_unknown_age) is structurally
 * excluded from the cron — intended, not a gap.
 */
export function isAutoReclaimable(
  run: Pick<RunRecord, 'terminal_state' | 'pending_gate'>,
  claim: InProgressClaimInfo,
  stepDef: StepDefinition | undefined,
  // #715 (b) (D-26): judged at the row's own snapshot's `at` (its `now: number` became `at`).
  opts: { olderThanMs?: number; at: Date },
): boolean {
  if (run.terminal_state) return false; // §3.1
  if (claim.state !== 'claim_stale') return false; // §3.3 + §3.4a — concrete deadline AND past it
  if (claim.step === run.pending_gate?.step_name) return false; // §3.6 — never the gated step
  if (stepDef?.idempotent !== true) return false; // §3.5 — requires the resolved definition
  if (opts.olderThanMs !== undefined) {
    // §3.4b — a null deadline is NEVER "old enough" (defensive; claim_stale already implies concrete).
    if (claim.deadline === null) return false;
    // #715 (b) (D-25): through the one deadline reader — an unparseable deadline is never "old
    // enough" (its NaN used to pass this test).
    const overdue = overdueOf(claim.deadline, opts.at);
    if (overdue === undefined || 'absent' in overdue || overdue.ms < opts.olderThanMs) return false;
  }
  return true;
}

/**
 * #922 P2-2 (item 5): the dry run's state word for a held step, from its composed entry — the three
 * words the reference documents (an unreadable deadline is of unknown age, never `healthy`: walk O3;
 * MA 2, WO922-P22-MA2-01).
 */
const CLAIM_STATE_OF: Record<HeldState['state'], ClaimState> = {
  ahead: 'healthy',
  past: 'claim_stale',
  unknown_age: 'claim_unknown_age',
  unreadable: 'claim_unknown_age',
  no_claim_record: 'claim_unknown_age',
  // #729 CW-3a: as CW-1b's classifier words a leased claim
  lease_held: 'healthy',
  lease_not_held: 'claim_stale',
};

/**
 * #922 P2-2 (item 5; m-I): a run's ways as the reclaim dry run composes them — its definition read
 * as the per-step path reads it, and on a refusal to read it (a `WorkflowError`) the definition-absent
 * composition, whose held entries need only the store. Any other error is thrown.
 */
export async function reclaimWaysOf(
  workflowStore: WorkflowRegistrar,
  snap: Snapshot,
  persistsClaims: boolean,
): Promise<ComposedWays> {
  try {
    const definition = await getWorkflowForRun(workflowStore, snap.record, {
      retryVerb: 'reclaim',
      verb: 'reclaim',
      terminalOk: true,
    });
    return composeWaysAt(snap.record, snap.at, {
      definition,
      persistsClaims,
      lease_facts: snap.lease_facts,
    });
  } catch (err) {
    const absent = definitionAbsenceOf(err, snap.record);
    if (absent === undefined) throw err;
    return composeWaysOn(snap, {
      definition: absent,
      enactor: { kind: 'observer' },
      store: { persistsClaims },
    });
  }
}

/**
 * #922 P2-2 (item 5): the dry run's lines for a run with steps in progress — each step's header
 * (its state from its composed entry), then the gate line, or what frees it (`heldWayLines`); the
 * footer names "a step's command above" only when one is listed (correction 1).
 */
export function reclaimDryRunLines(
  run: RunRecord,
  infos: readonly InProgressClaimInfo[],
  composed: ComposedWays,
): string[] {
  const held = new Map(heldEntriesOf(composed).map((e) => [e.facts.step, e]));
  const lines: string[] = [];
  // #922 P2-2 correction 1: whether a step above has a command that frees it.
  let listed = false;
  for (const c of infos) {
    const entry = held.get(c.step);
    const state = entry !== undefined ? CLAIM_STATE_OF[heldStateOf(entry).state] : c.state;
    lines.push(`  • ${c.step}: ${state}  (deadline: ${c.deadline ?? 'none (unknown age)'})`);
    const gate = run.pending_gate;
    if (gate !== undefined && gate.step_name === c.step) {
      // #729 PR-0 (Table row 43): the respond-path text — the answer command is the CLI renderer's,
      // from the open gate's `respond` way.
      lines.push(
        `      open gate — answer it, not reclaim: ${cliCommandOf(respondWayOfGate(run.id, gate), undefined, writerHost())}`,
      );
    } else if (entry !== undefined) {
      const under = heldWayLines(entry, writerCtx());
      if (under.length > 0) listed = true;
      for (const line of under) lines.push(`      ${line}`);
    }
  }
  lines.push(
    `\nReclaim re-drives a step (at-least-once — side effects may repeat).` +
      (listed ? ` Run a step's command above to free it.` : '') +
      ` realm run reclaim --all lists, across every run, the claims past their deadline whose ` +
      `steps are idempotent; with --force it frees them.`,
  );
  return lines;
}

/** #922 P2-2 (item 6): one `--all` pick — the claim selected, the definition and stamp read then. */
export interface AutoReclaimPick {
  runId: string;
  claim: InProgressClaimInfo;
  at: Date;
  definition: WorkflowDefinition;
  claimedAt?: string;
}

/**
 * The `--all` selection (issue #101 Phase 2): across the store's runs (of one workflow when given),
 * every claim {@link isAutoReclaimable} admits, with the definition and (#922 P2-2) the claim's
 * stamp read when it was selected.
 */
export async function selectAutoReclaims(
  store: RunStore,
  workflowStore: Pick<WorkflowRegistrar, 'get'>,
  opts: { workflow?: string; olderThanMs?: number },
): Promise<AutoReclaimPick[]> {
  // #715 (b) (D-26): no clock read here — each row is judged at its own snapshot's `at`.
  const selected: AutoReclaimPick[] = [];
  // #616 PR-2c c4: every page of the store's scan, of one workflow when one is given.
  const snapshots: Snapshot[] = [];
  const filter = opts.workflow === undefined ? {} : { workflow: opts.workflow };
  for await (const page of store.scan(filter, { pageSize: 1000, projection: 'record' })) {
    for (const item of page.items) if (item.kind === 'run') snapshots.push(item.run);
  }
  for (const snapshot of snapshots) {
    const { record: run, at } = snapshot;
    if (run.terminal_state) continue;
    // #729 CW-1b part 2: judged on the scan's snapshot, with its lease facts.
    const claims = classifyInProgressClaims(snapshot);
    if (claims.length === 0) continue;
    // Resolve the definition to read the `idempotent` hint. Unresolvable → cannot confirm
    // idempotent → exclude every claim (safe: never auto-reclaim an unverifiable step).
    const def = await workflowStore.get(run.workflow_id).catch(() => undefined);
    if (def === undefined) continue;
    for (const claim of claims) {
      const selOpts =
        opts.olderThanMs !== undefined ? { olderThanMs: opts.olderThanMs, at } : { at };
      if (!isAutoReclaimable(run, claim, def.steps[claim.step], selOpts)) continue;
      const since = run.claims?.[claim.step]?.since;
      selected.push({
        runId: run.id,
        claim,
        at,
        definition: def,
        ...(typeof since === 'string' ? { claimedAt: since } : {}),
      });
    }
  }
  return selected;
}

/**
 * `--all --force` (issue #101 Phase 2; #922 P2-2 item 6): each pick judged as offered — `force`,
 * the definition selection read and the stamp it read (none for an unstamped claim) — one CAS each,
 * continuing past a refusal or an error. Fenced only from selection to write (D3 §13 m-A).
 */
export async function reclaimPicks(
  store: RunStore,
  picks: readonly AutoReclaimPick[],
  traceBufferStore: TraceBufferStore | undefined,
  print: (line: string) => void,
  printError: (line: string) => void,
): Promise<number> {
  let reclaimed = 0;
  for (const pick of picks) {
    const { runId: rid, claim } = pick;
    try {
      const result = await reclaimStep(store, rid, claim.step, {
        ...(traceBufferStore !== undefined ? { traceBufferStore } : {}),
        force: true,
        definition: pick.definition,
        ...(pick.claimedAt !== undefined ? { claimed_at: pick.claimedAt } : {}),
      });
      if (result.outcome === 'reclaimed') reclaimed += 1;
      const { glyph, message } = renderReclaimOutcome(result);
      print(`  ${glyph} ${rid}: ${message}`);
      // issue #291 ([F7] defer-to-drain advisory) — reclaim never enacts a sibling gate's
      // expiry itself; it only points at the guaranteed-reachable lever.
      if (result.gateAdvisory !== undefined) print(`    ⚠ ${result.gateAdvisory}`);
    } catch (err) {
      // continue-on-error: one CAS mismatch/failure must not abort the batch.
      printError(`  ✗ ${rid} / '${claim.step}': ${pickRefusalWords(err)}`);
    }
  }
  return reclaimed;
}

/** #922 P2-2: a refused `--all` pick's words — a claim changed since selection said as such. */
function pickRefusalWords(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const refusal = err instanceof WorkflowError ? err.refusal : undefined;
  if (refusal?.code !== 'claim_changed') return err.message;
  const facts = refusal.facts;
  const now =
    typeof facts.current_claimed_at === 'string'
      ? `claimed since ${facts.current_claimed_at}`
      : 'held by a claim with no stamp';
  return `${now}, not since ${facts.offered_claimed_at} when selected; nothing was removed.`;
}

export const reclaimCommand = new Command('reclaim')
  .description('Detect or recover a wedged run (a step claimed but never settled)')
  .argument('[run-id]', 'ID of the run to inspect (default) or reclaim; omit when using --all')
  .option(
    '--step <name>',
    "Reclaim this in-progress step (requires --force); realm run reclaim <run-id> prints each held step's command",
  )
  .option(
    '--claimed-at <stamp>',
    "With --step: the claim's stamp, as the offered command shows it (required for a claim whose deadline is ahead or unknown)",
  )
  .option('--force', 'Actually reclaim — re-drives the step(s); side effects may repeat')
  .option(
    '--all',
    'Batch mode: auto-reclaim every idempotent, concrete-past-deadline, non-gated claim (dry-run without --force)',
  )
  .option('--workflow <id>', 'With --all: only consider runs of this workflow')
  .option(
    '--older-than <duration>',
    'With --all: only claims past deadline by ≥ this (e.g. 30m, 6h)',
  )
  .action(
    async (
      runId: string | undefined,
      opts: {
        step?: string;
        claimedAt?: string;
        force?: boolean;
        all?: boolean;
        workflow?: string;
        olderThan?: string;
      },
    ) => {
      // #616 PR-2a (iii): the one door, opened once; the registry is built on its first use.
      const home = await openCliHome();
      const store = home.runStore;
      // issue #198: wire the trace buffer so a reclaim clears the reclaimed step's stale WAL —
      // without this, reclaimStep's own clearStaleWal hook is inert (traceBufferStore stays
      // undefined) and the next attempt adopts the dead attempt's buffered lines, which is the
      // mechanical reason a sequential-abandon-then-retry is #185's dominant "adopted a
      // prior/concurrent writer's lines" population.
      // issue #616 PR-0: the door's trace buffer reads through the run store reclaim writes —
      // reclaim's `run_at_version` fence is evaluated against it inside its critical section.
      const traceBufferStore = home.traceBufferStore;

      // Loud-fail on a store that cannot persist the claim clock (liveness recovery unavailable).
      if (!store.persistsClaims) {
        console.error(
          'This store does not persist claims; liveness recovery is unavailable on this store.',
        );
        process.exit(1);
      }

      // ============================ Batch mode (Phase 2) ============================
      if (opts.all === true) {
        if (runId !== undefined) {
          console.error('Cannot combine a <run-id> with --all. Use one or the other.');
          process.exit(1);
        }
        if (opts.step !== undefined) {
          console.error('--step is a per-run flag; it cannot be combined with --all.');
          process.exit(1);
        }
        if (opts.claimedAt !== undefined) {
          console.error('--claimed-at is a per-step flag; it cannot be combined with --all.');
          process.exit(1);
        }
        let olderThanMs: number | undefined;
        if (opts.olderThan !== undefined) {
          try {
            olderThanMs = parseDuration(opts.olderThan);
          } catch (err) {
            console.error(err instanceof Error ? err.message : String(err));
            process.exit(1);
          }
        }

        let selected: AutoReclaimPick[];
        try {
          selected = await selectAutoReclaims(store, home.workflowStore, {
            ...(opts.workflow !== undefined ? { workflow: opts.workflow } : {}),
            ...(olderThanMs !== undefined ? { olderThanMs } : {}),
          });
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }

        if (selected.length === 0) {
          console.log(
            'No auto-reclaimable claims found (idempotent ∧ concrete-past-deadline ∧ non-gated).',
          );
          return;
        }

        if (opts.force !== true) {
          // DRY-RUN (default): report what WOULD be reclaimed; mutate nothing.
          console.log(
            `${selected.length} claim(s) WOULD be auto-reclaimed (idempotent ∧ past-deadline ∧ non-gated):`,
          );
          for (const { runId: rid, claim, at } of selected) {
            // #715 (b) (03 §B.2 A13): how far past its deadline, through the one formatter at this
            // row's reading (a selected claim's deadline is concrete and past); the stored string
            // stays beside the words.
            const pastWords = formatInstantWords(claim.deadline!, 'deadline', at);
            console.log(
              `  • ${rid} / ${claim.step}  (deadline ${claim.deadline}${pastWords !== undefined ? `, ${pastWords}` : ''})`,
            );
          }
          console.log(
            `\nRe-run with --force to reclaim them. WARNING: each re-executes its handler ` +
              `at-least-once with NO per-step human judgment — enable only for genuinely idempotent handlers.`,
          );
          return;
        }

        // --force: reclaim each selected claim, one CAS each, continue-on-error across claims.
        console.warn(
          `⚠ Auto-reclaiming ${selected.length} claim(s); each re-executes its handler — side effects may repeat.`,
        );
        const reclaimed = await reclaimPicks(
          store,
          selected,
          traceBufferStore,
          (line) => console.log(line),
          (line) => console.error(line),
        );
        console.log(`Reclaimed ${reclaimed}/${selected.length} selected claim(s).`);
        return;
      }

      // ==================== Per-step / single-run mode (Phase 1) ====================
      if (opts.workflow !== undefined || opts.olderThan !== undefined) {
        console.error('--workflow and --older-than are only valid with --all.');
        process.exit(1);
      }
      if (runId === undefined) {
        console.error('Provide a <run-id> to inspect/reclaim, or use --all for batch mode.');
        process.exit(1);
      }

      if (opts.claimedAt !== undefined && opts.step === undefined) {
        console.error('--claimed-at requires --step <name>.');
        process.exit(1);
      }
      // --force without --step: refuse (must name the claim to act on — no blanket sweep here).
      if (opts.force === true && opts.step === undefined) {
        console.error(
          '--force requires --step <name> (or use --all for batch). Run without arguments to see a dry-run.',
        );
        process.exit(1);
      }

      try {
        // #729 CW-1b part 2: the read whole, with the lease facts the store attached.
        const read = await store.get(runId);
        const { record: run } = read;

        // --- Reclaim path: --step (+ --force) ---
        if (opts.step !== undefined) {
          if (opts.force !== true) {
            // #922 P2-2 (S-2): the dry run, which prints the command for the claim it shows.
            console.error(
              `Refusing to reclaim '${opts.step}' without --force. See realm run reclaim ${runId}, ` +
                `which prints each held step's command.`,
            );
            process.exit(1);
          }
          // #922 (P1 items 8, 9, 12): the judged call — nothing is printed before admission. The
          // definition is the run's own copy; one that cannot be read is judged `definition_absent`.
          const definition = await getWorkflowForRun(home.workflowStore, run, {
            retryVerb: 'reclaim',
            verb: 'reclaim',
            terminalOk: true,
          }).catch(() => undefined);
          let result: ReclaimResult;
          try {
            result = await reclaimStep(store, runId, opts.step, {
              traceBufferStore,
              force: true,
              ...(definition !== undefined ? { definition } : {}),
              ...(opts.claimedAt !== undefined ? { claimed_at: opts.claimedAt } : {}),
            });
          } catch (err) {
            if (err instanceof WorkflowError && err.refusal !== undefined) {
              console.error(reclaimRefusalText(err.message, err.refusal));
              process.exit(1);
            }
            throw err;
          }
          for (const line of reclaimResultLines(result, runId, definition)) console.log(line);
          if (result.gateAdvisory !== undefined) {
            console.log(`  ⚠ ${result.gateAdvisory}`);
          }
          return;
        }

        // --- Dry-run (default): report the run's in-progress claims, no mutation ---
        if (run.terminal_state) {
          console.log(
            `Run '${runId}' is terminal (${writerCtx().word(run.run_phase, RUN_PHASE_WORDS)}); it has no reclaimable claim.`,
          );
          return;
        }
        const infos = classifyInProgressClaims(read);
        if (infos.length === 0) {
          console.log(
            `Run '${runId}' (${writerCtx().word(run.run_phase, RUN_PHASE_WORDS)}) has no in-progress claims. Nothing to reclaim.`,
          );
          return;
        }
        console.log(
          `Run '${runId}' (${writerCtx().word(run.run_phase, RUN_PHASE_WORDS)}) — in-progress claims:`,
        );
        // #922 P2-2 (item 5): each held step from the run's composed ways.
        const composed = await reclaimWaysOf(home.workflowStore, read, true);
        for (const line of reclaimDryRunLines(run, infos, composed)) console.log(line);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    },
  );
