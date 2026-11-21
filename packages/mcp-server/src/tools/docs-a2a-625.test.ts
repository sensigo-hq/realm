// docs-a2a-625.test.ts — #625 PR-2b unit A2a (prompt feat-625-a2a-carry-on.md): the words the unit adds
// for a reader, each held to its page word for word (spaces folded, as a table's padding moves), with
// the cell that executes what the sentence says named beside it (guardrail 9). CO = core
// carry-on-a2a-625.test.ts; MC = mcp-server tools/carry-on-a2a-625.test.ts.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8: (a) red when the page
// no longer holds the sentence word for word (once); (b) prints the page and the sentence.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const flat = (t: string): string => t.replace(/\s+/g, ' ');
const read = (page: string): string => readFileSync(join(ROOT, page), 'utf8');
function claim(page: string, sentence: string): void {
  expect(
    flat(read(page)).split(flat(sentence)).length - 1,
    `${page} no longer says (once): ${sentence}`,
  ).toBe(1);
}
const TOOLS = 'docs/reference/mcp/tools.md';

describe('#625 PR-2b A2a — tools.md, submit_human_response', () => {
  it('Carrying the run on: when, how far, within what time', () => {
    // MC check 9 (the token's answer runs `send` in the call); CO check 2 (to the next pause), check
    // 5 (the budget, a started step runs to its end).
    claim(
      TOOLS,
      'When the answer passes back the `claim_token` (its `proof` is `matched`), the call carries the run on: it runs the guards and `auto` steps the run then owes, as `advance_run` would on this server, until a step opens a question, fails, waits for the agent or ends the run.',
    );
    claim(
      TOOLS,
      "It does so within 240 seconds of the call's start; a step that has started runs to its end, and can take the call past them.",
    );
  });

  it('the merged reply, and the rule', () => {
    // CO check 2 (command, hint), check 3 (the late arm: status the error's, answer_recorded and
    // gate_claim kept, the expiry line first), check 6 / MC check 6 (a question handed on).
    claim(
      TOOLS,
      "The reply is then about what the call ran: its `status`, `stopped_step`, `chained_auto_steps` and the rest are the continuation's. It keeps the answer's own facts. `command` is the gate's step. `context_hint` opens with the answer's sentence. The guards the answer's own write decided come first in `guards`. `answer_recorded`, `outcome` and `expiry` stay where the answer had them, and the answer's `warnings` come first. A question the call reaches is handed on as any reply that opens a question hands it on: its answer instruction carries that question's own claim token.",
    );
    claim(
      TOOLS,
      "`gate_claim` on a reply says that this call's question is settled, whatever `status` says. The answer was recorded unless `answer_recorded` is false. `carried_on: true` means the continuation was started, not that it finished the run.",
    );
  });

  it('the members of gate_claim', () => {
    // CO check 5 and MC check 5 (chain_stopped, the owed sentence); CO check 2 (continued_by, and
    // its absent form); CO check 7 (answered_by on time, spent and late).
    claim(
      TOOLS,
      "With `carried_on: true`, `budget` when the call's time ran out before the next step started. The door's `Owed to the engine` sentence names the steps still owed, and `next_actions` holds `advance_run`.",
    );
    claim(
      TOOLS,
      "`gate_claim.continued_by` is `{ by: null, absent_cause: 'driver_not_recorded' }` when the host passed no driver.",
    );
    claim(
      TOOLS,
      'Who answered, as the record keeps it: the name the answer was recorded with, `{ "by": "Ana", "by_source": "stated" }` (stated by the caller, never verified), or `{ "by": null, "absent_cause": … }` with `settled_by_expiry` (the question\'s expiry settled it), `not_stated` or `name_unreadable`.',
    );
  });

  it('the reasons, and a server that records no code identity', () => {
    // CO check 1, one cell per row (and per reason).
    for (const row of [
      '| `nothing_runnable` | After the answer there is nothing this call could run: the run ended, only agent steps remain, or every owed step is refused. |',
      '| `not_settled_by_this_call` | The question was settled before this call (`proof: spent`). |',
      '| `proof_absent` | No `claim_token` was passed. |',
      "| `proof_mismatch` | The one passed is not this question's. |",
      '| `proof_unverifiable` | There was nothing to check it against. |',
      "| `no_registry` | The call has no step registry (a program's own call; every MCP server has one). |",
      "| `extensions_differ` | This server's code is not the code the run last ran with. |",
      "| `extensions_not_comparable` | This server's code cannot be compared with the code the run last ran with. |",
    ])
      claim(TOOLS, row);
    // CO check 1 row 6 (none recorded, none here: carried on); MC check 9 (`realm-mcp` over stdio).
    claim(
      TOOLS,
      'A server that records no code identity (`realm-mcp`, an embedding program) is not compared: on a run that recorded none either, it carries the run on.',
    );
  });

  it('the sentences', () => {
    // CO check 1 (each reason's sentence), check 5 (the budget's, after `a` and after the gate step);
    // MC check 9 (`next_actions` holds advance_run).
    claim(
      TOOLS,
      "When the call did not carry the run on and the run owes steps, the reply's sentence about the token ends with `The run was not carried on in this call.`, and `next_actions` holds `advance_run`, which runs the owed steps. For `no_registry` the sentence is `This call has no step registry. The run was not carried on in this call.`; for `extensions_differ`, `This server's code is not the code the run last ran with. The run was not carried on in this call; its owed steps run with the code of the program that runs them.`; for `extensions_not_comparable`, `This server's code cannot be compared with the code the run last ran with.` and the same second sentence. When the call's time ran out, it is `This call's time ran out after '<step>'; the run was not carried further in this call.`, naming the last step it ran (the gate's step when it ran none).",
    );
    // CO check 1 rows 2–3 (the proof's sentence, then C; C alone for `spent` with no token).
    claim(
      TOOLS,
      "The reply has at most one sentence in `warnings` about the token. Unless the proof is `matched`, or is `spent` with no token passed, it starts with the proof's sentence; when the call did not carry the run on and the run owes steps, it ends with `The run was not carried on in this call.` (that sentence alone for `spent` with no token; added after version 0.50.0).",
    );
  });

  it('the lines the carry-on made false, rewritten', () => {
    // CO check 2 (the guards after the answer in chained_auto_steps; `a`, `b` listed).
    claim(
      TOOLS,
      "From `submit_human_response`, the guards the answer's own write decided are in `guards` only; when the answer carries the run on, the guards decided after it are in `chained_auto_steps`, as from `execute_step` (added after version 0.50.0).",
    );
    claim(
      TOOLS,
      'The reply names it in `guards`; its `chained_auto_steps` list only what the call ran after the answer, when it carried the run on (added after version 0.50.0).',
    );
    // docs-claims-625 C163 (an answer that passes no token: the owed sentence).
    claim(
      TOOLS,
      'An answer that does not carry the run on — here, one that passed no `claim_token` — names what the run owes:',
    );
    // MC check 9, CO check 2 (with the token, the steps run in the call); holder-625 (the schema's
    // description says it too).
    claim(
      TOOLS,
      'with it, the steps after the answer run in this call (see [Carrying the run on](#carrying-the-run-on)). Never required.',
    );
    // CO check 2 (the shape), check 7 (answered_by).
    claim(
      TOOLS,
      '`gate_claim` says what the token showed, whether the call carried the run on (see [Carrying the run on](#carrying-the-run-on)) and who answered; whether the answer was recorded is `answer_recorded`.',
    );
    claim(TOOLS, '"carried_on": true,');
  });
});

describe('#625 PR-2b A2a — the CHANGELOG and llms.txt', () => {
  it('the CHANGELOG’s two lines, under [Unreleased]', () => {
    // MC check 9 and CO check 2 (carried on), CO check 1 row 5 and row 6 (the code compared, none
    // not compared), CO check 5 (240 s: MC check 5), CO check 7 (answered_by); a form's answer:
    // core holder-proof-625's route rows (no carry-on without a token).
    const text = read('CHANGELOG.md');
    const unreleased = text.slice(text.indexOf('## [Unreleased]'), text.indexOf('\n## [0.50.0]'));
    for (const line of [
      "- **An answer through `submit_human_response` carries the run on.** When the answer comes from the conversation that opened the question (it passes back the claim_token), and the server's code is the code the run last ran with (a server that records no code identity carries on a run that recorded none either), the steps after the answer run in the same call. They run up to the next pause, and no step starts later than 240 seconds after the call's start. The reply keeps the answer's facts: `gate_claim` gains `carried_on`, `not_carried_on_because`, `chain_stopped`, `continued_by` and `answered_by` (the name the answer was recorded with). A form's answer carries on when the form came from the call that opened the question, within the form wait's time; any other form does not. (#625)",
      "- In the library, `submitHumanResponse` carries the run on in the same way for a program that passes back the opening reply's `claimToken` with a registry. `SubmitGateOptions` gains `traceBufferStore`, for the steps it runs, and `budget`, whose `remainingMs` is read before each next step starts (without it nothing bounds the carry-on). `EngineReply`'s `gate_claim` gains the members above, and `AdvanceCaller` (with its list in `ENTRY_CALLERS`) gains `submit_human_response` and `submitHumanResponse`, the words such a call runs the steps under. (#625)",
    ])
      expect(flat(unreleased), `the CHANGELOG no longer says: ${line}`).toContain(flat(line));
  });

  it('llms.txt: the answer with its token runs the step; the glossary', () => {
    // MC check 9 (the answer with the opening reply's token completes the run in the one call).
    claim(
      'website/src/pages/llms.txt.js',
      '\'  → status "ok", run_phase "completed": the answer passed back the claim_token, so the call ran \\\'publish\\\' too; the webhook received the note\',',
    );
    claim(
      'website/src/pages/llms.txt.js',
      '\'- **"Owed to the engine":** automatic steps that are ready to run and that no call has run yet; `advance_run` runs them. An answer that passes back its `claim_token` runs them itself, in the same call.\',',
    );
  });
});
