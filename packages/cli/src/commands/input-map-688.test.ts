// input-map-688.test.ts — issue #688 at `realm workflow run`: a step that builds its input with an
// `input_map` (it has a `handler` or a `uses_service`) is checked against what the map builds, which
// no typed answer changes — so the command does not ask for it again: it stalls with the way out,
// exit 1. And the docs sentences #688 adds, quoted word for word.
//
// In-process through the real command, with `node:readline/promises` mocked (the #447 harness of
// run-cannot-go-on-625.test.ts). Beside each assertion: (a) what turns it red; (b) what it prints on
// failure (the prompts asked, the printed lines, the exit code) — never an environment.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mocks = vi.hoisted(() => ({ question: vi.fn(), close: vi.fn() }));
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({ question: mocks.question, close: mocks.close })),
}));

import { runCommand } from './run.js';
import { clearProjectExtensionsCache } from '../extensions/load-project-extensions.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const flat = (t: string): string => t.replace(/\s+/g, ' ');

/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(page: string, sentence: string): void {
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')).includes(flat(sentence)),
    `${page} no longer says: ${sentence}`,
  ).toBe(true);
}

/** The issue's shape (b): an agent step, then a handler step mapping its output; `h` from `extensions:`. */
const SHAPE_B = [
  'id: run688',
  'name: run688',
  'version: 1',
  'extensions: ./ext.mjs',
  'steps:',
  '  summarize:',
  '    description: Sum.',
  '    execution: agent',
  '  publish:',
  '    description: Pub.',
  '    execution: auto',
  '    handler: h',
  '    depends_on: [summarize]',
  '    input_map:',
  '      text: context.resources.summarize.summary',
  '    input_schema:',
  '      type: object',
  '      required: [text]',
  '',
].join('\n');

describe('#688 — realm workflow run stops on a mapped step whose built input does not fit', () => {
  let home: string;
  let dir: string;
  let savedHome: string | undefined;
  let savedTTY: boolean | undefined;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearProjectExtensionsCache();
    home = mkdtempSync(join(tmpdir(), 'realm-688-run-home-'));
    dir = mkdtempSync(join(tmpdir(), 'realm-688-run-wf-'));
    mkdirSync(join(home, '.realm'), { recursive: true });
    savedHome = process.env['HOME'];
    process.env['HOME'] = home;
    savedTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(() => {
    if (savedTTY === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY;
    else process.stdin.isTTY = savedTTY;
    if (savedHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = savedHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    mocks.question.mockReset();
    vi.restoreAllMocks();
  });

  const errored = (): string[] => errSpy.mock.calls.map((c: unknown[]) => String(c[0]));
  const asked = (): string[] => mocks.question.mock.calls.map((c: unknown[]) => String(c[0]));
  const runId = (): string =>
    readdirSync(join(home, '.realm', 'runs'))
      .filter((f) => f.endsWith('.json'))[0]!
      .replace('.json', '');

  async function run(text: string): Promise<number> {
    writeFileSync(join(dir, 'workflow.yaml'), text, 'utf8');
    writeFileSync(
      join(dir, 'ext.mjs'),
      "export default { handlers: { h: { id: 'h', execute: async (i) => ({ data: { got: i.params } }) } } };\n",
      'utf8',
    );
    try {
      await runCommand.parseAsync([join(dir, 'workflow.yaml')], { from: 'user' });
      return 0;
    } catch (err) {
      if (!(err instanceof Error) || err.message !== 'process.exit') throw err;
      return Number(exitSpy.mock.calls[0]?.[0]);
    }
  }

  it('cell 8: the answer to `summarize` lacks `summary` — the command stalls with the way out, exit 1, and never asks for `publish`', async () => {
    // The agent step's answer, then any further prompt is an error: the mapped step must not be asked.
    const answers = ['{"other":"x"}'];
    mocks.question.mockImplementation(async (prompt: string) => {
      if (prompt.startsWith('  Agent output') && answers.length > 0) return answers.shift()!;
      throw new Error(`fixture: an unexpected prompt: ${prompt}`);
    });
    const code = await run(SHAPE_B);
    // (a) red when the step is offered at its prompt (before #688: `Mock output (handler: h)` is
    //     asked — the fixture's throw — and the stall never comes); (b) prints the exit code, the
    //     prompts asked and the stall lines.
    expect({ code, asked: asked(), lines: errored() }).toEqual({
      code: 1,
      asked: ['  Agent output JSON (Enter for {}): '],
      lines: [
        '\nWorkflow stalled: nothing else can run.',
        "'publish' cannot run (input_schema): Invalid input for step 'publish': the input must have required property 'text'.",
        `Run ${runId()} stays open (phase 'running'): for 'publish', correct its input_map or its input_schema and register the workflow again; then, after a fix, realm run advance ${runId()} — or end it: realm run abandon ${runId()}`,
      ],
    });
  });

  it('control: when the built input fits, the mapped step runs and the run completes, never asked for', async () => {
    const answers = ['{"summary":"hello"}'];
    mocks.question.mockImplementation(async (prompt: string) => {
      if (prompt.startsWith('  Agent output') && answers.length > 0) return answers.shift()!;
      throw new Error(`fixture: an unexpected prompt: ${prompt}`);
    });
    const code = await run(SHAPE_B);
    // (a) red when the mapped step is refused or asked for; (b) prints the exit code and prompts.
    expect({ code, asked: asked() }).toEqual({
      code: 0,
      asked: ['  Agent output JSON (Enter for {}): '],
    });
  });
});

describe('#688 — the docs sentences it adds about the way out and an unresolved path', () => {
  it('step-kinds.md and input-map-and-templates.md say what a mapped step is checked against, and its way out', () => {
    // (a) red when a page no longer says it (the docs flip); (b) prints the sentence. The behaviour
    //     each states is driven by cell 8 above and by core's input-map-688.test.ts (cells 4, 5).
    claim(
      'docs/concepts/step-kinds.md',
      "for a step that builds its input with an `input_map` (one with a `handler` or a `uses_service`), its schema checks what the map builds, and the way is `for '<step>', correct its input_map or its input_schema and register the workflow again`, with `start a run with params that fit, or ` before `correct` when the key its schema refuses is built from `run.params` — joined by `; `,",
    );
    claim(
      'docs/reference/workflow/input-map-and-templates.md',
      "There is no error and no warning, when the file is loaded or when the step runs — unless the step's `input_schema` requires the key: then the step is refused before its claim (`'<step>' cannot run (input_schema): …`), and its way out names the `input_map` or the `input_schema`.",
    );
  });

  it('json-schema-blocks.md: a mapped auto step called by name is refused with report_to_user (#688 correction, item 5)', () => {
    // (a) red when the page no longer says it (the docs flip); (b) prints the sentence. The
    //     behaviour is executed by the MCP input-map-688.test.ts cells 4 (b) and 6.
    claim(
      'docs/reference/workflow/json-schema-blocks.md',
      'When the `input_schema` check refuses an `auto` step that builds its input with `input_map` (one with a `handler` or a `uses_service`), and the step was called by name, the reply is `VALIDATION_INPUT_SCHEMA` with `report_to_user`: its schema checks what the map builds, not the input sent with the call.',
    );
  });
});
