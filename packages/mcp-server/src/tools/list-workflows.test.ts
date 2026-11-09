// issue #558 PR-T (review fold R5) — the agent's discovery surface names what it could not read.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonWorkflowStore, CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import { handleListWorkflows } from './list-workflows.js';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

describe('list_workflows — every registered copy the listing could not read is named (issue #558 PR-T, R5)', () => {
  let h: TempHome;
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
    h = await makeTempHome();
    dir = join(h.path, 'workflows');
    store = h.stores.workflowStore;
  });
  afterEach(async () => {
    await h.cleanup();
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
});

describe('#627 W correction 2 (3.5) — list_workflows’ hint by class', () => {
  it('a copy a later version of Realm registered: class newer, no repair, and the hint names the other-version case', async () => {
    const h = await makeTempHome();
    const dir = join(h.path, 'workflows');
    try {
      await writeFile(
        join(dir, 'w1.json'),
        JSON.stringify({
          schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION + 1,
          id: 'w1',
          name: 'w1',
          version: 1,
          steps: {},
        }),
      );
      const r = await handleListWorkflows({ workflowStore: h.stores.workflowStore });
      if (r.status !== 'ok') throw new Error('fixture: the listing answers');
      // (a) red when the hint promises a repair for every entry (a newer copy carries none) and never
      //     names the other-version case; (b) prints the entry's class, whether it has a repair, and
      //     whether the hint names that case.
      expect({
        class: r.unreadable[0]?.class,
        repair: r.unreadable[0]?.repair,
        hint: r.hint.includes(
          'one an older or a later version of Realm registered, whose reason names the way out',
        ),
      }).toEqual({ class: 'newer', repair: undefined, hint: true });
    } finally {
      await h.cleanup();
    }
  });
});
