// run-state-lease-cw5a.test.ts — #729 CW-5a: run-state-and-health.md's rows for a step a `realm agent`
// drive holds, now that every such claim names a lease. get_run_state through the MCP door on a SQLite
// home, the claim taken through `claimStepForDrive` as `realm agent` takes it: held by a program
// (this one keeps the hold open), held by none (the hold closed), and its lease file gone.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it: (1) the
// change that turns it red; (2) what it prints when it fails.
import { describe, it, expect, afterEach } from 'vitest';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  claimStepForDrive,
  createDefaultRegistry,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type LeaseHold,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRealmMcpServer } from '../server.js';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

type Reply = Record<string, unknown>;
const DEF: WorkflowDefinition = {
  id: 'run-state-lease-cw5a',
  name: 'run-state-lease-cw5a',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: { s: { description: 'Answer this step.', execution: 'agent', depends_on: [] } },
} as WorkflowDefinition;

const handles: TempHome[] = [];
const holds: LeaseHold[] = [];
afterEach(async () => {
  for (const hold of holds.splice(0)) hold.close();
  for (const h of handles.splice(0).reverse()) await h.cleanup();
});

/** A run of DEF whose `s` a drive took under a lease, and the door's get_run_state on it. */
async function held(lease: 'held' | 'not_held' | 'absent') {
  const h = await makeTempHome();
  handles.push(h);
  await h.stores.workflowStore.register(DEF);
  const { record } = await h.stores.runStore.create({
    workflowId: DEF.id,
    workflowVersion: 1,
    params: {},
  });
  const answer = await claimStepForDrive(h.stores.runStore, record.id, 's', {
    definition: DEF,
    registry: createDefaultRegistry(),
    driver: { by: 'drive-a', by_source: 'stated', channel: 'agent' },
  });
  if (answer.kind !== 'claimed') throw new Error(`fixture: ${JSON.stringify(answer)}`);
  if (lease === 'held') holds.push(answer.hold);
  else answer.hold.close((await h.stores.runStore.get(record.id)).record);
  if (lease === 'absent') {
    const folder = join(h.path, 'claim-leases');
    for (const f of readdirSync(folder)) rmSync(join(folder, f));
  }
  const server = createRealmMcpServer({ ...h.stores });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'run-state-lease-cw5a', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const raw = (await client.callTool({
    name: 'get_run_state',
    arguments: { run_id: record.id },
  })) as { content: Array<{ text: string }> };
  return JSON.parse(raw.content[0]!.text) as Reply;
}

/** What the rows describe: the status, the stale-claim findings, and the stuck claims. */
const rows = (r: Reply) => ({
  status: r['next_actions_status'],
  findings: ((r['run_health'] as Reply[] | undefined) ?? [])
    .filter((f) => f['kind'] === 'stale_claim')
    .map((f) => [f['step'], f['reason'], (f['evidence'] as Reply | undefined)?.['state']]),
  stuck: ((r['stuck_claims'] as Reply[] | undefined) ?? []).map((c) => [c['step'], c['state']]),
});

describe('#729 CW-5a — run-state-and-health.md: a step a realm agent drive holds under a lease', () => {
  it('its program holds the lease: no finding, nothing stuck', async () => {
    // (1) red when a held lease is reported stale or of unknown age; (2) prints the rows.
    expect(rows(await held('held'))).toMatchObject({ findings: [], stuck: [] });
  });

  it('no program holds the lease: claim_stale, as a claim past its deadline', async () => {
    // (1) red when a lease no program holds is not reported as stale; (2) prints the rows.
    expect(rows(await held('not_held'))).toEqual({
      status: 'claim_stale',
      findings: [['s', 'claim_stale', 'claim_stale']],
      stuck: [['s', 'claim_stale']],
    });
  });

  it('its lease file is gone: claim_unknown_age', async () => {
    // (1) red when a gone lease file reads held or stale; (2) prints the rows.
    expect(rows(await held('absent'))).toMatchObject({
      findings: [['s', 'claim_unknown_age', 'claim_unknown_age']],
      stuck: [['s', 'claim_unknown_age']],
    });
  });
});
