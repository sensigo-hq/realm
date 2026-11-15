// display-filters-u3b.test.ts — fix 1, piece 3b at the CLI: a step's `display` template applies its
// filters on every surface that renders it, and every value it shows is masked before any filter
// runs. `realm agent`'s result line (on a terminal and on a pipe) and its gate print, `realm workflow
// run`'s gate print, and the Slack post (a broadcast: values as their shapes).
//
// In-process through the real drive and commands, with the writer installed and a declared fake added,
// as the CLI's own entry does from a manifest. A spied `console.log` holds what a renderer composed;
// `writerTestSeams.visible` is what the writer then shows on stdout for its audience (a terminal:
// the declared tier; a pipe: every tier) — so each cell reads what a person sees. Every value is a
// fake. Each assertion names (a) the change that turns it red and (b) what it prints when it fails.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mocks = vi.hoisted(() => ({ question: vi.fn(), close: vi.fn() }));
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({ question: mocks.question, close: mocks.close })),
}));

import { InMemoryStore } from '@sensigo/realm-testing';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  createDefaultRegistry,
  submitHumanResponse,
  type PendingGate,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { runAgent } from './run-agent.js';
import { LlmProvider } from './providers/llm-provider.js';
import { slackView } from './gate/slack-gate-notifier.js';
import { runCommand } from '../commands/run.js';
import { clearProjectExtensionsCache } from '../extensions/load-project-extensions.js';
import { addDeclaredValues, installWriter, writerTestSeams } from '../output/writer.js';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

/** A declared fake with lower-case letters (so `upper` changes it) and dashes (so `split` parts it). */
const SECRET = 'sk-live-u3b-4f9a8b7c6d5e3a2b';
/** The same fake with a span mark planted inside it (U+E000, the writer's own print-time mark). */
const PLANTED = `${SECRET.slice(0, 9)}\uE000${SECRET.slice(9)}`;
/** An environment value: swept on a pipe (every tier), shown on a terminal (the declared tier). */
const ENV_NAME = 'U3B_SWEPT_VALUE';
const ENV_VALUE = 'u3b-environment-value-8c2f-0aa1';

/** Every piece of the fake a filter could leave visible: the fake, its upper case, its first 11
 *  characters (`truncate: 12`'s cut), and each dash-separated part of four or more characters. */
const FRAGMENTS = [
  SECRET,
  SECRET.toUpperCase(),
  SECRET.slice(0, 11),
  ...SECRET.split('-').filter((p) => p.length >= 4),
];
const leaks = (text: string): string[] => FRAGMENTS.filter((f) => text.includes(f));

/** One agent step `review`, its output from the model; `gated` adds a message-less gate. */
function workflow(display: string | undefined, gated = false): WorkflowDefinition {
  return {
    id: 'display-u3b',
    name: 'display-u3b',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: {
      review: {
        description: 'Review',
        execution: 'agent',
        depends_on: [],
        ...(display !== undefined ? { display } : {}),
        ...(gated ? { trust: 'human_confirmed', gate: { choices: ['approve', 'reject'] } } : {}),
      },
    },
  } as unknown as WorkflowDefinition;
}

let h: TempHome & { readonly root: string };
let savedHome: string | undefined;
let savedStdoutTTY: boolean | undefined;
let savedStdinTTY: boolean | undefined;
let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  clearProjectExtensionsCache();
  h = await makeTempHome();
  savedHome = process.env['HOME'];
  process.env['HOME'] = h.root;
  process.env[ENV_NAME] = ENV_VALUE;
  savedStdoutTTY = process.stdout.isTTY;
  savedStdinTTY = process.stdin.isTTY;
  process.stdin.isTTY = true;
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(((): never => {
    throw new Error('process.exit');
  }) as never);
});
afterEach(async () => {
  writerTestSeams.reset();
  delete process.env[ENV_NAME];
  for (const [stream, saved] of [
    [process.stdout, savedStdoutTTY],
    [process.stdin, savedStdinTTY],
  ] as const) {
    if (saved === undefined) delete (stream as { isTTY?: boolean }).isTTY;
    else stream.isTTY = saved;
  }
  if (savedHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = savedHome;
  await h.cleanup();
  mocks.question.mockReset();
  vi.restoreAllMocks();
});

/** The writer installed for stdout on a terminal (`tty`) or a pipe, with the fake declared. */
function writerOn(tty: boolean): void {
  process.stdout.isTTY = tty;
  installWriter('default');
  addDeclaredValues({ U3B_TOKEN: SECRET });
}

/** Each `console.log` call as the writer shows it on stdout. */
const shown = (): string[] =>
  logSpy.mock.calls.map((c: unknown[]) => writerTestSeams.visible(c.map(String).join(' ')));

/** One `realm agent` drive of `def`, its model answering `output`; a gate is approved. Returns the
 *  result line's text and the gate print's body (each as shown), and everything shown. */
async function drive(
  def: WorkflowDefinition,
  output: Record<string, unknown>,
): Promise<{ result: string | undefined; gate: string | undefined; all: string }> {
  const store = new InMemoryStore();
  await runAgent(
    {
      store,
      workflowStore: {
        async register() {},
        async get() {
          return def;
        },
        async list() {
          return [def];
        },
      },
      provider: new (class extends LlmProvider {
        async callStep(): Promise<Record<string, unknown>> {
          return output;
        }
      })(),
      registry: createDefaultRegistry(),
      gateHandler: async (runId: string, gate: PendingGate) => {
        await submitHumanResponse(store, def, { runId, gateId: gate.gate_id, choice: 'approve' });
      },
    } as never,
    { definition: def, params: {}, inFlightPollMs: 5, inFlightWatchMs: 20, pollIntervalMs: 20 },
  );
  const lines = shown();
  const at = lines.findIndex((l) => l.startsWith('\nResult (review)'));
  const gateAt = lines.findIndex((l) => l.startsWith('\n⏸  Gate: review'));
  return {
    result: at === -1 ? undefined : lines[at + 1],
    // The gate print's body: the line after the gate's head (no deadline: the gate has none).
    gate: gateAt === -1 ? undefined : lines[gateAt + 1]!.replace(/^\n|\n$/g, ''),
    all: lines.join('\n'),
  };
}

const FILTERED = "A: {{ token | upper }} B: {{ token | truncate: 12 }} C: {{ token | split: '-' }}";
const MASKED_LINE = 'A: [REDACTED] B: [REDACTED] C: [REDACTED]';

describe('fix 1, piece 3b — no declared value through a filter (check 1)', () => {
  for (const tty of [true, false]) {
    it(`the result line on a ${tty ? 'terminal' : 'pipe'}: upper, truncate and split each print the mask`, async () => {
      writerOn(tty);
      const run = await drive(workflow(`${FILTERED} D: {{ planted | upper }}`), {
        token: SECRET,
        planted: PLANTED,
      });
      // (a) red when the result line renders `display` from output not masked first (as on the base
      //     outside log mode), and for D when the span marks are not stripped before the mask; (b)
      //     prints the line and the fragments it shows.
      expect({ line: run.result, leaks: leaks(run.all) }).toEqual({
        line: `${MASKED_LINE} D: [REDACTED]`,
        leaks: [],
      });
    });
  }

  it('the gate print: upper, truncate and split each print the mask', async () => {
    writerOn(true);
    const run = await drive(workflow(`${FILTERED} D: {{ planted | upper }}`, true), {
      token: SECRET,
      planted: PLANTED,
    });
    // (a) red when the gate print renders `display` over the gate's raw preview (not disclosed
    //     first); (b) prints the gate body and the fragments shown.
    expect({ gate: run.gate, leaks: leaks(run.all) }).toEqual({
      gate: `   ${MASKED_LINE} D: [REDACTED]`,
      leaks: [],
    });
  });
});

describe("fix 1, piece 3b — example 08's display (check 2)", () => {
  const DISPLAY = 'Changes:\n{{ key_changes | bullets }}';

  it('`{{ key_changes | bullets }}` renders the bulleted list at the result line', async () => {
    writerOn(true);
    const run = await drive(workflow(DISPLAY), { key_changes: ['a', 'b'] });
    // (a) red when filters are not applied (the placeholder printed as nothing, or the list's JSON);
    //     (b) prints the line.
    expect(run.result).toBe('Changes:\n• a\n• b');
  });

  it("and in a gated twin's gate print", async () => {
    writerOn(true);
    const run = await drive(workflow(DISPLAY, true), { key_changes: ['a', 'b'] });
    // (a) red when filters are not applied, or when the gate print's projection reads the filtered
    //     placeholder's whole expression as its path (no field projected: the list is missing and
    //     the placeholder prints nothing); (b) prints the gate body.
    expect(run.gate).toBe('   Changes:\n   • a\n   • b');
  });

  it("`realm workflow run`'s gate print renders it too", async () => {
    writerOn(true);
    const dir = mkdtempSync(join(tmpdir(), 'realm-u3b-wf-'));
    writeFileSync(
      join(dir, 'workflow.yaml'),
      [
        'id: display-u3b-run',
        'name: display-u3b-run',
        'version: 1',
        'steps:',
        '  review:',
        '    description: Review',
        '    execution: agent',
        '    trust: human_confirmed',
        '    depends_on: []',
        "    display: 'Changes: {{ key_changes | bullets }} / {{ token | upper }}'",
        '    gate:',
        '      choices: [approve, reject]',
        '',
      ].join('\n'),
    );
    mocks.question.mockImplementation(async (prompt: string) =>
      prompt.startsWith('  Choice ')
        ? 'approve'
        : prompt.startsWith('  Agent output JSON')
          ? JSON.stringify({ key_changes: ['a', 'b'], token: SECRET })
          : '',
    );
    try {
      await runCommand.parseAsync([join(dir, 'workflow.yaml'), '--params', '{}'], { from: 'user' });
    } catch (err) {
      if (!(err instanceof Error) || err.message !== 'process.exit') throw err;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const lines = shown();
    // (a) red when filters are not applied at this print (the list prints as nothing), or a value
    //     is not masked before its filter; (b) prints the preview line and the fragments shown.
    expect({
      preview: lines.find((l) => l.startsWith('  Preview: ')),
      leaks: leaks(lines.join('\n')),
    }).toEqual({ preview: '  Preview: Changes: • a\n• b / [REDACTED]', leaks: [] });
  });
});

describe('fix 1, piece 3b — the Slack post shows shapes, unfiltered (check 4)', () => {
  it('a number filter and `upper` show the shape as unfiltered; `bullets` shows bulleted shapes', () => {
    const gate: PendingGate = {
      gate_id: 'g-u3b',
      step_name: 'review',
      choices: ['approve', 'reject'],
      opened_at: '2026-11-15T10:00:00.000Z',
      preview: { amount: 12.5, name: 'Ana', tags: ['x', 'yy'] },
    };
    const view = slackView(
      gate,
      '{{ amount | number_format: 2 }} / {{ name | upper }} / {{ tags | bullets }}',
    );
    // (a) red when filters are applied to shapes (the number filter's placeholder left as written,
    //     `‹STRING, 3 CHARACTERS›`); (b) prints the preview.
    expect(view.preview_text).toBe(
      '‹number› / ‹string, 3 characters› / • ‹string, 1 character›\n• ‹string, 2 characters›',
    );
  });
});

describe("fix 1, piece 3b — the result line's other output is unchanged (check 5)", () => {
  const OUTPUT = { note: 'Pack with care.', env_copy: ENV_VALUE, count: 3, nested: { a: 'x' } };
  const JSON_LINE = (env: string): string =>
    [
      '{',
      '  "note": "Pack with care.",',
      `  "env_copy": "${env}",`,
      '  "count": 3,',
      '  "nested": {',
      '    "a": "x"',
      '  }',
      '}',
    ].join('\n');
  // The base's prints, run on main ab2905b3: a terminal shows the environment value (the declared
  // tier); a pipe hides it (every tier).
  for (const [tty, env] of [
    [true, ENV_VALUE],
    [false, '[REDACTED]'],
  ] as const) {
    it(`on a ${tty ? 'terminal' : 'pipe'}: no display, and a display with no filter, print as on the base`, async () => {
      writerOn(tty);
      const plain = await drive(workflow(undefined), OUTPUT);
      logSpy.mockClear();
      const unfiltered = await drive(
        workflow('Note: {{ note }} / env: {{ env_copy }} / n: {{ count }} / {{ nested }}'),
        OUTPUT,
      );
      // (a) red when the result line discloses for the wrong audience (`log` on a terminal hides the
      //     environment value the base shows there; `broadcast` shows shapes); (b) prints both lines.
      expect([plain.result, unfiltered.result]).toEqual([
        JSON_LINE(env),
        `Note: Pack with care. / env: ${env} / n: 3 / {"a":"x"}`,
      ]);
    });
  }
});

describe('fix 1, piece 3b — the words (check 7)', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const TEMPLATES = 'docs/reference/workflow/input-map-and-templates.md';
  const flat = (text: string): string => text.replace(/\s+/g, ' ');
  /** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
  const claim = (page: string, sentence: string): void =>
    expect(
      flat(readFileSync(join(ROOT, page), 'utf8')),
      `${page} no longer says: ${sentence}`,
    ).toContain(flat(sentence));

  it("input-map-and-templates.md: display's filters, its states and its printed example", async () => {
    // Core's display-filters-u3b: "a path that finds nothing" (`default`), "a filter that fails",
    // "every filter succeeds" (a list on one line, the empty lists); the table row: the same cells.
    claim(
      TEMPLATES,
      "| `display`      | `realm agent` prints the step's result, and a surface shows the step's gate. | Fields of the step's own output | Yes     | Nothing is printed in its place.             | The expression is left as written. |",
    );
    claim(
      TEMPLATES,
      "In `display`, a path is a field of the step's own output, without a root: `{{ note }}`. Filters work as in other templates: `{{ note | upper }}`, and `default` fills a missing value. A filter that cannot apply to a value that is there leaves the placeholder as written. In `display`, a list or a map is written as JSON on one line. This was added after version 0.49.0.",
    );
    claim(
      TEMPLATES,
      '`bullets`, `first`, `last` and `and_join` on an empty list leave the expression as written; in `display`, they show nothing.',
    );
    // The printed line, executed: the page's own template through `realm agent`'s result line (the
    // page prints it without the line's trailing space).
    const page = readFileSync(join(ROOT, TEMPLATES), 'utf8');
    const template = /^display: '(.*)'$/m.exec(
      page.slice(page.indexOf('In `display`, a path')),
    )![1]!;
    const printed = /`realm agent` printed:\n\n```text\n(.*)\n```/.exec(page)![1]!;
    writerOn(true);
    const run = await drive(workflow(template), { note: 'Pack with care.' });
    // (a) red when the page's line differs from what the drive prints; (b) prints both.
    expect({ printed, drive: run.result?.trimEnd() }).toEqual({
      printed: 'Note: Pack with care. / upper: PACK WITH CARE. / other step:',
      drive: 'Note: Pack with care. / upper: PACK WITH CARE. / other step:',
    });
  });

  it('CHANGELOG.md: the Fixed line', () => {
    // This file's check 1 (the mask on each surface), check 2 (the result line, both gate prints),
    // check 4 (Slack's shapes); core's display-filters-u3b (the states).
    const text = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
    const unreleased = text.slice(text.indexOf('## [Unreleased]'), text.indexOf('\n## [0.49.0]'));
    expect(flat(unreleased), 'the CHANGELOG no longer says the Fixed line').toContain(
      flat(
        "- **A `display` template's filters now work** (for example `{{ key_changes | bullets }}` in example 08): in `realm agent`'s result line and gate print, `realm workflow run`'s gate print, and the Slack post, where a value shows as its shape. Before, a placeholder with a filter was shown as nothing (an empty line where it stood alone). `default` fills a missing value; otherwise a path that finds nothing is still shown as nothing, and a filter that cannot apply to a value that is there leaves the placeholder as written. `display` values are masked before any filter runs.",
      ),
    );
  });
});
