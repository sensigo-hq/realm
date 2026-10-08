// The clause-9 guard. Run: node --experimental-vm-modules scripts/live/smoke.mjs [--manifest p] [--recording p]
// 1 static scan (free names vs allowlist) · 2 import in a node:vm context holding web-standard globals only
// · 3 zero calls into throwing members · 4 version equality · 5 the recorder's full sequence, both endings,
// compared with the recording under a DEFINED projection (below) · 6 live-ran · 7 stand-in request log
// · 8 a refused start_run is not live (N3) · 9 bundle size (300 KB gzip ceiling) · 10 the page's decisions
// (view.mjs, imported FROM THE BUNDLE): visible strings, the Live state table's state letters A–E and
// the machine-checkable claim-ledger rows, in both modes (recorded: from the recording-derived state)
// · 11 a failed run (state E) and an MCP-layer refusal that is not counted · 12 no reply carries a
// warning mentioning a store.
//
// Projection (N2): every reply is cut to distill.mjs's pick (env(): status, error_code, errors, agent_action,
// context_hint, run_phase, blocked_reason.eligible_steps, error_details.errors[instancePath,keyword,params,message];
// start/valid: status, context_hint, run_phase); the live run id -> '<run-id>', the live gate id -> '<gate-id>';
// on the recording, its run ids -> '<run-id>' and any other UUID -> '<gate-id>'. The gate answer is compared by
// EFFECT, never by reply text (the recorder answers through the CLI): run_phase after the answer vs the CLI's
// "new state '…'", skipped_steps after the answer vs the ending's skipped_steps, completed_steps after the answer
// vs the ending's completed_steps minus the posted step, and the gate_response evidence hash.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { scanFreeNames } from './scan.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const manifestPath = path.resolve(opt('--manifest', ROOT + '/src/live/manifest.json'));
const recordingPath = path.resolve(opt('--recording', ROOT + '/src/data/replay.json'));
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const bundlePath = path.join(
  path.dirname(manifestPath) === ROOT + '/src/live'
    ? ROOT + '/public/live'
    : path.dirname(manifestPath),
  manifest.file,
);
const R = JSON.parse(fs.readFileSync(recordingPath, 'utf8'));
const fails = [];
const checks = [];
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function check(name, expected, got) {
  const ok = eq(expected, got);
  checks.push([ok ? 'PASS' : 'FAIL', name]);
  if (!ok) fails.push({ name, expected, got });
  return ok;
}
function die(msg) {
  console.log('GUARD FAILED: ' + msg);
  process.exit(1);
}
console.log(
  'guard: bundle',
  path.relative(ROOT, bundlePath),
  '| recording',
  path.relative(ROOT, recordingPath),
  `(realm ${R.meta.realm_version}, ${R.meta.recorded_at})`,
);

// 1. static scan
const src = fs.readFileSync(bundlePath, 'utf8');
// M3: a bump that doubles the bundle fails here.
const GZIP_CEILING = 300 * 1024;
const gz = zlib.gzipSync(fs.readFileSync(bundlePath), { level: 9 }).length;
console.log(`size: ${fs.statSync(bundlePath).size} B min, ${gz} B gzip (ceiling ${GZIP_CEILING})`);
if (gz > GZIP_CEILING) die(`the bundle is ${gz} B gzip, over the ${GZIP_CEILING} B ceiling`);
const scan = scanFreeNames(src);
console.log(
  'scan: free names',
  Object.keys(scan.free).length,
  '| not on the allowlist:',
  JSON.stringify(scan.offending),
);
if (scan.offending.length && !args.includes('--no-scan-stop'))
  die(
    'the bundle references globals that are not web-standard: ' +
      scan.offending.map(([n, c]) => `${n} ×${c}`).join(', '),
  );

if (scan.offending.length)
  console.log('scan: FAILED (continuing only because --no-scan-stop, to show the vm layer)');
check('scan: free names not on the allowlist', [], scan.offending);
// 2. vm context with web-standard globals only (N6)
const consoleLines = [];
const capture =
  (lvl) =>
  (...a) =>
    consoleLines.push(lvl + ' ' + a.map(String).join(' ').slice(0, 120));
const pageFetchCalls = [];
// M8: browsers' timers return numbers; Node's return Timeout objects (a stray .unref() would pass here
// and throw in a browser), so the vm gets number-returning wrappers.
const timers = new Map();
let timerId = 0;
const numTimer = (set, clear) => [
  (fn, ms, ...a) => {
    const id = ++timerId;
    timers.set(
      id,
      set(() => {
        timers.delete(id);
        fn(...a);
      }, ms),
    );
    return id;
  },
  (id) => {
    if (timers.has(id)) {
      clear(timers.get(id));
      timers.delete(id);
    }
  },
];
const [vmSetTimeout, vmClearTimeout] = numTimer(setTimeout, clearTimeout);
const [vmSetInterval, vmClearInterval] = (() => {
  const m = new Map();
  return [
    (fn, ms, ...a) => {
      const id = ++timerId;
      m.set(
        id,
        setInterval(() => fn(...a), ms),
      );
      return id;
    },
    (id) => {
      if (m.has(id)) {
        clearInterval(m.get(id));
        m.delete(id);
      }
    },
  ];
})();
const WEB = {
  crypto: globalThis.crypto,
  TextEncoder,
  TextDecoder,
  URL,
  URLSearchParams,
  setTimeout: vmSetTimeout,
  clearTimeout: vmClearTimeout,
  setInterval: vmSetInterval,
  clearInterval: vmClearInterval,
  queueMicrotask,
  structuredClone,
  AbortController,
  AbortSignal,
  Event,
  EventTarget,
  performance,
  atob,
  btoa,
  navigator: { userAgent: 'realm-demo-guard' },
  File,
  console: {
    log: capture('log'),
    error: capture('error'),
    warn: capture('warn'),
    info: capture('info'),
    debug: capture('debug'),
  },
  // the page's own fetch: the bundle must never reach it (clause 1)
  fetch: (u) => {
    pageFetchCalls.push(String(u));
    throw new Error('page fetch reached from the bundle: ' + u);
  },
};
console.log(
  'vm globals:',
  Object.keys(WEB).join(', '),
  '(+ ECMAScript intrinsics, self = globalThis)',
);
const ctx = vm.createContext({ ...WEB });
vm.runInContext('globalThis.self = globalThis;', ctx);
const mod = new vm.SourceTextModule(src, { context: ctx, identifier: manifest.file });
await mod.link(() => {
  throw new Error('the bundle has an import');
});
try {
  await mod.evaluate();
} catch (e) {
  die(`import threw ${e?.constructor?.name ?? 'Error'}: ${e?.message ?? e}`);
}
const ns = mod.namespace;
const {
  classify,
  countLine,
  gateText,
  nextActions,
  evidenceRows,
  stageSentences,
  stateLetter,
  answeredChoice,
  recordedState,
  recordedRun,
  replyView,
  fetched,
  project,
} = ns;
check(
  'timers in the vm return numbers',
  ['number', 'number'],
  vm.runInContext('[typeof setTimeout(() => {}, 0), typeof setInterval(() => {}, 1e9)]', ctx),
);
vm.runInContext('clearInterval(2)', ctx);
// 3. zero calls into throwing members at import
const atImport = ns.diagnostics();
console.log('import ok; throwing-member calls at import:', JSON.stringify(atImport.stubCalls));
if (atImport.stubCalls.length) die('import called into stubs: ' + atImport.stubCalls.join(', '));

// 4. version equality
check('version: bundle realm == recording meta.realm_version', R.meta.realm_version, ns.version);

// helpers
const pick = (o, keys) =>
  Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));
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
  if (r?.error_details?.errors)
    o.error_details = {
      errors: r.error_details.errors.map((e) =>
        pick(e, ['instancePath', 'keyword', 'params', 'message']),
      ),
    };
  if (o.blocked_reason) o.blocked_reason = pick(o.blocked_reason, ['eligible_steps']);
  return o;
};
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const deep = (x, f) =>
  typeof x === 'string'
    ? f(x)
    : Array.isArray(x)
      ? x.map((y) => deep(y, f))
      : x && typeof x === 'object'
        ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, deep(v, f)]))
        : x;
const recordedIds = Object.values(R.endings).map((e) => e.run_id);
const phRec = (x) =>
  deep(x, (s) => {
    for (const id of recordedIds) s = s.split(id).join('<run-id>');
    return s.replace(UUID, '<gate-id>');
  });
const phLive = (x, ids) =>
  deep(x, (s) => {
    if (ids.run) s = s.split(ids.run).join('<run-id>');
    if (ids.gate) s = s.split(ids.gate).join('<gate-id>');
    return s;
  });
const recAttempt = (id) => R.attempts.find((a) => a.id === id);
const classes = [];

const replies = []; // every raw reply of the guard's runs (for the store-warning check)

// One ending, driven the way the page drives it: each call, then get_run_state.
async function runEnding(E, choice, withWrong) {
  const ids = {};
  let lastRaw = null;
  const states = {};
  const J = async (tool, a, label) => {
    const r = await E.call(tool, a);
    replies.push([choice + '/' + label, r]);
    if (r.kind !== 'json') {
      fails.push({
        name: `${choice}/${label}: reply is not engine JSON`,
        expected: 'json',
        got: r,
      });
      return {};
    }
    return r.value;
  };
  const prefix = choice + ': ';
  const startRaw = await E.call('start_run', {
    workflow_id: R.start.call.workflow_id,
    params: R.start.call.params,
  });
  replies.push([choice + '/start', startRaw]);
  const s = startRaw.value ?? {};
  ids.run = s.run_id;
  check(
    prefix + 'start reply',
    R.start.response,
    phLive(pick(s, ['status', 'context_hint', 'run_phase']), ids),
  );
  const na = s.next_actions?.[0];
  if (na) {
    const diff = JSON.parse(
      na.prompt.slice(na.prompt.indexOf('{\n  "diff_text"'), na.prompt.indexOf('\n}\n') + 2),
    );
    check(prefix + 'fetched PR (start.pr)', R.start.pr, diff);
    check(prefix + 'view: fetched() = the recording start.pr', R.start.pr, fetched(startRaw)?.pr);
    check(prefix + 'task', R.task, {
      step: R.task.step,
      human_readable: na.human_readable.trim(),
      schema: na.input_schema,
    });
  } else fails.push({ name: prefix + 'start has next_actions[0]', expected: 'present', got: s });
  let before = await J('get_run_state', { run_id: ids.run }, 'state');
  check(prefix + 'state letter after start', 'A', stateLetter(before));
  check(
    prefix + 'ledger stage 3 (L, A): the before-gate sentence',
    'The run reaches the gate once write_review is accepted.',
    stageSentences('live', before).beforeGate,
  );
  const send = async (label, tool, a, recorded) => {
    const r = await E.call(tool, { run_id: ids.run, ...a });
    replies.push([choice + '/' + label, r]);
    const after = await J('get_run_state', { run_id: ids.run }, 'state');
    classes.push([prefix + label, classify(r, before, after).label]);
    if (r.kind === 'json')
      check(
        prefix + label + ': view project() = the recording projection',
        env(r.value),
        project(r),
      );
    lastRaw = r;
    states[label] = { before, after };
    before = after;
    if (recorded !== undefined)
      check(prefix + label, phRec(recorded), phLive(r.kind === 'json' ? env(r.value) : r, ids));
    return r.value;
  };
  const raw = {};
  if (withWrong) {
    for (const id of ['skip_ahead', 'missing_field', 'bad_enum', 'extra_field']) {
      const { tool, ...a } = recAttempt(id).call;
      await send(id, tool, a, recAttempt(id).response);
      raw[id] = lastRaw;
    }
    // view.mjs: the visible counting lines (the projection above drops error_details.rejections)
    check(
      prefix + 'view: skip-ahead count line',
      'Nothing was counted.',
      countLine(raw.skip_ahead),
    );
    check(
      prefix + 'view: first schema refusal count line',
      'This refusal is counted (1 of 6).',
      countLine(raw.missing_field),
    );
    check(
      prefix + 'view: third schema refusal count line',
      'This refusal is counted (3 of 6).',
      countLine(raw.extra_field),
    );
    check(
      prefix + 'ledger :63 (L): no stop sentence after a refusal',
      null,
      stageSentences('live', states.extra_field.after).stop,
    );
    check(
      prefix + 'view: a refusal leaves the state letter A',
      'A',
      stateLetter(states.extra_field.after),
    );
    const after = await J('get_run_state', { run_id: ids.run }, 'state');
    check(
      prefix + 'after_refusals',
      R.after_refusals,
      pick(after, ['run_phase', 'completed_steps', 'evidence_count']),
    );
  }
  const { tool, ...va } = recAttempt('valid').call;
  const v = await send('valid', tool, va);
  const validRaw = lastRaw;
  check(prefix + 'view: gate text = recording gate.display', R.gate.display, gateText(validRaw));
  check(prefix + 'state letter after the valid review', 'B', stateLetter(states.valid.after));
  check(
    prefix + 'ledger :63 (L): the stop sentence shows once the gate is pending',
    'The step is complete and the run stops at the gate',
    stageSentences('live', states.valid.after).stop,
  );
  check(
    prefix + 'ledger :73 (L, B): the at-gate sentence names the live phase',
    'This is what the reviewer was shown. The run is in phase `gate_waiting` and neither posting step is available to the agent.',
    stageSentences('live', states.valid.after).gateShown,
  );
  let st = await J('get_run_state', { run_id: ids.run }, 'state');
  for (let i = 0; i < 3 && !st.pending_gate; i++) {
    const n = st.next_actions?.[0];
    if (!n) break;
    await send('open_gate', 'execute_step', { command: n.instruction.params.command, params: {} });
    st = await J('get_run_state', { run_id: ids.run }, 'state');
  }
  ids.gate = st.pending_gate?.gate_id;
  check(
    prefix + 'valid reply',
    phRec(recAttempt('valid').response),
    phLive(pick(v, ['status', 'context_hint', 'run_phase']), ids),
  );
  check(
    prefix + 'gate',
    phRec({ step: R.gate.step, display: R.gate.display, choices: R.gate.choices }),
    phLive(
      { step: v.gate?.step_name, display: v.gate?.display?.trim(), choices: v.gate?.choices },
      ids,
    ),
  );
  if (withWrong) {
    for (const [i, cmd] of [
      [0, 'post_approval'],
      [1, 'post_changes_request'],
    ]) {
      const rec = R.gate.agent_attempts[i];
      await send(rec.id, 'execute_step', { command: cmd, params: {} }, rec.response);
    }
    check(
      prefix + 'view: an at-gate attempt is not counted',
      'Nothing was counted.',
      countLine(lastRaw),
    );
    const atGate = await J('get_run_state', { run_id: ids.run }, 'state');
    check(prefix + 'state at gate', R.gate.state, pick(atGate, ['run_phase', 'completed_steps']));
    check(prefix + 'refused at-gate attempts leave the state letter B', 'B', stateLetter(atGate));
  }
  const ending = R.endings[choice];
  // the answer, through MCP (the page's path); compared by effect only
  const ans = await send('answer', 'submit_human_response', { gate_id: ids.gate, choice });
  check(
    prefix + "view: the reviewer's box is labelled by its actor",
    'The reviewer answers',
    replyView(
      { tool: 'submit_human_response', gate_id: ids.gate, choice },
      lastRaw,
      states.answer.before,
      states.answer.after,
    ).who,
  );
  const afterAns = await J('get_run_state', { run_id: ids.run }, 'state');
  const recPhase = /new state '([a-z_]+)'/.exec(ending.respond.stdout)?.[1];
  check(prefix + 'answer effect: run_phase', recPhase, afterAns.run_phase);
  check(prefix + 'answer effect: skipped_steps', ending.skipped_steps, afterAns.skipped_steps);
  check(
    prefix + 'answer effect: completed_steps',
    ending.completed_steps.filter((x) => x !== ending.posted.step),
    afterAns.completed_steps,
  );
  const runAns = await E.run(ids.run);
  const vsAns = { ...afterAns, choice: answeredChoice(runAns) };
  check(prefix + 'state letter after the answer', 'C', stateLetter(vsAns));
  // ledger :104: on this release the answer leaves the chosen posting step to the agent. If a
  // release runs it (#625), this check fails and the sentence must be re-worded.
  check(
    prefix +
      'ledger :104 condition: after the answer the posted step is not completed and the run is running',
    [false, 'running'],
    [afterAns.completed_steps.includes(ending.posted.step), afterAns.run_phase],
  );
  const sAns = stageSentences('live', vsAns);
  check(
    prefix + 'ledger :104 (L): heading and agent-sends sentence after the answer',
    [
      `The reviewer chose \`${choice}\`. Realm closes the other branch.`,
      'On this release the agent still sends the chosen step itself.',
    ],
    [sAns.branch, sAns.agentSends],
  );
  check(
    prefix + 'ledger stage 3/5 (L, C): the chose line and the not-finished line',
    [
      `The reviewer chose ${choice}.`,
      'The run is not finished: the agent has not sent the chosen step yet.',
    ],
    [sAns.chose, sAns.notFinished],
  );
  check(
    prefix + 'view: next action after the answer = the chosen posting step only',
    { send: ending.posted.step, other: ending.skipped_steps[0] },
    nextActions(afterAns),
  );
  console.log(
    `${prefix}live answer reply (not compared): ${JSON.stringify(pick(ans, ['status', 'context_hint', 'warnings']))}`.slice(
      0,
      260,
    ),
  );
  if (ending.other_branch) {
    const { tool: t2, ...oa } = ending.other_branch.call;
    await send('other_branch', t2, oa, ending.other_branch.response);
    check(
      prefix + 'a refused other-branch attempt leaves the state letter C',
      'C',
      stateLetter({ ...states.other_branch.after, choice }),
    );
  }
  await send(
    'posted',
    'execute_step',
    { command: ending.posted.step, params: {} },
    ending.posted.response,
  );
  const run = await E.run(ids.run);
  const afterPost = await J('get_run_state', { run_id: ids.run }, 'state');
  const vsPost = { ...afterPost, choice: answeredChoice(run) };
  check(prefix + 'state letter after the post', 'D', stateLetter(vsPost));
  const sPost = stageSentences('live', vsPost);
  check(
    prefix + 'ledger :104 (L): the agent-sends sentence is gone after the post',
    null,
    sPost.agentSends,
  );
  check(prefix + 'ledger stage 5 (L, D): no not-finished line', null, sPost.notFinished);
  check(
    prefix + 'view: no next action after the post',
    { send: null, other: ending.skipped_steps[0] },
    nextActions(afterPost),
  );
  const rows = evidenceRows(run);
  check(
    prefix + 'view + ledger :134: five evidence rows, hashes = the recording',
    ending.evidence.map((x) => x.hash),
    rows.map((x) => x.hash),
  );
  check(
    prefix + 'view: evidence rows (live record) = evidence rows (recording)',
    evidenceRows(recordedRun(ending)),
    rows,
  );
  check(
    prefix + 'ledger :134: one entry per completed step plus the gate answer',
    afterPost.completed_steps.length + 1,
    run.evidence.length,
  );
  const n = ending.evidence[1].rejections;
  check(
    prefix + 'ledger :140: write_review row = recording',
    n ? `accepted after ${n} counted refusal${n === 1 ? '' : 's'}` : 'success',
    rows[1]?.label,
  );
  check(prefix + 'posted body', ending.posted.body, run.evidence.at(-1)?.resolved_params?.body);
  const sk = Object.entries(run.skip_details ?? {}).map(
    ([step, d]) =>
      `${step}: ${d.kind}: ${d.expression} [lhs → ${JSON.stringify(d.leaves?.[0]?.resolved_value)}]`,
  );
  check(prefix + 'skipped line (from skip_details)', [ending.skipped], sk);
  check(
    prefix + 'final record',
    pick(ending, ['completed_steps', 'skipped_steps', 'run_phase', 'sealed_by', 'terminal_reason']),
    pick(run, ['completed_steps', 'skipped_steps', 'run_phase', 'sealed_by', 'terminal_reason']),
  );
  const ev = run.evidence.map((e) => ({
    step: e.step_id,
    kind: e.kind ?? 'step',
    status: e.status,
    hash: e.evidence_hash,
    choice: e.kind === 'gate_response' ? e.input_summary.choice : null,
    rejections: e.diagnostics?.validation_rejections ?? null,
  }));
  check(
    prefix + 'evidence (step, kind, status, hash, choice, rejections)',
    ending.evidence.map(({ duration_ms, ...x }) => x),
    ev,
  );
  console.log(
    `${prefix}evidence hashes recorded: ${ending.evidence.map((x) => x.step + (x.kind === 'gate_response' ? '(answer)' : '') + ':' + x.hash.slice(0, 12)).join(' ')}`,
  );
  console.log(
    `${prefix}evidence hashes live:     ${ev.map((x) => x.step + (x.kind === 'gate_response' ? '(answer)' : '') + ':' + x.hash.slice(0, 12)).join(' ')}`,
  );
  // no-op on the finished run (a reply class)
  await send('noop_on_finished', 'execute_step', { command: ending.posted.step, params: {} });
  return ids.run;
}

// Recorded mode: the sentences the frontmatter renders, from the state after the answer derived
// from the recording (ledger :104 R: "always in R" because it is true of the recording).
for (const [choice, ending] of Object.entries(R.endings)) {
  const rs = recordedState(R, ending);
  const S = stageSentences('recorded', rs);
  check(
    `recorded ${choice}: ledger :104 (R) condition and sentences`,
    [
      'running',
      false,
      `The reviewer chose \`${choice}\`. Realm closes the other branch.`,
      'On this release the agent still sends the chosen step itself.',
    ],
    [rs.run_phase, rs.completed_steps.includes(ending.posted.step), S.branch, S.agentSends],
  );
  check(
    `recorded ${choice}: ledger :73 (R) names the recorded phase at the gate`,
    'This is what the reviewer was shown. The run is in phase `gate_waiting` and neither posting step is available to the agent.',
    S.gateShown,
  );
}
// ledger :140 (R): the recording's write_review was accepted after 3 COUNTED refusals (the
// skip-ahead is not counted)
check(
  'ledger :140 (R): request_changes write_review rejections',
  3,
  R.endings.request_changes.evidence.find((x) => x.step === 'write_review')?.rejections,
);
check(
  'ledger :64 (R): no step completed after the refusals',
  ['fetch_pr'],
  R.after_refusals.completed_steps,
);
const live = [];
for (const [choice, wrong] of [
  ['request_changes', true],
  ['approve', false],
]) {
  const E = await ns.start();
  live.push(await runEnding(E, choice, wrong));
  await E.close();
}
// 6. live ran: run ids fresh, not the recording's
check(
  'live ran: run ids are new UUIDs, none recorded',
  [true, true],
  live.map((id) => /^[0-9a-f-]{36}$/.test(id ?? '') && !recordedIds.includes(id)),
);
console.log(
  'live run ids:',
  live.map((x) => x?.slice(0, 8)).join(' '),
  '| recorded:',
  recordedIds.map((x) => x.slice(0, 8)).join(' '),
);

// The failed run (state E): the MCP-layer refusal is not counted; the m-th schema refusal fails
// the run (m = error_details.threshold), before the gate.
{
  const E = await ns.start();
  const s = (await E.call('start_run', { workflow_id: 'pr-review', params: R.start.call.params }))
    .value;
  const st = async () => (await E.call('get_run_state', { run_id: s.run_id })).value;
  let before = await st();
  const r = await E.call('execute_step', { run_id: s.run_id, command: 'write_review', params: [] });
  replies.push(['failed/params []', r]);
  let after = await st();
  classes.push(['params: []', classify(r, before, after).label]);
  check('view: an MCP-layer refusal is not counted', 'Nothing was counted.', countLine(r));
  console.log('params: [] reply:', JSON.stringify(r).slice(0, 160));
  const bad = recAttempt('missing_field').call.params;
  let last = null;
  for (let i = 1; i <= 6; i++) {
    before = after;
    last = await E.call('execute_step', { run_id: s.run_id, command: 'write_review', params: bad });
    replies.push(['failed/refusal ' + i, last]);
    after = await st();
    if (i === 1)
      check(
        'view: after an MCP-layer refusal, the first schema refusal counts 1',
        'This refusal is counted (1 of 6).',
        countLine(last),
      );
  }
  const m = last.value?.error_details?.threshold;
  check(
    'failed run: the 6th refusal counts 6 of 6',
    'This refusal is counted (6 of 6).',
    countLine(last),
  );
  check('failed run: the phase', 'failed', after.run_phase);
  check('failed run: the state letter', 'E', stateLetter(after));
  const sE = stageSentences('live', { ...after, threshold: m });
  check(
    'failed run: stage sentences (E)',
    [
      'This run failed after 6 counted refusals.',
      'This run failed before reaching the gate.',
      null,
      null,
      null,
      null,
      null,
    ],
    [
      sE.failed,
      sE.failedBeforeGate,
      sE.beforeGate,
      sE.agentSends,
      sE.notFinished,
      sE.recordTitle,
      sE.stop,
    ],
  );
  check('failed run: no next action', { send: null, other: null }, nextActions(after));
  check(
    'failed run: confirm_review never ran',
    false,
    after.completed_steps.includes('confirm_review'),
  );
  const run = await E.run(s.run_id);
  check(
    'failed run: evidence rows (fetch_pr, then the failed write_review)',
    [
      ['fetch_pr', 'success'],
      ['write_review', 'error'],
    ],
    evidenceRows(run).map((x) => [x.step, x.label]),
  );
  before = after;
  const late = await E.call('execute_step', {
    run_id: s.run_id,
    command: 'write_review',
    params: recAttempt('valid').call.params,
  });
  replies.push(['failed/late valid', late]);
  after = await st();
  classes.push(['failed: a valid review after the failure', classify(late, before, after).label]);
  await E.close();
  const bad2 = await ns.start({ driver: { by: 'website demo' } });
  const b = await bad2.call('start_run', { workflow_id: 'pr-review', params: R.start.call.params });
  const isLive = b.kind === 'json' && b.value.status === 'ok' && typeof b.value.run_id === 'string';
  check('N3: a refused start_run is not live (page falls back)', false, isLive);
  console.log(
    'refused start reply:',
    JSON.stringify(pick(b.value, ['status', 'error_code', 'errors'])).slice(0, 200),
  );
  await bad2.close();
}
// Synthetic cells for the classes no executed case reaches (engine fault; catch-all; page check)
check(
  'classify: synthetic ENGINE_INTERNAL',
  'Realm hit an internal error',
  classify(
    {
      kind: 'json',
      value: { status: 'error', error_code: 'ENGINE_INTERNAL', errors: ['too much recursion'] },
    },
    { completed_steps: [] },
    { completed_steps: [] },
  ).label,
);
check(
  'classify: synthetic catch-all',
  'Realm answered: warning',
  classify(
    { kind: 'json', value: { status: 'warning' } },
    { completed_steps: [] },
    { completed_steps: [], run_phase: 'running' },
  ).label,
);
check(
  'classify: page check',
  'The page could not send this',
  classify({ kind: 'page', message: 'x' }).label,
);
console.log('reply classes:');
for (const [k, v] of classes) console.log('  ' + k.padEnd(40) + ' -> ' + v);
check(
  'reply classes on the main path',
  [
    'request_changes: skip_ahead|Realm refuses',
    'request_changes: missing_field|Realm refuses',
    'request_changes: bad_enum|Realm refuses',
    'request_changes: extra_field|Realm refuses',
    'request_changes: valid|Realm accepts it',
    'request_changes: past_gate|Realm refuses',
    'request_changes: past_gate_other|Realm refuses',
    'request_changes: answer|Realm accepts it',
    'request_changes: other_branch|Realm refuses',
    'request_changes: posted|Realm accepts it',
    'request_changes: noop_on_finished|The run has already ended',
    'approve: valid|Realm accepts it',
    'approve: answer|Realm accepts it',
    'approve: posted|Realm accepts it',
    'approve: noop_on_finished|The run has already ended',
    'params: []|Realm’s MCP layer refuses',
    'failed: a valid review after the failure|The run has already ended',
  ],
  classes.map(([k, v]) => k + '|' + v),
);
// The page shows the reply's warnings under "Full reply": no reply may carry a warning about a
// store (walk-1 W-7: a no-op trace store without `delete` did).
check(
  'no reply carries a warning mentioning a store',
  [],
  replies.flatMap(([label, r]) =>
    (r?.kind === 'json' && Array.isArray(r.value.warnings) ? r.value.warnings : [])
      .filter((w) => /store/i.test(String(w)))
      .map((w) => label + ': ' + w),
  ),
);
console.log(`replies checked for store warnings: ${replies.length}`);

// 3/7. stubs and the stand-in, after everything
const d = ns.diagnostics();
check('throwing-member calls after the full run', [], d.stubCalls);
check('stand-in refused requests', [], d.unrouted);
check('page fetch reached', [], pageFetchCalls);
const perRun = [
  'GET https://api.github.com/repos/acme/payments-api/pulls/42/files',
  'GET https://api.github.com/repos/acme/payments-api/pulls/42',
  'POST https://api.github.com/repos/acme/payments-api/issues/42/comments',
];
check(
  'stand-in request log (2 runs, then 1 start)',
  [...perRun, ...perRun, ...perRun.slice(0, 2)],
  d.fetches,
);
console.log(
  `Buffer.byteLength calls (working member): ${d.byteLengthCalls}; engine console lines: ${consoleLines.length}`,
);

console.log('\nchecks:');
for (const [s, n] of checks) console.log(`  ${s}  ${n}`);
if (fails.length) {
  for (const f of fails) {
    console.log(
      `\nFAIL ${f.name}\n  expected: ${JSON.stringify(f.expected)}\n  got:      ${JSON.stringify(f.got)}`,
    );
  }
  die(`${fails.length} of ${checks.length} checks failed`);
}
console.log(`\nGUARD PASSED: ${checks.length} checks`);
