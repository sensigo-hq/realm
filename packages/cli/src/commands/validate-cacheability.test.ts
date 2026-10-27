// validate-cacheability.test.ts — issue #600 caching PR 5 (C5): the `cache:` lines `realm workflow
// validate`, `register` and `watch` print, one cell per producing branch (guardrail 7), each run
// through the BUILT `realm` with piped output. Fixtures are the repository's examples where they
// exist (01 review_changes; 03 the two profiles; 04 tag_content; 05 the whole-part pair; 06 seven
// steps; 09 the two tools steps), else a scratch workflow; each economics cell writes its own
// economics file. Every line is pinned whole. On a failing host a cell prints realm's own lines, with
// the scratch folder's path written `<dir>`: sizes, words, causes — never a key or an environment.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_CLI = join(CLI_DIR, 'dist', 'index.js');
const EXAMPLES = join(CLI_DIR, '..', '..', 'examples');
const ex = (name: string): string => join(EXAMPLES, name);

let home: string;
let base: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'realm-pr5-home-'));
  base = mkdtempSync(join(tmpdir(), 'realm-pr5-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
});

/** The built realm, piped, in a bare environment (HOME, PATH, the nudge off). */
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

/** The scratch folder's path, written `<dir>` (a failure prints no path). */
const hide = (text: string): string => text.split(base).join('<dir>');
/** The `cache:` lines of an output. */
const cacheLines = (stdout: string): string[] =>
  hide(stdout)
    .split('\n')
    .filter((l) => l.startsWith('cache:'));
/** The once-lines of an output. */
const onceLines = (stdout: string): string[] =>
  stdout.split('\n').filter((l) => l.startsWith('anthropic: ') || l.startsWith('openai: '));

/**
 * A scratch project: `<base>/proj` with a `package.json` (its trust root), the workflow (copied from
 * an example, or written), and — when `economics` is given — a `realm.yaml` naming `economics.yaml`
 * and that file (`null`: realm.yaml names it, the file does not exist).
 */
function project(opts: {
  example?: string;
  workflow?: string;
  profiles?: Record<string, string>;
  economics?: string | null;
}): string {
  const dir = join(base, 'proj');
  if (opts.example !== undefined) cpSync(ex(opts.example), dir, { recursive: true });
  else mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{}\n');
  if (opts.workflow !== undefined) writeFileSync(join(dir, 'workflow.yaml'), opts.workflow);
  for (const [name, text] of Object.entries(opts.profiles ?? {})) {
    mkdirSync(join(dir, 'profiles'), { recursive: true });
    writeFileSync(join(dir, 'profiles', name), text);
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

/** An economics file stating `min` (or no minimum) for `model`. */
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

/** One agent step: `extra` holds its other keys, two-space indented under the step. */
const oneStep = (id: string, extra = ''): string =>
  `id: ${id}\nname: ${id}\nversion: 1\nsteps:\n  ${id}:\n    description: a step\n    execution: agent\n    prompt: Do it.\n${extra}`;

const ELIGIBLE_SCHEMA = [
  '    output_schema:',
  '      type: object',
  '      additionalProperties: false',
  '      required: [answer]',
  '      properties:',
  '        answer: { type: string }',
  '',
].join('\n');

const ONCE_ANTHROPIC =
  "anthropic: on steps without tools, realm marks the fixed part for caching unless the drive's --prompt-cache turns it off; a fixed part below the model's minimum is sent uncached, silently";
const ONCE_OPENAI =
  "openai: realm sends no cache marker; the provider's own rules decide — see https://developers.openai.com/api/docs/guides/prompt-caching (as of 2026-10-16)";
const ONCE_SCOPE =
  "anthropic: the cache is kept per workspace (per organization on Bedrock and Google Cloud), as Anthropic's page said on 2026-10-09: drives from different workspaces each pay the write";

describe('the lines and verdicts (C5)', { timeout: 60_000 }, () => {
  // Break: the two-layout parenthetical's words changed (2.5–5), or the band left off the anthropic
  // size. (a) red when the default line changes; (b) prints the exit code and the cache lines.
  it('the default line: both layouts, sizes only, the band on anthropic', () => {
    const r = realm(['workflow', 'validate', ex('01-code-reviewer')]);
    expect([r.code, cacheLines(r.stdout)]).toEqual([
      0,
      [
        "cache: review_changes — anthropic 1,010 chars ≈ 422–934 tokens, with Anthropic's tool text · openai 515 chars ≈ 103–206 tokens (estimates: 2.5–5 chars/token, with margin)",
      ],
    ]);
  });

  // Break: two-layout near given its tail, or a layout's verdict dropped. (a) red when the line
  // changes; (b) prints the cache lines.
  it('--floor on both layouts: each layout its own verdict, before the ·', () => {
    const r = realm(['workflow', 'validate', ex('01-code-reviewer'), '--floor', '512']);
    expect(cacheLines(r.stdout)).toEqual([
      "cache: review_changes — anthropic 1,010 chars ≈ 422–934 tokens, with Anthropic's tool text — near the floor (512, your --floor) · openai 515 chars ≈ 103–206 tokens — below the floor (512, your --floor): this step cannot cache at that minimum",
    ]);
  });

  // Below on anthropic with a schema, at the economics file's 1,024: the band in the size clause, no
  // tail; "on it" because a model is named. Break: the `--model` words swapped ("at that minimum").
  // (a) red when the line changes; (b) prints the cache lines.
  it('below on anthropic at 1,024, from the economics file, with --model', () => {
    const dir = project({
      example: '01-code-reviewer',
      economics: economics('claude-sonnet-4-6', 1024),
    });
    const r = realm([
      'workflow',
      'validate',
      dir,
      '--provider',
      'anthropic',
      '--model',
      'claude-sonnet-4-6',
    ]);
    expect(cacheLines(r.stdout)).toEqual([
      "cache: review_changes — 1,010 chars ≈ 422–934 tokens, with Anthropic's tool text (estimate) — below the floor for claude-sonnet-4-6 (1,024, your economics file): this step cannot cache on it",
    ]);
  });

  // The band's cell: tag_content caches on claude-sonnet-5-5 (PR5M-04), and its bare bytes alone
  // (188–375) would read below 512. Break: the band dropped → below. (a) red when the band is not
  // added; (b) prints the cache lines.
  it("near on anthropic at 512 where realm's bytes alone would read below: examples/04 tag_content", () => {
    const dir = project({
      example: '04-content-pipeline',
      economics: economics('claude-sonnet-5-5', 512),
    });
    const r = realm([
      'workflow',
      'validate',
      dir,
      '--provider',
      'anthropic',
      '--model',
      'claude-sonnet-5-5',
    ]);
    expect(cacheLines(r.stdout)[1]).toBe(
      "cache: tag_content — 938 chars ≈ 408–905 tokens, with Anthropic's tool text (estimate) — near the floor for claude-sonnet-5-5 (512, your economics file): not judged from an estimate; --ratio <chars-per-token> narrows it — shares its first 177 chars with summarise: the schemas differ",
    );
  });

  // A no-schema anthropic step: realm sends no tool, so no band. Break: the band added to a step
  // without the tools block. (a) red when either line changes; (b) prints both runs' lines.
  it('a step with no schema: no tool, no band — on both layouts and on anthropic alone', () => {
    const dir = project({ workflow: oneStep('ask') });
    const both = realm(['workflow', 'validate', dir]);
    const one = realm(['workflow', 'validate', dir, '--provider', 'anthropic', '--floor', '512']);
    expect([cacheLines(both.stdout), cacheLines(one.stdout)]).toEqual([
      [
        'cache: ask — anthropic 155 chars ≈ 31–62 tokens (no schema: realm sends no tool) · openai 155 chars ≈ 31–62 tokens (estimates: 2.5–5 chars/token, with margin)',
      ],
      [
        'cache: ask — 155 chars ≈ 31–62 tokens (estimate) (no schema: realm sends no tool) — below the floor (512, your --floor): this step cannot cache at that minimum',
      ],
    ]);
  });

  // Below on openai strict with a schema: realm's bytes only, so the line says so (Δ9). Break: the
  // tail's guard negated (it then also reads on the plain path below). (a) red when the tail goes;
  // (b) prints the cache lines.
  it("below on openai strict with a schema ends with OpenAI's schema text not counted", () => {
    const dir = project({
      workflow: oneStep('strict_step', `    structured_output: strict\n${ELIGIBLE_SCHEMA}`),
    });
    const r = realm(['workflow', 'validate', dir, '--provider', 'openai', '--floor', '1024']);
    expect(cacheLines(r.stdout)).toEqual([
      "cache: strict_step — 503 chars ≈ 101–201 tokens (estimate) — below the floor (1,024, your --floor): this step cannot cache at that minimum; by realm's bytes — OpenAI's own schema text is not counted",
    ]);
  });

  // Below on openai without strict: no tail; "at that minimum" because no model is named. Break:
  // the tail printed on every openai below. (a) red when the line changes; (b) prints it.
  it('below on openai without strict, and without --model', () => {
    const r = realm([
      'workflow',
      'validate',
      ex('01-code-reviewer'),
      '--provider',
      'openai',
      '--floor',
      '512',
    ]);
    expect(cacheLines(r.stdout)).toEqual([
      'cache: review_changes — 515 chars ≈ 103–206 tokens (estimate) — below the floor (512, your --floor): this step cannot cache at that minimum',
    ]);
  });

  // Above on anthropic pins the band's low end through a verdict: analyze_cause's bare bytes give
  // lo 357 (near), the band gives 577 (above). Break: the band's low end lowered (220 → 150 reads
  // near). Above on openai: its own words. (a) red when either verdict or its words change;
  // (b) prints the cache lines.
  it("above: anthropic's words at 512 (examples/03), openai's at 200", () => {
    const a = realm([
      'workflow',
      'validate',
      ex('03-incident-response'),
      '--provider',
      'anthropic',
      '--floor',
      '512',
    ]);
    const o = realm([
      'workflow',
      'validate',
      ex('03-incident-response'),
      '--provider',
      'openai',
      '--floor',
      '200',
    ]);
    expect([cacheLines(a.stdout)[0], cacheLines(o.stdout)[0]]).toEqual([
      "cache: analyze_cause — 1,782 chars ≈ 577–1,244 tokens, with Anthropic's tool text (estimate) — above the floor (512, your --floor): long enough to cache when the drive asks for caching — shares its first 177 chars with draft_response: the schemas differ",
      "cache: analyze_cause — 1,118 chars ≈ 224–448 tokens (estimate) — above the floor (200, your --floor): within the provider's own rules (realm sends no marker)",
    ]);
  });

  // --ratio takes the author's count, which already includes Anthropic's tool text: no band, and the
  // interval is chars / r × 0.87 to × 1.15. Break: the band passed under --ratio. (a) red when
  // either line changes; (b) prints both runs' lines.
  it('--ratio on a banded step: no band; one layout and both layouts', () => {
    const one = realm([
      'workflow',
      'validate',
      ex('01-code-reviewer'),
      '--provider',
      'anthropic',
      '--ratio',
      '4',
    ]);
    const both = realm(['workflow', 'validate', ex('01-code-reviewer'), '--ratio', '4']);
    expect([cacheLines(one.stdout), cacheLines(both.stdout)]).toEqual([
      [
        'cache: review_changes — 1,010 chars ≈ 220–290 tokens (estimate: 4 chars/token ±15%, your --ratio) — the floor was not judged: no --model named',
      ],
      [
        'cache: review_changes — anthropic 1,010 chars ≈ 220–290 tokens · openai 515 chars ≈ 113–148 tokens (estimates: 4 chars/token ±15%, your --ratio)',
      ],
    ]);
  });

  // Δ16: text outside ASCII counts up to a token a character at the high end. Break: that term
  // dropped → the high end falls under 512 and the line reads below. (a) red when the line changes;
  // (b) prints it.
  it('a profile in Chinese: the high end counts each character, so it reads near at 512, not below', () => {
    const dir = project({
      workflow: oneStep('zh', '    agent_profile: zh\n'),
      profiles: { 'zh.md': '中'.repeat(1100) },
    });
    const r = realm(['workflow', 'validate', dir, '--provider', 'anthropic', '--floor', '512']);
    // 1,257 chars: 1,100 CJK, the profile's `\n\n`, realm's 155-char base (its em dash is non-ASCII):
    // hi = 156 / 2.5 + 1,101 = 1,163.4.
    expect(cacheLines(r.stdout)).toEqual([
      'cache: zh — 1,257 chars ≈ 252–1,163 tokens (estimate) (no schema: realm sends no tool) — near the floor (512, your --floor): not judged from an estimate; --ratio <chars-per-token> narrows it',
    ]);
  });

  // Both bases, differing: the flag wins and the line names both; --json carries economics_tokens.
  // Break: the second basis left out. (a) red when the line or the floor changes; (b) prints them.
  it('both bases, differing: "512, your --floor; your economics file says 1,024"', () => {
    const dir = project({
      example: '01-code-reviewer',
      economics: economics('claude-sonnet-4-6', 1024),
    });
    const args = [
      'workflow',
      'validate',
      dir,
      '--provider',
      'anthropic',
      '--model',
      'claude-sonnet-4-6',
      '--floor',
      '512',
    ];
    const r = realm(args);
    const j = realm([...args, '--json']);
    expect([
      cacheLines(r.stdout),
      (JSON.parse(j.stdout) as { cacheability: { floor: unknown } }).cacheability.floor,
    ]).toEqual([
      [
        "cache: review_changes — 1,010 chars ≈ 422–934 tokens, with Anthropic's tool text (estimate) — near the floor for claude-sonnet-4-6 (512, your --floor; your economics file says 1,024): not judged from an estimate; --ratio <chars-per-token> narrows it",
      ],
      { tokens: 512, basis: 'flag', economics_tokens: 1024 },
    ]);
  });
});

describe('the causes, one per row of the decision table (C5)', { timeout: 60_000 }, () => {
  // Row 1, with Δ7's conjunct: a non-empty `tools:` is not judged; `tools: []` takes the single-shot
  // path and is sized. Break: the predicate's `length > 0` conjunct dropped (the empty list then
  // reads "uses tools"). (a) red when either step's line changes; (b) prints the lines.
  it('row 1: a step with tools is not judged; one with `tools: []` is sized', () => {
    const r = realm(['workflow', 'validate', ex('09-webhook-pr-review')]);
    // The loader requires an input_schema on a step that declares `tools`, an empty list included.
    const dir = project({
      workflow: oneStep(
        'no_tools',
        '    tools: []\n    input_schema:\n      type: object\n      properties:\n        answer: { type: string }\n',
      ),
    });
    const empty = realm(['workflow', 'validate', dir, '--provider', 'anthropic']);
    expect([cacheLines(r.stdout), cacheLines(empty.stdout)]).toEqual([
      [
        "cache: fetch_pr — uses tools: each tool's definition comes from its MCP server at run time, so the request cannot be measured before a run: not judged",
        "cache: analyze_changes — uses tools: each tool's definition comes from its MCP server at run time, so the request cannot be measured before a run: not judged",
      ],
      [
        "cache: no_tools — 486 chars ≈ 318–725 tokens, with Anthropic's tool text (estimate) — the floor was not judged: no --model named",
      ],
    ]);
  });

  // Rows 2 and 5 by one route: --registered on a copy whose tree was deleted. The step that names a
  // profile cannot be sized; the other is sized, and its floor's economics were not checked. Break:
  // row 2 applied to every step (the profile-less one then reads "profile unavailable"), or row 5's
  // guard negated. (a) red when either line changes; (b) prints the lines.
  it('rows 2 and 5: --registered on a copy whose source tree is gone', () => {
    const dir = project({
      workflow:
        'id: gone-tree\nname: gone-tree\nversion: 1\nsteps:\n' +
        '  with_profile:\n    description: a\n    execution: agent\n    prompt: Do it.\n    agent_profile: p\n' +
        '  without_profile:\n    description: b\n    execution: agent\n    prompt: Do it.\n    depends_on: [with_profile]\n',
      profiles: { 'p.md': 'You are careful.' },
    });
    expect(realm(['workflow', 'register', dir]).code).toBe(0);
    rmSync(dir, { recursive: true, force: true });
    const r = realm(['workflow', 'validate', '--registered', 'gone-tree']);
    expect(cacheLines(r.stdout)).toEqual([
      'cache: with_profile — profile unavailable (source_dir <dir>/proj no longer exists): sizes not computed',
      'cache: without_profile — anthropic 155 chars ≈ 31–62 tokens (no schema: realm sends no tool) · openai 155 chars ≈ 31–62 tokens (estimates: 2.5–5 chars/token, with margin) — economics not checked (trust_root <dir>/proj no longer exists)',
    ]);
  });

  // Rows 6–10, each the economics file's own answer, and row 11. Break: a row's guard negated, or its
  // words changed. (a) red when any line changes; (b) prints each run's line.
  it('rows 6–11: no economics file; unreachable; unreadable; no entry; no minimum; no --model', () => {
    const line = (econ: string | null | undefined, model?: string): string => {
      rmSync(join(base, 'proj'), { recursive: true, force: true });
      const dir = project({
        example: '01-code-reviewer',
        ...(econ !== undefined ? { economics: econ } : {}),
      });
      const args = ['workflow', 'validate', dir, '--provider', 'anthropic'];
      return cacheLines(realm(model !== undefined ? [...args, '--model', model] : args).stdout)[0]!;
    };
    const SIZE =
      "cache: review_changes — 1,010 chars ≈ 422–934 tokens, with Anthropic's tool text (estimate)";
    expect([
      line(undefined, 'claude-sonnet-5-5'),
      line(null, 'claude-sonnet-5-5'),
      line('version: 2\ncurrency: USD\nmodels: {}\n', 'claude-sonnet-5-5'),
      line(economics('claude-sonnet-5-5', 512), 'claude-opus-9'),
      line(economics('claude-sonnet-5-5'), 'claude-sonnet-5-5'),
      line(economics('claude-sonnet-5-5', 512)),
    ]).toEqual([
      `${SIZE} — no economics file named in realm.yaml (runner.cache.economics); --floor tests a minimum`,
      `${SIZE} — economics unreachable: cannot read '<dir>/proj/economics.yaml': ENOENT`,
      `${SIZE} — your economics file: '<dir>/proj/economics.yaml': economics/version: must be equal to constant`,
      `${SIZE} — no entry for claude-opus-9 in your economics file`,
      `${SIZE} — no minimum stated for claude-sonnet-5-5 in your economics file`,
      `${SIZE} — the floor was not judged: no --model named`,
    ]);
  });

  // Row 3 shadows an economics file that does not parse: the flag decides, and the file's problem is
  // not printed. Break: the economics cause printed under --floor. (a) red when the line changes;
  // (b) prints it.
  it('row 3: --floor decides, and an unreadable economics file is not printed', () => {
    const dir = project({ example: '01-code-reviewer', economics: 'version: 2\n' });
    const r = realm([
      'workflow',
      'validate',
      dir,
      '--provider',
      'anthropic',
      '--model',
      'claude-sonnet-5-5',
      '--floor',
      '1024',
    ]);
    expect(cacheLines(r.stdout)).toEqual([
      "cache: review_changes — 1,010 chars ≈ 422–934 tokens, with Anthropic's tool text (estimate) — below the floor for claude-sonnet-5-5 (1,024, your --floor): this step cannot cache on it",
    ]);
  });
});

describe('the sharing (C5; Δ12)', { timeout: 60_000 }, () => {
  // The whole-part clause first, then the others by size. Break: the whole clause given a size or
  // put last. (a) red when the line changes; (b) prints it.
  it('whole: examples/05 review_security and review_performance send the same fixed part', () => {
    const r = realm([
      'workflow',
      'validate',
      ex('05-parallel-code-review'),
      '--provider',
      'anthropic',
    ]);
    expect(cacheLines(r.stdout)[0]).toBe(
      "cache: review_security — 954 chars ≈ 411–912 tokens, with Anthropic's tool text (estimate) — the floor was not judged: no --model named — shares its whole fixed part with review_performance; shares its first 177 chars with synthesize_review: the schemas differ",
    );
  });

  // Two steps with one schema, one of them strict. Break: the pair read from one side only (the
  // non-strict step then names no clause). (a) red when either line changes; (b) prints them.
  it('only structured_output: strict differs — read from both steps', () => {
    const step = (id: string, strict: boolean): string =>
      `  ${id}:\n    description: s\n    execution: agent\n    prompt: Do it.\n${strict ? '    structured_output: strict\n' : ''}${ELIGIBLE_SCHEMA}`;
    const dir = project({
      workflow: `id: strict-pair\nname: strict-pair\nversion: 1\nsteps:\n${step('plain', false)}${step('strict', true).replace('description: s', 'description: s\n    depends_on: [plain]')}`,
    });
    const r = realm(['workflow', 'validate', dir, '--provider', 'anthropic']);
    expect(cacheLines(r.stdout)).toEqual([
      "cache: plain — 588 chars ≈ 338–765 tokens, with Anthropic's tool text (estimate) — the floor was not judged: no --model named — shares its first 228 chars with strict: only structured_output: strict differs",
      "cache: strict — 602 chars ≈ 341–771 tokens, with Anthropic's tool text (estimate) — the floor was not judged: no --model named — shares its first 228 chars with plain: only structured_output: strict differs",
    ]);
  });

  // Not printed: a pair that parts inside the profile (examples/03's two profiles, on openai). Break:
  // the profile filter dropped (a 10-char "You are a " clause appears). (a) red when a sharing clause
  // appears; (b) prints the lines.
  it("not printed: examples/03's steps part inside their profiles on openai", () => {
    const r = realm(['workflow', 'validate', ex('03-incident-response'), '--provider', 'openai']);
    expect(cacheLines(r.stdout).map((l) => l.includes('shares'))).toEqual([false, false]);
  });
});

describe('the once-lines (C5; Δ15)', { timeout: 60_000 }, () => {
  // Break: a once-line printed per step, or a layout's line printed when that layout is not shown.
  // (a) red when any list changes; (b) prints the once-lines of each run.
  it('once for two steps; a layout not shown has none; the scope line only with anthropic', () => {
    const both = realm(['workflow', 'validate', ex('05-parallel-code-review')]);
    const openai = realm([
      'workflow',
      'validate',
      ex('05-parallel-code-review'),
      '--provider',
      'openai',
    ]);
    const anthropic = realm([
      'workflow',
      'validate',
      ex('05-parallel-code-review'),
      '--provider',
      'anthropic',
    ]);
    const tools = realm(['workflow', 'validate', ex('09-webhook-pr-review')]);
    expect([
      onceLines(both.stdout),
      onceLines(openai.stdout),
      onceLines(anthropic.stdout),
      onceLines(tools.stdout),
    ]).toEqual([
      [ONCE_ANTHROPIC, ONCE_OPENAI, ONCE_SCOPE],
      [ONCE_OPENAI],
      [ONCE_ANTHROPIC, ONCE_SCOPE],
      [],
    ]);
  });
});

describe('the refusals (C5.5)', { timeout: 60_000 }, () => {
  // Break: a refusal's guard negated or its words changed. (a) red when an exit code, a stderr line or
  // a non-empty stdout differs; (b) prints them.
  it('each of the three, on validate (with and without --json), register and watch', () => {
    const run = (args: string[]) => {
      const r = realm(args);
      return [r.code, r.stdout, r.stderr.trim()];
    };
    const MODEL =
      "Error: --provider is required with --model: realm does not guess a model's provider. Add --provider anthropic or --provider openai.";
    const v = ['workflow', 'validate', ex('01-code-reviewer')];
    expect([
      run([...v, '--model', 'claude-sonnet-5-5']),
      run([...v, '--model', 'claude-sonnet-5-5', '--json']),
      run([...v, '--floor', '0']),
      run([...v, '--floor', '1.5', '--json']),
      run([...v, '--ratio', '0']),
      run([...v, '--ratio', 'abc', '--json']),
      run(['workflow', 'register', ex('01-code-reviewer'), '--floor', 'x']),
      run(['workflow', 'watch', ex('01-code-reviewer'), '--model', 'claude-sonnet-5-5']),
    ]).toEqual([
      [1, '', MODEL],
      [1, '', MODEL],
      [1, '', "Error: --floor must be a whole number of tokens, 1 or more (got '0')."],
      [1, '', "Error: --floor must be a whole number of tokens, 1 or more (got '1.5')."],
      [1, '', "Error: --ratio must be a number of characters per token above 0 (got '0')."],
      [1, '', "Error: --ratio must be a number of characters per token above 0 (got 'abc')."],
      [1, '', "Error: --floor must be a whole number of tokens, 1 or more (got 'x')."],
      [1, '', MODEL],
    ]);
  });
});

describe('where the block prints (C5; Δ10)', { timeout: 60_000 }, () => {
  // Break: register's block printed before the description line. (a) red when the order changes;
  // (b) prints register's stdout lines.
  it('register: after the description line', () => {
    const dir = project({
      workflow: `${oneStep('described')}`.replace(
        'version: 1\n',
        'version: 1\ndescription: What it is for.\n',
      ),
    });
    const r = realm(['workflow', 'register', dir]);
    expect(hide(r.stdout).split('\n').slice(0, 3)).toEqual([
      'Registered: described v1 (1 step)',
      '  What it is for.',
      'cache: described — anthropic 155 chars ≈ 31–62 tokens (no schema: realm sends no tool) · openai 155 chars ≈ 31–62 tokens (estimates: 2.5–5 chars/token, with margin)',
    ]);
  });

  // watch: the block on the first save; not again on a save with the same block; again after a
  // profile change; every line with the time. Break: the block printed on every save, or never
  // again. (a) red when the cache lines seen after each save differ; (b) prints them, times cut.
  it('watch: first save, not on an unchanged save, again after a profile change; each line timed', async () => {
    const dir = project({
      workflow: oneStep('watched', '    agent_profile: p\n'),
      profiles: { 'p.md': 'You are careful.' },
    });
    const child = spawn(process.execPath, [DIST_CLI, 'workflow', 'watch', dir], {
      cwd: base,
      env: { PATH: process.env['PATH'] ?? '', HOME: home, REALM_NO_NUDGE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (out += c.toString()));
    const registered = (): number => out.split('Registered:').length - 1;
    const until = async (need: number): Promise<void> => {
      const end = Date.now() + 20_000;
      while (registered() < need && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 300));
    };
    try {
      await until(1);
      const first = out;
      writeFileSync(join(dir, 'workflow.yaml'), oneStep('watched', '    agent_profile: p\n'));
      await until(2);
      const second = out.slice(first.length);
      writeFileSync(join(dir, 'profiles', 'p.md'), 'You are careful and brief.');
      await until(3);
      const third = out.slice(first.length + second.length);
      const timed = (chunk: string) =>
        hide(chunk)
          .split('\n')
          .filter((l) => / cache: | anthropic: | openai: /.test(l))
          .map((l) => [/^\[\d{4}-\d\d-\d\dT[\d:.]+Z\] /.test(l), l.replace(/^\[[^\]]+\] /, '')]);
      // The once-lines print once per process: the third save's block carries the step line only.
      expect([timed(first), timed(second), timed(third)]).toEqual([
        [
          [
            true,
            'cache: watched — anthropic 173 chars ≈ 35–69 tokens (no schema: realm sends no tool) · openai 173 chars ≈ 35–69 tokens (estimates: 2.5–5 chars/token, with margin)',
          ],
          [true, ONCE_ANTHROPIC],
          [true, ONCE_OPENAI],
          [true, ONCE_SCOPE],
        ],
        [],
        [
          [
            true,
            'cache: watched — anthropic 183 chars ≈ 37–73 tokens (no schema: realm sends no tool) · openai 183 chars ≈ 37–73 tokens (estimates: 2.5–5 chars/token, with margin)',
          ],
        ],
      ]);
    } finally {
      child.kill();
    }
  });
});

describe('--json (C5; C3.6)', { timeout: 60_000 }, () => {
  // The shape: per step, per layout — the prefix, the stable blocks with their segments, the printed
  // shares, the band and the strict rung. Break: a key dropped or renamed. (a) red when the object
  // changes; (b) prints it (sizes, names and segment bounds only).
  it('the field: examples/01 on both layouts', () => {
    const r = realm(['workflow', 'validate', ex('01-code-reviewer'), '--json']);
    expect((JSON.parse(r.stdout) as { cacheability: unknown }).cacheability).toEqual({
      steps: [
        {
          step: 'review_changes',
          layouts: [
            {
              adapter: 'anthropic',
              prefix: { chars: 1010, tokens: { low: 422, high: 934 }, basis: 'default' },
              blocks: [
                {
                  name: 'tools',
                  chars: 441,
                  segments: [
                    { name: 'tool_header', start: 0, end: 118 },
                    { name: 'tool_schema', start: 118, end: 439 },
                  ],
                },
                {
                  name: 'system',
                  chars: 569,
                  segments: [
                    { name: 'base', start: 0, end: 209 },
                    { name: 'schema_line', start: 209, end: 569 },
                  ],
                },
              ],
              shares_with: [],
              extra_tokens: { low: 220, high: 530, source: 'anthropic_tool_text' },
              strict_rung: false,
              verdict: 'not_judged',
              not_judged_cause: 'no_model',
            },
            {
              adapter: 'openai',
              prefix: { chars: 515, tokens: { low: 103, high: 206 }, basis: 'default' },
              blocks: [
                {
                  name: 'system',
                  chars: 515,
                  segments: [
                    { name: 'base', start: 0, end: 155 },
                    { name: 'schema_line', start: 155, end: 515 },
                  ],
                },
              ],
              shares_with: [],
              strict_rung: false,
              verdict: 'not_judged',
              not_judged_cause: 'no_model',
            },
          ],
        },
      ],
    });
  });

  // No prompt text: the profile's words and the schema's text never reach stdout. Break: a block's
  // text put in the field. (a) red when either appears; (b) prints two booleans.
  it("no prompt text: examples/03's profile and schema are absent from --json", () => {
    const r = realm(['workflow', 'validate', ex('03-incident-response'), '--json']);
    expect([r.stdout.includes('You are a'), r.stdout.includes('"properties"')]).toEqual([
      false,
      false,
    ]);
  });

  // The class row (Δ3): the model id is a fact, printed raw in --json even when an environment
  // value equals it (a log masks such a value). Break: the `cacheability` row removed from the
  // table → it reads [REDACTED]. (a) red when the id is masked; (b) prints the id as printed.
  it('cacheability.model prints raw, even when the environment holds the same text', () => {
    const r = realm(
      [
        'workflow',
        'validate',
        ex('01-code-reviewer'),
        '--provider',
        'anthropic',
        '--model',
        'claude-sonnet-5-5',
        '--json',
      ],
      { CELL_MODEL: 'claude-sonnet-5-5' },
    );
    expect((JSON.parse(r.stdout) as { cacheability: { model: string } }).cacheability.model).toBe(
      'claude-sonnet-5-5',
    );
  });

  // OpenAI's schema text is not counted on a strict step with a schema: the layout says so. Break:
  // `not_counted` dropped. (a) red when the field changes; (b) prints the layout's keys.
  it('not_counted on an openai strict step with a schema', () => {
    const dir = project({
      workflow: oneStep('strict_step', `    structured_output: strict\n${ELIGIBLE_SCHEMA}`),
    });
    const r = realm(['workflow', 'validate', dir, '--provider', 'openai', '--json']);
    const layout = (
      JSON.parse(r.stdout) as {
        cacheability: { steps: Array<{ layouts: Array<Record<string, unknown>> }> };
      }
    ).cacheability.steps[0]!.layouts[0]!;
    expect([layout['not_counted'], layout['strict_rung'], layout['extra_tokens']]).toEqual([
      'provider_schema_text',
      true,
      undefined,
    ]);
  });
});
