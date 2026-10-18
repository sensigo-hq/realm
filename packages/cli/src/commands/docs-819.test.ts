// docs-819.test.ts — #819 (guardrail 7(f)): every docs and CHANGELOG sentence this unit adds names
// the cell that executes it, beside it. The sentences it changes in place are re-pinned where they
// were claimed (docs-627.test.ts, separation/separation-790.test.ts).
//
// Every assertion carries (a) the change that turns it red — the page no longer says the sentence
// word for word — and (b) what it prints on failure: the page and the sentence.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const flat = (t: string) => t.replace(/\s+/g, ' ');

function claim(page: string, sentence: string): void {
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

describe('#819 — the docs sentences this unit adds, each by the cell that executes it', () => {
  it('U1: a question that can never be answered is ended by naming its gate — on every page that says abandon refuses a gate', () => {
    const TRUST = 'docs/concepts/gates-and-trust.md';
    // abandon-819 :: "each repairable cause keeps the refusal …" and abandon.test :: "issue #558
    // PR-C: the gate refusal ends in the command a CLI operator can run" (a question that can still
    // be answered keeps the refusal).
    claim(
      TRUST,
      'A run that is waiting at a gate cannot be abandoned either, while its question can still be answered.',
    );
    // abandon-819 :: "(a) an agent's copy that is gone: --gate ends the run …" and "(b) a copy that
    // cannot be read whose recorded source folder is gone: --gate ends the run"; core
    // unanswerable-819 :: "per member: …" (exactly those two).
    claim(
      TRUST,
      'A question that can never be answered is ended from a terminal by naming its gate: `realm run abandon <run-id> --gate <gate-id>`. That is a question whose workflow was created by an agent and whose stored copy is gone, or whose stored copy cannot be read and the folder it was registered from is gone.',
    );
    // core unanswerable-819 :: "(a) and (b): `gate` naming the open gate ends the run — the reason
    // names the cause …"; realm-mcp copy-819 :: "a run whose question can never be answered … is
    // still refused by abandon_run".
    claim(
      TRUST,
      "The run's recorded reason then says why. MCP's `abandon_run` refuses such a run as before (added after version 0.47.0).",
    );

    const CLI = 'docs/reference/cli/realm-run-acting.md';
    // args-witness-729 :: "respond, advance, inspect, abandon, register: …" (the flag, by name).
    claim(CLI, 'realm run abandon <run-id> [--reason <text>] [--gate <gate-id>]');
    // abandon-819 :: "(a) …", "(b) …"; core unanswerable-819 :: "(a) and (b): …" (the cause recorded).
    claim(
      CLI,
      '| `--gate <gate-id>` | Ends a run waiting at this gate whose question can never be answered: its workflow was created by an agent and its stored copy is gone, or its stored copy cannot be read and the folder it was registered from is gone. The cause then says why. |',
    );
    // abandon-819 :: "each repairable cause keeps the refusal …" (sourceThere: the repair command);
    // core unanswerable-819 :: "a question that can still be answered keeps the refusal …"
    // (sourceThere: the message).
    claim(
      CLI,
      "| The run is waiting at a gate whose workflow cannot be read yet | `Run '4233aa3c-…' is waiting on human gate 'review' (gate '70d76b3b-…'); it cannot be abandoned while its question is open. It can be answered once its workflow can be read: the stored copy of workflow 'deploy' (…/deploy.json) is not a valid workflow. Repair it: realm workflow validate --registered deploy` |",
    );
    // abandon-819 :: "without --gate, a question that can never be answered is refused, naming the
    // flag".
    claim(
      CLI,
      "| The run is waiting at a gate whose question can never be answered, and `--gate` is not given | `Run '4233aa3c-…' is waiting on human gate 'review' (gate '70d76b3b-…'), whose question can never be answered: workflow 'triage-0123456789abcdef' was created by an agent (create_workflow) and its stored copy is gone; there is no source file to register. To end it: realm run abandon 4233aa3c-… --gate 70d76b3b-…` |",
    );

    // realm-mcp copy-819 :: "a run whose question can never be answered … is still refused by
    // abandon_run"; abandon-819 :: "(a) …" (the CLI's --gate ends it).
    claim(
      'docs/reference/mcp/tools.md',
      "`abandon_run` refuses a run waiting at a gate even when its question can never be answered (its workflow's stored copy gone, with no source); only `realm run abandon --gate`, from a terminal, ends such a run (added after version 0.47.0).",
    );
    // abandon.test :: "issue #558 PR-C: the gate refusal ends in the command …" (answer first);
    // abandon-819 :: "(a) …" (the --gate command).
    claim(
      'docs/guides/operate-runs.md',
      '- **A run waiting at a gate cannot be abandoned while its question can be answered.** Answer the gate first. A question that can never be answered is ended with `realm run abandon <run-id> --gate <gate-id>`.',
    );
  });

  it("item 28: the record's route list names Slack's", () => {
    // slack-gate-notifier :: "exact match resolves gate and posts confirmation reply" (route slack
    // recorded) and its "#819 (item 28) the cross cell".
    claim(
      'docs/reference/run-record-and-export.md',
      'On a gate answer: how it arrived, as its door declared it — `route` (`mcp_form`, `mcp`, `cli` or `slack`)',
    );
  });

  it('the CHANGELOG bullets this unit adds, sentence by sentence', () => {
    const C = 'CHANGELOG.md';
    // realm-mcp door-627 :: "under withheld: W-a1 … — by whether the gate declares a message (#819 T1),
    // each telling the agent to give the user the run id (T2) …" (its later, noMessage and opened
    // rows; `has_message` produces the later row's text).
    claim(
      C,
      "The awaiting entry of a reply that carries no `gate` points to `get_run_state`'s `pending_gate.resolved_message` when the gate declares a message, and otherwise says the gate declares none and names the step the run waits at; every withheld awaiting entry tells the agent to give the user the run id. A `respond` way gains `has_message`, present when the record keeps the question's text.",
    );
    // abandon-819 :: "(a) …", "(b) …", "without --gate …", "each repairable cause …"; core
    // unanswerable-819 :: its four U1 cells; required-parts :: the abandonRun options rows; core
    // unanswerable-819 :: "an agent copy that is gone: the gate-named abandon …" (`gate_id`);
    // realm-mcp copy-819 :: abandon_run unchanged.
    claim(
      C,
      "It ends a run whose open question can never be answered: its workflow was created by an agent and its stored copy is gone, or its stored copy cannot be read and the folder it was registered from is gone. The run's reason says why, and the same write clears the question. Without `--gate`, such a run is refused and the refusal names the flag; a question that can still be answered is refused as before, now with its copy's repair when its workflow cannot be read. `abandonRun` takes `{ gate, absence }`; core exports `questionNeverAnswerable`, `definitionAbsentWords` and the `DefinitionAbsent` and `AbandonRunOptions` types; an `abandon` way names its gate in `gate_id`. MCP's `abandon_run` is unchanged.",
    );
    // slack-gate-notifier :: "exact match resolves gate …".
    claim(
      C,
      "`mcp_form`, `mcp`, `cli` or `slack` — `realm agent`'s Slack thread, issue #819 — as its door declared it",
    );
  });
});
