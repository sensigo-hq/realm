// The home page stepper's decisions, as pure functions (#624, design rev 4, "The live layer inside
// the real stepper"). The live bundle exports them next to start(), so the build guard
// (scripts/live/smoke.mjs) tests the bytes the page runs; Replay.astro's frontmatter imports this
// file at build time for recorded mode, so one source states every visitor sentence in both modes.
// No DOM and no I/O here. Replay.astro's client script only wires the DOM to these.
//
// Workflow knowledge (the demo is pinned to examples/08-pr-review): the gate step is
// confirm_review and the two posting steps are post_approval and post_changes_request.

export const PAGE_MAX_BYTES = 16 * 1024;
export const PAGE_MAX_DEPTH = 32;
const TERMINAL = new Set(['completed', 'failed', 'abandoned', 'aborted']);
const POSTING = ['post_approval', 'post_changes_request'];

export function depthOf(v, d = 0) {
  if (d > PAGE_MAX_DEPTH) return d;
  if (v && typeof v === 'object') {
    let m = d + 1;
    for (const x of Object.values(v)) m = Math.max(m, depthOf(x, d + 1));
    return m;
  }
  return d;
}

// Parse the raw text first; only if that fails, retry with curly quotes made straight.
export function parseInput(text) {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > PAGE_MAX_BYTES)
    return { ok: false, message: `The page sends at most 16 KB; this is ${bytes} bytes.` };
  let value,
    note = null;
  try {
    value = JSON.parse(text);
  } catch (e1) {
    const straight = text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
    try {
      value = JSON.parse(straight);
      note = 'The page replaced curly quotes with straight ones before sending.';
    } catch {
      return { ok: false, message: 'This is not valid JSON: ' + e1.message };
    }
  }
  if (depthOf(value) > PAGE_MAX_DEPTH)
    return { ok: false, message: `The page sends at most ${PAGE_MAX_DEPTH} levels of nesting.` };
  return { ok: true, value, note };
}

// The reply-class table, checked top to bottom; the first row that matches wins.
// 1 page check · 2 MCP input error · 3 engine fault · 4 refused · 5 accepted · 6 no-op on a
// finished run · 7 catch-all.
export function classify(reply, before, after) {
  if (reply.kind === 'page')
    return {
      cls: 'page',
      label: 'The page could not send this',
      reason: '(The page’s own check.) ' + reply.message,
    };
  if ((reply.kind === 'text' || reply.kind === 'thrown') && /^MCP error/.test(reply.value))
    return { cls: 'mcp', label: 'Realm’s MCP layer refuses', reason: reply.value };
  const v = reply.kind === 'json' ? reply.value : null;
  if (!v)
    return {
      cls: 'other',
      label: 'Realm answered: ' + String(reply.value).slice(0, 64),
      reason: '',
    };
  const firstError =
    v.error_details?.errors?.[0]?.message ??
    (typeof v.errors?.[0] === 'string' ? v.errors[0] : undefined);
  if (v.error_code === 'ENGINE_INTERNAL')
    return {
      cls: 'internal',
      label: 'Realm hit an internal error',
      reason: firstError ?? v.context_hint ?? '',
    };
  if (v.status === 'error' || v.status === 'blocked')
    return { cls: 'refused', label: 'Realm refuses', reason: firstError ?? v.context_hint ?? '' };
  const b = before?.completed_steps ?? [],
    a = after?.completed_steps ?? [];
  const grew = a.length > b.length;
  if ((v.status === 'ok' || v.status === 'confirm_required') && grew)
    return { cls: 'accepted', label: 'Realm accepts it', reason: '' };
  if (v.status === 'ok' && !grew && TERMINAL.has(after?.run_phase))
    return { cls: 'noop', label: 'The run has already ended', reason: v.context_hint ?? '' };
  return {
    cls: 'other',
    label: 'Realm answered: ' + String(v.status),
    reason: v.context_hint ?? '',
  };
}

// The counting line. A schema refusal carries error_details.rejections and .threshold (0.46.0
// sends both; the threshold is never hard-coded). `blocked` and an MCP-layer refusal never reach
// the counter: "Nothing was counted.".
export function countLine(reply) {
  if ((reply?.kind === 'text' || reply?.kind === 'thrown') && /^MCP error/.test(reply.value))
    return 'Nothing was counted.';
  const v = reply?.kind === 'json' ? reply.value : null;
  if (!v) return null;
  if (v.status === 'blocked') return 'Nothing was counted.';
  const n = v.error_details?.rejections,
    m = v.error_details?.threshold;
  if (typeof n === 'number' && typeof m === 'number')
    return `This refusal is counted (${n} of ${m}).`;
  return null;
}

// The gate text comes only with the reply that opened the gate (get_run_state's pending_gate has
// no display, P-8).
export function gateText(openingReply) {
  const v = openingReply?.kind === 'json' ? openingReply.value : openingReply;
  const d = v?.gate?.display;
  return typeof d === 'string' ? d.trim() : null;
}

// After the answer, the closed branch is the posting step the answer's `when` turned off
// (skip_details kind when_false; a failed run skips both with another kind). The chosen posting
// step is the other one; it is offered to the agent while the run is running and that step is
// not completed (#625: on 0.46.0 the answer does not run it).
export function nextActions(state) {
  const sd = state?.skip_details ?? {};
  const other = POSTING.find((p) => sd[p]?.kind === 'when_false') ?? null;
  if (!other) return { send: null, other: null };
  const step = POSTING.find((p) => p !== other);
  const send =
    state?.run_phase === 'running' && !(state?.completed_steps ?? []).includes(step) ? step : null;
  return { send, other };
}

// The Live state table's five states, from the run's state after the last reply: A running, gate
// not reached · B gate open · C answered, chosen posting step not sent · D completed · E failed.
export function stateLetter(state) {
  const p = state?.run_phase;
  if (p === 'completed') return 'D';
  if (TERMINAL.has(p)) return 'E';
  if (state?.pending_gate) return 'B';
  if (nextActions(state).other) return 'C';
  return 'A';
}

// The choice the gate answer recorded, from the run record's gate-response entry.
export const answeredChoice = (run) =>
  (run?.evidence ?? []).find((e) => e.kind === 'gate_response')?.input_summary?.choice ?? null;

const refusals = (n) => `${n} counted refusal${n === 1 ? '' : 's'}`;

// One row per evidence entry, labelled as recorded mode labels them.
export function evidenceRows(run) {
  const ev = run?.evidence ?? [];
  const gateSteps = new Set(ev.filter((e) => e.kind === 'gate_response').map((e) => e.step_id));
  return ev.map((e) => {
    const n = e.diagnostics?.validation_rejections;
    const label =
      e.kind === 'gate_response'
        ? `human chose ${e.input_summary?.choice}`
        : gateSteps.has(e.step_id)
          ? 'gate opened'
          : n && e.status === 'success'
            ? `accepted after ${refusals(n)}`
            : e.status;
    return { step: e.step_id, label, hash: e.evidence_hash };
  });
}

// Recorded mode's inputs, in the shapes the functions above take. `recordedRun` maps an ending's
// evidence list to run-record entries; `recordedState` is the state after the answer, derived from
// the recording (the CLI's "new state", the completed steps minus the posted one, the skip line).
export function recordedRun(ending) {
  return {
    evidence: ending.evidence.map((x) => ({
      step_id: x.step,
      kind: x.kind === 'step' ? undefined : x.kind,
      status: x.status,
      evidence_hash: x.hash,
      input_summary: x.kind === 'gate_response' ? { choice: x.choice } : {},
      diagnostics: x.rejections == null ? {} : { validation_rejections: x.rejections },
    })),
  };
}
export function recordedState(r, ending) {
  const [, step, kind] = /^(\w+): (\w+):/.exec(ending.skipped) ?? [];
  return {
    run_phase: /new state '([a-z_]+)'/.exec(ending.respond.stdout)?.[1] ?? null,
    completed_steps: ending.completed_steps.filter((x) => x !== ending.posted.step),
    skipped_steps: ending.skipped_steps,
    skip_details: step ? { [step]: { kind } } : {},
    choice: ending.choice,
    gate_state: r.gate.state,
    after_refusals: r.after_refusals,
    meta: r.meta,
  };
}

// THE CLAIM LEDGER (design rev 4 "Claim ledger", executed on 0.46.0; R = recorded, L = live).
// Every visitor sentence below is true on the pinned release for the reason given. At each version
// bump: the guard (scripts/live/smoke.mjs) re-runs the rows marked "guard"; check the rows marked
// "hand" by hand on the new release (pre-publication checklist Part B, step 11).
// Line numbers are Replay.astro's on 1f8262c2.
//
// | Where | Sentence | Holds because | Modes | Checked by |
// |---|---|---|---|---|
// | :29 | The agent starts a run. Realm fetches the pull request itself. | fetch_pr is `execution: auto`; start_run's reply has it completed and the GitHub stand-in logged the GET | R, L | guard (start reply, stand-in log) |
// | :45 | All four are required. Nothing else gets into the record. | missing_field and extra_field are refused; a refused call leaves no entry (#724: `__proto__` is accepted but is not in the record) | R, L | guard (attempt replies, after_refusals) |
// | :59 | the reply's class label | classify(), from the reply and the state before and after | L | guard (reply classes) |
// | :63 | The step is complete, and the run stops at the human gate. Go to the next stage. | the recorded valid reply is confirm_required, phase gate_waiting | R | guard (valid reply) |
// | :63 | The step is complete and the run stops at the gate | shown only while pending_gate is set (a failed run never sets it) | L | guard |
// | :64 | After every refusal the run still read … No step completed. Refusals of a submission's content are counted toward the limit of six; a step sent out of order is not. | after_refusals is fetch_pr only; the write_review entry counts 3 for the 3 schema refusals; the skip-ahead is `blocked` | R | guard (after_refusals, :140 row) |
// | :64 | This refusal is counted (n of m). / Nothing was counted. | error_details.rejections and .threshold; `blocked` and MCP-layer refusals never reach the counter | L | guard ((1 of 6), Nothing was counted., MCP then 1) |
// | :72 | The run stops. The posting steps cannot run until the gate is answered. | both posting steps are refused before the gate and at the gate | R, L | guard (skip-ahead, at-gate attempts) |
// | :73 | This is what the reviewer was shown. The run is in phase gate_waiting and neither posting step is available to the agent. | at the gate the phase is gate_waiting and both posting steps are refused (V-12) | R, L (B) | guard (state at gate, at-gate attempts) |
// | stage 3 | The run reaches the gate once write_review is accepted. | the valid write_review reply opens the gate (confirm_review is auto) | L (A) | guard (valid reply carries the gate) |
// | :84 | Or let the agent try to skip the gate | the two attempts are refused | R, L | guard (at-gate attempts) |
// | stage 3 | The reviewer chose X. | the record's gate-response entry | L (C, D) | guard (answer effect) |
// | :101 | Answer the gate first. This stage opens once the gate is answered. | before the answer neither posting step can run | R, L | guard (at-gate attempts) |
// | :104 | The reviewer chose `X`. Realm closes the other branch. | after the answer the other posting step is skipped (when_false) and refused | R, L | guard (answer effect, other-branch reply) |
// | :104 | On this release the agent still sends the chosen step itself. | after the answer the chosen posting step is not completed and the phase is running (#625); shown only while that holds (L), always in R (true of the recording) | R, L | guard (:104 condition, both modes) |
// | :131 | Answer the gate first. There is no finished record until the gate is answered. | the run is not completed before the answer | R, L | guard (state at gate) |
// | :134 | What is left behind. One entry for each step that ran and for the gate answer, each with a hash. Refused calls leave no entry; counted refusals are noted on the step's entry. | 5 entries; after 4 refusals evidence_count is 1; write_review's entry carries validation_rejections | R, L (C, D) | guard (rows, after_refusals) |
// | :140 | accepted after n counted refusal(s) | diagnostics.validation_rejections on a successful entry | R, L | guard (:140 row) |
// | stage 5 | The run is not finished: the agent has not sent the chosen step yet. | state C: running, chosen posting step not completed | L (C) | guard (:104 condition) |
// | stages 2–5 | This run failed after m counted refusals. / This run failed before reaching the gate. | the m-th schema refusal (m = error_details.threshold) fails the run before confirm_review runs | L (E) | guard (failed run) |
// | :150 | Read it back any time with `realm run inspect <run-id>`, or take the whole record with `realm run export`. | the recorder read the runs back with the CLI | R | hand |
// | :150 | This run lives only in this page. With Realm installed, `realm run inspect <run-id>` reads a run back. | runs are in an in-memory store; `realm run inspect` exists on 0.46.0 | L | hand |
// | :160 | … on Realm {v}, driven over MCP; the reviewer answered with the CLI. … | record.mjs drives the steps over MCP and answers with `realm run respond` | R | hand (record.mjs) |
// | footer | Live · Realm {version} running in your browser … nothing is posted. Runs are kept in memory … | the bundle's fetch is the stand-in (0 page fetches); InMemoryStore | L | guard (page fetch, stand-in log) |
// | details | What is swapped (each line) | scripts/live/build.mjs and src/live/engine.mjs | L | guard (scan, stub calls) + hand |
export function stageSentences(mode, state) {
  const live = mode === 'live';
  const letter = live ? stateLetter(state) : null;
  const na = nextActions(state);
  const choice = state?.choice ?? null;
  const ar = state?.after_refusals;
  const meta = state?.meta;
  return {
    start: 'The agent starts a run. Realm fetches the pull request itself.', // :29
    schema: 'All four are required. Nothing else gets into the record.', // :45
    choose: 'Choose a submission.', // :54
    stop: live
      ? state?.pending_gate
        ? 'The step is complete and the run stops at the gate' // :63 L
        : null
      : 'The step is complete, and the run stops at the human gate. Go to the next stage.', // :63 R
    refusals:
      live || !ar
        ? null
        : `After every refusal the run still read \`completed_steps: ${JSON.stringify(ar.completed_steps)}\`, phase \`${ar.run_phase}\`. No step completed. Refusals of a submission's content are counted toward the limit of six; a step sent out of order is not.`, // :64 R
    gate: 'The run stops. The posting steps cannot run until the gate is answered.', // :72
    gateShown:
      live && letter !== 'B'
        ? null
        : `This is what the reviewer was shown. The run is in phase \`${(live ? state : state?.gate_state)?.run_phase}\` and neither posting step is available to the agent.`, // :73
    beforeGate:
      live && letter === 'A' ? 'The run reaches the gate once write_review is accepted.' : null,
    skipLabel: 'Or let the agent try to skip the gate', // :84
    chose:
      live && choice && (letter === 'C' || letter === 'D') ? `The reviewer chose ${choice}.` : null,
    need4: 'Answer the gate first. This stage opens once the gate is answered.', // :101
    branch: choice ? `The reviewer chose \`${choice}\`. Realm closes the other branch.` : null, // :104
    agentSends: na.send ? 'On this release the agent still sends the chosen step itself.' : null, // :104
    sendLabel: 'The agent sends the next step',
    otherLabel: 'The agent tries the other branch',
    need5: 'Answer the gate first. There is no finished record until the gate is answered.', // :131
    recordTitle: !live || letter === 'C' || letter === 'D' ? 'What is left behind.' : null, // :134
    recordBody:
      !live || letter === 'C' || letter === 'D'
        ? "One entry for each step that ran and for the gate answer, each with a hash. Refused calls leave no entry; counted refusals are noted on the step's entry."
        : null, // :134
    notFinished:
      live && letter === 'C'
        ? 'The run is not finished: the agent has not sent the chosen step yet.'
        : null,
    readBack: live
      ? 'This run lives only in this page. With Realm installed, `realm run inspect <run-id>` reads a run back.' // :150 L
      : 'Read it back any time with `realm run inspect <run-id>`, or take the whole record with `realm run export`.', // :150 R
    failed:
      live && letter === 'E' && state?.threshold
        ? `This run failed after ${state.threshold} counted refusals.`
        : null,
    failedBeforeGate: live && letter === 'E' ? 'This run failed before reaching the gate.' : null,
    newRun: 'Start a new run',
    pressSend: 'Press Send to submit it.',
    tryLabel: 'Try it yourself — the real engine, in your browser',
    loading: 'Loading the engine…',
    marker: live
      ? `Live · Realm ${state?.version} in your browser · run ${String(state?.run_id ?? '').slice(0, 8)}`
      : null,
    footer: live
      ? `Live · Realm ${state?.version} running in your browser · run ${String(state?.run_id ?? '').slice(0, 8)}. GitHub is a stand-in inside this page; nothing is posted. Runs are kept in memory and disappear when you leave. Long text is shortened with “…”; Full reply shows it whole.`
      : meta
        ? `Recorded on ${meta.recorded_at.slice(0, 10)} from two real runs of \`${meta.example}\` on Realm ${meta.realm_version}, driven over MCP; the reviewer answered with the CLI. The two runs differ only in the reviewer's answer; the refusals come from the first. GitHub was a local stand-in server, so nothing was posted. Long text is shortened with “…”.` // :160
        : null,
    notes: {
      noLoad: 'The live engine could not load, so this shows the recording.',
      insecure: 'Live mode needs a secure (HTTPS) page, so this shows the recording.',
      noStart: 'The live engine did not start a run (error {code}), so this shows the recording.',
      failedStart: 'The live engine failed to start, so this shows the recording.',
      timeout: 'The live engine took too long to load, so this shows the recording.',
    },
  };
}

// The "What is swapped" details (design clause 2, word for word). `m` is src/live/manifest.json.
export function swappedLines(m) {
  return {
    title: 'What is swapped',
    opening:
      "To run in your browser, a few parts that need a server are replaced. Realm's own decisions — what it accepts, refuses and records — are unchanged.",
    lines: [
      'process: argv [], env {}, platform "browser", stderr.write a no-op.',
      'Buffer: only byteLength, through TextEncoder; every other member throws and is logged.',
      'global and setImmediate: throw, logged.',
      'fetch: the GitHub stand-in, which throws naming the method and URL for anything off its routes.',
      'crypto: sha256 from @noble/hashes, plus Web Crypto.',
      'Every other Node built-in and the npm package proper-lockfile: stubs that throw.',
      `The MCP SDK at ${m.sdk_version} in place of the version realm-mcp ${m.realm_version} pins exactly (security fix GHSA-6qxp-vccf-f47h).`,
      'Runs: InMemoryStore (realm-testing). Workflows: a hand-made in-memory store holding this one workflow.',
      "Traces: InMemoryTraceBufferStore, Realm's own in-memory trace store. Failed attempts: not written to a file; refusals are still counted in the run.",
    ],
  };
}

// The recording's projection (distill.mjs's pick) and its 64-character shortening, for live replies.
const pick = (o, keys) =>
  Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));
export function project(reply) {
  if (reply?.kind !== 'json') return String(reply?.value ?? '');
  const r = reply.value;
  const o = pick(r, [
    'status',
    'error_code',
    'errors',
    'agent_action',
    'context_hint',
    'run_phase',
    'blocked_reason',
  ]);
  if (r?.error_details?.errors)
    o.error_details = {
      errors: r.error_details.errors.map((e) =>
        pick(e, ['instancePath', 'keyword', 'params', 'message']),
      ),
    };
  if (o.blocked_reason) o.blocked_reason = pick(o.blocked_reason, ['eligible_steps']);
  return o;
}
export const shorten = (v) =>
  typeof v === 'string'
    ? v.length > 64
      ? v.slice(0, 61) + '…'
      : v
    : Array.isArray(v)
      ? v.map(shorten)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shorten(x)]))
        : v;
export const showJson = (v) => JSON.stringify(shorten(v), null, 2);

// What one call's box shows (the page renders it as text): who called and what, the class label,
// the reason, the counting line, the projected and shortened reply, and the whole reply.
export function replyView(call, reply, before, after) {
  const c = classify(reply, before, after);
  const json = reply.kind === 'json';
  return {
    who: call
      ? call.tool === 'submit_human_response'
        ? 'The reviewer answers'
        : 'Agent calls'
      : null,
    call: call ? showJson(call) : null,
    cls: c.cls,
    tone: c.cls === 'accepted' ? 'good' : c.cls === 'noop' || c.cls === 'other' ? '' : 'bad',
    label: c.label,
    reason: c.reason || null,
    count: countLine(reply),
    shown: json ? showJson(project(reply)) : null,
    full: json ? JSON.stringify(reply.value, null, 2) : null,
  };
}

// Stage 1: what fetch_pr fetched, read from start_run's next action (as distill.mjs reads it).
export function fetched(startReply) {
  const na = startReply?.kind === 'json' ? startReply.value.next_actions?.[0] : null;
  if (!na?.prompt) return null;
  try {
    const pr = JSON.parse(
      na.prompt.slice(na.prompt.indexOf('{\n  "diff_text"'), na.prompt.indexOf('\n}\n') + 2),
    );
    return {
      label: `What the step fetched — ${pr.pr_title}, ${pr.files_changed.length} files`,
      diff: pr.diff_text.split('\n\n')[0],
      pr,
    };
  } catch {
    return null;
  }
}
