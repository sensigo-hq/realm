// issue #558 PR-T (review fold R5) — the agent's discovery surface names what it could not read.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonWorkflowStore, CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import { handleListWorkflows } from './list-workflows.js';

const RR = 're-register the workflow from its source (realm workflow register <path-to-workflow>)';

describe('list_workflows — every registered copy the listing could not read is named (issue #558 PR-T, R5)', () => {
  let dir: string;
  let store: JsonWorkflowStore;
  const plant = (id: string): Promise<void> =>
    writeFile(
      join(dir, `${id}.json`),
      JSON.stringify({
        schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
        id,
        name: id,
        version: 1,
        steps: {},
      }),
      'utf8',
    );

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-lw-'));
    store = new JsonWorkflowStore(dir);
  });
  afterEach(async () => {
    await chmod(dir, 0o755).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  });

  it('LW1 a healthy registry: the workflows, an empty unreadable list, and the create_workflow steer', async () => {
    await plant('w1');
    const r = await handleListWorkflows({ workflowStore: store });
    expect(r.status).toBe('ok');
    expect(r.workflows).toEqual([{ id: 'w1', name: 'w1', version: 1 }]);
    expect(r.unreadable).toEqual([]);
    if (r.status !== 'ok') throw new Error('unreachable');
    expect(r.warnings).toEqual([]);
    expect(r.hint).toContain('use create_workflow to define and start your own plan');
  });

  it('LW2 a chmod-000 copy is NAMED with its class, errno, reason and repair — and the steer to create_workflow is withdrawn', async () => {
    await plant('w1');
    await chmod(join(dir, 'w1.json'), 0o000);
    const r = await handleListWorkflows({ workflowStore: store });
    expect(r.status).toBe('ok');
    expect(r.workflows).toEqual([]);
    expect(r.unreadable).toEqual([
      {
        file: 'w1.json',
        class: 'unreadable',
        errno: 'EACCES',
        reason: `the registered copy of 'w1' could not be read (EACCES: ${join(dir, 'w1.json')})`,
        repair: `make ${join(dir, 'w1.json')} readable (chmod u+r ${join(dir, 'w1.json')})`,
      },
    ]);
    if (r.status !== 'ok') throw new Error('unreachable');
    expect(r.warnings).toEqual([
      "1 registered workflow copy could not be read — see 'unreadable'.",
    ]);
    expect(r.hint).toContain('1 registered workflow copy could not be read');
    expect(r.hint).toContain('until an operator has looked');
    expect(r.hint).not.toContain('use create_workflow');
    await chmod(join(dir, 'w1.json'), 0o644);
  });

  it('LW3 an unreadable registry DIRECTORY is a typed refusal, not an empty healthy list', async () => {
    await plant('w1');
    await chmod(dir, 0o000);
    const r = await handleListWorkflows({ workflowStore: store });
    await chmod(dir, 0o755);
    expect(r.status).toBe('error');
    if (r.status !== 'error') throw new Error('unreachable');
    expect(r.error_code).toBe('STATE_WORKFLOW_UNREADABLE');
    expect(r.error_details).toEqual({ class: 'registry_broken', errno: 'EACCES', path: dir });
    expect(r.errors).toEqual([
      `the workflow registry at ${dir} cannot be read (EACCES). To repair: make the registry directory ${dir} readable and searchable (chmod u+rx ${dir}).`,
    ]);
    expect(r.agent_action).toBe('stop');
    expect(r.workflows).toEqual([]);
    expect(r.hint).toContain('Do not create a workflow to work around it');
    expect(r.hint).toContain('cannot tell you what is registered there');
    expect(r.hint).not.toContain('still exist');
  });

  it('LW4 a directory in place of a copy, an empty copy and a corrupt copy each carry their own class and act', async () => {
    await plant('ok');
    await mkdir(join(dir, 'd.json'));
    await writeFile(join(dir, 'e.json'), '', 'utf8');
    await writeFile(join(dir, 'c.json'), '{ not json', 'utf8');
    const r = await handleListWorkflows({ workflowStore: store });
    expect(r.status).toBe('ok');
    expect(r.workflows.map((w) => w.id)).toEqual(['ok']);
    const byFile = Object.fromEntries(r.unreadable.map((u) => [u.file, u]));
    expect(byFile['d.json']).toMatchObject({
      class: 'not_a_file',
      repair: `remove the directory at ${join(dir, 'd.json')} (rm -r ${join(dir, 'd.json')}), then ${RR}`,
    });
    expect(byFile['d.json']).not.toHaveProperty('errno');
    const alt = (f: string): string =>
      `${RR}; if it was never registered from a source, remove the file (rm ${join(dir, f)}) instead`;
    expect(byFile['e.json']).toMatchObject({ class: 'empty', repair: alt('e.json') });
    expect(byFile['c.json']).toMatchObject({ class: 'parse', repair: alt('c.json') });
    if (r.status !== 'ok') throw new Error('unreachable');
    expect(r.warnings).toEqual([
      "3 registered workflow copies could not be read — see 'unreadable'.",
    ]);
    expect(r.hint).toContain('3 registered workflow copies could not be read');
  });
});
