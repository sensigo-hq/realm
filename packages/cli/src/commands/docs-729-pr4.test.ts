// docs-729-pr4.test.ts — #729 PR-4 (04 "Docs cells"; guardrail 7(f), 9): each docs sentence the asked
// person adds or changes is quoted here exactly, asserted to still be on its page (read from the
// repository), and executed: the case it states is driven through the code and its result asserted.
// Neither the page nor the behaviour can change alone. The sentences about `realm agent`'s and
// `realm workflow run`'s gate print are claimed in `asked-person-729.test.ts`'s cells, which drive
// those commands; the MCP pages' in `mcp-server/src/asked-person-729.test.ts`. Every value is a fake.
// Each assertion names (a) the change that turns it red and (b) what it prints when it fails.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  CUT_SENTENCE,
  JsonFileStore,
  VIEW_BUDGET,
  buildDisclosureSet,
  composePersonNotice,
  composeQuestionView,
  discloseGate,
  durationWords,
  endsWithCutSentence,
  executeStep,
  respondWayOfGate,
  stripSpanMarks,
  type DisclosureSet,
  type PendingGate,
  type PersonNotice,
  type WorkflowDefinition,
} from '@sensigo/realm';
import {
  renderSlack,
  slackEscape,
  slackFailureLine,
  slackOwner,
  slackView,
} from '../agent/gate/slack-gate-notifier.js';
import { SLACK_CALL_DEADLINE_MS } from '../agent/gate/slack-call.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');
const flat = (t: string): string => t.replace(/\s+/g, ' ');
const read = (page: string): string => readFileSync(join(ROOT, page), 'utf8');
/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(page: string, sentence: string): void {
  expect(flat(read(page)), `${page} no longer says: ${sentence}`).toContain(flat(sentence));
}
/** #871's form: the section that holds this unit's entries — `[Unreleased]` until a release renames
 *  it, then the first release section after `[0.48.0]`'s, never a fixed heading. */
function changelogSection(): string {
  const text = read('CHANGELOG.md');
  const start = text.includes('## [Unreleased]')
    ? text.indexOf('## [Unreleased]')
    : text.indexOf('\n## [') + 1;
  const end = text.indexOf('\n## [0.48.0]');
  return text.slice(start, end);
}
function claimChangelog(sentence: string): void {
  expect(flat(changelogSection()), `the CHANGELOG no longer says: ${sentence}`).toContain(
    flat(sentence),
  );
}

const SLACK = 'docs/guides/slack-gates.md';
const GATES = 'docs/reference/workflow/gates.md';
const GUIDE = 'docs/guides/human-gates.md';
const FAKE = 'FAKE-DECLARED-DOCS-0729';

const gate = (over: Partial<PendingGate> = {}): PendingGate => ({
  gate_id: 'g1',
  step_name: 'review',
  preview: {},
  choices: ['send', 'discard'],
  opened_at: '2026-10-27T10:00:00.000Z',
  resolved_message: 'Realm docs test.',
  ...over,
});
const notice = (event: Parameters<typeof composePersonNotice>[0]): string =>
  renderSlack(composePersonNotice(event), { mode: 'bot' }).text;
const base = (g: PendingGate) => ({
  run_id: 'r1',
  gate: g,
  view: slackView(g),
  respond: respondWayOfGate('r1', g),
});
const setOf = (declared: Record<string, string>): DisclosureSet =>
  buildDisclosureSet({ env: {}, declared, declaredState: 'resolved', audience: 'private' }).set;

/** A gate opened by the engine with `message` over the run's `x`, through the host's set. */
async function opened(
  message: string,
  x: string,
  set: DisclosureSet | undefined,
  display?: string,
  more: Record<string, unknown> = {},
): Promise<PendingGate> {
  const def = {
    id: 'docs729',
    name: 'docs729',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: {
      review: {
        description: 'd',
        execution: 'auto',
        trust: 'human_confirmed',
        ...(display !== undefined ? { display } : {}),
        gate: { choices: ['send', 'discard'], message },
      },
    },
  } as unknown as WorkflowDefinition;
  const store = new JsonFileStore(mkdtempSync(join(tmpdir(), 'realm-docs-729-')));
  const { run } = await store.create({
    workflowId: 'docs729',
    workflowVersion: 1,
    params: { x, ...more },
  });
  await executeStep(store, def, {
    runId: run.id,
    command: 'review',
    input: {},
    dispatcher: async () => ({ summary: 'the output' }),
    ...(set !== undefined ? { disclosure: set } : {}),
  });
  return (await store.get(run.id)).pending_gate!;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe(`${SLACK} — the post, the thread, the transport`, () => {
  it('the terminal shows the step’s output under the question; with none, `(no output)`', () => {
    claim(
      SLACK,
      "Under the question, the terminal shows the step's output; `review` has none, so it says `(no output)`.",
    );
    const view = composeQuestionView(discloseGate(gate(), setOf({}), 'private'));
    // (a) red when the composer's empty-output words change; (b) prints the preview.
    expect(view.preview_text).toBe('(no output)');
  });

  it('the post has four parts; a bot answers in the thread, a webhook with one `realm run respond`', () => {
    claim(
      SLACK,
      "It has four parts: the gate's name (and its `owner`, when set); your gate message, with the step's output below it; how to answer; and, when the message was cut to fit, the command that shows the step's whole output. With a bot token, how to answer is `Reply in this thread with` and the choices. With only `webhook_url`, it is one `realm run respond` command.",
    );
    const cut = gate({ owner: '@ana', resolved_message: `Q\n\n${CUT_SENTENCE(1, 900)}` });
    const opening = (g: PendingGate, mode: 'bot' | 'webhook') =>
      renderSlack(composePersonNotice({ kind: 'question_opened', ...base(g) }), { mode });
    const bot = opening(cut, 'bot');
    const hook = opening(gate(), 'webhook');
    const texts = (blocks: unknown[]) =>
      (blocks as Array<{ text?: { text: string }; elements?: Array<{ text: string }> }>).map(
        (b) => b.text?.text ?? b.elements?.[0]?.text ?? '',
      );
    // (a) red when a part is dropped, the owner is not in the header, the bot's route changes or
    //     the webhook renders one command per choice; (b) prints the parts and counts.
    expect({
      heading: bot.text,
      parts: bot.blocks.length,
      owner: texts(bot.blocks)[0],
      botRoute: texts(bot.blocks)[2]!.startsWith('Reply in this thread with `send` or `discard`'),
      cutWay: texts(bot.blocks)[3]!.startsWith("The step's whole output: realm run inspect"),
      webhookCommands: (texts(hook.blocks)[2]!.match(/realm run respond/g) ?? []).length,
    }).toEqual({
      heading: '⏸ Workflow gate waiting for approval',
      parts: 4,
      owner: '*Gate:* `review`\n*Owner:* @ana',
      botRoute: true,
      cutWay: true,
      webhookCommands: 1,
    });
  });

  it('text is shown as written; an owner written as a Slack mention still pings', () => {
    claim(
      SLACK,
      'Text from the workflow and the agent is shown as written: `<`, `>` and `&` do not become Slack markup. An `owner` written as a Slack mention still pings: a person (`<@U024BE7LH>`, or `<@W…>` on Enterprise Grid), a user group (`<!subteam^SAZ94GDB8>`), or `<!here>`, `<!channel>` and `<!everyone>`. Any other `owner`, such as `@ana`, is shown as written.',
    );
    const owners = [
      '<@U024BE7LH>',
      '<@W012AB3CD>',
      '<!subteam^SAZ94GDB8>',
      '<!here>',
      '<!channel>',
      '<!everyone>',
      '@ana',
    ];
    // (a) red when `<`, `>` or `&` pass through, or a mention form is escaped; (b) prints the texts.
    expect({ escaped: slackEscape('a < b > c & d'), owners: owners.map(slackOwner) }).toEqual({
      escaped: 'a &lt; b &gt; c &amp; d',
      owners,
    });
  });

  it('the answer: recorded with the resolution message below; an answer that ends the run says so', () => {
    claim(
      SLACK,
      'Realm replies in the thread that the choice is recorded, with the line you set in `resolution_messages` below it:',
    );
    claim(
      SLACK,
      "When the answer ends the run, the reply says ``✅ Gate resolved: `send`. The run has ended.`` instead, and the run's ending is printed where `realm agent` runs.",
    );
    const g = gate({ resolution_messages: { send: 'Recorded: send.' } });
    const recorded = (ended: boolean) =>
      notice({ kind: 'answer_recorded', run_id: 'r1', gate: g, choice: 'send', ended });
    // (a) red when the reply's words change, or the resolution message rides an ended run; (b)
    //     prints the two replies. (The ending's lines on the console: slack-gate-ending-625.test.ts.)
    expect([recorded(false), recorded(true)]).toEqual([
      '✅ Gate resolved: `send`\nRecorded: send.',
      '✅ Gate resolved: `send`. The run has ended.',
    ]);
    expect(read(SLACK)).toContain('✅ Gate resolved: `send`\nRecorded: send.');
  });

  it('the reminders, the escalation, the expiry reminder and the closed lines, in their words; durations in `formatDuration`’s forms', () => {
    claim(
      SLACK,
      "A reminder reads ``⏰ gate `review` has been open for 12m. Please respond.``; the escalation is the same line with the gate's `owner` first. When the gate has a time limit, the last reminder says the question expired and what happens next, such as ``⏰ gate `review` expired 42s ago — its default choice will be recorded.`` Durations read like `1h 5m`, `12m` or `42s`. When the question closes without an answer in the thread, Realm says so there: `This question is closed: its time ran out.`, `This question is closed: the run stopped.` or ``This question is closed: it was answered elsewhere as `send`.``",
    );
    const now = new Date('2026-10-27T10:12:00.000Z');
    const g = gate({ owner: '@ana' });
    const reminder = (escalation: boolean) =>
      notice({
        kind: 'reminder',
        ...base(g),
        scheduled_at: now.toISOString(),
        count: 1,
        escalation,
        now,
      });
    const expiry = notice({
      kind: 'expiry_reminder',
      ...base(gate({ expires_at: '2026-10-27T10:11:18.000Z', on_expiry: 'settle_default' })),
      now,
    });
    const closed = (
      outcome: Parameters<typeof composePersonNotice>[0] extends infer E
        ? E extends { kind: 'question_closed'; outcome: infer O }
          ? O
          : never
        : never,
    ) => notice({ kind: 'question_closed', run_id: 'r1', gate: g, outcome });
    // (a) red when a line's words change or a duration is formatted another way; (b) prints the
    //     lines and the forms.
    expect({
      lines: [
        reminder(false),
        reminder(true),
        expiry,
        closed({ step: 'review', attempted: false, by: { kind: 'timeout' } } as never),
        closed(undefined),
        closed({
          step: 'review',
          attempted: false,
          by: { kind: 'answer', basis: 'stated' },
          choice: 'send',
        } as never),
      ],
      forms: [
        durationWords('2026-10-27T09:07:00.000Z', 'past_event', now),
        durationWords('2026-10-27T10:00:00.000Z', 'past_event', now),
        durationWords('2026-10-27T10:11:18.000Z', 'past_event', now),
      ],
    }).toEqual({
      lines: [
        '⏰ gate `review` has been open for 12m. Please respond.',
        '@ana — ⏰ gate `review` has been open for 12m. Please respond.',
        '⏰ gate `review` expired 42s ago — its default choice will be recorded.',
        'This question is closed: its time ran out.',
        'This question is closed: the run stopped.',
        'This question is closed: it was answered elsewhere as `send`.',
      ],
      forms: ['1h 5m', '12m', '42s'],
    });
  });

  it('no thread message names a command; the drain command is the console’s', () => {
    claim(
      SLACK,
      "No message in the thread names a command. The command that carries out an expired question's `on_expiry`, `realm run drain --expired`, is printed where `realm agent` runs.",
    );
    const g = gate({ expires_at: '2026-10-27T10:00:01.000Z', on_expiry: 'settle_default' });
    const now = new Date('2026-10-27T10:30:00.000Z');
    const events: Array<Parameters<typeof composePersonNotice>[0]> = [
      {
        kind: 'reminder',
        ...base(g),
        scheduled_at: now.toISOString(),
        count: 1,
        escalation: true,
        now,
      },
      { kind: 'expiry_reminder', ...base(g), now },
      { kind: 'answer_recorded', run_id: 'r1', gate: g, choice: 'send', ended: true },
      { kind: 'answer_refused', run_id: 'r1', gate: g, choice: 'send', code: 'STATE_RUN_TERMINAL' },
      {
        kind: 'answer_late',
        run_id: 'r1',
        gate: g,
        choice: 'send',
        outcome: {
          step: 'review',
          attempted: true,
          by: { kind: 'timeout' },
          choice: 'discard',
        } as never,
        ended: false,
      },
      { kind: 'question_closed', run_id: 'r1', gate: g, outcome: undefined },
    ];
    const lines = events.map(notice);
    // (a) red when a thread arm names a command (G9); (b) prints the lines. (The console's drain
    //     line: gate-notify-clock.test.ts's final-occurrence cells.)
    expect(lines.filter((l) => /realm /.test(l))).toEqual([]);
  });

  it('the command line still works, and the post no longer carries one command per choice', () => {
    claim(
      SLACK,
      'Every Slack gate can also be answered with `realm run respond`. `realm agent` notices the answer and carries on, whichever way it arrived.',
    );
    // (a) red when the old sentence returns; (b) prints a boolean.
    expect(read(SLACK).includes('The Slack message includes the command for each choice.')).toBe(
      false,
    );
  });

  it('the transport’s lines: the deadline and the refusal name their cause; a rate limit is retried once; a thread post outliving the drain is said', () => {
    claim(
      SLACK,
      "**`⚠  Slack did not answer within 30 s`** or **`⚠  Slack refused the post: invalid_blocks`.** Realm waits up to 30 seconds for each call to Slack and reads Slack's answer; after the colon is Slack's reason. When the gate's message could not be posted, Realm prints the commands to answer on the terminal, one `realm run respond` per choice, and the gate waits for one of them. No reminders are posted, since there is no thread.",
    );
    claim(
      SLACK,
      '**`⚠  Slack asked to wait 2 s before the post; retrying once`.** Slack limited the rate of posts. When the wait it asks for is 30 seconds or less, Realm waits and tries once more; otherwise the post is refused with `ratelimited`.',
    );
    claim(
      SLACK,
      '**`⚠  Slack thread post not delivered within 2 s; the question is closed`.** A reply in the thread did not reach Slack within 2 seconds of the question closing, so Realm went on without it.',
    );
    // (a) red when the deadline or a cause's words change; (b) prints the lines and the constant.
    // (Each line is driven end to end in slack-gate-notifier.test.ts's transport cells.)
    expect({
      deadline: SLACK_CALL_DEADLINE_MS,
      timeout: slackFailureLine({ ok: false, cause: 'timeout' }),
      refused: slackFailureLine({ ok: false, cause: 'refused', reason: 'invalid_blocks' }),
      ratelimited: slackFailureLine({ ok: false, cause: 'refused', reason: 'ratelimited' }),
    }).toEqual({
      deadline: 30_000,
      timeout: 'Slack did not answer within 30 s',
      refused: 'Slack refused the post: invalid_blocks',
      ratelimited: 'Slack refused the post: ratelimited',
    });
  });
});

describe(`${GATES}, ${GUIDE} — the question is minted once, masked, and cut to the budget`, () => {
  it('the message is stored as shown: a declared value masked first; past 600 characters, cut with a sentence that names what is shown', async () => {
    claim(
      GATES,
      "The message is rendered once, when the gate opens, and stored as it is shown. A value the project declares secret is replaced by `[REDACTED]` first. Then, when the message and the step's output together are longer than the view budget of 600 characters, they are cut. When the message alone is longer, its long values are cut first, sharing the room so that short values stay whole, unless a declared value appears anywhere in the message: then the message is cut only as a whole, so no part of that value is left. After that the step's output is cut, then the message itself. The message then ends with a sentence that says what is shown: `[Cut when this question opened: the first N of M characters are shown. Your answer is checked against what is shown here only, but approving lets the step's whole output go ahead.]`",
    );
    claim(
      GUIDE,
      "The message is rendered once, when the gate opens. Every surface shows it with the step's output below it, through the step's `display` when it has one. When the two together pass 600 characters, they are cut to fit, and a sentence at the end of the message says so; approving still lets the step's whole output go ahead.",
    );
    const set = setOf({ X: FAKE });
    const masked = await opened('Send {{ run.params.x }}?', FAKE, set);
    const long = await opened('Send {{ run.params.x }} now', 'y'.repeat(2000), set);
    const sentence =
      /\[Cut when this question opened: the first \d+ of \d+ characters are shown\. Your answer is checked against what is shown here only, but approving lets the step's whole output go ahead\.\]$/;
    // (a) red when the value is stored raw, the cut or its sentence is lost, or the budget changes;
    //     (b) prints the stored texts' shape.
    expect({
      masked: masked.resolved_message,
      budget: VIEW_BUDGET,
      cut: sentence.test(long.resolved_message!) && endsWithCutSentence(long.resolved_message!),
      within: long.resolved_message!.length <= VIEW_BUDGET,
      mintMarker: long.resolved_message!.includes('…[cut at mint: '),
    }).toEqual({
      masked: 'Send [REDACTED]?',
      budget: 600,
      cut: true,
      within: true,
      mintMarker: true,
    });
  });

  it('a declared value anywhere in the message: the values are not cut one by one, so no part of it is left', async () => {
    const set = setOf({ X: FAKE });
    // The value straddles the first substitution's tail and the fixed text; the second
    // substitution makes the message overflow, so the per-value cuts would run without the check.
    const stored = (
      await opened(
        `{{ run.params.x }}${FAKE.slice(-6)} and more {{ run.params.y }}`,
        '.'.repeat(390) + FAKE.slice(0, -6),
        set,
        undefined,
        { y: 'z'.repeat(300) },
      )
    ).resolved_message!;
    // (a) red when the per-value cut runs anyway (the fixed tail of the value stands in clear); (b)
    //     prints booleans.
    expect({
      redacted: stored.includes('[REDACTED]'),
      part: stored.includes(FAKE.slice(-6)) || stored.includes(FAKE.slice(0, 8)),
      mintMarker: stored.includes('…[cut at mint: '),
    }).toEqual({ redacted: true, part: false, mintMarker: false });
  });
});

describe('the `display` pages — the preview on every surface that shows one', () => {
  it('step-fields, input-map-and-templates and agent-steps: `display` shapes the gate’s preview, with a message too', async () => {
    claim(
      'docs/reference/workflow/step-fields.md',
      "How the step's output is shown: `realm agent`'s result line, and the gate's preview on every surface that shows one.",
    );
    claim(
      'docs/reference/workflow/input-map-and-templates.md',
      "| `display`      | `realm agent` prints the step's result, and a surface shows the step's gate. | Fields of the step's own output | No      | Nothing is printed in its place.             | Nothing is printed in its place.   |",
    );
    claim(
      'docs/guides/agent-steps.md',
      "When the step opens a gate, every surface that shows the gate's preview shows it through `display` too: the terminal, `realm workflow run`, Slack and the MCP replies.",
    );
    const g = await opened('Ship it?', 'v', setOf({}), 'Summary: {{ summary }}');
    const display = 'Summary: {{ summary }}';
    // (a) red when a composer ignores `display` while a message exists (the chain's JSON shows);
    //     (b) prints the previews. (The terminal and `realm workflow run`: asked-person-729.test.ts.)
    expect({
      read: composeQuestionView(discloseGate(stripSpanMarks(g), setOf({}), 'private'), display)
        .preview_text,
      slack: slackView(g, display).preview_text,
      question: g.resolved_message,
    }).toEqual({
      read: 'Summary: the output',
      slack: 'Summary: ‹string, 10 characters›',
      question: 'Ship it?',
    });
  });
});

describe('docs/reference/core-library.md — the engine’s `disclosure` input', () => {
  it('with a set, the question is stored masked and cut; without one, stored as rendered and never cut', async () => {
    claim(
      'docs/reference/core-library.md',
      'The values your program hides, as a set from `buildDisclosureSet`. A gate this call opens stores its question masked with it, and cut to the view budget of 600 characters when the set knows every declared value; without it the question is stored as rendered and never cut. `advanceRun` and `executeEngineStep` take it too.',
    );
    const withSet = await opened(
      'Key {{ run.params.x }} {{ run.params.x }}',
      FAKE + 'z'.repeat(400),
      setOf({ X: FAKE }),
    );
    const without = await opened(
      'Key {{ run.params.x }} {{ run.params.x }}',
      FAKE + 'z'.repeat(400),
      undefined,
    );
    // (a) red when the set is dropped (raw stored) or a cut runs without one; (b) prints booleans.
    expect({
      withSetMasked: !withSet.resolved_message!.includes(FAKE),
      withSetCut: endsWithCutSentence(withSet.resolved_message!),
      withoutWhole:
        without.resolved_message === `Key ${FAKE}${'z'.repeat(400)} ${FAKE}${'z'.repeat(400)}`,
    }).toEqual({ withSetMasked: true, withSetCut: true, withoutWhole: true });
  });
});

describe('CHANGELOG.md — this unit’s entries (#871’s form: the section that holds them)', () => {
  it('each line, and the behaviour it states', async () => {
    for (const sentence of [
      "**One composer for a gate's question, on every surface (issue #729 PR-4).**",
      'Closes #722.',
      "**The asked person's notices (issue #729 PR-4).**",
      'Text from the workflow and the agent is shown as written in Slack (`<`, `>` and `&` are escaped); an `owner` written as a Slack mention still pings.',
      '**`WorkflowCopyFault` is exported from `@sensigo/realm`.**',
      "**BREAKING — a gate's question is cut to the view budget when it opens (issue #729 PR-4).** A gate's question longer than the view budget is cut when it opens, with a line saying so; the step's whole output still goes ahead on approval.",
      '**BREAKING — a gate with no `message` shows no question (issue #729 PR-4).**',
      '**BREAKING — Slack threads name no operator command (issue #729 PR-4).**',
      '**The Slack reminder and expiry durations read `1h 5m`, `12m` or `42s` (issue #729 PR-4)**',
      '`advanceRun` and `executeEngineStep` (issue #729 PR-4).**',
      "**A Slack post that is refused or does not answer within 30 s is reported, and the person's terminal way is printed (issue #729 PR-4).**",
    ]) {
      claimChangelog(sentence);
    }
    const index = readFileSync(join(ROOT, 'packages/core/src/index.ts'), 'utf8');
    const { resolved_message: _none, ...noMessage } = gate();
    const long = await opened('{{ run.params.x }}', 'q'.repeat(1000), setOf({}));
    // (a) red when an entry's behaviour is gone: the cut, the export, the composer's (f), the
    //     durations, the transport's line; (b) prints booleans and texts.
    expect({
      cut: endsWithCutSentence(long.resolved_message!),
      export: /\bWorkflowCopyFault,/.test(index),
      noMessage: composeQuestionView(discloseGate(noMessage, setOf({}), 'private')).question_text,
      durations: durationWords(
        '2026-10-27T10:00:00.000Z',
        'past_event',
        new Date('2026-10-27T11:05:00.000Z'),
      ),
      transport: slackFailureLine({ ok: false, cause: 'timeout' }),
    }).toEqual({
      cut: true,
      export: true,
      noMessage: '',
      durations: '1h 5m',
      transport: 'Slack did not answer within 30 s',
    });
  });
});

describe('packages/core/src/utils/duration.ts — the doc comment no longer lists the Slack reminder', () => {
  it('a grep cell', () => {
    const source = readFileSync(join(ROOT, 'packages/core/src/utils/duration.ts'), 'utf8');
    // (a) red when the comment lists the Slack reminder's minutes as not yet moved; (b) prints the
    //     booleans.
    expect({
      stale: source.includes("the Slack reminder's minutes"),
      moved: source.includes("the Slack reminder's and expiry reminder's spans"),
    }).toEqual({ stale: false, moved: true });
  });
});

// The notice type is used only through the arms above.
export type { PersonNotice };
