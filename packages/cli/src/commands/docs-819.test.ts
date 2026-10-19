// docs-819.test.ts — #819 (guardrail 7(f)): every docs and CHANGELOG sentence this unit adds names
// the cell that executes it, beside it. #819 correction 1: the stuck-run command's sentences are gone
// with it (01); abandon's two refusals and the CHANGELOG's bullet for them are claimed here. The
// sentences it changes in place are re-pinned where they were claimed (docs-627.test.ts,
// separation/separation-790.test.ts).
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
  it("correction 1 (01, 02 C2): abandon's refusals — a gate whose workflow cannot be read names the repair; an empty reason is refused", () => {
    const CLI = 'docs/reference/cli/realm-run-acting.md';
    // abandon-819 :: "the walk cases whose workflow cannot be read — A4f, A6b, A6c, B1, and the
    // repairable causes — are each refused with their repair; the record is unchanged".
    claim(
      CLI,
      "| The run is waiting at a gate whose workflow cannot be read | `Run '4233aa3c-…' is waiting on human gate 'review' (gate '70d76b3b-…'); it cannot be abandoned while its question is open. Its workflow cannot be read, so the question cannot be answered until it is repaired. Repair it: realm workflow validate --registered deploy` |",
    );
    // abandon-819 :: "02 C2: an empty or blank --reason is refused with its four clauses …".
    claim(
      CLI,
      "| `--reason` is empty or blank | `realm run abandon: invalid --reason value '': expected text that says why the run ends — refused: the run is not abandoned while the reason is empty, because an empty reason records nothing about why it ended. Give a reason, or leave --reason out (the record then says it was abandoned via realm run abandon). The run can be abandoned as soon as the reason is not empty.` |",
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
    // rows; `has_message` produces the later row's text); correction 1 (02 W1–W3): door-627 ::
    // "#819 correction 1 (02 W1): a reply whose gate carries no display …" and the protocol rules'
    // row (":481").
    claim(
      C,
      "The awaiting entry of a reply that carries no `gate` points to `get_run_state`'s `pending_gate.resolved_message` when the gate declares a message, and otherwise says `get_run_state` carries no question text for this gate and names the step the run waits at, as does a reply whose `gate` carries no `display`; every withheld awaiting entry tells the agent to give the user the run id, which they need to answer from a terminal, and the withheld protocol rules say to present `gate.display` when the reply has one. A `respond` way gains `has_message`, present when the record keeps the question's text.",
    );
    // abandon-819 :: "the walk cases …" (the repair) and "02 C2 …" (the empty reason); core
    // unanswerable-819 :: "getWorkflowForRun: a run at gate g-1 whose hex-suffixed workflow has no
    // copy → not registered …" and abandon-819 :: "B1: … no CLI surface says it was created by an
    // agent" (not registered, whatever its id); registrar-probe :: the live-gate cells (no `rm`).
    claim(
      C,
      "The run is still refused, as every run waiting at a gate is; where its answer line would name an answer the run cannot take yet, the refusal says the workflow cannot be read and names its repair (`realm workflow register <file>`, or `realm workflow validate --registered <id>`). An empty or blank `--reason` is refused, and the run is not abandoned. At a gate, a workflow whose copy is gone is reported as not registered, whatever its id (a workflow created by an agent has no gate), and the copy's repair no longer offers to remove the file.",
    );
    // slack-gate-notifier :: "exact match resolves gate …".
    claim(
      C,
      "`mcp_form`, `mcp`, `cli` or `slack` — `realm agent`'s Slack thread, issue #819 — as its door declared it",
    );
  });
});
