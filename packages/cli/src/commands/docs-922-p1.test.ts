// docs-922-p1.test.ts — #922 P1a (prompt fix-922-p1-reclaim-way.md, "Words a user reads", items 10
// and 13; checks 10 and 14; guardrail 9): every sentence P1a writes for a person, each with the cell
// that executes what it says — the condition words of the one table, the MCP person block's reclaim
// line printed through the CLI's own operator route (the words before the command, B b7f72a42), the
// CHANGELOG's lines — and the release rule: #922 P1 and P2 ship in one release.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: the page
// and the sentence, the words, or the cell that is missing.
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  InMemoryTraceBufferStore,
  reclaimConditionWords,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { InMemoryStore, settableClock } from '@sensigo/realm-testing';
import { createRealmMcpServer } from '@sensigo/realm-mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { cliOperatorRoute } from './ways-renderer.js';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');
const flat = (t: string): string => t.replace(/\s+/g, ' ');
const read = (page: string): string => readFileSync(join(ROOT, page), 'utf8');

/** The CHANGELOG's `[Unreleased]` section (#871's form): `[Unreleased]` until a release renames it,
 *  then the first section (the release's). */
function unreleased(): string {
  const text = read('CHANGELOG.md');
  const start = text.includes('## [Unreleased]')
    ? text.indexOf('## [Unreleased]')
    : text.indexOf('\n## [') + 1;
  return text.slice(start, text.indexOf('\n## [', start + 1));
}

/** P1a's CHANGELOG lines, word for word (the Upgrading item without its number, which a merge moves). */
const UPGRADING =
  'On MCP, `agent_action` is `report_to_user` and `until` is never a past held deadline when every blocker is a step past its deadline.';
const CHANGED =
  "**Each held step carries a `reclaim` way for a person, with its conditions.** In the library, `WAY_VERBS` gains `reclaim`, and `WayOn` the new `ReclaimWay`; `Cond` gains the conditions `claim_deadline_ahead`, `override_claim_unknown_age` and `rerun_not_idempotent`; `UNAVAILABLE_CODES` and `FactsByCode` gain the codes `not_held`, `store_keeps_no_claims`, `fence_required` and `claim_changed`, and `held_elsewhere`'s facts gain the claim's stamp (`claimed_at`) and, for a deadline that cannot be read, `{ absent: 'unparseable_stamp' }`. `WayRenderer` and `LIBRARY_WORDS` gain `reclaim` with the list: a program that writes the full `WayRenderer` itself adds a `reclaim` function, and one built with `withLibraryWords` renders it in Realm's words.";

/** A cell, by its file and (part of) its title. */
type Cell = readonly [file: string, title: string];
const MCP_C1: Cell = [
  'packages/mcp-server/src/held-reply-922.test.ts',
  'get_run_state: report_to_user, no until — judged at the reading of the record (snap.at)',
];
const MCP_C2C: Cell = [
  'packages/mcp-server/src/held-reply-922.test.ts',
  'every hold past its deadline: report_to_user',
];
const CORE_WAY: Cell = [
  'packages/core/src/engine/held-state-922.test.ts',
  'every held state × idempotent or not: the conditions that hold, the stamp when the claim has one',
];

function cellExists([file, title]: Cell): boolean {
  return existsSync(join(ROOT, file)) && read(file).includes(title);
}

describe('#922 P1a — the release rule (item 13, check 14)', () => {
  it('#922 P1 and P2 ship in one release: until docs-922-p2.test.ts exists, P1’s lines sit between the literal `## [Unreleased]` heading and the next section', () => {
    // NOT #871's form: after a release renames [Unreleased], that form reads the release's section,
    // so a gate written with it never fails. P2 deletes this cell.
    if (existsSync(join(HERE, 'docs-922-p2.test.ts'))) return;
    const text = read('CHANGELOG.md');
    const at = text.indexOf('\n## [Unreleased]\n');
    const section = at < 0 ? '' : text.slice(at, text.indexOf('\n## [', at + 1));
    const missing = [UPGRADING, CHANGED].filter((line) => !flat(section).includes(flat(line)));
    // (a) red when a release commit renames [Unreleased] (or moves P1's lines under a version) before
    //     P2 lands; (b) prints the rule and the lines not found under the literal heading.
    expect(
      missing,
      '#922 P1 and P2 ship in one release; P2 has not landed: cut from before P1, or wait',
    ).toEqual([]);
  });
});

describe('#922 P1a — the CHANGELOG lines, each with the cell that executes it', () => {
  it('Upgrading: the MCP reply on a run whose every blocker is a step past its deadline', () => {
    // (a) red when the line is dropped or reworded, or its executing cells are gone; (b) prints it.
    expect(flat(unreleased()).includes(flat(UPGRADING)), UPGRADING).toBe(true);
    expect([MCP_C1, MCP_C2C].filter((c) => !cellExists(c))).toEqual([]);
  });

  it('Changed: the reclaim way and the public rows it changes', () => {
    // (a) red when the line is dropped or reworded, or its executing cell is gone; (b) prints it.
    expect(flat(unreleased()).includes(flat(CHANGED)), CHANGED).toBe(true);
    expect(cellExists(CORE_WAY)).toBe(true);
  });
});

describe('#922 P1a — the condition words: one table, read by every place that prints a reclaim (R13)', () => {
  it('each condition’s words, as the prompt writes them (the owner’s B for the window)', () => {
    const T = '2030-01-01T12:01:00.000Z';
    // (a) red when a condition's words change, or the unreadable or no-record words say "no
    //     deadline"; (b) prints every condition's words.
    expect([
      reclaimConditionWords({ code: 'claim_deadline_ahead', deadline: T }),
      reclaimConditionWords({ code: 'override_claim_unknown_age', state: 'unknown_age' }),
      reclaimConditionWords({ code: 'override_claim_unknown_age', state: 'unreadable' }),
      reclaimConditionWords({ code: 'override_claim_unknown_age', state: 'no_claim_record' }),
      reclaimConditionWords({ code: 'rerun_not_idempotent', basis: 'not_declared' }),
      reclaimConditionWords({ code: 'rerun_not_idempotent', basis: 'definition_absent' }),
    ]).toEqual([
      `Its deadline is ahead (${T}); if its program is still running, the step runs twice.`,
      'Its claim has no deadline, so whether its program still runs is not known; if it does, the step runs twice.',
      "Its claim's deadline cannot be read, so whether its program still runs is not known; if it does, the step runs twice.",
      'It is held with no claim record, so whether its program still runs is not known; if it does, the step runs twice.',
      'It is not declared idempotent, so running it again may repeat its effects.',
      'Its workflow definition is not available here, so whether running it again is safe is not known.',
    ]);
  });
});

const handles: TempHome[] = [];
afterEach(async () => {
  for (const h of handles.splice(0).reverse()) await h.cleanup();
});

describe('#922 P1a — check 10: the MCP person block says the conditions before the command', () => {
  it('a held step inside its window, not declared idempotent: the line names both conditions, then the command the CLI route prints', async () => {
    const start = new Date('2030-01-01T12:00:00.000Z');
    const deadline = new Date(start.getTime() + 60_000).toISOString();
    const since = new Date(start.getTime() - 3_600_000).toISOString();
    const def = {
      id: 'docs-922-p1',
      name: 'docs-922-p1',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: { a: { description: 'a', execution: 'agent', depends_on: [] } },
    } as WorkflowDefinition;
    const runStore = new InMemoryStore({ clock: settableClock(start) });
    const h = await makeTempHome();
    handles.push(h);
    await h.home.workflowStore.register(def);
    const server = createRealmMcpServer({
      gateAnswers: 'permitted',
      runStore,
      workflowStore: h.home.workflowStore,
      traceBufferStore: new InMemoryTraceBufferStore(runStore),
      failedAttemptStore: h.home.failedAttemptStore,
      operatorRoute: cliOperatorRoute('realm mcp'),
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'docs-922-p1', version: '0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const { record } = await runStore.create({
      workflowId: def.id,
      workflowVersion: 1,
      params: {},
    });
    await runStore.update({
      ...record,
      in_progress_steps: ['a'],
      claims: { a: { deadline, token: 'other', since } },
    });
    const raw = (await client.callTool({
      name: 'get_run_state',
      arguments: { run_id: record.id },
    })) as { content: Array<{ text: string; annotations?: { audience?: string[] } }> };
    const agentJson = JSON.parse(raw.content[0]!.text) as {
      elsewhere?: Array<{ verb: string; human_readable: string }>;
    };
    const person = raw.content.find((c) => c.annotations?.audience?.includes('user'))?.text ?? '';
    const words =
      `An operator can free step 'a', outside this conversation. Its deadline is ahead (${deadline}); ` +
      'if its program is still running, the step runs twice. It is not declared idempotent, so ' +
      'running it again may repeat its effects.';
    // (a) red when elsewhereWords has no reclaim arm (the line then names no condition), or the
    //     command comes before the words; (b) prints the person block and the agent's entry.
    expect({
      person: person.split('\n').filter((l) => l.includes('realm run reclaim')),
      agent: agentJson.elsewhere?.filter((e) => e.verb === 'reclaim').map((e) => e.human_readable),
    }).toEqual({
      person: [
        `${words} The operator's command: realm run reclaim ${record.id} --step a --claimed-at ${since} --force`,
      ],
      agent: [words],
    });
  });
});
