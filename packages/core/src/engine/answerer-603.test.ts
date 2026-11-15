// answerer-603.test.ts — #603 A3a: who may answer, in core. Acceptance checks 8 (answers through
// the other routes are not compared), 13 (the loader's `answerers` and realm.yaml's `answerers`
// refused where they cannot work), 17 (malformed channel evidence refused before any read), and the
// library call with channel evidence but no route (checked, not stored). The Slack cells live
// beside the notifier, in the CLI.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { describe, expect, it } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import { executeStep, submitHumanResponse, type SubmitGateOptions } from './execution-loop.js';
import { judgeAnswerer } from './answerer.js';
import { loadWorkflowFromString } from '../workflow/yaml-loader.js';
import { validateDeploymentManifest } from '../manifest/deployment-manifest.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { RunStore } from '../store/store-interface.js';

/** One gated step whose question names `U0ALICE` as its owner. */
const owned: WorkflowDefinition = {
  id: 'answerer-603',
  name: 'answerer-603',
  version: 1,
  steps: {
    confirm: {
      description: 'Confirm',
      execution: 'auto',
      trust: 'human_confirmed',
      depends_on: [],
      gate: { choices: ['approve', 'reject'], owner: 'U0ALICE' },
    },
  },
};

async function openQuestion(store: RunStore): Promise<{ runId: string; gateId: string }> {
  const { record } = await store.create({ workflowId: owned.id, workflowVersion: 1, params: {} });
  const opened = await executeStep(store, owned, {
    runId: record.id,
    command: 'confirm',
    input: {},
    dispatcher: async () => ({}),
  });
  if (opened.gate === undefined) throw new Error(`fixture: ${opened.status}`);
  return { runId: record.id, gateId: opened.gate.gate_id };
}

/** What the answer's entry records about how it arrived and who it let through. */
async function answerEntry(store: RunStore, runId: string) {
  const { record } = await store.get(runId);
  const entry = record.evidence.find((e) => e.kind === 'gate_response');
  return { answer: entry?.answer, admitted_by: entry?.admitted_by, open: record.pending_gate };
}

describe('#603 A3a — check 8: answers through MCP and the terminal are not compared with `owner`', () => {
  const doors: Array<[string, Partial<SubmitGateOptions>]> = [
    ['MCP', { route: 'mcp', caller: 'submit_human_response' }],
    ['the terminal', { route: 'cli', caller: 'respond', respondedBy: 'bob' }],
  ];
  it.each(doors)(
    'an answer through %s to a question owned by U0ALICE is recorded',
    async (_door, opts) => {
      const store = new InMemoryStore();
      const { runId, gateId } = await openQuestion(store);
      const reply = await submitHumanResponse(store, owned, {
        runId,
        gateId,
        choice: 'approve',
        ...opts,
      });
      // (1) red when the write compares every answer (no channel evidence judged as no match);
      // (2) prints the reply's status and what the entry records.
      expect({ status: reply.status, ...(await answerEntry(store, runId)) }).toEqual({
        status: 'ok',
        answer: { route: opts.route },
        admitted_by: 'owner_not_checked_on_route',
        open: undefined,
      });
    },
  );
});

describe('#603 A3a — a library call with channel evidence and no route: checked, not stored', () => {
  it("Bob's answer is refused; Alice's is recorded, with no account stored", async () => {
    const store = new InMemoryStore();
    const { runId, gateId } = await openQuestion(store);
    const before = (await store.get(runId)).record.version;
    const as = (user: string) =>
      submitHumanResponse(store, owned, {
        runId,
        gateId,
        choice: 'approve',
        channelEvidence: { user, forms: [user, `<@${user}>`], ts: '1.2', thread_ts: '1.1' },
      });
    const bob = await as('U0BOB');
    const afterBob = (await store.get(runId)).record.version;
    const alice = await as('U0ALICE');
    // (1) red when the check runs only with a route, or the evidence is stored without one;
    // (2) prints both replies and what the entry records.
    expect({
      bob: {
        status: bob.status,
        code: bob.error_code,
        message: bob.errors[0],
        moved: afterBob !== before,
      },
      bobFacts: bob.error?.facts,
      alice: alice.status,
      ...(await answerEntry(store, runId)),
    }).toEqual({
      bob: {
        status: 'error',
        code: 'STATE_ANSWERER_MISMATCH',
        message: `The answer was not recorded: 'U0BOB' is not one of the names that may answer gate '${gateId}' (U0ALICE). The question is still open.`,
        moved: false,
      },
      bobFacts: { allowed: ['U0ALICE'], sender: 'U0BOB' },
      alice: 'ok',
      answer: { absent: 'route_not_declared' },
      admitted_by: 'owner',
      open: undefined,
    });
  });
});

describe('#603 A3a — check 17: malformed channel evidence is refused before any read', () => {
  it.each([
    ['not an object', 'U0BOB', ['options.channelEvidence']],
    ['no user', { ts: '1.2' }, ['options.channelEvidence.user']],
  ])('channel evidence %s', async (_label, channelEvidence, invalid) => {
    let reads = 0;
    const base = new InMemoryStore();
    const store = new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === 'get') reads++;
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const refused = await submitHumanResponse(store, owned, {
      runId: 'r',
      gateId: 'g',
      choice: 'approve',
      channelEvidence: channelEvidence as never,
    }).then(
      () => undefined,
      (err: { code?: string; details?: { invalid?: unknown } }) => err,
    );
    // (1) red when the admission row is removed (the call reads the store); (2) prints the code,
    // the parts named and the reads.
    expect({
      code: refused?.code,
      invalid: (refused?.details?.invalid as Array<{ option: string }> | undefined)?.map(
        (p) => p.option,
      ),
      reads,
    }).toEqual({ code: 'VALIDATION_OPTION_INVALID', invalid, reads: 0 });
  });
});

describe('#603 A3a — check 13: the keys refused where they cannot work', () => {
  const gateWith = (answerers: string): string =>
    [
      'id: k603',
      'name: k603',
      'version: 1',
      'steps:',
      '  confirm:',
      '    description: Confirm',
      '    execution: auto',
      '    trust: human_confirmed',
      '    depends_on: []',
      '    gate:',
      '      choices: [approve, reject]',
      `      answerers: ${answerers}`,
    ].join('\n');

  it.each([
    ['a scalar', 'U1'],
    ['an empty list', '[]'],
    ['a non-string entry', '[U1, 7]'],
  ])("a gate's `answerers` as %s refuses the load, naming the key", (_label, answerers) => {
    // (1) red when the rule is removed (the list ignored); (2) prints the loader's error.
    expect(() => loadWorkflowFromString(gateWith(answerers))).toThrow(/'gate\.answerers'/);
  });

  it('a gate listing member IDs loads, and the question freezes them', async () => {
    // (1) red when a valid list is refused; (2) prints the loader's error.
    expect(() => loadWorkflowFromString(gateWith('[U1, U2]'))).not.toThrow();
  });

  const manifest = (config: Record<string, unknown>) => ({
    version: 1,
    notifiers: { slack_gate: { type: 'slack', config: { ...config, answerers: ['U9'] } } },
  });
  const W7 =
    "notifiers.slack_gate: 'answerers' needs a notifier that reads replies ('bot_token' and 'channel_id', with 'app_token' or 'signing_secret'); without one no Slack reply is read, so the list can answer nothing. Add the reply settings or remove 'answerers'.";

  it.each([
    ['bot_token and channel_id, no reply setting', { bot_token: 'xoxb-1', channel_id: 'C1' }, [W7]],
    ['bot_token and app_token, no channel_id', { bot_token: 'xoxb-1', app_token: 'xapp-1' }, [W7]],
    [
      'bot_token, channel_id and app_token',
      { bot_token: 'xoxb-1', channel_id: 'C1', app_token: 'xapp-1' },
      [],
    ],
    [
      'bot_token, channel_id and signing_secret',
      { bot_token: 'xoxb-1', channel_id: 'C1', signing_secret: 's', events_port: 3100 },
      [],
    ],
  ])("realm.yaml's `answerers` with %s", (_label, config, expected) => {
    // (1) red when W7 is removed, or its condition narrowed to the two reply settings; (2) prints
    // the manifest's errors.
    expect(validateDeploymentManifest(manifest(config))).toEqual(expected);
  });
});

describe('#603 A3a — the judge, alone (the rule the write and the door share)', () => {
  it.each([
    ['owner matches', { owner: 'U1' }, ['U1', '<@U1>'], undefined, { admitted: 'owner' }],
    ['the mention form', { owner: '<@U1>' }, ['U1', '<@U1>'], undefined, { admitted: 'owner' }],
    [
      'answerers',
      { answerers: ['U1', 'U2'] },
      ['U2', '<@U2>'],
      undefined,
      { admitted: 'answerers' },
    ],
    [
      'no match',
      { owner: 'U1', answerers: ['U2'] },
      ['U3'],
      ['U3'],
      { refused: { allowed: ['U1', 'U2'] } },
    ],
    [
      'a non-id owner names someone',
      { owner: '@ana' },
      ['U9'],
      ['U9'],
      { refused: { allowed: ['@ana'] } },
    ],
    ['the project list', {}, ['U9'], ['U9'], { admitted: 'project_answerers' }],
    ['the project list refuses', {}, ['U8'], ['U9'], { refused: { allowed: ['U9'] } }],
    ['nothing named', {}, ['U8'], undefined, { admitted: 'no_named_answerer' }],
    ['answerers not a list', { answerers: 'U1' }, ['U1'], undefined, { refused: { allowed: [] } }],
    [
      'an empty list names no one',
      { answerers: [] },
      ['U8'],
      undefined,
      { admitted: 'no_named_answerer' },
    ],
    [
      'no evidence, someone named',
      { owner: 'U1' },
      undefined,
      undefined,
      { admitted: 'owner_not_checked_on_route' },
    ],
    ['no evidence, nothing named', {}, undefined, ['U9'], { admitted: 'no_named_answerer' }],
  ] as const)('%s', (_label, question, forms, project, verdict) => {
    // (1) red when any arm of the rule changes; (2) prints the verdict.
    expect(judgeAnswerer(question, forms, project)).toEqual(verdict);
  });
});
