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

/** A step for the sharing cells: a schema with one required string, a profile and strict if asked. */
const shareStep = (
  id: string,
  required: string,
  opts: { profile?: string; strict?: boolean } = {},
): string =>
  `  ${id}:\n    description: s\n    execution: agent\n    prompt: Do it.\n` +
  (opts.profile !== undefined ? `    agent_profile: ${opts.profile}\n` : '') +
  (opts.strict === true ? '    structured_output: strict\n' : '') +
  `    output_schema:\n      type: object\n      additionalProperties: false\n      required: [${required}]\n      properties:\n        ${required}: { type: string }\n`;
/** A workflow of the given steps. */
const shareWorkflow = (id: string, steps: string[]): string =>
  `id: ${id}\nname: ${id}\nversion: 1\nsteps:\n${steps.join('')}`;

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
      "cache: tag_content — 938 chars ≈ 408–905 tokens, with Anthropic's tool text (estimate) — near the floor for claude-sonnet-5-5 (512, your economics file): not judged from an estimate; --ratio <chars-per-token> narrows it",
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
      "cache: analyze_cause — 1,782 chars ≈ 577–1,244 tokens, with Anthropic's tool text (estimate) — above the floor (512, your --floor): long enough to cache when the drive asks for caching",
      "cache: analyze_cause — 1,118 chars ≈ 224–448 tokens (estimate) — above the floor (200, your --floor): within the provider's own rules (realm sends no marker)",
    ]);
  });

  // --ratio takes the author's count, which already includes Anthropic's tool text: no band, and the
  // interval is chars / (r × 1.15) to chars / (r × 0.85) (correction 1, C-2). Break: the band passed under --ratio. (a) red when
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
        'cache: review_changes — 1,010 chars ≈ 220–297 tokens (estimate: 4 chars/token ±15%, your --ratio) — the floor was not judged: no --model named',
      ],
      [
        'cache: review_changes — anthropic 1,010 chars ≈ 220–297 tokens · openai 515 chars ≈ 112–151 tokens (estimates: 4 chars/token ±15%, your --ratio)',
      ],
    ]);
  });

  // Correction 1 (C-2): the line's `±15%` is on characters per token, so at --ratio 4
  // examples/03's analyze_cause (1,782 chars) reads 388–524. A floor of 520 is inside that range:
  // near, never `cannot cache`. (a) red when the high end is chars / r × 1.15 again (520 then reads
  // below); (b) prints the two verdict clauses' heads.
  it('C-2: --ratio 4 on 1,782 chars reads 388–524 — near at 520, below at 525', () => {
    const verdict = (floor: string): string => {
      const line = cacheLines(
        realm([
          'workflow',
          'validate',
          ex('03-incident-response'),
          '--provider',
          'anthropic',
          '--ratio',
          '4',
          '--floor',
          floor,
        ]).stdout,
      )[0]!;
      const end = line.indexOf('your --floor)') + 'your --floor)'.length;
      return line.slice(line.indexOf('1,782'), end);
    };
    expect([verdict('520'), verdict('525')]).toEqual([
      '1,782 chars ≈ 388–524 tokens (estimate: 4 chars/token ±15%, your --ratio) — near the floor (520, your --floor)',
      '1,782 chars ≈ 388–524 tokens (estimate: 4 chars/token ±15%, your --ratio) — below the floor (525, your --floor)',
    ]);
  });

  // Correction 1 (C-3): a near verdict advises `--ratio` only when it was not passed. examples/06's
  // identify_ticket reads near at 512 with the default range, and near at 300 with --ratio 4
  // (250–338). (a) red when the advice is printed under --ratio; (b) prints both near clauses.
  it('C-3: the near clause names --ratio only when --ratio was not given', () => {
    const near = (args: string[]): string => {
      const line = cacheLines(
        realm(['workflow', 'validate', ex('06-ticket-router'), '--provider', 'anthropic', ...args])
          .stdout,
      )[0]!;
      return line.slice(line.indexOf(' — near'));
    };
    expect([near(['--floor', '512']), near(['--ratio', '4', '--floor', '300'])]).toEqual([
      ' — near the floor (512, your --floor): not judged from an estimate; --ratio <chars-per-token> narrows it',
      ' — near the floor (300, your --floor): not judged from an estimate',
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
      "cache: review_security — 954 chars ≈ 411–912 tokens, with Anthropic's tool text (estimate) — the floor was not judged: no --model named — shares its whole fixed part with review_performance",
    );
  });

  // Correction 1 (C-1): Anthropic names a whole shared fixed part only. Anthropic writes its cache
  // entry at the marked block, and a read needs every byte up to it, so a pair that parts earlier
  // shares none. cat_one and cat_two differ in schema, with first required names that start with the
  // same letter (they shared 178 chars at 894d0725, all Realm's own text); sp_plain and sp_strict
  // differ only in `structured_output: strict`; twin_a and twin_b are the same. On Anthropic the tools
  // block leads, so no pair there shares a whole profile: the break restores 894d0725's length rule.
  // (a) red when a partial share is named on Anthropic; (b) prints the lines.
  it('C-1 Anthropic: only a whole shared fixed part is named', () => {
    const dir = project({
      workflow: shareWorkflow('anth-share', [
        shareStep('cat_one', 'category'),
        shareStep('cat_two', 'code'),
        shareStep('sp_plain', 'answer', { profile: 'p' }),
        shareStep('sp_strict', 'answer', { profile: 'p', strict: true }),
        shareStep('twin_a', 'verdict'),
        shareStep('twin_b', 'verdict'),
      ]),
      profiles: { 'p.md': 'You are careful.' },
    });
    const r = realm(['workflow', 'validate', dir, '--provider', 'anthropic']);
    const NOT_JUDGED =
      "with Anthropic's tool text (estimate) — the floor was not judged: no --model named";
    expect(cacheLines(r.stdout)).toEqual([
      `cache: cat_one — 596 chars ≈ 340–769 tokens, ${NOT_JUDGED}`,
      `cache: cat_two — 580 chars ≈ 336–762 tokens, ${NOT_JUDGED}`,
      `cache: sp_plain — 606 chars ≈ 342–773 tokens, ${NOT_JUDGED}`,
      `cache: sp_strict — 620 chars ≈ 344–778 tokens, ${NOT_JUDGED}`,
      `cache: twin_a — 592 chars ≈ 339–767 tokens, ${NOT_JUDGED} — shares its whole fixed part with twin_b`,
      `cache: twin_b — 592 chars ≈ 339–767 tokens, ${NOT_JUDGED} — shares its whole fixed part with twin_a`,
    ]);
  });

  // Correction 1 (C-1.4): the names are capped in the rendering only. Seven identical steps name all
  // six others; thirteen name five and `and 7 more`, and --json's shares_with keeps all twelve.
  // (a) red when the cap is removed (twelve names) or applied to the steps (--json then lists five);
  // (b) prints the first line's sharing clause and the counts.
  it('C-1 names: six or fewer printed whole; more, the first five and `and N more`', () => {
    const run = (count: number, args: string[] = []) => {
      rmSync(join(base, 'proj'), { recursive: true, force: true });
      const ids = Array.from({ length: count }, (_, i) => `s${String(i + 1).padStart(2, '0')}`);
      const dir = project({
        workflow: shareWorkflow(
          `same-${String(count)}`,
          ids.map((id) => shareStep(id, 'answer')),
        ),
      });
      return realm(['workflow', 'validate', dir, ...args]);
    };
    const seven = cacheLines(run(7).stdout)[0]!;
    const thirteen = cacheLines(run(13).stdout)[0]!;
    const json = JSON.parse(run(13, ['--json']).stdout) as {
      cacheability: { steps: Array<{ layouts: Array<{ shares_with: unknown[] }> }> };
    };
    expect([
      seven.split(' — ').slice(-1)[0],
      thirteen.split(' — ').slice(-1)[0],
      json.cacheability.steps[0]!.layouts.map((l) => l.shares_with.length),
    ]).toEqual([
      'shares its whole fixed part with s02, s03, s04, s05, s06, s07',
      'shares its whole fixed part with s02, s03, s04, s05, s06 and 7 more',
      [12, 12],
    ]);
  });

  // Correction 1 (C-1): --json's shares_with holds the pairs the line names, no others: on Anthropic
  // a pair that parts is not listed, a whole-share pair is. (a) red when the filter and the clause
  // part ways (the raw pairs listed); (b) prints each step's listed names.
  it('C-1 --json: shares_with lists only the pairs the line names', () => {
    const dir = project({
      workflow: shareWorkflow('anth-json', [
        shareStep('cat_one', 'category'),
        shareStep('cat_two', 'code'),
        shareStep('twin_a', 'verdict'),
        shareStep('twin_b', 'verdict'),
      ]),
    });
    const r = realm(['workflow', 'validate', dir, '--provider', 'anthropic', '--json']);
    const steps = (
      JSON.parse(r.stdout) as {
        cacheability: {
          steps: Array<{ layouts: Array<{ shares_with: Array<{ step: string }> }> }>;
        };
      }
    ).cacheability.steps;
    expect(steps.map((s) => s.layouts[0]!.shares_with.map((w) => w.step))).toEqual([
      [],
      [],
      ['twin_b'],
      ['twin_a'],
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
