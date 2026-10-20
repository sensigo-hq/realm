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
    // #819 follow-up 2 re-pins (R2, R4): one row per repair form the refusal prints — abandon-819 ::
    // "the walk cases whose workflow cannot be read …" (gone: B1; damaged: A4f, A6c, notJson; older:
    // A6b; later: newer), "#819 follow-up 2 (R2): walk A4b, A5b and A6c …" (no `rm`), "#819 follow-up 2
    // (R2, the audit's B1): walk A6a and A6b …" (the class's own remedy), "#819 follow-up 2 (R2, R13):
    // a registry folder at mode 000 …" (the act respond names; core registrar :: repairActFor's
    // unreadable act). Was one row naming `realm workflow validate --registered deploy`.
    claim(
      CLI,
      "| The run is waiting at a gate, and its workflow's copy is gone | `Run '4233aa3c-…' is waiting on human gate 'review' (gate '70d76b3b-…'); it cannot be abandoned while its question is open. Its question cannot be answered until its workflow can be read. Repair it: realm workflow register <file>` |",
    );
    claim(
      CLI,
      "| … and its copy is damaged or not a workflow | `Run '4233aa3c-…' is waiting on human gate 'review' (gate '70d76b3b-…'); it cannot be abandoned while its question is open. Its question cannot be answered until its workflow can be read. Repair it: re-register the workflow from its source (realm workflow register <path-to-workflow>)` |",
    );
    claim(
      CLI,
      "| … and its copy cannot be read | `Run '4233aa3c-…' is waiting on human gate 'review' (gate '70d76b3b-…'); it cannot be abandoned while its question is open. Its question cannot be answered until its workflow can be read. Repair it: make /home/ops/.realm/workflows/deploy.json readable (chmod u+r /home/ops/.realm/workflows/deploy.json)` |",
    );
    claim(
      CLI,
      "| … and an older Realm registered its copy | `Run '4233aa3c-…' is waiting on human gate 'review' (gate '70d76b3b-…'); it cannot be abandoned while its question is open. Its question cannot be answered until its workflow can be read. Re-register it with: realm workflow register <path-to-workflow>` |",
    );
    claim(
      CLI,
      "| … and a later Realm registered its copy | `Run '4233aa3c-…' is waiting on human gate 'review' (gate '70d76b3b-…'); it cannot be abandoned while its question is open. Its question cannot be answered until its workflow can be read. Use the Realm version that registered it, or register the workflow's source again with this version.` |",
    );
    // #819 follow-up 2 re-pin (R1, the audit's S5): abandon-819 :: "#819 follow-up 2 (R1, the audit's
    // S5): an empty or blank --reason is refused in respond --by's words …". Was the four-clause
    // refusal whose last clause promised re-admission.
    claim(
      CLI,
      "| `--reason` is empty or blank | `--reason: empty; nothing was recorded. Give a reason, or leave it out: the default reason is 'Abandoned via realm run abandon'.` |",
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
    // row (":481"). #819 follow-up 2 re-pin (reader B's M2, M4(b)): "may need it to answer" —
    // door-627 :: "under withheld: W-a1 …" (re-pinned); every rule-2 variant says "when the reply has
    // one" — door-627 :: "rule 2, the await rule …" (re-pinned) and docs-pages-625-guides' live-rules
    // cell. Was "which they need to answer from a terminal, and the withheld protocol rules …".
    claim(
      C,
      "The awaiting entry of a reply that carries no `gate` points to `get_run_state`'s `pending_gate.resolved_message` when the gate declares a message, and otherwise says `get_run_state` carries no question text for this gate and names the step the run waits at, as does a reply whose `gate` carries no `display`; every withheld awaiting entry tells the agent to give the user the run id, which they may need to answer, and the protocol rules say to present `gate.display` when the reply has one. A `respond` way gains `has_message`, present when the record keeps the question's text.",
    );
    // #819 follow-up 2 re-pin (R1, R2, reader B's M5, the audit's S7): abandon-819 :: "the walk
    // cases …" (each copy's way on), "#819 follow-up 2 (R2): walk A4b, A5b and A6c …" (no `validate`,
    // no `rm`), "#819 follow-up 2 (R2, the audit's B1) …" (the older and later copies' own remedies),
    // "#819 follow-up 2 (R2, R13) …" (respond's act) and "#819 follow-up 2 (R1 …)" (nothing recorded);
    // core unanswerable-819 :: "getWorkflowForRun: a run at gate g-1 whose hex-suffixed workflow has
    // no copy → not registered …" and abandon-819 :: "B1: … no CLI surface says it was created by an
    // agent" (not registered, whatever its id; `create_workflow` opens no gate).
    claim(
      C,
      'The run is still refused, as every run waiting at a gate is; where its answer line would name an answer the run cannot take yet, the refusal says the question cannot be answered until its workflow can be read, and names the way on: the repair `realm run respond` names for the copy (make it readable, or re-register it from its source), the remedy of a copy an older or a later Realm registered, or `realm workflow register <file>` when the copy is gone. It no longer names `realm workflow validate`, and no longer offers to remove the copy. An empty or blank `--reason` is refused, and nothing is recorded. At a gate, a workflow whose copy is gone is reported as not registered, whatever its id (a workflow `create_workflow` writes has no gate).',
    );
    // slack-gate-notifier :: "exact match resolves gate …".
    claim(
      C,
      "`mcp_form`, `mcp`, `cli` or `slack` — `realm agent`'s Slack thread, issue #819 — as its door declared it",
    );
  });
});
