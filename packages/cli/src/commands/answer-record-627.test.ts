// answer-record-627.test.ts — #627 W, Part G on the CLI door: `realm run respond` records route
// `cli` with the principal's absence `not_a_server_door` (cell 5, CLI half; the `realm workflow run`
// prompt's cell is run-prompt-route-627.test.ts); inspect's answer line names the route by its
// door's words (W-i10), the program, the principal by kind (W-i8; cell 25's rendering) and the client
// prompt (W-i5), and its absences (W-i2, W-i3, W-i7); one answerer phrase for inspect and respond (cell 20); inspect's open-gate block
// (cell 13: the frozen question, its absences, and the respond line); the `newer` readers (MA 3's W-r2
// arms: `list --stuck`'s class word, `validate --registered`'s arm).
//
// The record cells run the built `realm` with a fresh HOME. Every assertion carries (a) the change
// that turns it red and (b) what it prints on failure: lines and record fields — never a token.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JsonFileStore,
  JsonWorkflowStore,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  advanceRun,
  answerArrivalOf,
  loadWorkflowFromString,
  type AnswerView,
} from '@sensigo/realm';
import { answererPhrase, renderAnswerLine } from '../lib/holder-render.js';
import { answererClause } from './respond.js';

const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

const YAML = (message = true) =>
  [
    'id: rec627',
    'name: rec627',
    'version: 1',
    'steps:',
    '  q:',
    '    description: Ask.',
    '    execution: auto',
    '    trust: human_confirmed',
    '    gate:',
    '      choices: [approve, reject]',
    ...(message ? ['      message: Ship it?'] : []),
    '  after:',
    '    description: After.',
    '    execution: agent',
    '    depends_on: [q]',
  ].join('\n');

/** A fresh HOME with the workflow registered and one run opened at its question. */
async function home(message = true) {
  const dir = mkdtempSync(join(tmpdir(), 'realm-rec-627-'));
  const def = loadWorkflowFromString(YAML(message));
  await new JsonWorkflowStore(join(dir, '.realm', 'workflows')).register(def);
  const store = new JsonFileStore(join(dir, '.realm', 'runs'));
  const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
  await advanceRun(store, def, { runId: run.id });
  const gateId = (await store.get(run.id)).pending_gate!.gate_id;
  const realm = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      env: { PATH: process.env['PATH'] ?? '', HOME: dir, ...env },
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  return { dir, def, store, runId: run.id, gateId, realm };
}

describe('#627 W — the CLI door records its route (cell 5, CLI half)', () => {
  it('`realm run respond` records route cli and the principal absence not_a_server_door, and inspect says so in its door’s words', async () => {
    const h = await home();
    const r = h.realm(
      ['run', 'respond', h.runId, '--gate', h.gateId, '--choice', 'approve', '--by', 'alice'],
      {
        REALM_OPERATOR: 'ops',
      },
    );
    const entry = (await h.store.get(h.runId)).evidence.find((e) => e.kind === 'gate_response');
    const inspected = h.realm(['run', 'inspect', h.runId]);
    // (a) red when the route parameter is dropped, the principal absence is not written, or the
    //     door's words are not the CLI's; (b) prints the exit, the record's facts and the line.
    expect({
      code: r.code,
      answer: entry?.answer,
      principal: entry?.principal,
      driver: entry?.driven_by,
      line: inspected.out
        .split('\n')
        .find((l) => l.trim().startsWith('Answer: '))
        ?.trim(),
    }).toEqual({
      code: 0,
      answer: { route: 'cli' },
      principal: { absent: 'not_a_server_door' },
      driver: { by: 'ops', by_source: 'ambient', channel: 'respond' },
      line: "Answer: approve · answered by alice (as stated) · through a terminal (realm run respond) (as its door declared), recorded by respond, running as ops (from REALM_OPERATOR) · token: none passed (a token is passed only by Realm's MCP answer tool, from the conversation that opened the question, or by a program that calls the library with it)",
    });
  }, 60_000);
});

describe('#627 W — inspect’s answer line (W-i1…W-i8, W-i10)', () => {
  const view = (over: Partial<AnswerView> = {}): AnswerView => ({
    choice: 'approve',
    answered_by: { by: null, absent_cause: 'not_stated' },
    claim_proof_absent: 'proof_not_recorded',
    ...over,
  });
  const line = (entry: Record<string, unknown>) => renderAnswerLine(view(), answerArrivalOf(entry));
  const DRIVER = { by: 'host', by_source: 'derived', channel: 'mcp-stdio' };

  it('one phrase per route (W-i10); an unknown route by its id; never the id for a known route', () => {
    // (a) red when a known route renders its id, or a route renders another's words; (b) prints each.
    expect({
      form: line({
        answer: { route: 'mcp_form', shown: { renderer: 'realm-mcp-form/1' } },
        driven_by: DRIVER,
      }),
      mcp: line({ answer: { route: 'mcp' }, driven_by: DRIVER }),
      cli: line({ answer: { route: 'cli' }, driven_by: DRIVER }),
      slack: line({ answer: { route: 'slack' }, driven_by: DRIVER }),
    }).toEqual({
      form: "Answer: approve · answered by (not stated) · through the user's app, as a form (as its door declared), recorded by mcp-stdio, running as host (from the OS user) · token: none recorded",
      mcp: "Answer: approve · answered by (not stated) · through Realm's MCP answer tool (as its door declared), recorded by mcp-stdio, running as host (from the OS user) · token: none recorded",
      cli: 'Answer: approve · answered by (not stated) · through a terminal (realm run respond) (as its door declared), recorded by mcp-stdio, running as host (from the OS user) · token: none recorded',
      slack:
        "Answer: approve · answered by (not stated) · through route 'slack' (as its door declared), recorded by mcp-stdio, running as host (from the OS user) · token: none recorded",
    });
  });

  it('the absences: no program (W-i2), no route recorded (W-i3, no program part), a route not declared (W-i7); a stated program name reads "named by the program that runs Realm"', () => {
    // (a) red when an absence is rendered as a route, or the program part shows with no route;
    //     (b) prints each line.
    expect({
      noDriver: line({ answer: { route: 'mcp' } }),
      noRoute: line({ driven_by: DRIVER }),
      undeclared: line({
        answer: { absent: 'route_not_declared' },
        driven_by: { by: 'embedder', by_source: 'stated', channel: 'lib' },
      }),
    }).toEqual({
      noDriver:
        "Answer: approve · answered by (not stated) · through Realm's MCP answer tool (as its door declared), as recorded by a program that did not name itself · token: none recorded",
      noRoute:
        'Answer: approve · answered by (not stated) · how it arrived was not recorded · token: none recorded',
      undeclared:
        'Answer: approve · answered by (not stated) · through a route its program did not declare, as recorded by lib, running as embedder (named by the program that runs Realm) · token: none recorded',
    });
  });

  it('cell 25 — the principal by kind (W-i8), nothing for the other absences; the client prompt (W-i5); a shared token is never an identity', () => {
    const facts = { answer: { route: 'mcp' }, driven_by: DRIVER };
    const tail = (entry: Record<string, unknown>) =>
      line({ ...facts, ...entry })
        .split(' · ')
        .slice(3, -1);
    // (a) red when a principal renders for a door that authenticates no one, the shared token is
    //     shown as a name, or the prompt request is dropped; (b) prints each middle part.
    expect({
      apiKey: tail({ principal: { kind: 'api_key', id: 'key_7' } }),
      sharedToken: tail({ principal: { kind: 'shared_token' } }),
      dev: tail({ principal: { absent: 'door_authentication_disabled' } }),
      stdio: tail({ principal: { absent: 'door_authenticates_no_principal' } }),
      notPassed: tail({ principal: { absent: 'principal_not_passed' } }),
      cli: tail({ principal: { absent: 'not_a_server_door' } }),
      prompted: tail({ client_prompt_requested: true }),
    }).toEqual({
      apiKey: ['authenticated by API key key_7'],
      sharedToken: ["through realm serve's shared token, which names no one"],
      dev: ['with authentication turned off (dev mode)'],
      stdio: [],
      notPassed: [],
      cli: [],
      prompted: [
        'client prompt requested (anthropic/requiresUserInteraction); Realm cannot tell whether anyone approved',
      ],
    });
  });

  it('cell 20 — one answerer phrase: inspect’s line and respond’s Responded: clause say the same words', () => {
    const by = { by: 'alice', by_source: 'stated' as const };
    // (a) red when respond.ts keeps a second phrase (a different label); (b) prints both parts.
    expect({
      inspect: renderAnswerLine(view({ answered_by: by }), answerArrivalOf({})).split(' · ')[1],
      respond: answererClause(view({ answered_by: by }), true).replace(' | ', ''),
      phrase: `answered by ${answererPhrase(by, 'as stated')}`,
    }).toEqual({
      inspect: 'answered by alice (as stated)',
      respond: 'answered by alice (as stated)',
      phrase: 'answered by alice (as stated)',
    });
  });
});

describe('#627 W — cell 13: inspect’s open-gate block', () => {
  it('the frozen question and the respond line; the message comes from the record, never the live definition', async () => {
    const h = await home();
    // Edit the registered definition's message after the gate opened: inspect must not read it.
    const edited = loadWorkflowFromString(YAML().replace('Ship it?', 'Edited later.'));
    await new JsonWorkflowStore(join(h.dir, '.realm', 'workflows')).register(edited);
    const out = h.realm(['run', 'inspect', h.runId]).out.split('\n');
    const at = out.findIndex((l) => l.startsWith('Gate: q'));
    // (a) red when the message is read from the live definition, or the respond line is dropped;
    //     (b) prints the block.
    expect(out.slice(at + 1, at + 4)).toEqual([
      '  Question: "Ship it?"',
      '  Choices: approve, reject',
      `  To answer: realm run respond ${h.runId} --gate ${h.gateId} --choice <one of: approve, reject>`,
    ]);
  }, 60_000);

  it('the two absences: a gate that declares no message; a gate an earlier version opened without keeping it', async () => {
    const none = await home(false);
    const legacy = await home(true);
    const record = await legacy.store.get(legacy.runId);
    const { resolved_message: _gone, ...gate } = record.pending_gate!;
    await legacy.store.update({ ...record, pending_gate: gate });
    const questionOf = (h: Awaited<ReturnType<typeof home>>) =>
      h
        .realm(['run', 'inspect', h.runId])
        .out.split('\n')
        .find((l) => l.startsWith('  Question:'));
    // (a) red when an absence prints the live definition's words, or the two read the same; (b)
    //     prints both lines.
    expect({ none: questionOf(none), legacy: questionOf(legacy) }).toEqual({
      // Correction 2 (2.1): its step declares no prompt either.
      none: '  Question: none — the gate declares no message and its step no prompt',
      legacy:
        '  Question: not recorded — this gate was opened by a version of Realm that did not keep its message',
    });
  }, 60_000);
  it('correction 2 (2.1): a prompt-only gate → the step’s prompt, labelled as read from the workflow as registered now', async () => {
    const h = await home(false);
    const withPrompt = loadWorkflowFromString(
      YAML(false).replace(
        '    trust: human_confirmed\n',
        '    trust: human_confirmed\n    prompt: Ship the release to production?\n',
      ),
    );
    await new JsonWorkflowStore(join(h.dir, '.realm', 'workflows')).register(withPrompt);
    const line = h
      .realm(['run', 'inspect', h.runId])
      .out.split('\n')
      .find((l) => l.startsWith('  Question'));
    // (a) red when inspect prints "none" for a gate whose step declares a prompt; (b) prints the line.
    expect(line).toBe(
      `  Question (the step's prompt, from the workflow as registered now): "Ship the release to production?"`,
    );
  }, 60_000);

  it('correction 2 (2.1): a prompt that cannot be rendered → "not shown", never a thrown error', async () => {
    const h = await home(false);
    // The renderer throws only in strict mode, so the one input that makes the composer throw is a
    // registered copy whose prompt is not a string.
    const copy = join(h.dir, '.realm', 'workflows', 'rec627.json');
    const parsed = JSON.parse(readFileSync(copy, 'utf8')) as {
      steps: Record<string, Record<string, unknown>>;
    };
    parsed.steps['q']!['prompt'] = 42;
    writeFileSync(copy, JSON.stringify(parsed));
    const r = h.realm(['run', 'inspect', h.runId]);
    // (a) red when inspect throws on the prompt (exit 1, no Question line); (b) prints the exit and
    //     the line.
    expect({
      code: r.code,
      line: r.out.split('\n').find((l) => l.startsWith('  Question')),
    }).toEqual({
      code: 0,
      line: "  Question: not shown — the step's prompt could not be rendered",
    });
  }, 60_000);

  it('correction 2 (8.3): the gate’s step is not in a readable definition → "not shown", never "none"', async () => {
    const h = await home(false);
    const without = loadWorkflowFromString(
      [
        'id: rec627',
        'name: rec627',
        'version: 1',
        'steps:',
        '  other:',
        '    description: Other.',
        '    execution: agent',
      ].join('\n'),
    );
    await new JsonWorkflowStore(join(h.dir, '.realm', 'workflows')).register(without);
    const line = h
      .realm(['run', 'inspect', h.runId])
      .out.split('\n')
      .find((l) => l.startsWith('  Question'));
    // (a) red when a missing step reads as "the gate declares no message"; (b) prints the line.
    expect(line).toBe(
      "  Question: not shown — the gate's step is not in the workflow's definition",
    );
  }, 60_000);

  it('correction 1 (E6): no frozen message and a definition that cannot be read → "not shown", never "none"', async () => {
    const h = await home(false);
    writeFileSync(join(h.dir, '.realm', 'workflows', 'rec627.json'), '{ not json');
    const line = h
      .realm(['run', 'inspect', h.runId])
      .out.split('\n')
      .find((l) => l.startsWith('  Question:'));
    // (a) red when inspect says the gate declares no message although it could not read the
    //     definition; (b) prints the line.
    expect(line).toBe("  Question: not shown — the workflow's definition cannot be read");
  }, 60_000);
});

describe('#627 W — the `newer` readers on the CLI (MA 3’s W-r2 arms)', () => {
  async function newerHome() {
    const h = await home();
    writeFileSync(
      join(h.dir, '.realm', 'workflows', 'rec627.json'),
      JSON.stringify({ ...h.def, schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION + 1 }),
    );
    return h;
  }

  it('`realm run list --stuck` names the class `newer`, never an unknown class', async () => {
    const h = await newerHome();
    const out = h.realm(['run', 'list', '--stuck']).out;
    // (a) red when the code falls to the class map's default (no word); (b) prints the run's line.
    expect(out.split('\n').find((l) => l.startsWith(h.runId))).toContain(
      'definition_unresolvable (newer)',
    );
  }, 60_000);

  it('`realm workflow validate --registered` prints W-r2 and exits 1 (its own arm, never the rethrow)', async () => {
    const h = await newerHome();
    const r = h.realm(['workflow', 'validate', '--registered', 'rec627']);
    // (a) red when the arm is dropped (a stack trace); (b) prints the exit and stderr's first line.
    expect({
      code: r.code,
      line: r.err.trim().split('\n')[0],
      stack: r.err.includes('    at '),
    }).toEqual({
      code: 1,
      line: expect.stringContaining("Workflow 'rec627' was registered by a later version of Realm"),
      stack: false,
    });
  }, 60_000);
  it('`realm workflow list` names a newer copy by its class, never as readable (correction 1, C3)', async () => {
    const h = await newerHome();
    const r = h.realm(['workflow', 'list']);
    // (a) red when the listing shows the newer copy as readable, or drops it with no sentence;
    //     (b) prints the warning lines.
    expect(r.err.split('\n').filter((l) => l.startsWith('⚠'))).toEqual([
      '⚠ 1 file in the registry was registered by a later version of Realm: rec627.json — realm cannot audit what it cannot read.',
    ]);
  }, 60_000);
});
