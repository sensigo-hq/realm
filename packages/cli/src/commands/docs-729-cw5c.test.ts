// docs-729-cw5c.test.ts — #729 CW-5c (prompt feat-729-cw5c-below-cap-words.md): the words the unit
// adds for a person, each held to its page word for word (spaces folded, as a table's padding moves),
// with the cell that executes what the sentence says named beside it (guardrail 9). The line the
// pages quote is also held to the renderer: the page's line, its placeholders filled in, is the line
// the screens print.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  claimStepForDrive,
  composeWaysAt,
  createDefaultRegistry,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { InMemoryStore, createLeaseDouble } from '@sensigo/realm-testing';
import { PLAIN } from '../output/writer.js';
import { stepsTakenBack } from '../lib/holder-render.js';
import { heldEntriesOf, heldWayLines } from './ways-renderer.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const flat = (t: string): string => t.replace(/\s+/g, ' ');
const read = (page: string): string => readFileSync(join(ROOT, page), 'utf8');
/** (1) red when the page no longer holds the sentence word for word; (2) prints the sentence. */
function claim(page: string, sentence: string, times = 1): void {
  expect(
    flat(read(page)).split(flat(sentence)).length - 1,
    `${page} no longer says (${times}×): ${sentence}`,
  ).toBe(times);
}
/** The section that holds this unit's entry: `[Unreleased]` until a release renames it. */
function claimChangelog(sentence: string): void {
  const text = read('CHANGELOG.md');
  const start = text.includes('## [Unreleased]')
    ? text.indexOf('## [Unreleased]')
    : text.indexOf('\n## [') + 1;
  const section = text.slice(start, text.indexOf('\n## [0.50.0]'));
  expect(flat(section), `the CHANGELOG no longer says: ${sentence}`).toContain(flat(sentence));
}

/** The line the screens end a step's held lines with, as the pages quote it. */
const LINE =
  "Or let realm agent --run-id <run> --provider <provider> --model <model> take it back and run it (this step's one automatic take-back until a person reclaims it).";
const SCREENS = `For an agent step that \`realm agent\` has not taken back since a person last reclaimed it, the lines end with \`${LINE}\` (added after version 0.50.0).`;

describe('#729 CW-5c — the screens', () => {
  it('realm-run-acting.md (advance, the dry run) and realm-run-reading.md (inspect): the line, after the not-held lead', () => {
    // below-cap-words-cw5c check 2: advance (both places), the dry run and inspect, below the cap the
    // line and at the cap today's words; held-lease-cw3a check 2 (advance and the dry run); check 6
    // (inspect and advance on real leases, the command run as printed).
    claim('docs/reference/cli/realm-run-acting.md', SCREENS, 2);
    claim('docs/reference/cli/realm-run-reading.md', SCREENS);
  });

  it('the line the pages quote, its placeholder filled in, is the line the screens print', async () => {
    // A run whose agent step a killed drive left (its claim's lease held by no program), rendered as
    // `realm run inspect` renders its lines.
    const def = {
      id: 'docs-729-cw5c',
      name: 'docs-729-cw5c',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: { s: { description: 'S.', execution: 'agent', depends_on: [] } },
    } as WorkflowDefinition;
    const store = new InMemoryStore({ leases: createLeaseDouble() });
    const { record } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    const claimed = await claimStepForDrive(store, record.id, 's', {
      definition: def,
      registry: createDefaultRegistry(),
      driver: { by: 'drive-a', by_source: 'stated', channel: 'agent' },
    });
    if (claimed.kind !== 'claimed') throw new Error(`fixture: ${claimed.kind}`);
    claimed.hold.close((await store.get(record.id)).record);
    const snap = await store.get(record.id);
    const held = heldEntriesOf(
      composeWaysAt(snap.record, snap.at, {
        definition: def,
        persistsClaims: true,
        lease_facts: snap.lease_facts,
      }),
    );
    const lines = held.flatMap((e) =>
      heldWayLines(e, PLAIN, stepsTakenBack(snap.record, def, held)),
    );
    // (1) red when the page's line and the printed line differ (either changed); (2) prints both.
    expect(lines.at(-1)).toBe(LINE.split('<run>').join(record.id));
  });
});

describe('#729 CW-5c — realm workflow run and realm agent', () => {
  it('realm-workflow.md: the hand-back names the realm agent command, and its Go-on line opens with it', () => {
    // holder-lines-cw4b "a killed drive's step the command reaches": below the cap the in-flight line
    // ends with the line and the Go-on opens `let realm agent … take 'b' back, or`; at the cap
    // today's words.
    claim(
      'docs/reference/cli/realm-workflow.md',
      'hands the run back with the command that frees the step and, for an agent step `realm agent` has not taken back since a person last reclaimed it, the `realm agent` command that takes it back (only `realm agent` takes such a step back;',
    );
    claim(
      'docs/reference/cli/realm-workflow.md',
      "and `realm run reclaim <run>` prints its command; for an agent step `realm agent` has not taken back since a person last reclaimed it, the line opens `let realm agent --run-id <run> --provider <provider> --model <model> take '<step>' back, or` (added after version 0.50.0).",
    );
  });

  it('realm-agent.md: the Go-on line for a step this drive could not take back', () => {
    // take-back-watch-cw5b: "#729 CW-5c check 4: no driver, below the cap" (no program name: the
    // Go-on, no realm agent take-back), "not an agent step" (watched as today), W5 (at the cap: the
    // at-cap line, then the Go-on).
    claim(
      'docs/reference/cli/realm-agent.md',
      "or, for a step whose deadline has passed or whose claim's lease no program held and this drive could not take it back (it has no program name, the step is not an agent step, or it was already taken back automatically since a person last reclaimed it), ` Go on: once '<step>' is freed (realm run reclaim <run> prints its command), realm agent --run-id <run> <flags>`",
    );
  });
});

describe('#729 CW-5c — the MCP pages catch up with the protocol (CW-5a)', () => {
  it('run-state-and-health.md and tools.md: a lease no program held reads as report_to_user, with its next sentence', () => {
    // mcp-server held-lease-cw3a "check 2, not held": get_run_state's agent_action report_to_user,
    // no until, and advance_run's hint `No step is ready: 'a' was claimed, and no program held the
    // claim's lease when it was checked; no result is recorded for it. Tell the user: a person can
    // free it.`; held-words-922-p21's protocol pins (generator.ts).
    const CLAUSE =
      'held by a claim whose deadline has passed, or whose lease no program held when it was checked';
    claim('docs/reference/mcp/run-state-and-health.md', CLAUSE, 2);
    claim('docs/reference/mcp/tools.md', CLAUSE, 2);
    claim(
      'docs/reference/mcp/tools.md',
      "`No step is ready: '<step>' was claimed and its deadline passed at <time>; no result is recorded for it. Tell the user: a person can free it.`, or, for a lease no program held, `No step is ready: '<step>' was claimed, and no program held the claim's lease when it was checked; no result is recorded for it. Tell the user: a person can free it.`",
    );
  });
});

describe('#729 CW-5c — the CHANGELOG', () => {
  it('CW-3a’s line points below, and the new Changed line', () => {
    // below-cap-words-cw5c check 2 (the six commands, below the cap and at it); check 6 (a killed
    // drive's step on real leases).
    claimChangelog(
      "A claim whose lease no program holds is reported like a claim past its deadline; on the CLI, an agent step's lines also name `realm agent` (see below).",
    );
    claimChangelog(
      `- **The screens that show a killed drive's step name \`realm agent\`.** For an agent step whose claim's lease no program held, and which \`realm agent\` has not taken back since a person last reclaimed it, \`realm run inspect\`, \`realm run advance\`, \`respond\`, \`drain\`, the reclaim dry run and \`realm workflow run\` now add \`${LINE}\` The reclaim command stays. (#729)`,
    );
  });
});
