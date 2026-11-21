// actor-who-ended-625.test.ts — #625 PR-2b, the actor unit: who ended a run.
//
// Before this unit every screen said how a run ended ("It was abandoned, with the reason …"), never
// who ended it: a person could not tell a colleague's `realm run abandon` from the assistant's
// `abandon_run`. Now `abandonRun` and a `seal_run` change carry the program (`by`) and the command
// or tool (`door`), the seal keeps both, and the one ending composer and inspect's line name them.
//
// These cells write each record through its real writer — `abandonRun`, the store's `seal_run` as
// `realm run cleanup` writes it — except the unreadable and foreign-door records, which are seeded
// raw (a record a newer or broken writer left). Names are synthetic. Every assertion carries (a)
// the change that turns it red and (b) what it prints.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import { abandonRun } from './abandon-run.js';
import { endedByLine, runEndingOf } from './pending.js';
import {
  BY_SOURCE_WORDS,
  RECORDED_BY_SOURCE_WORDS,
  UNSHOWABLE_NAME,
  type Attributed,
} from './holder.js';
import { WorkflowError } from '../types/workflow-error.js';
import type { RunRecord, SealedBy } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

const WF: WorkflowDefinition = {
  id: 'actor-wf',
  name: 'Actor',
  version: 1,
  steps: { a: { description: 'A.', execution: 'agent', depends_on: [] } },
};

const DERIVED: Attributed = { by: 'abcd@box', by_source: 'derived', channel: 'abandon' };
const AMBIENT: Attributed = { by: 'tester', by_source: 'ambient', channel: 'cleanup' };
const STATED: Attributed = { by: 'shop-bot', by_source: 'stated', channel: 'mcp-http' };
const SERVER: Attributed = { by: 'abcd@box', by_source: 'derived', channel: 'mcp-stdio' };

async function fresh(store: InMemoryStore): Promise<string> {
  return (await store.create({ workflowId: WF.id, workflowVersion: 1, params: {} })).record.id;
}

const sentenceOf = async (store: InMemoryStore, id: string): Promise<string | undefined> =>
  runEndingOf((await store.get(id)).record, WF)?.sentence;

/** Seeds an abandoned record whose seal is exactly `sealed_by` (a newer or broken writer's record). */
async function seeded(store: InMemoryStore, sealed_by: unknown, reason: string): Promise<string> {
  const id = await fresh(store);
  const { record } = await store.get(id);
  await store.update({
    ...record,
    terminal_state: true,
    terminal_reason: reason,
    abandoned_at: '2026-11-21T00:00:00.000Z',
    sealed_by,
  } as RunRecord);
  return id;
}

describe('#625 the actor unit, check 1 — one cell per producing branch of the ending sentence', () => {
  it('check 1 — the door × reason cells: realm run abandon, the abandon_run tool, realm run cleanup', async () => {
    const store = new InMemoryStore();
    const [a1, a2, t1, t2, c1] = [
      await fresh(store),
      await fresh(store),
      await fresh(store),
      await fresh(store),
      await fresh(store),
    ];
    await abandonRun(store, a1, 'duplicate order', { by: DERIVED, door: 'realm_run_abandon' });
    // The CLI's own default reason reads as no reason given.
    await abandonRun(store, a2, 'Abandoned via realm run abandon', {
      by: DERIVED,
      door: 'realm_run_abandon',
    });
    await abandonRun(store, t1, 'duplicate order', { by: SERVER, door: 'abandon_run' });
    await abandonRun(store, t2, 'Abandoned via abandon_run', { by: SERVER, door: 'abandon_run' });
    // `realm run cleanup`'s exact write.
    const { record } = await store.get(c1);
    await store.settleStep(c1, {
      kind: 'seal_run',
      arm: 'cleanup_sweep',
      reason: 'Marked abandoned by realm cleanup',
      expected_version: record.version,
      release_claims: true,
      by: AMBIENT,
      door: 'realm_run_cleanup',
    });
    // (a) red when a door's words are missing or swapped, the clause is built from `channel`, or the
    //     reason's two forms are lost; (b) prints the five sentences.
    expect({
      abandonWithReason: await sentenceOf(store, a1),
      abandonNoReason: await sentenceOf(store, a2),
      toolWithReason: await sentenceOf(store, t1),
      toolNoReason: await sentenceOf(store, t2),
      cleanup: await sentenceOf(store, c1),
    }).toEqual({
      abandonWithReason:
        'It was abandoned with \'realm run abandon\', by abcd@box (from the OS user), with the reason "duplicate order".',
      abandonNoReason:
        "It was abandoned with 'realm run abandon', by abcd@box (from the OS user); no reason was given.",
      toolWithReason:
        "It was abandoned with the assistant's 'abandon_run' tool, on the Realm server running as abcd@box (from the OS user), with the reason \"duplicate order\".",
      toolNoReason:
        "It was abandoned with the assistant's 'abandon_run' tool, on the Realm server running as abcd@box (from the OS user); no reason was given.",
      cleanup: "'realm run cleanup', run by tester (from REALM_OPERATOR), marked it abandoned.",
    });
  });

  it('check 1 — no door: an embedder that holds the server’s driver (mcp-stdio) or the CLI’s (abandon) calls abandonRun itself — the library form, with the channel', async () => {
    const store = new InMemoryStore();
    const [m, a, n, c] = [
      await fresh(store),
      await fresh(store),
      await fresh(store),
      await fresh(store),
    ];
    await abandonRun(store, m, 'duplicate order', { by: SERVER });
    await abandonRun(store, a, 'duplicate order', { by: DERIVED });
    await abandonRun(store, n, undefined, { by: STATED });
    const { record } = await store.get(c);
    await store.settleStep(c, {
      kind: 'seal_run',
      arm: 'cleanup_sweep',
      reason: 'Marked abandoned by realm cleanup',
      expected_version: record.version,
      release_claims: true,
      by: AMBIENT,
    });
    // (a) red when the library form drops the channel, names a door that was not passed, or the
    //     stated words are the holder lines' own ("as stated"); (b) prints the sentences.
    expect({
      mcpStdio: await sentenceOf(store, m),
      abandon: await sentenceOf(store, a),
      stated: await sentenceOf(store, n),
      cleanup: await sentenceOf(store, c),
    }).toEqual({
      mcpStdio:
        'It was abandoned by abcd@box (from the OS user, via mcp-stdio), with the reason "duplicate order".',
      abandon:
        'It was abandoned by abcd@box (from the OS user, via abandon), with the reason "duplicate order".',
      stated:
        'It was abandoned by shop-bot (named by the program that runs Realm, via mcp-http); no reason was given.',
      cleanup:
        "'realm run cleanup', run by tester (from REALM_OPERATOR, via cleanup), marked it abandoned.",
    });
  });

  it('check 1 — an unreadable name, a door from another arm and a door this binary does not know', async () => {
    const store = new InMemoryStore();
    const unreadable = await seeded(
      store,
      {
        arm: 'abandon_requested',
        by: { by: 'abcd\u001b[2J', by_source: 'derived', channel: 'abandon' },
        door: 'realm_run_abandon',
      },
      'duplicate order',
    );
    const otherArm = await seeded(
      store,
      { arm: 'abandon_requested', by: DERIVED, door: 'realm_run_cleanup' },
      'duplicate order',
    );
    const unknown = await seeded(
      store,
      { arm: 'cleanup_sweep', by: AMBIENT, door: 'realm_run_sweeper' },
      'Marked abandoned by realm cleanup',
    );
    // (a) red when an unreadable name prints a byte of the stored value, a door is used on an arm
    //     that is not its own, or a door outside SEAL_DOORS is worded; (b) prints the sentences.
    expect({
      unreadable: await sentenceOf(store, unreadable),
      otherArm: await sentenceOf(store, otherArm),
      unknown: await sentenceOf(store, unknown),
    }).toEqual({
      unreadable: `It was abandoned with 'realm run abandon', by ${UNSHOWABLE_NAME}, with the reason "duplicate order".`,
      otherArm:
        'It was abandoned by abcd@box (from the OS user, via abandon), with the reason "duplicate order".',
      unknown:
        "'realm run cleanup', run by tester (from REALM_OPERATOR, via cleanup), marked it abandoned.",
    });
  });

  it('check 1 — no recorded name: today’s words, and the seal carries neither member', async () => {
    const store = new InMemoryStore();
    const [given, none] = [await fresh(store), await fresh(store)];
    await abandonRun(store, given, 'duplicate order');
    await abandonRun(store, none);
    const seal = (await store.get(given)).record.sealed_by as SealedBy;
    // (a) red when a run ended with no actor gains a clause or a `by`/`door` key; (b) prints them.
    expect({
      given: await sentenceOf(store, given),
      none: await sentenceOf(store, none),
      keys: Object.keys(seal).sort(),
    }).toEqual({
      given: 'It was abandoned, with the reason "duplicate order".',
      none: 'It was abandoned; no reason was given.',
      keys: ['arm'],
    });
  });

  it('check 1 — runEndingOf fills RunEnding.by with the readable program, and leaves it out otherwise', async () => {
    const store = new InMemoryStore();
    const named = await fresh(store);
    await abandonRun(store, named, 'x', { by: DERIVED, door: 'realm_run_abandon' });
    const unreadable = await seeded(
      store,
      { arm: 'abandon_requested', by: { by: '' }, door: 'abandon_run' },
      'x',
    );
    const bare = await fresh(store);
    await abandonRun(store, bare, 'x');
    const endingOf = async (id: string) => runEndingOf((await store.get(id)).record, WF);
    // (a) red when `by` is not filled, or filled with an unreadable name; (b) prints the members.
    expect({
      named: (await endingOf(named))?.by,
      unreadable: 'by' in (await endingOf(unreadable))!,
      bare: 'by' in (await endingOf(bare))!,
    }).toEqual({ named: DERIVED, unreadable: false, bare: false });
  });

  it('check 1 — how a name is known, in words, is one copy: the holder lines’ words, with the stated override', () => {
    // (a) red when the words drift from the holder lines' or the override is lost; (b) prints both.
    expect({ base: BY_SOURCE_WORDS, recorded: RECORDED_BY_SOURCE_WORDS }).toEqual({
      base: { derived: 'from the OS user', ambient: 'from REALM_OPERATOR', stated: 'as stated' },
      recorded: {
        derived: 'from the OS user',
        ambient: 'from REALM_OPERATOR',
        stated: 'named by the program that runs Realm',
      },
    });
  });
});

describe('#625 the actor unit, check 6 — realm run inspect’s Ended by line, from the seal as stored', () => {
  const seal = (extra: Partial<SealedBy>): SealedBy => ({ arm: 'abandon_requested', ...extra });
  it('check 6 — each door’s line, the library form, no line with none recorded', () => {
    // (a) red when a door's line is worded wrong, the no-door line drops its channel, or a line is
    //     printed with no program recorded; (b) prints the lines.
    expect({
      abandon: endedByLine(seal({ by: DERIVED, door: 'realm_run_abandon' })),
      tool: endedByLine(seal({ by: SERVER, door: 'abandon_run' })),
      cleanup: endedByLine({ arm: 'cleanup_sweep', by: AMBIENT, door: 'realm_run_cleanup' }),
      noDoor: endedByLine(seal({ by: SERVER })),
      stated: endedByLine(seal({ by: STATED, door: 'abandon_run' })),
      none: endedByLine(seal({})),
      doorOnly: endedByLine(seal({ door: 'realm_run_abandon' })),
      noSeal: endedByLine(undefined),
    }).toEqual({
      abandon: 'Ended by: realm run abandon, by abcd@box (from the OS user)',
      tool: "Ended by: the assistant's abandon_run tool, on the Realm server running as abcd@box (from the OS user)",
      cleanup: 'Ended by: realm run cleanup, run by tester (from REALM_OPERATOR)',
      noDoor: 'Ended by: abcd@box (from the OS user, via mcp-stdio)',
      stated:
        "Ended by: the assistant's abandon_run tool, on the Realm server running as shop-bot (named by the program that runs Realm)",
      none: undefined,
      doorOnly: undefined,
      noSeal: undefined,
    });
  });

  it('check 6 — the line shows the record as stored: a door from another arm is worded, an unknown door is none, an unreadable name is never printed', () => {
    const raw = {
      by: 'abcd\u001b[2J',
      by_source: 'derived',
      channel: 'abandon',
    } as unknown as Attributed;
    // (a) red when the line applies the sentence's per-arm rule, words a door outside SEAL_DOORS,
    //     or prints a byte of an unreadable name; (b) prints the lines.
    expect({
      guardArm: endedByLine({ arm: 'guard_abort', by: DERIVED, door: 'realm_run_abandon' }),
      unknown: endedByLine({
        arm: 'abandon_requested',
        by: DERIVED,
        door: 'realm_run_sweeper' as never,
      }),
      unreadable: endedByLine({ arm: 'abandon_requested', by: raw, door: 'realm_run_abandon' }),
    }).toEqual({
      guardArm: 'Ended by: realm run abandon, by abcd@box (from the OS user)',
      unknown: 'Ended by: abcd@box (from the OS user, via abandon)',
      unreadable: `Ended by: realm run abandon, by ${UNSHOWABLE_NAME}`,
    });
  });
});

describe('#625 the actor unit, check 9 — abandonRun’s admission refuses before any read', () => {
  async function refusal(
    actor: unknown,
  ): Promise<{ code: string; details: unknown; read: number }> {
    const store = new InMemoryStore();
    const id = await fresh(store);
    const get = vi.spyOn(store, 'get');
    try {
      await abandonRun(store, id, 'x', actor as never);
      return { code: 'none', details: undefined, read: get.mock.calls.length };
    } catch (err) {
      const e = err as WorkflowError;
      return { code: e.code, details: e.details, read: get.mock.calls.length };
    }
  }
  const optionsOf = (details: unknown): string[] =>
    ((details as { invalid?: Array<{ option: string }> }).invalid ?? []).map((p) => p.option);

  it('check 9 — door realm_run_cleanup, a door that is no door, and an extra member: VALIDATION_OPTION_INVALID naming the member, nothing read', async () => {
    const cleanupDoor = await refusal({ by: DERIVED, door: 'realm_run_cleanup' });
    const notADoor = await refusal({ by: DERIVED, door: 42 });
    const extra = await refusal({ by: DERIVED, door: 'realm_run_abandon', who: 'Ana' });
    const noBy = await refusal({ door: 'realm_run_abandon' });
    // (a) red when the admission accepts cleanup's door or another member, names the wrong member,
    //     or reads the run first; (b) prints the codes, the members named and the reads.
    expect({
      cleanupDoor: [cleanupDoor.code, optionsOf(cleanupDoor.details), cleanupDoor.read],
      notADoor: [notADoor.code, optionsOf(notADoor.details), notADoor.read],
      extra: [extra.code, optionsOf(extra.details), extra.read],
      noBy: [noBy.code, optionsOf(noBy.details), noBy.read],
    }).toEqual({
      cleanupDoor: ['VALIDATION_OPTION_INVALID', ['actor.door'], 0],
      notADoor: ['VALIDATION_OPTION_INVALID', ['actor.door'], 0],
      extra: ['VALIDATION_OPTION_INVALID', ['actor.who'], 0],
      noBy: ['VALIDATION_OPTION_INVALID', ['actor.by'], 0],
    });
  });

  it('check 9 — a `by` the driver rule rejects is refused as every driver is: VALIDATION_ACTOR_INVALID naming driver.by, nothing read', async () => {
    const blank = await refusal({ by: { by: '', by_source: 'derived', channel: 'abandon' } });
    const badClass = await refusal({
      by: { by: 'abcd@box', by_source: 'guessed', channel: 'abandon' },
    });
    // (a) red when a malformed program is written on the seal, or refused under another code or
    //     field; (b) prints the codes, the fields and the reads.
    expect({
      blank: [blank.code, (blank.details as { field?: string }).field, blank.read],
      badClass: [badClass.code, (badClass.details as { field?: string }).field, badClass.read],
    }).toEqual({
      blank: ['VALIDATION_ACTOR_INVALID', 'driver.by', 0],
      badClass: ['VALIDATION_ACTOR_INVALID', 'driver.by_source', 0],
    });
  });

  it('check 9 — a well-formed actor is written on the seal as passed; a second abandon changes nothing', async () => {
    const store = new InMemoryStore();
    const id = await fresh(store);
    await abandonRun(store, id, 'x', { by: DERIVED, door: 'realm_run_abandon' });
    await abandonRun(store, id, 'y', { by: SERVER, door: 'abandon_run' });
    const seal = (await store.get(id)).record.sealed_by;
    // (a) red when the members are not written, or a later abandon rewrites them; (b) prints the seal.
    expect(seal).toEqual({ arm: 'abandon_requested', by: DERIVED, door: 'realm_run_abandon' });
  });
});
