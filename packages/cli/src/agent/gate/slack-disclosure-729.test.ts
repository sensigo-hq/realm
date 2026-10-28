// #729 PR-3 (03 L-3; 04 "Slack"; RECORD 05 "Slack"): Slack is a broadcast surface. Every value is
// fake. Each assertion names (a) the change that turns it red and (b) what it prints: booleans and
// fake text.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { buildDisclosureSet, discloseGate, type PendingGate } from '@sensigo/realm';
import {
  postGateNotificationToSlack,
  postGateViaApi,
  postSlackReply,
} from './slack-gate-notifier.js';
import { addDeclaredValues, installWriter, writerTestSeams } from '../../output/writer.js';
import { slackResponse } from '../test-support/slack-response.js';

const ENV_NAME = 'SLACK_FAKE_ENV_729';
const ENV_VALUE = 'FAKE-SLACK-ENV-0729';
const MARKS = /[\uE000-\uE002]/;

beforeEach(() => {
  vi.stubEnv('REALM_NOT_SECRET', '');
  vi.stubEnv(ENV_NAME, ENV_VALUE);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function capture() {
  const bodies: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return slackResponse({ json: { ok: true, ts: '1.0' } });
    }),
  );
  return bodies;
}

const gate = (message: string): PendingGate => ({
  gate_id: 'g1',
  step_name: 'review',
  preview: { headline: 'H' },
  choices: ['approve', 'reject'],
  opened_at: '2026-10-17T00:00:00.000Z',
  resolved_message: message,
});

describe('#729 PR-3 — Slack', () => {
  it("the posted question is discloseGate's question (the declared tier), on both send paths", async () => {
    const bodies = capture();
    const g = gate(`Ship ${ENV_VALUE}?`);
    await postGateNotificationToSlack('https://hooks.slack.test/x', g, 'r1');
    await postGateViaApi('xoxb-fake', 'C1', g, 'r1', true);
    const set = buildDisclosureSet({
      env: process.env,
      declared: {},
      declaredState: 'unknown',
      declaredCause: 'embedder_none',
      audience: 'broadcast',
    }).set;
    const question = discloseGate(g, set, 'broadcast').resolved_message!;
    // (a) red when the post composes from the raw gate, or gives the question every tier (the
    //     environment value would be masked there); (b) prints booleans.
    expect({
      sameQuestion: bodies.map((b) => b.includes(JSON.stringify(question).slice(1, -1))),
      envWhole: bodies.map((b) => b.includes(ENV_VALUE)),
    }).toEqual({ sameQuestion: [true, true], envWhole: [true, true] });
  });

  it('a thread reply is walked with every tier', async () => {
    const bodies = capture();
    await postSlackReply('xoxb-fake', 'C1', '1.0', `answered with ${ENV_VALUE}`);
    // (a) red when replies are posted raw; (b) prints the posted text (fake).
    expect((JSON.parse(bodies[0]!) as { text: string }).text).toBe('answered with [REDACTED]');
  });

  it('F26: a mark planted inside a value is removed before the law reads the body', async () => {
    const bodies = capture();
    installWriter('broadcast');
    addDeclaredValues({ SECRET: 'FAKE-SLACK-DECL-0729' });
    try {
      await postSlackReply(
        'xoxb-fake',
        'C1',
        '1.0',
        `answered with ${ENV_VALUE.slice(0, 5)}\uE001${ENV_VALUE.slice(5)}`,
      );
      await postGateViaApi('xoxb-fake', 'C1', gate('Ship FAKE-SLACK\uE000-DECL-0729?'), 'r1', true);
    } finally {
      writerTestSeams.reset();
    }
    // (a) red when the reply's or the gate's marks are removed after masking (the mark parts the
    //     value, so the law misses it); (b) prints booleans.
    expect({
      replyLeaks: bodies[0]?.includes(ENV_VALUE),
      questionLeaks: bodies[1]?.includes('FAKE-SLACK-DECL-0729'),
      questionHidden: bodies[1]?.includes('Ship [REDACTED]?'),
    }).toEqual({ replyLeaks: false, questionLeaks: false, questionHidden: true });
  });

  it('no body holds a span mark', async () => {
    const bodies = capture();
    const marked = gate('Ship it?\uE000cAAAAAAAAAAAAAAAAAAAAAA\uE001now\uE002');
    await postGateNotificationToSlack('https://hooks.slack.test/x', marked, 'r1');
    await postGateViaApi('xoxb-fake', 'C1', marked, 'r1', true);
    await postSlackReply('xoxb-fake', 'C1', '1.0', 'reply \uE000\uE001\uE002');
    // (a) red when the one send function stops stripping U+E000–E002; (b) prints booleans.
    expect(bodies.map((b) => MARKS.test(b))).toEqual([false, false, false]);
  });
});

// F2 (B2): Slack's own set (no writer installed) passes the working directory.
describe('F2 — the working directory (B2, slack-gate-notifier slackSet)', () => {
  const F2_CWD = '/srv/fake-f2-project-01';
  it('a thread reply shows a path under the working directory whole', async () => {
    const bodies = capture();
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(F2_CWD);
    try {
      vi.stubEnv('INIT_CWD', F2_CWD);
      vi.stubEnv('npm_config_local_prefix', F2_CWD);
      await postSlackReply('xoxb-fake', 'C1', '1.0', `ended; the record is under ${F2_CWD}/runs`);
      // (a) red when slackSet builds its set without `cwd`; (b) prints the posted fake text.
      expect((JSON.parse(bodies[0]!) as { text: string }).text).toBe(
        `ended; the record is under ${F2_CWD}/runs`,
      );
    } finally {
      cwdSpy.mockRestore();
    }
  });
});
