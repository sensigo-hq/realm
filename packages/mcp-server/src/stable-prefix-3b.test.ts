// stable-prefix-3b.test.ts — caching 3-B, Part B (B4): the MCP door's `stable_prefix` on a `run_step`
// entry. Computed inside `toolContentOf`, before the walk, from the brief's internal boundary: cut
// the prompt with the walk's own set at the agent's tier and publish `{ chars, unit, sha256 }` of the
// disclosed head only when the agent receives exactly `disclose`'s text. Each cell names (a) the change
// that turns it red and (b) what it prints: lengths, booleans and fake prompts, never a set.
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  JsonFileStore,
  JsonWorkflowStore,
  buildDisclosureSet,
  loadWorkflowFromString,
  type DisclosureSet,
} from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRealmMcpServer } from './server.js';
import { BRIEF_STABLE_CHARS, MCP_ENVELOPE_TABLE, toolContentOf } from './render-reply.js';

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const setOf = (declared: Record<string, string>, cause?: 'load_failed'): DisclosureSet =>
  buildDisclosureSet({
    env: {},
    declared,
    declaredState: cause === undefined ? 'resolved' : 'unknown',
    ...(cause !== undefined ? { declaredCause: cause } : {}),
    audience: 'agent',
  }).set;

interface Entry {
  prompt?: string;
  stable_prefix?: { chars: number; unit: string; sha256: string };
}

/** The agent's view of an envelope with one `run_step` entry: the reply text and its first entry. */
function sent(prompt: string, chars: number, set: DisclosureSet): { text: string; entry: Entry } {
  const reply = {
    status: 'ok',
    run_id: 'r1',
    next_actions: [
      {
        instruction: { tool: 'execute_step', params: { run_id: 'r1', command: 's' } },
        human_readable: "Execute step 's': S.",
        orientation: "Run is active. Next step ready: 's'.",
        prompt,
        [BRIEF_STABLE_CHARS]: chars,
      },
    ],
  };
  const text = toolContentOf(reply as never, { set, audience: 'agent', table: MCP_ENVELOPE_TABLE })
    .content[0]!.text;
  return { text, entry: (JSON.parse(text) as { next_actions: Entry[] }).next_actions[0]! };
}

/** What a client does: cut the RECEIVED prompt at `chars` and compare its hash. */
const clientAgrees = (entry: Entry): boolean =>
  entry.stable_prefix !== undefined &&
  entry.prompt !== undefined &&
  sha256(entry.prompt.slice(0, entry.stable_prefix.chars)) === entry.stable_prefix.sha256;

const BS = '\\';
// #901's D2-4: a declared value with two backslashes, in the prompt decoded twice.
const D24_DECLARED = `pa${BS}${BS}nss-word1`;
const D24_TWICE = JSON.parse(`"${JSON.parse(`"${D24_DECLARED}"`) as string}"`) as string;
// #901's D2-6: four backslashes, decoded three times (disclose shows it; the walk hides it).
const D26_DECLARED = `pa${BS}${BS}${BS}${BS}nss-word1`;
const D26_THRICE = JSON.parse(
  `"${JSON.parse(`"${JSON.parse(`"${D26_DECLARED}"`) as string}"`) as string}"`,
) as string;

describe('caching 3-B B4 — the door publishes stable_prefix only for text the agent receives', () => {
  it("(a) #901's D2-4 input: present, and a client's hash of the received head matches", () => {
    const prompt = `Fixed rules. before ${D24_TWICE} after`;
    // The brief's cut falls inside the hidden value: it moves back to the value's start.
    const { entry } = sent(
      prompt,
      'Fixed rules. before '.length + 3,
      setOf({ FAKE_SECRET: D24_DECLARED }),
    );
    // (a) red when the field is withheld here, or computed from another text than the one sent;
    //     (b) prints the field and whether the client's hash agrees.
    expect({ stable: entry.stable_prefix, agrees: clientAgrees(entry) }).toEqual({
      stable: {
        chars: 'Fixed rules. before '.length,
        unit: 'utf16',
        sha256: sha256('Fixed rules. before '),
      },
      agrees: true,
    });
  });

  it("(b) #901's D2-6 input (verified at the base: disclose 24, the walk 10): absent", () => {
    const prompt = `before ${D26_THRICE} after`;
    const { entry } = sent(prompt, 3, setOf({ FAKE_SECRET: D26_DECLARED }));
    // (a) red when the guard (`discloseLeaf(prompt) === head + tail`) is removed: the field would
    //     describe a head the agent never received; (b) prints the received length and the field.
    expect({ received: entry.prompt?.length, stable: entry.stable_prefix }).toEqual({
      received: 10,
      stable: undefined,
    });
  });

  it('(c) a set that withholds values (a manifest that failed to load): absent', () => {
    const { entry } = sent(
      'Fixed rules. Then {{ run.params.x }}',
      13,
      setOf({ A: 'FAKE-VAL-01' }, 'load_failed'),
    );
    // (a) red when the withholding check is removed; (b) prints the field.
    expect(entry.stable_prefix).toBeUndefined();
  });

  it('(d) `token=` in the tail: present, the head unchanged, and the hash matches', () => {
    const head = 'Fixed instructions here.\n';
    const { entry } = sent(`${head}Use token=FAKE-T-1 now`, head.length, setOf({}));
    // (a) red when a hidden value in the tail moves or withholds the head; (b) prints them.
    expect({
      stable: entry.stable_prefix,
      agrees: clientAgrees(entry),
      tailHidden: entry.prompt === `${head}Use token=[REDACTED] now`,
    }).toEqual({
      stable: { chars: head.length, unit: 'utf16', sha256: sha256(head) },
      agrees: true,
      tailHidden: true,
    });
  });

  it("(e) MA 1's cell, for declared values absent from the head: the same template with different values gives the same field", () => {
    const head = 'Review the ticket below.\nTicket: ';
    const one = sent(
      `${head}FAKE-VALUE-ONE-1`,
      head.length,
      setOf({ T: 'FAKE-VALUE-ONE-1' }),
    ).entry;
    const two = sent(
      `${head}FAKE-VALUE-TWO-22`,
      head.length,
      setOf({ T: 'FAKE-VALUE-TWO-22' }),
    ).entry;
    // (a) red when the field depends on a value outside the head; (b) prints both fields.
    expect({
      one: one.stable_prefix,
      same: JSON.stringify(one.stable_prefix) === JSON.stringify(two.stable_prefix),
    }).toEqual({
      one: { chars: head.length, unit: 'utf16', sha256: sha256(head) },
      same: true,
    });
  });
});

const FLOW = loadWorkflowFromString(
  [
    'id: caching-3b-door',
    'name: caching-3b-door',
    'version: 1',
    'steps:',
    '  classify:',
    '    description: Classify.',
    '    execution: agent',
    '    prompt: "Classify the ticket below into one queue. Send it with Bearer FAKE.TOKEN-1A2B3C4D\\nTicket: {{ run.params.ticket }}"',
  ].join('\n') + '\n',
);
// The fixed text holds a fake credential the law hides, so the head the agent receives is shorter
// than the raw head: a field computed after the walk (the raw `chars` cut into the walked prompt)
// would cut elsewhere, and (g) would see it.
const HEAD = 'Classify the ticket below into one queue. Send it with Bearer [REDACTED]\nTicket: ';

async function connect() {
  const dir = await mkdtemp(join(tmpdir(), 'realm-3b-door-'));
  const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
  await workflowStore.register(FLOW);
  const server = createRealmMcpServer({
    runStore: new JsonFileStore(join(dir, 'runs')),
    workflowStore,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'stable-prefix-3b', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return async (name: string, args: Record<string, unknown>): Promise<string> => {
    const raw = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
    };
    return raw.content[0]!.text;
  };
}

describe('caching 3-B B4 — every carrier, over a real reply', () => {
  it('(f) the internal key is never in the agent’s text, on the envelope, get_run_state and start_run_batch; (g) a client cuts and hashes the received prompt', async () => {
    const call = await connect();
    const startText = await call('start_run', {
      workflow_id: FLOW.id,
      params: { ticket: 'FAKE-TICKET-1' },
    });
    const runId = (JSON.parse(startText) as { run_id: string }).run_id;
    const stateText = await call('get_run_state', { run_id: runId });
    const batchText = await call('start_run_batch', {
      workflow_id: FLOW.id,
      items: [{ params: { ticket: 'FAKE-TICKET-2' } }],
    });
    const entries = {
      envelope: (JSON.parse(startText) as { next_actions: Entry[] }).next_actions[0]!,
      get_run_state: (JSON.parse(stateText) as { next_actions: Entry[] }).next_actions[0]!,
      start_run_batch: (JSON.parse(batchText) as { started: Array<{ next_actions: Entry[] }> })
        .started[0]!.next_actions[0]!,
    };
    // (a) red when the strip is removed (on every carrier), or skipped at one carrier's depth;
    //     (b) prints, per carrier, whether the key leaked and whether the field arrived.
    expect({
      envelope: [
        startText.includes(BRIEF_STABLE_CHARS),
        entries.envelope.stable_prefix !== undefined,
      ],
      get_run_state: [
        stateText.includes(BRIEF_STABLE_CHARS),
        entries.get_run_state.stable_prefix !== undefined,
      ],
      start_run_batch: [
        batchText.includes(BRIEF_STABLE_CHARS),
        entries.start_run_batch.stable_prefix !== undefined,
      ],
    }).toEqual({
      envelope: [false, true],
      get_run_state: [false, true],
      start_run_batch: [false, true],
    });
    // (g) (a) red when the field is computed after the walk (the head holds a hidden value, so the
    //     raw boundary lands elsewhere in the walked prompt) or from another text; (b) prints the
    //     field and each client's verdict.
    expect({
      stable: entries.envelope.stable_prefix,
      agree: Object.values(entries).map(clientAgrees),
    }).toEqual({
      stable: { chars: HEAD.length, unit: 'utf16', sha256: sha256(HEAD) },
      agree: [true, true, true],
    });
  });
});
