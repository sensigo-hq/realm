// The child of async-schema-runtime.test.ts: one check kind of a definition stored with a root
// `$async`, as a program embedding the engine runs it (`executeStep` on a real store; params by
// `validateRunParams`). A rejection left unawaited exits 3. Prints ONE line: the reply's status
// and code, or the refusal's code (never a value).
/* global console, process, setTimeout */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.on('unhandledRejection', () => process.exit(3));
const core = await import('@sensigo/realm');
const kind = process.argv[2];
const ASYNC = { $async: true, type: 'object', required: ['x'] };
const TRACE = { $async: true, type: 'array', items: { type: 'object', required: ['zzz'] } };
const codeOf = (r) => r?.error_code ?? r?.error?.code ?? '-';
if (kind === 'params') {
  try {
    core.validateRunParams({}, ASYNC, 'w');
    console.log('accepted');
  } catch (err) {
    console.log(core.isAsyncSchemaRefusal(err) ? 'VALIDATION_WORKFLOW_SCHEMA' : 'other');
  }
} else {
  const dir = mkdtempSync(join(tmpdir(), 'realm-async-child-'));
  const workflowStore = new core.JsonWorkflowStore(join(dir, 'wf'));
  const runStore = new core.JsonFileStore(join(dir, 'runs'));
  const step = { description: 'Ask.', execution: 'agent', depends_on: [] };
  if (kind === 'input') step.input_schema = ASYNC;
  if (kind === 'output') step.output_schema = ASYNC;
  if (kind.startsWith('trace')) step.trace_schema = TRACE;
  if (kind === 'trace-enforce') step.trace_validation_mode = 'enforce';
  const definition = {
    id: `async-child-${kind}`,
    name: 'c',
    version: 1,
    schema_version: core.CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: { ask: step },
  };
  await workflowStore.register(definition);
  const { run } = await runStore.create({
    workflowId: definition.id,
    workflowVersion: 1,
    params: {},
  });
  const options = { runId: run.id, command: 'ask', input: {}, dispatcher: async (p) => p };
  if (kind.startsWith('trace')) options.trace = [{ seq: 1, event: 'e' }];
  try {
    const reply = await core.executeStep(runStore, definition, options);
    const warned = (reply.warnings ?? []).some((w) => String(w).includes('$async'));
    console.log(
      `${reply.status} ${codeOf(reply)}${kind === 'trace-warn' ? ` warned=${warned}` : ''}`,
    );
  } catch (err) {
    console.log(`threw ${core.isAsyncSchemaRefusal(err) ? 'VALIDATION_WORKFLOW_SCHEMA' : 'other'}`);
  }
}
await new Promise((resolve) => setTimeout(resolve, 100));
