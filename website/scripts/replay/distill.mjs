// Distils $WORK/recording.json (from record.mjs) into src/data/replay.json — only what the
// home page renders. Every string under `response`/`cli`/`inspect` is copied from the recording.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const rec = JSON.parse(fs.readFileSync(process.env.WORK + '/recording.json', 'utf8'));
const pick = (o, keys) =>
  Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const env = (r) => {
  const o = pick(r, [
    'status',
    'error_code',
    'errors',
    'agent_action',
    'context_hint',
    'run_phase',
    'blocked_reason',
  ]);
  if (r.error_details?.errors)
    o.error_details = {
      errors: r.error_details.errors.map((e) =>
        pick(e, ['instancePath', 'keyword', 'params', 'message']),
      ),
    };
  if (o.blocked_reason) o.blocked_reason = pick(o.blocked_reason, ['eligible_steps']);
  return o;
};
const [A, B] = rec.runs;
const ev = (run, kind) => run.events.find((e) => e.kind === kind);
const start = ev(A, 'start');
const na = start.response.next_actions[0];
const fetchEv = A.export.run.evidence[0];
const diff = JSON.parse(
  na.prompt.slice(na.prompt.indexOf('{\n  "diff_text"'), na.prompt.indexOf('\n}\n') + 2),
);
const attempt = (run, kind, label, blurb) => {
  const e = ev(run, kind);
  const a = { ...e.arguments };
  delete a.run_id;
  return {
    id: kind.replace('wrong:', ''),
    label,
    blurb,
    call: { tool: e.tool, ...a },
    response: env(e.response),
  };
};
const after = ev(A, 'state_after_refusals').response,
  atGate = ev(A, 'state_at_gate').response,
  valid = ev(A, 'valid').response;
const ending = (run) => {
  const x = run.export.run;
  const human = run.events.find((e) => e.kind === 'human').cli;
  const drive = ev(run, 'drive');
  const other = ev(run, 'wrong:other_branch');
  const skip = run.inspect
    .split('\n')
    .find((l) => /^  post_\w+: when_false/.test(l))
    .trim();
  return {
    run_id: run.run_id,
    choice: run.choice,
    respond: {
      argv: human.argv
        .map((s) => (s === run.run_id ? '<run-id>' : s))
        .join(' ')
        .replace(/--gate \S+/, '--gate <gate-id>'),
      stdout: human.stdout.trim(),
    },
    other_branch: other ? attempt(run, 'wrong:other_branch', '', '') : null,
    posted: {
      step: drive.arguments.command,
      response: env(drive.response),
      body: x.evidence.at(-1).resolved_params.body,
    },
    skipped: skip,
    completed_steps: x.completed_steps,
    skipped_steps: x.skipped_steps,
    run_phase: x.run_phase,
    sealed_by: x.sealed_by,
    terminal_reason: x.terminal_reason,
    evidence: x.evidence.map((e) => ({
      step: e.step_id,
      kind: e.kind ?? 'step',
      status: e.status,
      duration_ms: e.duration_ms,
      hash: e.evidence_hash,
      choice: e.kind === 'gate_response' ? e.input_summary.choice : null,
      rejections: e.diagnostics?.validation_rejections ?? null,
    })),
  };
};
const out = {
  meta: {
    realm_version: rec.realm_version,
    recorded_at: rec.recorded_at,
    workflow_id: 'pr-review',
    example: 'examples/08-pr-review',
    register: rec.register.stdout.trim(),
  },
  start: {
    call: { tool: 'start_run', ...start.arguments },
    response: pick(start.response, ['status', 'context_hint', 'run_phase']),
    pr: diff,
    evidence: { step: 'fetch_pr', hash: fetchEv.evidence_hash, duration_ms: fetchEv.duration_ms },
  },
  task: { step: 'write_review', human_readable: na.human_readable.trim(), schema: na.input_schema },
  attempts: [
    attempt(
      A,
      'wrong:skip_ahead',
      'Skip ahead and post',
      'The agent skips the review and calls the step that posts to GitHub.',
    ),
    attempt(
      A,
      'wrong:missing_field',
      'Leave out a field',
      'The agent submits a review with no risk level.',
    ),
    attempt(
      A,
      'wrong:bad_enum',
      'Invent a value',
      'The agent recommends "merge", which is not one of the two allowed outcomes.',
    ),
    attempt(
      A,
      'wrong:extra_field',
      'Add its own field',
      'The agent adds approved_by, a field the step never asked for.',
    ),
    {
      id: 'valid',
      label: 'Submit a valid review',
      blurb: 'All four fields, the right types, nothing extra.',
      call: {
        tool: 'execute_step',
        command: 'write_review',
        params: ev(A, 'valid').arguments.params,
      },
      response: pick(valid, ['status', 'context_hint', 'run_phase']),
    },
  ],
  after_refusals: pick(after, ['run_phase', 'completed_steps', 'evidence_count']),
  gate: {
    step: valid.gate.step_name,
    display: valid.gate.display.trim(),
    choices: valid.gate.choices,
    state: pick(atGate, ['run_phase', 'completed_steps']),
    agent_attempts: [
      attempt(A, 'wrong:past_gate', 'Agent calls post_approval', ''),
      attempt(A, 'wrong:past_gate_other', 'Agent calls post_changes_request', ''),
    ],
  },
  endings: { request_changes: ending(A), approve: ending(B) },
};
fs.writeFileSync(HERE + '/../../src/data/replay.json', JSON.stringify(out, null, 1));
console.log(
  'wrote src/data/replay.json',
  fs.statSync(HERE + '/../../src/data/replay.json').size,
  'bytes',
);
