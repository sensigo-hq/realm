// Records the home page's interactive replay: two real runs of examples/08-pr-review driven
// over MCP (stdio) against published realm packages, with a local stand-in for GitHub.
// Usage: NM=<dir with node_modules holding @sensigo/realm-cli + realm-testing> WORK=<empty scratch dir> \
//        node scripts/replay/record.mjs   -> writes $WORK/recording.json; then run distill.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const NM = process.env.NM,
  D = process.env.WORK;
if (!NM || !D) throw new Error('set NM and WORK');
const { startGitHubMockServer } = await import(
  pathToFileURL(NM + '/node_modules/@sensigo/realm-testing/dist/index.js')
);
const { Client } = await import(
  pathToFileURL(NM + '/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')
);
const { StdioClientTransport } = await import(
  pathToFileURL(NM + '/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js')
);
const HOME = D + '/home';
const CLI = NM + '/node_modules/@sensigo/realm-cli/dist/index.js';
fs.rmSync(D, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(D + '/project');
fs.copyFileSync(
  HERE + '/../../../examples/08-pr-review/workflow.yaml',
  D + '/project/workflow.yaml',
);
const gh = await startGitHubMockServer(HERE + '/github-fixture.json');
fs.writeFileSync(
  D + '/project/realm.yaml',
  `version: 1\nadapters:\n  github:\n    use: github\n    config: { base_url: '${gh.url}', auth: { token: '\${secret:GITHUB_TOKEN}' } }\n`,
);
fs.writeFileSync(D + '/project/.env', 'GITHUB_TOKEN=local-stand-in\n');
const env = { ...process.env, HOME };
const cli = (...a) => {
  const r = spawnSync('node', [CLI, ...a], { env, encoding: 'utf8', cwd: D + '/project' });
  return { argv: ['realm', ...a], exit: r.status, stdout: r.stdout, stderr: r.stderr };
};
const reg = cli('workflow', 'register', D + '/project/workflow.yaml');
const t = new StdioClientTransport({
  command: 'node',
  args: [CLI, 'mcp', '--project', D + '/project'],
  env,
  stderr: 'inherit',
});
const c = new Client({ name: 'recorder', version: '1' });
await c.connect(t);
const good = {
  risk: 'high',
  key_changes: [
    'deliverWebhook now retries a failed POST in a loop instead of failing on the first error',
    'New MAX_RETRIES constant (5) in webhooks/config.ts',
    'One new test: a single failure followed by a success',
  ],
  recommendation: 'request_changes',
  review_comment:
    'Changes requested. The retry loop swallows the final failure: after the last attempt throws, the loop ends and deliverWebhook returns normally, so a charge webhook that never got through is reported as delivered. Rethrow the last error (or return a failed result) once attempts run out. Two smaller points: `attempt <= MAX_RETRIES` makes six attempts, not five, and the fixed 1 s sleep retries every error, including 4xx responses that will never succeed — back off exponentially and retry only timeouts and 5xx. Please add a test for the all-attempts-fail case; the current test covers only fail-once-then-succeed.',
};
async function run(label, choice, withWrong) {
  const ev = [];
  let id;
  const call = async (kind, name, args) => {
    const r = await c.callTool({ name, arguments: args });
    const txt = r.content?.[0]?.text;
    let j;
    try {
      j = JSON.parse(txt);
    } catch {
      j = txt;
    }
    ev.push({ kind, tool: name, arguments: args, isError: r.isError ?? false, response: j });
    return j;
  };
  const s = await call('start', 'start_run', {
    workflow_id: 'pr-review',
    params: { repo: 'acme/payments-api', pr_number: 42 },
  });
  id = s.run_id;
  if (withWrong) {
    await call('wrong:skip_ahead', 'execute_step', {
      run_id: id,
      command: 'post_approval',
      params: {},
    });
    await call('wrong:missing_field', 'execute_step', {
      run_id: id,
      command: 'write_review',
      params: { ...good, risk: undefined },
    });
    await call('wrong:bad_enum', 'execute_step', {
      run_id: id,
      command: 'write_review',
      params: { ...good, recommendation: 'merge' },
    });
    await call('wrong:extra_field', 'execute_step', {
      run_id: id,
      command: 'write_review',
      params: { ...good, approved_by: 'the agent' },
    });
    await call('state_after_refusals', 'get_run_state', { run_id: id });
  }
  const ok = await call('valid', 'execute_step', {
    run_id: id,
    command: 'write_review',
    params: good,
  });
  let st = await call('state', 'get_run_state', { run_id: id });
  // drive whatever non-gate next action exists (confirm_review opens the gate)
  for (let i = 0; i < 3 && !st.pending_gate; i++) {
    const na = st.next_actions?.[0];
    if (!na) break;
    await call('open_gate', 'execute_step', {
      run_id: id,
      command: na.instruction.params.command,
      params: {},
    });
    st = await call('state', 'get_run_state', { run_id: id });
  }
  if (withWrong) {
    await call('wrong:past_gate', 'execute_step', {
      run_id: id,
      command: 'post_approval',
      params: {},
    });
    await call('wrong:past_gate_other', 'execute_step', {
      run_id: id,
      command: 'post_changes_request',
      params: {},
    });
    await call('state_at_gate', 'get_run_state', { run_id: id });
  }
  const gate = st.pending_gate;
  const gid = gate?.gate_id;
  const inspectAtGate = cli('run', 'inspect', id);
  const respond = cli('run', 'respond', id, '--gate', String(gid), '--choice', choice);
  ev.push({ kind: 'human', cli: respond });
  if (withWrong) {
    await call('wrong:other_branch', 'execute_step', {
      run_id: id,
      command: choice === 'approve' ? 'post_changes_request' : 'post_approval',
      params: {},
    });
  }
  await call('drive', 'execute_step', {
    run_id: id,
    command: choice === 'approve' ? 'post_approval' : 'post_changes_request',
    params: {},
  });
  const final = await call('final_state', 'get_run_state', { run_id: id, include_steps: true });
  const inspect = cli('run', 'inspect', id);
  const out = D + `/export-${label}.json`;
  fs.rmSync(out, { force: true });
  const exp = cli('run', 'export', id, '--out', out);
  return {
    label,
    choice,
    run_id: id,
    events: ev,
    inspect_at_gate: inspectAtGate.stdout,
    inspect: inspect.stdout,
    export_cli: exp,
    export: JSON.parse(fs.readFileSync(out, 'utf8')),
  };
}
const a = await run('request_changes', 'request_changes', true);
const b = await run('approve', 'approve', false);
const ver = cli('--version');
fs.writeFileSync(
  D + '/recording.json',
  JSON.stringify(
    {
      recorded_at: new Date().toISOString(),
      realm_version: ver.stdout.trim(),
      register: reg,
      github: 'local stand-in server (packages/testing startGitHubMockServer)',
      runs: [a, b],
    },
    null,
    1,
  ),
);
await c.close();
await gh.close();
for (const r of [a, b]) {
  console.log('\n=====', r.label, r.run_id);
  for (const e of r.events) {
    if (e.cli) {
      console.log('HUMAN', e.cli.exit, e.cli.stdout.trim(), e.cli.stderr.trim());
      continue;
    }
    const x = e.response;
    console.log(
      e.kind,
      '|',
      e.tool,
      e.arguments.command ?? '',
      '| status',
      x.status ?? '-',
      '| phase',
      x.run_phase,
      '| v',
      x.run_version,
      '|',
      (x.errors || [])
        .map((z) => (typeof z === 'string' ? z : JSON.stringify(z)))
        .join(' ; ')
        .slice(0, 400),
      '| hint:',
      (x.context_hint || '').slice(0, 160),
      '| done',
      JSON.stringify(x.completed_steps || ''),
      'skip',
      JSON.stringify(x.skipped_steps || ''),
      'gate',
      x.pending_gate ? x.pending_gate.gate_id : '',
    );
  }
  console.log(r.inspect);
  console.log('export', r.export_cli.exit, r.export_cli.stderr);
}
