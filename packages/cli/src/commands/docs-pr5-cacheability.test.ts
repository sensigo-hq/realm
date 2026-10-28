// docs-pr5-cacheability.test.ts — issue #600 caching PR 5 (C6): every new docs sentence is claimed
// word for word, in the cell that runs what it says, through the BUILT `realm` with piped output
// (guardrail 9). The pages: realm-workflow.md's "The cache lines", the economics page's "The cache
// minimum", the --json contract row, review-note's transcript (its profile now stated on the page),
// and the CHANGELOG. On a failing host a cell prints the sentence a page no longer holds, or realm's
// own lines with the scratch folder written `<dir>`: never a key or an environment.
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CHARS_PER_TOKEN_HIGH,
  DEFAULT_CHARS_PER_TOKEN_LOW,
  DISCLOSURE_FLOORS,
  parseCacheEconomics,
  priceFromEconomics,
} from '@sensigo/realm';
import { ANTHROPIC_TOOL_TEXT_TOKENS } from '../agent/providers/request-layout.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');
const DIST_CLI = join(HERE, '..', '..', 'dist', 'index.js');
const ex = (name: string): string => join(ROOT, 'examples', name);
const flat = (t: string): string => t.replace(/\s+/g, ' ');
const read = (page: string): string => readFileSync(join(ROOT, page), 'utf8');
/** (a) red when the page no longer holds the text word for word; (b) prints the text. */
function claim(page: string, text: string): void {
  expect(flat(read(page)).includes(flat(text)), `${page} no longer says: ${text}`).toBe(true);
}
/** Correction 2 (F-7): the page holds a LINE equal to realm's printed line — not merely one that
 *  contains it, so a page line that kept a stale ending fails. (a) red when a stale tail is appended
 *  to that transcript line; (b) prints the page's file name, the line, and whether a page line
 *  begins with it (a stale tail). */
function claimLine(page: string, line: string): void {
  const lines = read(page).split('\n');
  expect(
    lines.includes(line),
    `${page} has no line equal to: ${line} (a page line begins with it: ${String(lines.some((l) => l.startsWith(line)))})`,
  ).toBe(true);
}
const WORKFLOW_PAGE = 'docs/reference/cli/realm-workflow.md';
const ECONOMICS_PAGE = 'docs/reference/cache-economics.md';
const DIAGNOSTICS_PAGE = 'docs/reference/workflow/loader-diagnostics.md';
const FIELDS_PAGE = 'docs/reference/workflow/top-level-fields.md';
const CHANGELOG = 'CHANGELOG.md';

let home: string;
let base: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'realm-pr5-docs-home-'));
  base = mkdtempSync(join(tmpdir(), 'realm-pr5-docs-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
});

function realm(
  args: string[],
  env: Record<string, string> = {},
): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [DIST_CLI, ...args], {
    cwd: base,
    env: { PATH: process.env['PATH'] ?? '', HOME: home, REALM_NO_NUDGE: '1', ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}
const hide = (text: string): string => text.split(base).join('<dir>');
const cacheLines = (stdout: string): string[] =>
  hide(stdout)
    .split('\n')
    .filter((l) => l.startsWith('cache:'));

/** A scratch project with a trust root, the workflow (copied or written), profiles, economics. */
function project(opts: {
  example?: string;
  workflow?: string;
  files?: Record<string, string>;
  economics?: string | null;
}): string {
  const dir = join(base, 'proj');
  rmSync(dir, { recursive: true, force: true });
  if (opts.example !== undefined) cpSync(ex(opts.example), dir, { recursive: true });
  else mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{}\n');
  if (opts.workflow !== undefined) writeFileSync(join(dir, 'workflow.yaml'), opts.workflow);
  for (const [name, text] of Object.entries(opts.files ?? {})) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  if (opts.economics !== undefined) {
    writeFileSync(
      join(dir, 'realm.yaml'),
      'version: 1\nrunner:\n  cache:\n    economics: economics.yaml\n',
    );
    if (opts.economics !== null) writeFileSync(join(dir, 'economics.yaml'), opts.economics);
  }
  return dir;
}
const economics = (model: string, min?: number): string =>
  [
    'version: 1',
    'currency: USD',
    'models:',
    `  ${model}:`,
    ...(min !== undefined ? [`    min_cacheable_tokens: ${String(min)}`] : []),
    '    prices:',
    '      - per_million_tokens: { input: 3, output: 15 }',
    '',
  ].join('\n');
const oneStep = (id: string, extra = ''): string =>
  `id: ${id}\nname: ${id}\nversion: 1\nsteps:\n  ${id}:\n    description: a step\n    execution: agent\n    prompt: Do it.\n${extra}`;
const ELIGIBLE_SCHEMA =
  '    output_schema:\n      type: object\n      additionalProperties: false\n      required: [answer]\n      properties:\n        answer: { type: string }\n';

describe(
  'realm-workflow.md, "The cache lines": the examples are what the commands print',
  { timeout: 60_000 },
  () => {
    // Each example line on the page, produced by the command the page says it came from. Break: one
    // word of an example changed on the page. (a) red when a page line differs from realm's — since
    // correction 2 (F-7), also when it carries a stale tail after realm's line; (b) prints the line
    // the page no longer holds.
    it('every example line, from examples 01, 03, 04, 05 and 09', () => {
      claim(
        WORKFLOW_PAGE,
        'The lines below come from the examples in the Realm repository. With no flag, `realm workflow validate examples/01-code-reviewer` gives the size of the request each provider is sent:',
      );
      const v = (args: string[]) => cacheLines(realm(['workflow', 'validate', ...args]).stdout);
      const at01 = project({
        example: '01-code-reviewer',
        economics: economics('claude-sonnet-4-6', 1024),
      });
      const fromEconomics01 = v([at01, '--provider', 'anthropic', '--model', 'claude-sonnet-4-6']);
      const at04 = project({
        example: '04-content-pipeline',
        economics: economics('claude-sonnet-5-5', 512),
      });
      const fromEconomics04 = v([at04, '--provider', 'anthropic', '--model', 'claude-sonnet-5-5']);
      const lines = [
        ...v([ex('01-code-reviewer')]),
        ...v([ex('01-code-reviewer'), '--floor', '512']),
        fromEconomics01[0]!,
        fromEconomics04[1]!,
        v([ex('03-incident-response'), '--provider', 'anthropic', '--floor', '512'])[0]!,
        v([ex('03-incident-response'), '--provider', 'openai', '--floor', '200'])[0]!,
        ...v([ex('01-code-reviewer'), '--provider', 'anthropic', '--ratio', '4']),
        v([ex('09-webhook-pr-review')])[0]!,
        v([ex('05-parallel-code-review'), '--provider', 'anthropic'])[0]!,
      ];
      expect(lines).toHaveLength(9);
      for (const line of lines) claimLine(WORKFLOW_PAGE, line);
      const once = realm(['workflow', 'validate', ex('05-parallel-code-review')])
        .stdout.split('\n')
        .filter((l) => l.startsWith('anthropic: ') || l.startsWith('openai: '));
      expect(once).toHaveLength(3);
      for (const line of once) claimLine(WORKFLOW_PAGE, line);
    });

    // The refusals, printed on standard error with exit 1, with or without --json. Break: a refusal's
    // words changed on the page. (a) red when realm's line or exit code differs, or a refusal prints
    // nothing on standard error (correction 1, C-6.3: an empty line would pass the claim vacuously),
    // or the page's line carries a stale tail (correction 2, F-7); (b) prints them, and each exit
    // code with its standard error's length.
    it('the three refusals', () => {
      claim(
        WORKFLOW_PAGE,
        '`--model` needs `--provider`, `--floor` a whole number of tokens, 1 or more, and `--ratio` a number above 0. Otherwise the command prints one of these lines on standard error and exits with 1, with nothing on standard output, with or without `--json`:',
      );
      const v = ['workflow', 'validate', ex('01-code-reviewer')];
      const runs = [
        realm([...v, '--model', 'claude-sonnet-5-5']),
        realm([...v, '--floor', '0', '--json']),
        realm([...v, '--ratio', '0']),
      ];
      expect(runs.map((r) => [r.code, r.stdout])).toEqual([
        [1, ''],
        [1, ''],
        [1, ''],
      ]);
      for (const r of runs) {
        expect(
          r.stderr.trim().length,
          `exit ${String(r.code)}: standard error is empty`,
        ).toBeGreaterThan(0);
        claimLine(WORKFLOW_PAGE, r.stderr.trim());
      }
    });

    // Correction 1 (C-6.1): a flag given last with nothing after it, and an unknown --provider, get
    // the command line parser's message; a flag followed by an option that takes no value takes it
    // as its value. Correction 2 (F-1): with a path given, a flag followed by an option that takes a
    // value gets the parser's "too many arguments", and `--provider --floor 5` the parser's invalid
    // argument. Each: exit 1, nothing on standard output, the message on standard error, and the
    // page says so. (a) red when the page keeps the old sentence or drops the new one, or an exit, a
    // standard-output fact or a quoted prefix changes; (b) prints each exit code and the first line
    // of standard error.
    it("C-6.1 / F-1: the parser's own messages, and which option a flag takes as its value", () => {
      claim(
        WORKFLOW_PAGE,
        "A flag given last, with nothing after it, and a `--provider` other than `anthropic` or `openai` (in lower case) get the command line parser's own message instead, also on standard error with exit 1 and nothing on standard output: `error: option '--floor <tokens>' argument missing`, or `error: option '--provider <name>' argument 'foo' is invalid. --provider must be openai or anthropic.` A flag followed by an option that takes no value takes that option as its value. For `--floor` and `--ratio` that gets the `Error:` line above: `--floor --json` prints `Error: --floor must be a whole number of tokens, 1 or more (got '--json').` For `--provider` it gets the parser's message: `--provider --json` prints `error: option '--provider <name>' argument '--json' is invalid. --provider must be openai or anthropic.` `--model` has no check on its value: `--provider anthropic --model --json` reads `--json` as the model id, prints no error and leaves `--json` unset, so the output is text, not JSON; `--model --strict` leaves `--strict` unset, so a warning no longer fails the run. With a path given, a flag followed by an option that takes a value is read by the command line parser instead: `--floor --ratio 4` and `--floor --provider anthropic` print `error: too many arguments for 'validate'. Expected 1 argument but got 2: …` (`register` and `watch` name themselves; the path and the value follow). `--provider --floor 5` prints `error: option '--provider <name>' argument '--floor' is invalid. --provider must be openai or anthropic.` Each goes to standard error with exit 1 and nothing on standard output.",
      );
      expect(
        read(WORKFLOW_PAGE),
        'the page still says a flag followed by ANY option takes it as its value',
      ).not.toContain('A flag followed by another option takes that option as its value');
      const v = ['workflow', 'validate', ex('01-code-reviewer')];
      const runs = [
        realm([...v, '--floor']),
        realm([...v, '--provider', 'foo']),
        realm([...v, '--floor', '--json']),
      ];
      expect(runs.map((r) => [r.code, r.stdout, r.stderr.trim().split('\n')[0]])).toEqual([
        [1, '', "error: option '--floor <tokens>' argument missing"],
        [
          1,
          '',
          "error: option '--provider <name>' argument 'foo' is invalid. --provider must be openai or anthropic.",
        ],
        [1, '', "Error: --floor must be a whole number of tokens, 1 or more (got '--json')."],
      ]);
      // F-1: the three orders the old sentence got wrong. stderr STARTS with the quoted prefix (the
      // path and the value after it vary).
      const parsed = [
        realm([...v, '--floor', '--ratio', '4']),
        realm([...v, '--floor', '--provider', 'anthropic']),
        realm([...v, '--provider', '--floor', '5']),
      ].map((r) => {
        const first = r.stderr.trim().split('\n')[0] ?? '';
        return { code: r.code, stdout: r.stdout, first };
      });
      const prefixes = [
        "error: too many arguments for 'validate'. Expected 1 argument but got 2:",
        "error: too many arguments for 'validate'. Expected 1 argument but got 2:",
        "error: option '--provider <name>' argument '--floor' is invalid.",
      ];
      parsed.forEach((r, i) => {
        const shown = `exit ${String(r.code)}: ${r.first}`;
        expect([r.code, r.stdout], shown).toEqual([1, '']);
        expect(r.first.startsWith(prefixes[i] ?? '\0'), shown).toBe(true);
      });
      // Correction 3 (I-1): which option a flag takes as its value, flag by flag. `--floor` and
      // `--ratio` get realm's `Error:` line; `--provider` the parser's message, on all three commands;
      // `--model` has no check on its value, so `--model --json` leaves `--json` unset (text, not
      // JSON), and `--model --strict` leaves `--strict` unset, so a warning no longer fails the run:
      // the contrast is `--strict` alone, exit 1 on the same fixture (its warning is on standard
      // error). (a) red when the page keeps the old sentence, `--model` starts refusing a value that
      // begins with `-`, `--json` or `--strict` is set by `--model <flag>`, the fixture stops warning,
      // or a message changes; (b) prints each run's exit code and the first line of its standard
      // output and standard error.
      const firstLine = (s: string): string => hide(s).trim().split('\n')[0] ?? '';
      const PROVIDER_JSON =
        "error: option '--provider <name>' argument '--json' is invalid. --provider must be openai or anthropic.";
      const valued = [
        realm([...v, '--ratio', '--json']),
        realm([...v, '--provider', '--json']),
        realm(['workflow', 'register', ex('01-code-reviewer'), '--provider', '--json']),
        realm(['workflow', 'watch', ex('01-code-reviewer'), '--provider', '--json']),
      ];
      expect(valued.map((r) => [r.code, r.stdout, firstLine(r.stderr)])).toEqual([
        [1, '', "Error: --ratio must be a number of characters per token above 0 (got '--json')."],
        [1, '', PROVIDER_JSON],
        [1, '', PROVIDER_JSON],
        [1, '', PROVIDER_JSON],
      ]);
      const asModel = realm([...v, '--provider', 'anthropic', '--model', '--json']);
      let parses = true;
      try {
        JSON.parse(asModel.stdout);
      } catch {
        parses = false;
      }
      const retried = project({ workflow: oneStep('retried', '    retry: { max_attempts: 3 }\n') });
      const INERT = "⚠ Step 'retried': 'retry' is inert on execution: 'agent' steps";
      const gate = [
        realm(['workflow', 'validate', retried, '--strict']),
        realm(['workflow', 'validate', retried, '--provider', 'anthropic', '--model', '--strict']),
      ].map((r) => [r.code, firstLine(r.stdout), firstLine(r.stderr).startsWith(INERT)]);
      expect({
        model: [asModel.code, firstLine(asModel.stdout), parses, asModel.stderr],
        gate,
      }).toEqual({
        model: [0, 'Valid: code-reviewer v1 (3 steps)', false, ''],
        gate: [
          [1, 'Valid: retried v1 (1 step) — 1 warning; failing due to --strict', true],
          [0, 'Valid: retried v1 (1 step)', true],
        ],
      });
      // Correction 3 (I-6): `register` and `watch` name themselves in the parser's "too many
      // arguments", and exit 1 before anything is registered or watched. (a) red when either stops
      // naming itself or exits 0; (b) prints the exit code and the first line of standard error.
      for (const c of ['register', 'watch']) {
        const r = realm(['workflow', c, ex('01-code-reviewer'), '--floor', '--ratio', '4']);
        const shown = `${c}: exit ${String(r.code)}: ${firstLine(r.stderr)}`;
        expect([r.code, r.stdout], shown).toEqual([1, '']);
        expect(
          firstLine(r.stderr).startsWith(
            `error: too many arguments for '${c}'. Expected 1 argument but got 2:`,
          ),
          shown,
        ).toBe(true);
      }
    });

    // Correction 1 (C-6.2): a log hides the provider word and the model id when an environment value
    // holds them, at 8 characters or more (core's environment floor, read here, not restated):
    // `anthropic` is masked, `openai` prints whole; --json prints both whole. (a) red when the page
    // names the word without the 8-character condition, drops the sentence, or a run says otherwise;
    // (b) prints the two adapter words of each line, the environment's value written `<env>`.
    it('C-6.2: a log hides `anthropic` when the environment holds it; `openai` is under the floor; --json prints both whole', () => {
      claim(
        WORKFLOW_PAGE,
        'That includes the model id and the word `anthropic` when an environment variable holds the same text, for example `ANTHROPIC_MODEL=claude-sonnet-5-5` or `LLM_PROVIDER=anthropic`: the line then reads `[REDACTED]` where they stood. Realm hides an environment value only when it is 8 characters or more, so `openai` prints whole. In `--json`, both print whole (#885).',
      );
      const v = ['workflow', 'validate', ex('01-code-reviewer')];
      const words = (value: string): string[] => {
        const line = cacheLines(realm(v, { LLM_PROVIDER: value }).stdout)[0]!
          .split(value)
          .join('<env>');
        return [
          / — (\S+) 1,010 chars/.exec(line)?.[1] ?? '?',
          / · (\S+) 515 chars/.exec(line)?.[1] ?? '?',
        ];
      };
      const json = (value: string): string[] =>
        (
          JSON.parse(realm([...v, '--json'], { LLM_PROVIDER: value }).stdout) as {
            cacheability: { steps: Array<{ layouts: Array<{ adapter: string }> }> };
          }
        ).cacheability.steps[0]!.layouts.map((l) => l.adapter.split(value).join('<env>'));
      expect([
        'openai'.length < DISCLOSURE_FLOORS.environment,
        'anthropic'.length >= DISCLOSURE_FLOORS.environment,
        DISCLOSURE_FLOORS.environment,
        words('anthropic'),
        words('openai'),
        json('anthropic'),
        json('openai'),
      ]).toEqual([
        true,
        true,
        8,
        ['[REDACTED]', 'openai'],
        ['anthropic', '<env>'],
        ['<env>', 'openai'],
        ['anthropic', '<env>'],
      ]);
      // Correction 2 (F-6): the sentence's model-id half, run (correction 1 ran only the provider
      // word): piped, with ANTHROPIC_MODEL holding the id, the line reads `[REDACTED]` where it
      // stood. And the page's "8 characters or more" is core's environment floor, read here, so a
      // change of the floor turns it red. (b) prints the line, the environment's value written
      // `<env>`.
      const modelLine = cacheLines(
        realm([...v, '--provider', 'anthropic', '--model', 'claude-sonnet-5-5', '--floor', '500'], {
          ANTHROPIC_MODEL: 'claude-sonnet-5-5',
        }).stdout,
      )[0]!
        .split('claude-sonnet-5-5')
        .join('<env>');
      expect(modelLine, modelLine).toContain('the floor for [REDACTED] (500, your --floor)');
      expect(read(WORKFLOW_PAGE), "the page no longer states core's environment floor").toContain(
        `Realm hides an environment value only when it is ${String(DISCLOSURE_FLOORS.environment)} characters or more`,
      );
    });

    // The watch transcript holds only what watch prints: lines that begin with `Watching ` or the time.
    // Break: another command's output pasted into the block (76f9483b carried a generator's output
    // there). (a) red when a line of the block is not watch's, or its cache line is not the scaffold's;
    // (b) prints the foreign lines and both cache lines.
    it("the watch transcript holds only watch's own lines, and its cache line is the scaffold's", () => {
      const page = read(WORKFLOW_PAGE);
      const at = page.indexOf(
        'after the first `Registered` line, and again only when they change.',
      );
      const block = /```text\n([\s\S]*?)```/.exec(page.slice(at))![1]!;
      const foreign = block
        .split('\n')
        .filter(
          (l) =>
            l !== '' && !l.startsWith('Watching ') && !/^\[\d{4}-\d\d-\d\dT[\d:.]+Z\] /.test(l),
        );
      expect(realm(['workflow', 'init', 'invoice-check']).code).toBe(0);
      const line = cacheLines(realm(['workflow', 'register', 'invoice-check']).stdout)[0];
      const pageLine = block
        .split('\n')
        .find((l) => l.includes('] cache: '))
        ?.replace(/^\[[^\]]+\] /, '');
      expect([foreign, pageLine]).toEqual([[], line]);
    });
  },
);

describe('realm-workflow.md, "The cache lines": the sentences', { timeout: 60_000 }, () => {
  // The estimate's constants, the band, and text outside ASCII. Break: a constant or the band changed
  // in the code (or its number on the page). (a) red when the page's numbers part from the code's,
  // or a Chinese profile reads below at 512; (b) prints the numbers and the line.
  it('how the estimate is made: 2.5–5 characters a token, one a character outside ASCII, 220–530 tokens of tool text', () => {
    claim(
      WORKFLOW_PAGE,
      "**How the estimate is made.** Realm has no tokenizer, so the tokens are a range. Realm's own text is counted at 2.5 to 5 characters a token, measured on English text. Text in other scripts counts up to one token a character, an approximation: for such text, pass `--ratio` from your own count. On Anthropic, a step with a schema is sent Realm's tool, and Anthropic adds text of its own to such a request: 220 to 530 tokens, set from measurements on claude-sonnet-4-6 and claude-sonnet-5-5 on 2026-10-27, with margin. The line says `with Anthropic's tool text` where it adds them.",
    );
    const zh = project({
      workflow: oneStep('zh', '    agent_profile: zh\n'),
      files: { 'profiles/zh.md': '中'.repeat(1100) },
    });
    expect([
      DEFAULT_CHARS_PER_TOKEN_LOW,
      DEFAULT_CHARS_PER_TOKEN_HIGH,
      { ...ANTHROPIC_TOOL_TEXT_TOKENS },
      cacheLines(
        realm(['workflow', 'validate', zh, '--provider', 'anthropic', '--floor', '512']).stdout,
      )[0],
    ]).toEqual([
      2.5,
      5,
      { low: 220, high: 530 },
      'cache: zh — 1,257 chars ≈ 252–1,163 tokens (estimate) (no schema: realm sends no tool) — near the floor (512, your --floor): not judged from an estimate; --ratio <chars-per-token> narrows it',
    ]);
  });

  // A minimum, both bases, the whole-range rule, the 512 note, and OpenAI's tail. Break: the flag
  // made to lose to the economics file, a small schema step reading below at 512, or the tail
  // dropped. (a) red when a line differs; (b) prints the lines.
  it('a minimum: --floor or the economics file, both named when they differ; never below at 512 with a schema; OpenAI strict ends with its tail', () => {
    claim(
      WORKFLOW_PAGE,
      "**A minimum.** `--floor <tokens>` tests a minimum of your own. With `--provider` and `--model`, the minimum is the one your [economics file](../cache-economics.md#the-cache-minimum) states for the model. When both give one, `--floor` decides. The line names both only when the numbers differ, as in `(1,000, your --floor; your economics file says 512)`; when they are the same, it names only `--floor`. `cannot cache on it` and `long enough to cache` speak for the model only when the minimum is the economics file's; a minimum given by `--floor` reads `at that minimum`. Each provider's size is then followed by its verdict, here with `--floor 512`:",
    );
    claim(
      WORKFLOW_PAGE,
      "A verdict is given only when the whole range is on one side of the minimum. A range that holds the minimum reads `near`, and is not judged. At a 512-token minimum, an Anthropic step with a schema never reads `below`: the high end of Anthropic's tool text alone reaches 530. The verdicts with `--provider`, from examples 01, 04 and 03:",
    );
    claim(
      WORKFLOW_PAGE,
      "On OpenAI, a step with `structured_output: strict` and a schema is sent the schema in `response_format`. OpenAI's own text for it is not counted, so a `below` verdict there ends `; by realm's bytes — OpenAI's own schema text is not counted`.",
    );
    const both = project({
      example: '01-code-reviewer',
      economics: economics('claude-sonnet-4-6', 1024),
    });
    const bothNamed = cacheLines(
      realm([
        'workflow',
        'validate',
        both,
        '--provider',
        'anthropic',
        '--model',
        'claude-sonnet-4-6',
        '--floor',
        '512',
      ]).stdout,
    )[0]!.includes('(512, your --floor; your economics file says 1,024)');
    const tiny = project({
      workflow: oneStep('tiny', '    input_schema:\n      type: object\n'),
    });
    const tinyLine = cacheLines(
      realm(['workflow', 'validate', tiny, '--provider', 'anthropic', '--floor', '512']).stdout,
    )[0]!;
    const strict = project({
      workflow: oneStep('strict_step', `    structured_output: strict\n${ELIGIBLE_SCHEMA}`),
    });
    expect([
      bothNamed,
      ANTHROPIC_TOOL_TEXT_TOKENS.high >= 512,
      tinyLine.includes(' — near the floor (512, your --floor)'),
      cacheLines(
        realm(['workflow', 'validate', strict, '--provider', 'openai', '--floor', '1024']).stdout,
      )[0]!.endsWith("; by realm's bytes — OpenAI's own schema text is not counted"),
    ]).toEqual([true, true, true, true]);
  });

  // --ratio: the count ±15%, and no tool text. Break: the band added under --ratio. (a) red when the
  // range is not 1,010 / (4 × 1.15) to 1,010 / (4 × 0.85) (correction 1, C-2), or the line says tool
  // text; (b) prints the line.
  it('your own count: the range is that count ±15%, and no tool text is added', () => {
    claim(
      WORKFLOW_PAGE,
      "**Your own count.** `--ratio <chars-per-token>` takes your own count: the step's characters as the line prints them, divided by the input tokens the provider counted for one request of the step with a one-character message, tools included. The range is then that count ±15%, and no tool text is added, because your count holds it:",
    );
    const line = cacheLines(
      realm([
        'workflow',
        'validate',
        ex('01-code-reviewer'),
        '--provider',
        'anthropic',
        '--ratio',
        '4',
      ]).stdout,
    )[0]!;
    expect([
      line.includes(
        `1,010 chars ≈ ${Math.ceil(1010 / (4 * 1.15))}–${Math.floor(1010 / (4 * 0.85))} tokens`,
      ),
      line.includes("Anthropic's tool text"),
    ]).toEqual([true, false]);
  });

  // The table of reasons: each row's words, from the condition its row names. Break: a row's words
  // or its condition changed. (a) red when a line does not end with its row's words; (b) prints
  // each line's ending.
  it('no verdict: each reason in the table, from its condition', () => {
    claim(WORKFLOW_PAGE, '**No verdict.** When no minimum is known, the line says why:');
    const ending = (econ: string | null | undefined, model?: string): string => {
      const dir = project({
        example: '01-code-reviewer',
        ...(econ !== undefined ? { economics: econ } : {}),
      });
      const args = ['workflow', 'validate', dir, '--provider', 'anthropic'];
      const line = cacheLines(
        realm(model !== undefined ? [...args, '--model', model] : args).stdout,
      )[0]!;
      return line.slice(line.indexOf(' — ', line.indexOf('(estimate)')) + 3);
    };
    const endings = [
      ending(economics('claude-sonnet-5-5', 512)),
      ending(undefined, 'claude-sonnet-5-5'),
      ending(null, 'claude-sonnet-5-5').split(':')[0]!,
      ending('version: 2\n', 'claude-sonnet-5-5').split(':')[0]!,
      ending(economics('claude-sonnet-5-5', 512), 'claude-opus-9'),
      ending(economics('claude-sonnet-5-5'), 'claude-sonnet-5-5'),
    ];
    expect(endings).toEqual([
      'the floor was not judged: no --model named',
      'no economics file named in realm.yaml (runner.cache.economics); --floor tests a minimum',
      'economics unreachable',
      'your economics file',
      'no entry for claude-opus-9 in your economics file',
      'no minimum stated for claude-sonnet-5-5 in your economics file',
    ]);
    for (const row of [
      '| `the floor was not judged: no --model named` | `--provider` is given, with no `--model` and no `--floor`. |',
      '| `no economics file named in realm.yaml (runner.cache.economics); --floor tests a minimum` | `--model` is given and `realm.yaml` names no economics file. |',
      '| `economics unreachable: <reason>`, `your economics file: <reason>` | The economics file cannot be read, or does not parse. |',
      '| `no entry for <model> in your economics file` | The economics file has no entry for the model. |',
      "| `no minimum stated for <model> in your economics file` | The model's entry has no `min_cacheable_tokens`. |",
      '| `economics not checked (<reason>)` | `--registered`, and the copy records no project folder, or the one it records is gone. |',
      '| `profile file not read (<reason>): sizes not computed` | `--registered`, the step names a profile, and the copy records no workflow folder, or the one it records is gone. |',
    ]) {
      claim(WORKFLOW_PAGE, row.replace(/ +\|/g, ' |'));
    }
    // The two --registered rows, by their route: the copy's folder deleted.
    const dir = project({
      workflow:
        'id: gone-tree\nname: gone-tree\nversion: 1\nsteps:\n' +
        '  with_profile:\n    description: a\n    execution: agent\n    prompt: Do it.\n    agent_profile: p\n' +
        '  without_profile:\n    description: b\n    execution: agent\n    prompt: Do it.\n',
      files: { 'profiles/p.md': 'You are careful.' },
    });
    expect(realm(['workflow', 'register', dir]).code).toBe(0);
    rmSync(dir, { recursive: true, force: true });
    const registered = cacheLines(
      realm(['workflow', 'validate', '--registered', 'gone-tree']).stdout,
    );
    expect([
      registered[0]!.includes(
        '— profile file not read (source_dir <dir>/proj no longer exists): sizes not computed',
      ),
      registered[1]!.endsWith('— economics not checked (trust_root <dir>/proj no longer exists)'),
    ]).toEqual([true, true]);
  });

  // Correction 2 (F-4): the page says a step below the minimum names no sharing, the OpenAI strict
  // exception, and when the clause comes back. The behaviour is pinned by execution in
  // validate-cacheability's "F-4 one layout", "F-4 --json", "F-4 exception" and "F-4 two layouts".
  // (a) red when the page drops a sentence; (b) prints the sentence.
  it('F-4: a step below the minimum names no sharing; the OpenAI strict exception', () => {
    for (const sentence of [
      "A step below the minimum names no sharing, because it cannot cache whatever it shares; on OpenAI with `structured_output: strict` and a model that is not an `o1` model, where the provider's own schema text is not counted, the clause stays.",
      'The clause comes back with a lower floor or a longer fixed part.',
    ])
      claim(WORKFLOW_PAGE, sentence);
  });

  // Correction 2 (F-6): four sentences the walk and the reader could not find. 6.1: both minimums
  // are named only when they differ, and which words speak for the model (pinned by execution in
  // validate-cacheability's "both bases", "C-4" and "F-5"). 6.2: a strict step and a plain one are
  // not named to each other; identical strict steps are; strict steps with different schemas are not
  // (pinned in this file's "F-6.2" cell). 6.3: on OpenAI the shared characters count Realm's text too
  // (the lib cells on a shared profile). 6.4: the OpenAI profile sentence, as two. (a) red when the
  // page drops a sentence; (b) prints the sentence.
  it('F-6: both minimums named only when they differ; strict and plain steps; what the chars count; the profile rule', () => {
    for (const sentence of [
      'When both give one, `--floor` decides. The line names both only when the numbers differ, as in `(1,000, your --floor; your economics file says 512)`; when they are the same, it names only `--floor`.',
      "`cannot cache on it` and `long enough to cache` speak for the model only when the minimum is the economics file's; a minimum given by `--floor` reads `at that minimum`.",
      'Two steps that differ only in `structured_output: strict`, one strict and one not, are not named to each other: a strict step sends a different fixed part.',
      'Two identical strict steps still name each other, on both providers, unless a floor puts them below the minimum on Anthropic or with an `o1` model; two strict steps with different schemas name nothing.',
      "On OpenAI the `<n> chars` count Realm's own text after the profile too, so with a short profile most of them are Realm's.",
      'The line says what the text shares, not how much of it is yours.',
      'On OpenAI, two steps that carry the same profile are named too when they first differ in the schema, which comes after it.',
      'The line then says `shares its first <n> chars with …: the schemas differ`.',
    ])
      claim(WORKFLOW_PAGE, sentence);
  });

  // Correction 2 (F-6.2), by execution: two steps with the same prompt and schema, one strict and
  // one not, are not named to each other; two identical strict steps are; two strict steps with
  // different schemas are not — on both providers. (a) red when a strict and a plain step are named
  // to each other, or identical strict steps are not; (b) prints each step's sharing clause.
  it('F-6.2: strict and plain are not named to each other; identical strict steps are', () => {
    const step = (id: string, required: string, strict: boolean): string =>
      `  ${id}:\n    description: s\n    execution: agent\n    prompt: Do it.\n${strict ? '    structured_output: strict\n' : ''}    output_schema:\n      type: object\n      additionalProperties: false\n      required: [${required}]\n      properties:\n        ${required}: { type: string }\n`;
    const dir = project({
      workflow: `id: strictness\nname: strictness\nversion: 1\nsteps:\n${[
        step('plain_a', 'response_draft', false),
        step('plain_b', 'response_draft', false),
        step('strict_a', 'response_draft', true),
        step('strict_b', 'response_draft', true),
        step('strict_c', 'other_field', true),
      ].join('')}`,
    });
    const clauses = (provider: string): string[] =>
      cacheLines(realm(['workflow', 'validate', dir, '--provider', provider]).stdout).map(
        (l) => / — (shares [^—]*)$/.exec(l)?.[1] ?? '',
      );
    const expected = [
      'shares its whole fixed part with plain_b',
      'shares its whole fixed part with plain_a',
      'shares its whole fixed part with strict_b',
      'shares its whole fixed part with strict_a',
      '',
    ];
    expect({ anthropic: clauses('anthropic'), openai: clauses('openai') }).toEqual({
      anthropic: expected,
      openai: expected,
    });
  });

  // Correction 3 (I-2, I-3, I-9a), by execution on two identical `structured_output: strict` steps.
  // Below the minimum, OpenAI keeps the clause (its own schema text is not counted), except with an
  // `o1` model, which takes the reasoning shape where the schema text is counted; Anthropic drops it.
  // With no floor and at --floor 100 both providers name the pair. With both providers shown, a
  // provider that names steps the other does not starts its part with its own name; a clause both
  // name alike has no label. (a) red when a sentence drops the exception, the o1 clause, the floor
  // clause or the label sentence, or a run says otherwise; (b) prints, per run, the verdict and the
  // share list, or the tail of each line.
  it('I-2, I-3, I-9a: below the minimum only OpenAI strict (not o1) names its twin; the provider label', () => {
    claim(
      WORKFLOW_PAGE,
      'the other steps that share it (on OpenAI also a start shared after a profile; none for a step below the minimum, except a `structured_output: strict` step on OpenAI with a model that is not an `o1` model)',
    );
    claim(
      DIAGNOSTICS_PAGE,
      'the other steps it shares a cacheable start with (a step below the minimum lists none, except a `structured_output: strict` step on OpenAI with a model that is not an `o1` model)',
    );
    for (const sentence of [
      "A step below the minimum names no sharing, because it cannot cache whatever it shares; on OpenAI with `structured_output: strict` and a model that is not an `o1` model, where the provider's own schema text is not counted, the clause stays.",
      'Two identical strict steps still name each other, on both providers, unless a floor puts them below the minimum on Anthropic or with an `o1` model; two strict steps with different schemas name nothing.',
      'When the two providers would not name the same steps, each provider that names any starts its part with its own name, once, as in `— anthropic: shares its whole fixed part with handle_bug, …` or `— openai: shares its whole fixed part with strict_b`; a provider that names none is left out, and with `--provider` there is one layout and no label.',
    ])
      claim(WORKFLOW_PAGE, sentence);
    const strict = (id: string): string =>
      `  ${id}:\n    description: s\n    execution: agent\n    prompt: Do it.\n    structured_output: strict\n${ELIGIBLE_SCHEMA}`;
    const twins = project({
      workflow: `id: twins\nname: twins\nversion: 1\nsteps:\n${strict('strict_a')}${strict('strict_b')}`,
    });
    const json = (args: string[]): [string | undefined, string[]] => {
      const layout = (
        JSON.parse(realm(['workflow', 'validate', twins, ...args, '--json']).stdout) as {
          cacheability: {
            steps: Array<{
              layouts: Array<{ verdict?: string; shares_with: Array<{ step: string }> }>;
            }>;
          };
        }
      ).cacheability.steps[0]!.layouts[0]!;
      return [layout.verdict, layout.shares_with.map((s) => s.step)];
    };
    expect({
      openai: json(['--provider', 'openai', '--floor', '2000']),
      anthropic: json(['--provider', 'anthropic', '--floor', '2000']),
      o1: json(['--provider', 'openai', '--model', 'o1', '--floor', '2000']),
      gpt4o: json(['--provider', 'openai', '--model', 'gpt-4o', '--floor', '2000']),
    }).toEqual({
      openai: ['below_floor', ['strict_b']],
      anthropic: ['below_floor', []],
      o1: ['below_floor', []],
      gpt4o: ['below_floor', ['strict_b']],
    });
    // The tail of a step's line: what follows its last ` — `.
    const tail = (dir: string, args: string[], step: string): string => {
      const line =
        cacheLines(realm(['workflow', 'validate', dir, ...args]).stdout).find((l) =>
          l.startsWith(`cache: ${step} `),
        ) ?? '';
      return line.slice(line.lastIndexOf(' — ') + 3);
    };
    const SHARES_B = 'shares its whole fixed part with strict_b';
    const BELOW = 'this step cannot cache at that minimum';
    const twin = (args: string[]): string => tail(twins, args, 'strict_a');
    expect({
      noFloor: [twin(['--provider', 'openai']), twin(['--provider', 'anthropic'])],
      floor100: [
        twin(['--provider', 'openai', '--floor', '100']),
        twin(['--provider', 'anthropic', '--floor', '100']),
      ],
      floor2000: [
        twin(['--provider', 'openai', '--floor', '2000']),
        twin(['--provider', 'anthropic', '--floor', '2000']),
        twin(['--provider', 'openai', '--model', 'o1', '--floor', '2000']),
      ],
    }).toEqual({
      noFloor: [SHARES_B, SHARES_B],
      floor100: [SHARES_B, SHARES_B],
      floor2000: [
        SHARES_B,
        `below the floor (2,000, your --floor): ${BELOW}`,
        `below the floor for o1 (2,000, your --floor): ${BELOW}`,
      ],
    });
    // I-9a: both providers shown. A split clause starts with its provider; a provider that names
    // none is left out; one provider, or a clause both name alike, has no label.
    const both2000 =
      cacheLines(realm(['workflow', 'validate', twins, '--floor', '2000']).stdout)[0] ?? '';
    expect({
      ex06: tail(ex('06-ticket-router'), ['--floor', '512'], 'handle_billing'),
      twins2000: [
        both2000.includes(' · openai 503 chars '),
        tail(twins, ['--floor', '2000'], 'strict_a'),
      ],
      ex06openai: tail(
        ex('06-ticket-router'),
        ['--provider', 'openai', '--floor', '512'],
        'handle_billing',
      ),
      twinsNoFloor: tail(twins, [], 'strict_a'),
    }).toEqual({
      ex06: 'anthropic: shares its whole fixed part with handle_bug, handle_feature, handle_account, handle_other',
      twins2000: [true, `openai: ${SHARES_B}`],
      ex06openai: `below the floor (512, your --floor): ${BELOW}`,
      twinsNoFloor: SHARES_B,
    });
  });

  // Tools, and the sharing words (correction 1, C-1.5): on Anthropic a whole shared part only; on
  // OpenAI also a pair that shares a whole profile and parts in the schema; no other start; long lists
  // capped. The cells that pin each fact: validate-cacheability's "C-1 Anthropic" and "C-1 names", and
  // lib/cacheability's two openai cells and its C-7 cell (a floor in force). Break: the page's sentence back to 894d0725's. (a) red when
  // the page drops a sentence or a run says otherwise; (b) prints the sentence, or the answers.
  it('a step with tools; the sharing forms: a whole part, and on openai a shared profile; long lists end `and N more`', () => {
    claim(
      WORKFLOW_PAGE,
      "A step that calls tools is not judged: each tool's definition comes from its MCP server when the step runs, so its request cannot be measured before a run:",
    );
    claim(
      WORKFLOW_PAGE,
      "**Steps that share a fixed part.** The line names the other steps whose fixed part is the same as this step's: `shares its whole fixed part with …`. On Anthropic nothing else is named: Anthropic writes its cache entry at the block Realm marks, and a read needs every character up to it, so two steps that part earlier share no entry. On OpenAI, two steps that carry the same profile are named too when they first differ in the schema, which comes after it. The line then says `shares its first <n> chars with …: the schemas differ`. With a minimum in force, they are named only when the estimate of the start they share reaches it or comes near it. On OpenAI the `<n> chars` count Realm's own text after the profile too, so with a short profile most of them are Realm's. The line says what the text shares, not how much of it is yours. No other shared start is named. A step below the minimum names no sharing, because it cannot cache whatever it shares; on OpenAI with `structured_output: strict` and a model that is not an `o1` model, where the provider's own schema text is not counted, the clause stays. The clause comes back with a lower floor or a longer fixed part. Two steps that differ only in `structured_output: strict`, one strict and one not, are not named to each other: a strict step sends a different fixed part. Two identical strict steps still name each other, on both providers, unless a floor puts them below the minimum on Anthropic or with an `o1` model; two strict steps with different schemas name nothing. A list of more than six steps names five and ends `and N more`. When the two providers would not name the same steps, each provider that names any starts its part with its own name, once, as in `— anthropic: shares its whole fixed part with handle_bug, …` or `— openai: shares its whole fixed part with strict_b`; a provider that names none is left out, and with `--provider` there is one layout and no label. From example 05, with `--provider anthropic`:",
    );
    const step = (id: string, required: string, profile?: string): string =>
      `  ${id}:\n    description: s\n    execution: agent\n    prompt: Do it.\n${profile !== undefined ? `    agent_profile: ${profile}\n` : ''}    output_schema:\n      type: object\n      additionalProperties: false\n      required: [${required}]\n      properties:\n        ${required}: { type: string }\n`;
    const workflow = (steps: string[]): string =>
      `id: shares\nname: shares\nversion: 1\nsteps:\n${steps.join('')}`;
    const pairs = project({
      workflow: workflow([
        step('cat_one', 'category'),
        step('cat_two', 'code'),
        step('pf_one', 'answer', 'p'),
        step('pf_two', 'summary', 'p'),
      ]),
      files: { 'profiles/p.md': 'P'.repeat(400) },
    });
    const anthropic = cacheLines(
      realm(['workflow', 'validate', pairs, '--provider', 'anthropic']).stdout,
    );
    const openai = cacheLines(
      realm(['workflow', 'validate', pairs, '--provider', 'openai']).stdout,
    );
    // C-7: the profile pair's shared start (655 chars, 131–262 tokens) is below 512: not named.
    const floored = cacheLines(
      realm(['workflow', 'validate', pairs, '--provider', 'openai', '--floor', '512']).stdout,
    );
    const profiles = cacheLines(
      realm(['workflow', 'validate', ex('03-incident-response'), '--provider', 'openai']).stdout,
    );
    const same = project({
      workflow: workflow(
        Array.from({ length: 13 }, (_, i) => step(`s${String(i + 1).padStart(2, '0')}`, 'answer')),
      ),
    });
    const long = cacheLines(
      realm(['workflow', 'validate', same, '--provider', 'openai']).stdout,
    )[0]!;
    expect([
      anthropic.map((l) => l.includes('shares')),
      openai.map((l) => / — shares its first [\d,]+ chars with \w+: the schemas differ$/.test(l)),
      floored.map((l) => l.includes('shares')),
      profiles.some((l) => l.includes('shares')),
      long.endsWith(' and 7 more'),
    ]).toEqual([
      [false, false, false, false],
      [false, false, true, true],
      [false, false, false, false],
      false,
      true,
    ]);
  });

  // The once-lines, the same verdict everywhere, a log's masking, and --json. Break: a once-line
  // printed per step, a key or environment variable changing a line, or the field gone. (a) red when
  // any answer differs; (b) prints the answers: booleans and realm's own masked line.
  it('once each; the same lines with or without keys in the environment; a log hides a value there too; --json has cacheability', () => {
    claim(
      WORKFLOW_PAGE,
      'After the step lines come the lines that hold for each provider shown, once:',
    );
    // Correction 1 re-pin: the paragraph's two halves, each word for word, since C-6.2 adds its own
    // sentences between them (that cell claims them). (a) each red when the page changes that half;
    // (b) prints the half the page no longer holds (claim's message), no environment.
    claim(
      WORKFLOW_PAGE,
      'The verdict is worked out the same way on every machine: Realm reads no key and no environment variable for it. The lines are printed like any other output, so in a log a value Realm hides elsewhere is hidden in them too.',
    );
    claim(
      WORKFLOW_PAGE,
      'With `--json`, `validate` gives the same facts in `cacheability`: see [the JSON output](../workflow/loader-diagnostics.md#--json).',
    );
    const five = realm(['workflow', 'validate', ex('05-parallel-code-review')]).stdout.split('\n');
    const lastStep = five.map((l) => l.startsWith('cache:')).lastIndexOf(true);
    const onceAt = five
      .map((l, i) => (l.startsWith('anthropic: ') || l.startsWith('openai: ') ? i : -1))
      .filter((i) => i >= 0);
    const args = ['workflow', 'validate', ex('01-code-reviewer'), '--floor', '512'];
    const bare = realm(args).stdout;
    const keyed = realm(args, {
      ANTHROPIC_API_KEY: 'test-key-not-real-0001',
      OPENAI_API_KEY: 'test-key-not-real-0002',
    }).stdout;
    const dir = project({
      example: '01-code-reviewer',
      economics: economics('claude-opus-9', 512),
    });
    const masked = cacheLines(
      realm(
        ['workflow', 'validate', dir, '--provider', 'anthropic', '--model', 'claude-sonnet-5-5'],
        { CELL_MODEL: 'claude-sonnet-5-5' },
      ).stdout,
    )[0]!;
    expect([
      onceAt.length === 3 && onceAt.every((i) => i > lastStep),
      cacheLines(bare).join('\n') === cacheLines(keyed).join('\n'),
      masked.endsWith(' — no entry for [REDACTED] in your economics file'),
      'cacheability' in
        (JSON.parse(
          realm(['workflow', 'validate', ex('01-code-reviewer'), '--json']).stdout,
        ) as object),
    ]).toEqual([true, true, true, true]);
  });

  // register and watch place the block. Break: register's block before the description line, or
  // watch printing it on every save. (a) red when the order or the count differs; (b) prints them.
  // Correction 2 (F-11): the page's three watch facts. Run here: a later block carries no provider
  // line (fact 1); an unchanged save prints `Registered:` and no cache line, and a profile changed
  // and changed back prints its first line again (fact 2). Fact 3 (the economics file is read on a
  // save, not on its own change) needs a second watch with --model: pinned word for word here; its
  // run is in the correction's report. (a) red when watch prints the provider lines twice, skips a
  // changed-back block, or the page drops a sentence.
  it('register: after the description line; watch: after the first Registered line, and again only when the lines change', async () => {
    claim(
      WORKFLOW_PAGE,
      'It prints the [cache lines](#the-cache-lines) after the description line.',
    );
    claim(
      WORKFLOW_PAGE,
      'It prints the [cache lines](#the-cache-lines) after the first `Registered` line, and again only when they change.',
    );
    for (const sentence of [
      '`watch` prints the lines for each provider once, in the first block that shows a size for that provider.',
      'After that block, a block carries the step lines only, so a log read from the middle can show step lines without them.',
      'A block is printed only when its lines differ from the last block printed.',
      'A save that leaves them as they were prints `Registered:` and no cache lines, and so does a repair that returns them to the block printed before a refused save.',
      'Lines that change and then change back are printed again.',
      'With `--model`, `watch` reads your economics file on each save of the workflow file or of one of its profile files, not when the economics file itself changes: an edit to it prints nothing until the next such save.',
    ])
      claim(WORKFLOW_PAGE, sentence);
    const described = project({
      workflow: oneStep('described').replace(
        'version: 1\n',
        'version: 1\ndescription: For the cell.\n',
      ),
    });
    const reg = realm(['workflow', 'register', described]).stdout.split('\n');
    const dir = project({
      workflow: oneStep('watched', '    agent_profile: p\n'),
      files: { 'profiles/p.md': 'You are careful.' },
    });
    const child = spawn(process.execPath, [DIST_CLI, 'workflow', 'watch', dir], {
      cwd: base,
      env: { PATH: process.env['PATH'] ?? '', HOME: home, REALM_NO_NUDGE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    const until = async (need: number): Promise<void> => {
      const end = Date.now() + 20_000;
      while (out.split('Registered:').length - 1 < need && Date.now() < end)
        await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 300));
    };
    try {
      await until(1);
      writeFileSync(join(dir, 'workflow.yaml'), oneStep('watched', '    agent_profile: p\n'));
      await until(2);
      writeFileSync(join(dir, 'profiles', 'p.md'), 'You are careful and brief.');
      await until(3);
      writeFileSync(join(dir, 'profiles', 'p.md'), 'You are careful.');
      await until(4);
      const lines = out.split('\n');
      const kinds = lines
        .map((l) =>
          l.includes('] Registered:')
            ? 'R'
            : l.includes('] cache:')
              ? 'C'
              : /\] (anthropic|openai): /.test(l)
                ? 'P'
                : '',
        )
        .filter((k) => k !== '')
        .join('');
      const caches = lines
        .filter((l) => l.includes('] cache:'))
        .map((l) => l.slice(l.indexOf('] cache:') + 2));
      expect([
        reg.indexOf('  For the cell.') + 1 === reg.findIndex((l) => l.startsWith('cache:')),
        kinds,
        caches.length === 3 && caches[2] === caches[0] && caches[1] !== caches[0],
      ]).toEqual([true, 'RCPPPRRCRC', true]);
    } finally {
      child.kill();
    }
  });

  // Correction 3 (I-5): the first block that shows a size is not the first block. A workflow with no
  // agent step prints `Registered:` alone; the save that adds one prints the step line and the
  // provider lines; an unchanged save prints `Registered:` alone; a refused save prints `Invalid:`
  // (on standard error, read here with standard output); the repair that returns to the block
  // printed before prints `Registered:` alone. The 300 ms settle after each count covers watch's
  // start-up gap (#919). (a) red when the provider lines come in a later block, an unchanged save or
  // the repair prints cache lines, or the page keeps "A later block carries the step lines only";
  // (b) prints the kinds string and the output, the scratch folder written `<dir>`.
  it('I-5: the provider lines come in the first block that shows a size; an unchanged save and a repair print none', async () => {
    claim(
      WORKFLOW_PAGE,
      '`watch` prints the lines for each provider once, in the first block that shows a size for that provider. After that block, a block carries the step lines only, so a log read from the middle can show step lines without them.',
    );
    expect(read(WORKFLOW_PAGE), 'the page keeps the old sentence').not.toContain(
      'A later block carries the step lines only',
    );
    const dir = project({
      workflow:
        'id: w\nname: w\nversion: 1\nsteps:\n  plain:\n    description: a step\n    execution: auto\n    depends_on: []\n    input_schema: { type: object, additionalProperties: true }\n',
    });
    const child = spawn(process.execPath, [DIST_CLI, 'workflow', 'watch', dir], {
      cwd: base,
      env: { PATH: process.env['PATH'] ?? '', HOME: home, REALM_NO_NUDGE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (out += c.toString()));
    const until = async (need: number): Promise<void> => {
      const end = Date.now() + 20_000;
      const count = (): number =>
        out.split('\n').filter((l) => /\] (Registered|Invalid):/.test(l)).length;
      while (count() < need && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 300));
    };
    try {
      await until(1);
      writeFileSync(join(dir, 'workflow.yaml'), oneStep('w'));
      await until(2);
      writeFileSync(join(dir, 'workflow.yaml'), oneStep('w'));
      await until(3);
      writeFileSync(join(dir, 'workflow.yaml'), 'id: w\nsteps: [unclosed\n');
      await until(4);
      writeFileSync(join(dir, 'workflow.yaml'), oneStep('w'));
      await until(5);
      const kinds = out
        .split('\n')
        .map((l) =>
          l.includes('] Registered:')
            ? 'R'
            : l.includes('] Invalid:')
              ? 'I'
              : l.includes('] cache:')
                ? 'C'
                : /\] (anthropic|openai): /.test(l)
                  ? 'P'
                  : '',
        )
        .filter((k) => k !== '')
        .join('');
      expect(kinds, hide(out)).toBe('RRCPPPRIR');
    } finally {
      child.kill();
    }
  });
});

describe('cache-economics.md, "The cache minimum"', { timeout: 60_000 }, () => {
  // The key, what reads it, its form, a dated model name, and pricing unchanged. Break: the floor not
  // read from the file, the dated name losing its entry, or a refusal's words. (a) red when a line or
  // an answer differs; (b) prints them.
  it('validate reads the key; pricing does not; it is a whole number, 1 or more; a dated name finds the same entry', () => {
    claim(
      ECONOMICS_PAGE,
      "A model's entry has `prices`, and may carry `min_cacheable_tokens` (see [The cache minimum](#the-cache-minimum)). `prices` is a list of one or more prices.",
    );
    claim(
      ECONOMICS_PAGE,
      "A model's entry may also carry `min_cacheable_tokens`: the fewest input tokens the provider caches for that model. `realm workflow validate`, `register` and `watch` read it when given `--provider` and `--model`, and say of each agent step whether its fixed part is long enough to be cached: see [the cache lines](cli/realm-workflow.md#the-cache-lines). Pricing does not read it. This key was added after version 0.48.0.",
    );
    claim(
      ECONOMICS_PAGE,
      'It is a whole number, 1 or more. A model name with a date at its end finds the same entry for its minimum as for its price.',
    );
    claim(
      ECONOMICS_PAGE,
      '| Has `min_cacheable_tokens: 0` | `economics/models/m/min_cacheable_tokens: must be >= 1` |',
    );
    claim(
      ECONOMICS_PAGE,
      '| Has a `min_cacheable_tokens` that is not a whole number | `economics/models/m/min_cacheable_tokens: must be integer` |',
    );
    const dir = project({
      example: '01-code-reviewer',
      economics: economics('claude-sonnet-5-5', 512),
    });
    const dated = cacheLines(
      realm([
        'workflow',
        'validate',
        dir,
        '--provider',
        'anthropic',
        '--model',
        'claude-sonnet-5-5-20261001',
      ]).stdout,
    )[0]!;
    const reason = (min: string): string => {
      const p = parseCacheEconomics(
        economics('m').replace('  m:\n', `  m:\n    min_cacheable_tokens: ${min}\n`),
      );
      return 'error' in p ? p.error.reason : 'ACCEPTED';
    };
    const price = (text: string): unknown => {
      const p = parseCacheEconomics(text);
      return 'economics' in p
        ? priceFromEconomics(p.economics, 'm', '2026-10-01T00:00:00Z', {
            prompt_tokens: 1000,
            output_tokens: 100,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
          })
        : p;
    };
    expect([
      dated.includes('(512, your economics file)'),
      reason('0'),
      reason('1.5'),
      JSON.stringify(price(economics('m', 512))) === JSON.stringify(price(economics('m'))),
    ]).toEqual([
      true,
      'economics/models/m/min_cacheable_tokens: must be >= 1',
      'economics/models/m/min_cacheable_tokens: must be integer',
      true,
    ]);
  });

  // The one-way door: the form a realm prints for a key its schema does not hold, executed here on a
  // sibling key; that realm 0.48.x holds no `min_cacheable_tokens` is INFERRED from its code (the
  // review's walk runs it on 0.48.0). Also the dated table: its date and its four sources; and
  // (correction 1, C-6.4) the Bedrock rows, AWS's own model names dated 2026-10-27 (MA 2's fetch,
  // registry MA2-BEDROCK-01, -02). Break: the upgrade line's words, the date, a source, or a
  // Bedrock row changed. (a) red when the page or the form differs, "Claude 5.x" or
  // "GPT-5.6, GPT-6.1" returns, or a model moves rows; (b) prints the reason, the missing text, or
  // the rows.
  it('the upgrade line, the table dated 2026-10-16 with its four sources, the Bedrock rows dated 2026-10-27, and the CHANGELOG door', () => {
    claim(
      ECONOMICS_PAGE,
      "**Upgrade every realm that reads the folder before adding the key.** A realm older than this release refuses a file carrying it, on every run's price line, with `your economics file: '<path>': economics/models/<id>: unknown key 'min_cacheable_tokens'`.",
    );
    claim(
      ECONOMICS_PAGE,
      "The minimums the providers published, as of 2026-10-16. Copy the table of the platform you call: Bedrock's differs from Anthropic's on Opus 4.7. For an OpenAI model before GPT-5.6, state no minimum: OpenAI says it varies with the request's settings.",
    );
    for (const url of [
      'https://platform.claude.com/docs/en/build-with-claude/prompt-caching',
      'https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html',
      'https://ai.google.dev/gemini-api/docs/caching',
      'https://developers.openai.com/api/docs/guides/prompt-caching',
    ])
      claim(ECONOMICS_PAGE, url);
    const lines = read(ECONOMICS_PAGE).split('\n');
    const at = lines.findIndex((l) => l.startsWith('| [Amazon Bedrock]'));
    expect([
      ...lines.slice(at, at + 3).map((l) =>
        l
          .split('|')
          .slice(1, 4)
          .map((c) => c.trim()),
      ),
      lines[at + 3]!.startsWith('| [Google Gemini]'),
    ]).toEqual([
      [
        '[Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html), as of 2026-10-27',
        '512',
        'Haiku 5.5, Sonnet 5.5, Opus 5.5, Fable 5.1, Mythos 5.1, Fable 5, Mythos 5, Opus 5',
      ],
      [
        '',
        '1,024',
        'Opus 4.8, Sonnet 5, Sonnet 4.6, Sonnet 4.5, 3.7 Sonnet, 3.5 Sonnet v2, GPT-6.1 Sol, GPT-6 Astra, GPT-5.6 Sol, GPT-5.6 Terra, GPT-5.6 Luna',
      ],
      ['', '4,096', 'Opus 4.7, Opus 4.6, Opus 4.5, Haiku 4.5'],
      true,
    ]);
    claim(
      CHANGELOG,
      "- **The economics file may carry `min_cacheable_tokens` in a model's entry (issue #600). This is a one-way door.** A realm older than this release refuses a file carrying it, on every run's price line: upgrade every realm that reads the folder before adding it.",
    );
    const p = parseCacheEconomics(
      economics('m').replace('  m:\n', '  m:\n    min_cacheable_token: 512\n'),
    );
    expect('error' in p ? p.error.reason : 'ACCEPTED').toBe(
      "economics/models/m: unknown key 'min_cacheable_token'",
    );
  });
});

/** A heading's anchor, as the site and GitHub make it: lower case, punctuation but `-` and `_`
 *  dropped, spaces to `-`. */
const slug = (heading: string): string =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/ /g, '-');
/** Correction 2 (F-8): where a link on `page` lands: `ok`, `no file`, or `no heading` (the anchor
 *  is no heading of the target page). */
function linkLands(page: string, href: string): string {
  const [file, anchor] = href.split('#');
  const target = join(dirname(join(ROOT, page)), file ?? '');
  if (!existsSync(target)) return 'no file';
  if (anchor === undefined) return 'ok';
  const headings = readFileSync(target, 'utf8')
    .split('\n')
    .filter((l) => /^#{1,6} /.test(l))
    .map((l) => slug(l.replace(/^#{1,6} /, '')));
  return headings.includes(anchor) ? 'ok' : 'no heading';
}

describe(
  'correction 2, F-10: the profile row says what the command did',
  { timeout: 60_000 },
  () => {
    // The page says what `profile file not read` means and what to do, and where `--registered`'s
    // sizes come from. Each runtime claim is run here on a scratch registration: the sizes follow the
    // profile file on disk while the copy's stored text stays as registered; with the folder gone, the
    // copy still holds the text, the row reads `profile file not read`, and the `N checks not run:`
    // line names the same reason. That runs send the stored text is pinned in
    // `agent/profile-reaches-the-model.test.ts` ("travels from the definition, through the drive, onto
    // the wire"). (a) red when the page drops a sentence, the old words return, or the sizes stop
    // following the file; (b) prints the page's sentence, or the lines, the scratch folder written
    // `<dir>`.
    it('F-10: the row, what to do, and where the --registered sizes come from', () => {
      for (const sentence of [
        "`profile file not read` means the command could not read the step's profile file, because the registered copy records no workflow folder, or the one it records is gone.",
        "The copy still holds the profile's text, and runs use it.",
        "What to do: register again from the workflow's folder, with `realm workflow register <path>`.",
        'The line above the cache lines that starts `1 check not run:` or `N checks not run:` names the same reason.',
        "With `--registered`, the sizes come from the profile files now in the workflow's folder, which is what registering again would store, not from the text the copy holds.",
      ])
        claim(WORKFLOW_PAGE, sentence);
      const dir = project({
        workflow:
          'id: moved\nname: moved\nversion: 1\nsteps:\n' +
          '  with_profile:\n    description: a\n    execution: agent\n    prompt: Do it.\n    agent_profile: p\n',
        files: { 'profiles/p.md': 'You are careful.' },
      });
      expect(realm(['workflow', 'register', dir]).code).toBe(0);
      const stored = (): number =>
        (
          JSON.parse(readFileSync(join(home, '.realm', 'workflows', 'moved.json'), 'utf8')) as {
            resolved_profiles: Record<string, { content: string }>;
          }
        ).resolved_profiles['p']!.content.length;
      const chars = (): number => {
        const line = cacheLines(
          realm(['workflow', 'validate', '--registered', 'moved']).stdout,
        )[0]!;
        return Number(/ — anthropic ([\d,]+) chars/.exec(line)?.[1]?.replace(/,/g, '') ?? -1);
      };
      const before = [chars(), stored()];
      writeFileSync(join(dir, 'profiles', 'p.md'), 'You are careful.' + 'x'.repeat(326));
      const after = [chars(), stored()];
      expect({ before, after, grew: after[0]! - before[0]! }).toEqual({
        before: [before[0], 16],
        after: [after[0], 16],
        grew: 326,
      });
      rmSync(dir, { recursive: true, force: true });
      const out = hide(realm(['workflow', 'validate', '--registered', 'moved']).stdout).split('\n');
      const reason = 'source_dir <dir>/proj no longer exists';
      expect(
        {
          held: stored(),
          row: out.find((l) => l.startsWith('cache: with_profile ')),
          // Correction 3 (I-4): both folders are gone, so two checks are left out: the line starts
          // `2 checks not run: ` exactly (a `2 check not run:` stays red).
          notRun: out.some((l) => /^2 checks not run: /.test(l) && l.includes(`(${reason})`)),
        },
        out.join('\n'),
      ).toEqual({
        held: 16,
        row: `cache: with_profile — profile file not read (${reason}): sizes not computed`,
        notRun: true,
      });
      // Correction 3 (I-4): one check left out reads `1 check not run:`. A workflow in a subfolder of
      // its trust root is registered, then the subfolder is removed: the trust root is still there,
      // so only the profile check is left out, and the row names the same reason. (a) red when the
      // singular and the plural swap, or the row loses the reason; (b) prints the lines, the scratch
      // folder written `<dir>`.
      const root = project({
        files: {
          'wf/workflow.yaml':
            'id: moved_wf\nname: moved_wf\nversion: 1\nsteps:\n' +
            '  with_profile:\n    description: a\n    execution: agent\n    prompt: Do it.\n    agent_profile: p\n',
          'wf/profiles/p.md': 'You are careful.',
        },
      });
      expect(realm(['workflow', 'register', join(root, 'wf')]).code).toBe(0);
      rmSync(join(root, 'wf'), { recursive: true, force: true });
      const one = hide(realm(['workflow', 'validate', '--registered', 'moved_wf']).stdout).split(
        '\n',
      );
      const oneReason = 'source_dir <dir>/proj/wf no longer exists';
      expect(
        {
          notRun: one.find((l) => / not run: /.test(l)),
          row: one.find((l) => l.startsWith('cache: with_profile ')),
        },
        one.join('\n'),
      ).toEqual({
        notRun: `1 check not run: agent-profile file resolution (${oneReason})`,
        row: `cache: with_profile — profile file not read (${oneReason}): sizes not computed`,
      });
    });
  },
);

describe('correction 2, F-8: the pages that print the cache lines say what they are', () => {
  // The five pages a new user meets the cache lines on carry one sentence and a link after the
  // transcript; realm-workflow.md defines the three words the provider lines use, each from a page
  // that already says it. (a) red when a sentence or a link is removed, or an anchor is renamed so
  // that no heading carries it; (b) prints the page and the sentence, or each link and where it
  // lands.
  // Correction 3 (I-7): `--prompt-cache` sets what ANTHROPIC is asked to cache; that a drive on
  // OpenAI refuses it is run in `commands/prompt-cache-600.test.ts`, G17 (`realm agent`) and G19
  // (`realm listen`). (a) red when the page says "the provider" again.
  it('F-8: each page carries its sentence, and each added link lands on a heading', () => {
    const pages: Array<[string, string]> = [
      [
        'docs/start/install-and-first-run.md',
        "The `cache:` lines and the `anthropic:` and `openai:` lines under them are about prompt caching: how big each agent step's fixed text is, and what each provider does with it. They matter once a model runs your agent steps, which `realm agent` does; you can ignore them here. [What they mean](../reference/cli/realm-workflow.md#the-cache-lines).",
      ],
      [
        'docs/guides/first-workflow.md',
        'Notice `Valid`. The `ℹ` line is a suggestion; the `cache:` lines and the `anthropic:` and `openai:` lines under them are about prompt caching, which matters once a model runs your agent steps, which `realm agent` does; you can ignore them all here. [What the cache lines mean](../reference/cli/realm-workflow.md#the-cache-lines).',
      ],
      [
        'docs/guides/agent-steps.md',
        'The `cache:` lines are explained under [The cache lines](../reference/cli/realm-workflow.md#the-cache-lines).',
      ],
      [
        'docs/guides/step-handlers.md',
        'The `cache:` lines are explained under [The cache lines](../reference/cli/realm-workflow.md#the-cache-lines).',
      ],
      [
        'docs/reference/workflow/top-level-fields.md',
        'The `cache:` lines are explained under [The cache lines](../cli/realm-workflow.md#the-cache-lines).',
      ],
    ];
    for (const [page, sentence] of pages) claim(page, sentence);
    // Correction 3 (I-9b, I-9c): the two first-use pages' sentences name the `cache:`, `anthropic:`
    // and `openai:` lines; the transcript right above each sentence holds them. A check of the page's
    // own text, not a run: no cell runs these two pages' commands (that is P-7, left for #902).
    // (a) red when that transcript loses one of the three kinds of line; (b) prints the page and the
    // kinds it found.
    const kindsAbove = (page: string, sentence: string): string[] => {
      const text = read(page);
      const open = text.lastIndexOf('```text\n', text.indexOf(sentence));
      const block = text.slice(open + 8, text.indexOf('\n```', open + 8)).split('\n');
      return ['cache:', 'anthropic:', 'openai:'].filter((s) => block.some((l) => l.startsWith(s)));
    };
    const firstUse = pages.slice(0, 2);
    expect(firstUse.map(([page, sentence]) => [page, kindsAbove(page, sentence)])).toEqual(
      firstUse.map(([page]) => [page, ['cache:', 'anthropic:', 'openai:']]),
    );
    for (const sentence of [
      '**Words on the provider lines.**',
      '_The drive_ is one `realm agent` driving one run, whether you start it or `realm listen` starts it for a run; its `--prompt-cache` flag sets what Anthropic is asked to cache (see [`realm agent`](realm-agent.md)).',
      "_Sent uncached, silently_: a fixed part shorter than the model's minimum is not cached, and the provider says nothing about it.",
      '_Pay the write_: the request that writes a cache entry is billed for what it writes at the cache-write price (see [How a request is priced](../cache-economics.md#how-a-request-is-priced) and [What a run costs](../../guides/realm-agent.md#what-a-run-costs)).',
    ])
      claim(WORKFLOW_PAGE, sentence);
    const links: Array<[string, string]> = [
      ...pages.map(([page, sentence]): [string, string] => [
        page,
        /\]\(([^)]+)\)/.exec(sentence)![1]!,
      ]),
      [WORKFLOW_PAGE, 'realm-agent.md'],
      [WORKFLOW_PAGE, '../cache-economics.md#how-a-request-is-priced'],
      [WORKFLOW_PAGE, '../../guides/realm-agent.md#what-a-run-costs'],
    ];
    expect(links.map(([page, href]) => `${page} → ${href}: ${linkLands(page, href)}`)).toEqual(
      links.map(([page, href]) => `${page} → ${href}: ok`),
    );
  });
});

describe('the --json row, the CHANGELOG, and review-note on its page', { timeout: 60_000 }, () => {
  // `cacheability` on the arms where a definition loaded, absent where the file could not be read.
  // Break: the field on a load failure, or missing on the refused arm. (a) red when an arm differs;
  // (b) prints booleans per arm.
  it('loader-diagnostics: cacheability on a valid and a refused arm, absent when the file could not be read', () => {
    claim(
      DIAGNOSTICS_PAGE,
      "| `cacheability` | Each agent step's fixed part, for each provider described: its size and token range, its blocks and their segments, the other steps it shares a cacheable start with (a step below the minimum lists none, except a `structured_output: strict` step on OpenAI with a model that is not an `o1` model), and its verdict or why it has none. `shares_with` lists exactly the steps the `cache:` line names, all of them when the line ends `and N more`. Each entry holds `step`, `chars` (the length of the shared start), `tokens` (the token range of that start; for a whole shared fixed part, the step's own range) and `divergence_at` (the name of the segment where the two steps part, or `null` when they are equal). It holds no prompt text, and is absent when the file could not be read. See [The cache lines](../cli/realm-workflow.md#the-cache-lines). Added after version 0.48.0. |",
    );
    const has = (workflow: string): boolean => {
      const dir = project({ workflow });
      return (
        'cacheability' in
        (JSON.parse(realm(['workflow', 'validate', dir, '--json']).stdout) as object)
      );
    };
    expect([
      has(oneStep('ok')),
      has(oneStep('refused', '    depend_on: [x]\n')),
      has('id: broken\nsteps: [\n'),
    ]).toEqual([true, true, false]);
  });

  // Correction 2 (F-2): the page says what `shares_with` holds — exactly the steps the line names,
  // all of them past `and N more`, and a whole share's `tokens` are the step's own range (pinned by
  // execution in validate-cacheability.test.ts "F-2 --json" and core's "F-2"). (a) red when the page
  // drops either sentence; (b) prints the sentence.
  it('F-2: loader-diagnostics says what `shares_with` holds', () => {
    for (const sentence of [
      '`shares_with` lists exactly the steps the `cache:` line names, all of them when the line ends `and N more`.',
      "Each entry holds `step`, `chars` (the length of the shared start), `tokens` (the token range of that start; for a whole shared fixed part, the step's own range) and `divergence_at` (the name of the segment where the two steps part, or `null` when they are equal).",
    ])
      claim(DIAGNOSTICS_PAGE, sentence);
  });

  // Correction 2 (F-3): since correction 1 the line names only a whole shared fixed part (and, on
  // OpenAI, a start shared after a profile), and none below the minimum (F-4). The four places that
  // said it names every step that "starts the same way" say what it names; the old phrases are gone
  // from both pages and from PR 5's own CHANGELOG bullet (sliced here: the bullet, not a section).
  // (a) red when a new phrase is dropped or an old phrase returns; (b) prints the file and the
  // phrase.
  it('F-3: the pages and the CHANGELOG bullet say what the line names, never "starts the same way"', () => {
    claim(
      WORKFLOW_PAGE,
      'the other steps that share it (on OpenAI also a start shared after a profile; none for a step below the minimum, except a `structured_output: strict` step on OpenAI with a model that is not an `o1` model)',
    );
    claim(WORKFLOW_PAGE, '**Steps that share a fixed part.**');
    claim(
      DIAGNOSTICS_PAGE,
      'the other steps it shares a cacheable start with (a step below the minimum lists none, except a `structured_output: strict` step on OpenAI with a model that is not an `o1` model)',
    );
    const log = read(CHANGELOG);
    const start = log.indexOf('- **`realm workflow validate`, `register` and `watch` say how big');
    expect(start, 'PR 5 bullet not found in the CHANGELOG').toBeGreaterThanOrEqual(0);
    const next = log.indexOf('\n- ', start + 1);
    const heading = log.indexOf('\n#', start + 1);
    const ends = [next, heading].filter((i) => i > 0);
    const bullet = log.slice(start, ends.length > 0 ? Math.min(...ends) : undefined);
    expect(flat(bullet), 'the CHANGELOG bullet').toContain(
      'the other steps with the same fixed text (on OpenAI, also a start they share after a profile)',
    );
    const OLD = ['starts the same way', 'start the same way', 'shares a beginning'];
    const texts: Array<[string, string]> = [
      ['realm-workflow.md', read(WORKFLOW_PAGE)],
      ['loader-diagnostics.md', read(DIAGNOSTICS_PAGE)],
      ['the CHANGELOG bullet', bullet],
    ];
    const found = texts.flatMap(([file, text]) =>
      OLD.filter((phrase) => flat(text).includes(phrase)).map((phrase) => `${file}: ${phrase}`),
    );
    expect(found).toEqual([]);
  });

  // The CHANGELOG's added bullet: the lines, no model and no key, the four flags, the --json field.
  // Break: a flag dropped. (a) red when a sentence or an answer differs; (b) prints them.
  it('the CHANGELOG: the lines on all three commands, the four flags, and validate --json', () => {
    claim(
      CHANGELOG,
      "- **`realm workflow validate`, `register` and `watch` say how big each agent step's fixed part is, which steps share it, and whether it can be cached (issue #600).** Each agent step gets a `cache:` line: the size of the text it sends ahead of its input on every call, the other steps with the same fixed text (on OpenAI, also a start they share after a profile), and, with a minimum, whether it is long enough to be cached at all. No model is called and no key is read. Four flags: `--provider`, `--model` (it needs `--provider`, and its minimum is read from your economics file), `--floor` (a minimum of your own) and `--ratio` (your own characters per token). `validate --json` gains `cacheability`.",
    );
    claim(
      WORKFLOW_PAGE,
      "An agent step sends the same text ahead of its input on every call: its profile, Realm's instructions and its schema. A provider can cache that fixed part, but not when it is shorter than the model's minimum, and then it says nothing. `validate`, `register` and `watch` print one `cache:` line for each agent step: the size of its fixed part, the other steps that share it (on OpenAI also a start shared after a profile; none for a step below the minimum, except a `structured_output: strict` step on OpenAI with a model that is not an `o1` model), and, when a minimum is known, whether the step can be cached at all. No model is called, and no key is read. These lines were added after version 0.48.0.",
    );
    const dir = project({
      example: '01-code-reviewer',
      economics: economics('claude-sonnet-5-5', 512),
    });
    const flags = [
      '--provider',
      'anthropic',
      '--model',
      'claude-sonnet-5-5',
      '--floor',
      '600',
      '--ratio',
      '3',
    ];
    expect(
      ['validate', 'register'].map((c) => {
        const r = realm(['workflow', c, dir, ...flags]);
        return [r.code, cacheLines(r.stdout).length];
      }),
    ).toEqual([
      [0, 1],
      [0, 1],
    ]);
  });

  // MA 2's option B: the page states the profile the transcript was made with. Built from the page
  // alone — its workflow block, the profile line its sentence states, and a module with the handler
  // the workflow names — validate prints the page's cache lines. Break: one word of the profile
  // sentence changed. (a) red when the page's lines differ from the run's; (b) prints both.
  it("top-level-fields: review-note's cache lines come from the profile its page states", () => {
    const page = read(FIELDS_PAGE);
    const stated = /holds one line: `([^`]+)`/.exec(page)?.[1] ?? '';
    const yaml = [...page.matchAll(/```yaml\n([\s\S]*?)```/g)]
      .map((m) => m[1]!)
      .find((b) => b.includes('id: review-note') && b.includes('steps:'))!;
    const transcript = /holds one line: `[^`]+`\n\n```text\n([\s\S]*?)```/.exec(page)?.[1] ?? '';
    const dir = project({
      workflow: yaml,
      files: {
        'personas/reviewer.md': `${stated}\n`,
        'registry.mjs':
          "export default { handlers: { file_result: { id: 'file_result', execute: async () => ({ data: {} }) } } };\n",
      },
    });
    const r = spawnSync(process.execPath, [DIST_CLI, 'workflow', 'validate', './'], {
      cwd: dir,
      env: { PATH: process.env['PATH'] ?? '', HOME: home },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect([stated, cacheLines(r.stdout)]).toEqual([
      'You are a reviewer.',
      transcript.split('\n').filter((l) => l.startsWith('cache:')),
    ]);
  });
});
