// held-line-922-p22.test.ts — #922 P2-2 (prompt fix-922-p2-2-cli-doors.md items 1, 2, 4 and the dry
// run's header word; checks 3 (the table's states), 4, 7; MA 2's WO922-P22-MA2-01/02): the ONE CLI
// held line and the lines under a held step, read from the entry core composes for each held state,
// over a run whose claims are written as a store writes them, judged at one store reading. Every
// CLI line that prints a reclaim command says its conditions first, and "runs twice" exactly where
// the deadline is ahead or the age unknown (the owner's B). The hand-back says a step past its
// deadline is to be freed, never waited for.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect } from 'vitest';
import {
  HELD_WORDS,
  composeWaysAt,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type ClaimRecord,
  type RunRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { InMemoryStore, createLeaseDouble, settableClock } from '@sensigo/realm-testing';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  heldEntriesOf,
  heldLine,
  heldWayLines,
  waitsOnlyOnPastHeld,
  type HeldEntry,
} from './ways-renderer.js';
import { goOnLine } from '../lib/holder-render.js';
import { reclaimDryRunLines } from './reclaim.js';

const AT = Date.parse('2031-03-04T05:06:07.000Z');
const iso = (ms: number): string => new Date(AT + ms).toISOString();
const SINCE = iso(-1_200_000);
const PAST = iso(-60_000);
const AHEAD = iso(60_000);

/** `x` declared idempotent, `y` not; both engine steps (their claims carry deadlines). */
const DEF: WorkflowDefinition = {
  id: 'held-line-922',
  name: 'held-line-922',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    x: { description: 'x', execution: 'auto', depends_on: [], idempotent: true },
    y: { description: 'y', execution: 'auto', depends_on: [] },
  },
} as WorkflowDefinition;

/** The claim each held state is written with (`undefined`: in progress with no claim record). */
const CLAIMS: Record<string, ClaimRecord | undefined> = {
  past: { deadline: PAST, token: 't', since: SINCE },
  ahead: { deadline: AHEAD, token: 't', since: SINCE },
  unknown_age: { deadline: null, token: 't', since: SINCE },
  unreadable: { deadline: 'not-a-time', token: 't', since: SINCE },
  no_claim_record: undefined,
};

/** The held entries of a run with `held` in progress, composed at the store's reading `AT`. */
async function heldOn(
  held: Record<string, ClaimRecord | undefined>,
  persistsClaims = true,
  completed: string[] = [],
  // a lease double's state for the lease `L` a claim may name
  lease?: 'live' | 'dead',
): Promise<{
  runId: string;
  record: RunRecord;
  entries: HeldEntry[];
  ways: ReturnType<typeof composeWaysAt>;
}> {
  const leases = createLeaseDouble();
  if (lease !== undefined) leases.set('L', lease);
  const store = new InMemoryStore({ clock: settableClock(new Date(AT)), leases });
  const { record } = await store.create({ workflowId: DEF.id, workflowVersion: 1, params: {} });
  const claims: Record<string, ClaimRecord> = {};
  for (const [step, claim] of Object.entries(held)) if (claim !== undefined) claims[step] = claim;
  await store.update({
    ...record,
    in_progress_steps: Object.keys(held),
    completed_steps: completed,
    claims,
  });
  const snap = await store.get(record.id);
  const ways = composeWaysAt(snap.record, snap.at, {
    definition: DEF,
    persistsClaims,
    lease_facts: snap.lease_facts,
  });
  return { runId: record.id, record: snap.record, entries: heldEntriesOf(ways), ways };
}

const NOT_IDEMPOTENT = 'It is not declared idempotent, so running it again may repeat its effects.';
const UNKNOWN = 'so whether its program still runs is not known; if it does, the step runs twice.';

describe('#922 P2-2 — item 1: the one CLI held line, per state (check 3 at the table)', () => {
  it('each state: its opening, its conditions, then the command (the stamp when the claim has one)', async () => {
    const lines: Record<string, string> = {};
    let runId = '';
    for (const [state, claim] of Object.entries(CLAIMS)) {
      const on = await heldOn({ y: claim });
      runId = on.runId;
      lines[state] = heldLine(on.entries[0]!).replaceAll(on.runId, '<id>');
    }
    // (a) red when a state is read as another, "wait" is dropped for ahead (or said for past), the
    //     conditions follow the command, or the stamp is left out of a stamped claim's command;
    //     (b) prints every state's line, the run id as <id>.
    expect(runId).not.toBe('');
    expect(lines).toEqual({
      past: `'y' was claimed and its deadline passed at ${PAST}; no result is recorded for it. ${NOT_IDEMPOTENT} To free it, run: realm run reclaim <id> --step y --claimed-at ${SINCE} --force`,
      ahead: `'y' is held; wait for it. Its deadline is ahead (${AHEAD}); if its program is still running, the step runs twice. ${NOT_IDEMPOTENT} To free it anyway, run: realm run reclaim <id> --step y --claimed-at ${SINCE} --force`,
      unknown_age: `'y' is held since ${SINCE}; wait for it, or free it if its program has stopped. Its claim has no deadline, ${UNKNOWN} ${NOT_IDEMPOTENT} To free it, run: realm run reclaim <id> --step y --claimed-at ${SINCE} --force`,
      unreadable: `'y' is held since ${SINCE}; wait for it, or free it if its program has stopped. Its claim's deadline cannot be read, ${UNKNOWN} ${NOT_IDEMPOTENT} To free it, run: realm run reclaim <id> --step y --claimed-at ${SINCE} --force`,
      no_claim_record: `'y' is held; wait for it, or free it if its program has stopped. It is held with no claim record, ${UNKNOWN} ${NOT_IDEMPOTENT} To free it, run: realm run reclaim <id> --step y --force`,
    });
  });

  it('a store that keeps no claims: the opening alone, no command', async () => {
    const on = await heldOn({ y: CLAIMS['past'] }, false);
    // (a) red when the store's words change or a command is printed it cannot take; (b) prints it.
    expect(heldLine(on.entries[0]!)).toBe(
      "'y' is held; this store keeps no claim records, so it cannot be freed with reclaim.",
    );
    expect(heldWayLines(on.entries[0]!)).toEqual([]);
  });

  it('an idempotent step past its deadline: no condition, the command alone after the opening', async () => {
    const on = await heldOn({ x: CLAIMS['past'] });
    // (a) red when a condition is invented for a past idempotent step; (b) prints the line.
    expect(heldLine(on.entries[0]!).replaceAll(on.runId, '<id>')).toBe(
      `'x' was claimed and its deadline passed at ${PAST}; no result is recorded for it. To free it, run: realm run reclaim <id> --step x --claimed-at ${SINCE} --force`,
    );
  });
});

describe('#922 P2-2 — check 4 (the owner’s B): the conditions before every printed command', () => {
  it('every state × idempotent or not, on the held line and the lines under a step: "runs twice" exactly where the deadline is ahead or the age unknown', async () => {
    const wrong: string[] = [];
    for (const [state, claim] of Object.entries(CLAIMS)) {
      for (const step of ['x', 'y']) {
        const on = await heldOn({ [step]: claim });
        const entry = on.entries[0]!;
        const twice = state !== 'past';
        for (const [door, text] of [
          ['held line', heldLine(entry)],
          ['lines under it', heldWayLines(entry).join(' ')],
        ] as const) {
          const command = text.indexOf('realm run reclaim');
          const words = text.indexOf('It');
          if (text.includes('runs twice') !== twice)
            wrong.push(`${state}/${step}/${door}: runs twice`);
          if (step === 'y' && !(words >= 0 && words < command)) {
            wrong.push(`${state}/${step}/${door}: conditions after the command`);
          }
        }
      }
    }
    // (a) red when a condition is dropped, said after the command, or "runs twice" appears where
    //     no window or unknown age holds; (b) prints each state, step and door that is wrong.
    expect(wrong).toEqual([]);
  });
});

describe('#922 P2-2 — item 5: the dry run’s lines under a held step, and its header word', () => {
  it('a past step leads with its deadline-passed line; the header words are the three documented ones (MA 2, WO922-P22-MA2-01)', async () => {
    const on = await heldOn({ x: CLAIMS['past'], y: CLAIMS['ahead'] });
    const state: Record<string, string> = {};
    for (const [name, claim] of Object.entries(CLAIMS)) {
      const one = await heldOn({ y: claim });
      state[name] = reclaimDryRunLines(
        one.record,
        // the classifier's word is `healthy` for an unreadable deadline (walk O3): never read here
        [{ step: 'y', state: 'healthy', deadline: claim?.deadline ?? null }],
        one.ways,
      )[0]!;
    }
    // (a) red when the header reads the classifier's word (an unreadable deadline then "healthy"),
    //     or a fourth word is printed; (b) prints every state's header.
    expect(state).toEqual({
      past: `  • y: claim_stale  (deadline: ${PAST})`,
      ahead: `  • y: healthy  (deadline: ${AHEAD})`,
      unknown_age: '  • y: claim_unknown_age  (deadline: none (unknown age))',
      unreadable: '  • y: claim_unknown_age  (deadline: not-a-time)',
      no_claim_record: '  • y: claim_unknown_age  (deadline: none (unknown age))',
    });
    // (a) red when the past line is missing or follows the conditions, or "anyway" is lost for a
    //     step whose deadline is ahead; (b) prints the lines.
    expect(
      on.entries.map((e) => heldWayLines(e).map((l) => l.replaceAll(on.runId, '<id>'))),
    ).toEqual([
      [
        `Its deadline passed at ${PAST}; no result is recorded for it.`,
        `To free it, run: realm run reclaim <id> --step x --claimed-at ${SINCE} --force`,
      ],
      [
        `Its deadline is ahead (${AHEAD}); if its program is still running, the step runs twice.`,
        NOT_IDEMPOTENT,
        `To free it anyway, run: realm run reclaim <id> --step y --claimed-at ${SINCE} --force`,
      ],
    ]);
  });
});

describe('#922 P2-2 — item 2: what `realm run advance` exits 1 on (the composed ways)', () => {
  it('past only → 1; past beside a step that can still finish → 0', async () => {
    const results: Record<string, boolean> = {};
    // the step not held is completed, so nothing else is owed
    for (const [name, held, completed] of [
      ['past', { x: CLAIMS['past'] }, ['y']],
      ['two past', { x: CLAIMS['past'], y: CLAIMS['past'] }],
      ['past + ahead', { x: CLAIMS['past'], y: CLAIMS['ahead'] }],
      ['past + unknown age', { x: CLAIMS['past'], y: CLAIMS['unknown_age'] }],
      ['past + unreadable', { x: CLAIMS['past'], y: CLAIMS['unreadable'] }],
      ['past + no claim record', { x: CLAIMS['past'], y: undefined }],
      ['ahead', { y: CLAIMS['ahead'] }, ['x']],
      // `y` owed to the engine: the advance way is offered, so nothing waits on the past step alone
      ['past + owed engine work', { x: CLAIMS['past'] }, []],
    ] as const) {
      results[name] = waitsOnlyOnPastHeld((await heldOn(held, true, [...(completed ?? [])])).ways);
    }
    // (a) red when the rule reads "some blocker past", or a step that can still finish counts as
    //     past; (b) prints each mix's verdict.
    expect(results).toEqual({
      past: true,
      'two past': true,
      'past + ahead': false,
      'past + unknown age': false,
      'past + unreadable': false,
      'past + no claim record': false,
      ahead: false,
      'past + owed engine work': false,
    });
  });
});

describe('#922 P2-2 — item 4 (check 7): the hand-back', () => {
  it('past alone, two past, past beside one that can still finish, two that can still finish', async () => {
    const line = async (held: Record<string, ClaimRecord | undefined>): Promise<string> => {
      const on = await heldOn(held);
      return goOnLine(on.entries, on.runId, '<command>').replaceAll(on.runId, '<id>');
    };
    // (a) red when a past step is told to be waited for ("no longer in flight"), the plural is
    //     not "their commands" (MA 2, WO922-P22-MA2-02), or steps that can still finish lose
    //     today's words; (b) prints each line.
    expect({
      past: await line({ x: CLAIMS['past'] }),
      twoPast: await line({ x: CLAIMS['past'], y: CLAIMS['past'] }),
      pastAndAhead: await line({ x: CLAIMS['past'], y: CLAIMS['ahead'] }),
      aheadAndUnknown: await line({ x: CLAIMS['ahead'], y: CLAIMS['unknown_age'] }),
    }).toEqual({
      past: "  Go on:     once 'x' is freed (realm run reclaim <id> prints its command), <command>",
      twoPast:
        "  Go on:     once 'x', 'y' are freed (realm run reclaim <id> prints their commands), <command>",
      pastAndAhead:
        "  Go on:     once 'y' is no longer in flight and 'x' is freed (realm run reclaim <id> prints its command), <command>",
      aheadAndUnknown: "  Go on:     once 'x', 'y' are no longer in flight, <command>",
    });
  });
});

describe('#729 CW-3a — the lease states at the CLI’s renderer (P2-2’s temporary branch removed)', () => {
  it('a claim whose lease is held: wait, lease_held’s words first, "To free it anyway", the header healthy, the hand-back waits; not held: freed as a past claim, led by the not-held line, the header claim_stale', async () => {
    const leased = { ...CLAIMS['past']!, lease: { id: 'L' } };
    const live = await heldOn({ y: leased }, true, ['x'], 'live');
    const dead = await heldOn({ y: leased }, true, ['x'], 'dead');
    const dryRun = (on: Awaited<ReturnType<typeof heldOn>>): string[] =>
      reclaimDryRunLines(on.record, [{ step: 'y', state: 'claim_stale', deadline: PAST }], on.ways);
    const cmd = (on: Awaited<ReturnType<typeof heldOn>>): string =>
      `realm run reclaim ${on.runId} --step y --claimed-at ${SINCE} --force`;
    const held =
      "Its program held the claim's lease when it was checked; if that program is still running, the step runs twice.";
    const notHeld =
      "No program held the claim's lease when it was checked; no result is recorded for it.";
    // (a) red when a leased claim is read by its deadline (past, here), a held lease is offered no
    //     command or without its condition, or a lease no program held is waited for; (b) prints both.
    expect({
      live: {
        line: heldLine(live.entries[0]!),
        under: heldWayLines(live.entries[0]!),
        header: dryRun(live)[0],
        goOn: goOnLine(live.entries, live.runId, '<command>'),
      },
      dead: {
        line: heldLine(dead.entries[0]!),
        under: heldWayLines(dead.entries[0]!),
        header: dryRun(dead)[0],
        goOn: goOnLine(dead.entries, dead.runId, '<command>'),
      },
    }).toEqual({
      live: {
        line: `'y' is held; wait for it. ${held} ${NOT_IDEMPOTENT} To free it anyway, run: ${cmd(live)}`,
        under: [held, NOT_IDEMPOTENT, `To free it anyway, run: ${cmd(live)}`],
        header: `  • y: healthy  (deadline: ${PAST})`,
        goOn: "  Go on:     once 'y' is no longer in flight, <command>",
      },
      dead: {
        line: `'y' was claimed, and no program held the claim's lease when it was checked; no result is recorded for it. ${NOT_IDEMPOTENT} To free it, run: ${cmd(dead)}`,
        under: [notHeld, NOT_IDEMPOTENT, `To free it, run: ${cmd(dead)}`],
        header: `  • y: claim_stale  (deadline: ${PAST})`,
        goOn: `  Go on:     once 'y' is freed (realm run reclaim ${dead.runId} prints its command), <command>`,
      },
    });
  });
});

describe('#922 P2-2 — check 12 (rule 10): no held-step line says a program died', () => {
  it('the CLI’s held words over every state, and the public ClaimRecord.deadline description', async () => {
    const texts: string[] = [];
    for (const state of [
      'ahead',
      'past',
      'unknown_age',
      'unreadable',
      'no_claim_record',
      'store_keeps_no_claims',
      // #729 CW-3a: the two lease states
      'lease_held',
      'lease_not_held',
    ] as const) {
      texts.push(HELD_WORDS.cli(state, 's', SINCE));
    }
    for (const claim of Object.values(CLAIMS)) {
      for (const step of ['x', 'y']) {
        const on = await heldOn({ [step]: claim });
        texts.push(heldLine(on.entries[0]!), ...heldWayLines(on.entries[0]!));
        texts.push(goOnLine(on.entries, on.runId, '<command>'));
      }
    }
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../../core/src/types/run-record.ts'),
      'utf8',
    );
    const start = source.indexOf('export interface ClaimRecord {');
    const jsdoc = source.slice(start, source.indexOf('deadline: string | null;', start));
    texts.push(jsdoc);
    // (a) red when a held-step line or the description says a program died, is dead, gone or
    //     presumed; (b) prints each text that does.
    expect(jsdoc).toContain('deadline has passed');
    expect(texts.filter((t) => /\b(died|dead|gone|presumed)\b/i.test(t))).toEqual([]);
  });

  it('#729 CW-3a: the CLI’s lines for the two lease states hold no word of the deny-list', async () => {
    const DENY =
      /\b(died|dead|alive|live runner|live driver|presumed|probably|likely|unknown age|deadline)\b/i;
    const lines = async (lease: 'live' | 'dead'): Promise<string[]> => {
      // a claim with no deadline, so the deny-list's "deadline" cannot come from the claim itself
      const on = await heldOn(
        { y: { ...CLAIMS['unknown_age']!, lease: { id: 'L' } } },
        true,
        ['x'],
        lease,
      );
      return [
        HELD_WORDS.cli(lease === 'live' ? 'lease_held' : 'lease_not_held', 'y', SINCE),
        heldLine(on.entries[0]!),
        ...heldWayLines(on.entries[0]!),
      ];
    };
    const held = await lines('live');
    const notHeld = await lines('dead');
    // (a) red when a lease state's words say a program died, is alive, presumed or likely, name an
    //     unknown age or a deadline, or a not-held one says "wait for it"; (b) prints each such text.
    expect({
      deny: [...held, ...notHeld].filter((t) => DENY.test(t)),
      wait: notHeld.filter((t) => /wait for it/i.test(t)),
    }).toEqual({ deny: [], wait: [] });
  });
});
