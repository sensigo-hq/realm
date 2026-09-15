// extension-namespace-559.test.ts — the `x-` author-extension namespace, CLI disclosure
// (issue #559). validate (file mode AND --registered mode) and register both compose the SAME
// clause — via the SAME helper (loader-warnings.ts) — directly onto their verdict line's own
// tail; there is no second, standalone line anywhere (see the D4 design note in the prompt for
// why that design changed after the pre-implementation audit).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCommand } from './validate.js';
import { registerCommand } from './register.js';
import { JsonWorkflowStore, CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';

// The crown fixture: examples/01-code-reviewer/workflow.yaml with an `x-category-enum` anchor
// host prepended, consumed TWICE (params_schema + the review_changes step's input_schema) — the
// cs1 production shape (plans/issue-559/crown-fixture.yaml).
const CROWN = `x-category-enum: &cats [billing, refund, other]
# examples/01-code-reviewer/workflow.yaml
id: code-reviewer
name: Code Reviewer
version: 1

params_schema:
  type: object
  additionalProperties: false
  required: [path]
  properties:
    category: { type: string, enum: *cats }
    path:
      type: string
      description: 'Path to the diff file to review'

services:
  diffs:
    adapter: filesystem
    trust: engine_delivered

steps:
  read_diff:
    description: Load the diff file from disk
    execution: auto
    depends_on: []
    uses_service: diffs
    operation: read
    input_map:
      path: run.params.path

  review_changes:
    description: Review the diff and produce a structured assessment.
    execution: agent
    depends_on: [read_diff]
    prompt: Review the diff and produce a structured assessment.
    input_schema:
      type: object
      additionalProperties: false
      required: [severity, summary, breaking_changes, action_required]
      properties:
        severity:
          type: string
          enum: *cats
        summary:
          type: string
          minLength: 20
        breaking_changes:
          type: boolean
        action_required:
          type: boolean

  record_review:
    description: Record the structured code review
    execution: auto
    depends_on: [review_changes]
`;

const PLAIN = `id: plain-wf
name: Plain
version: 1
steps:
  s:
    description: d
    execution: auto
`;

describe('the `x-` extension namespace — CLI disclosure (issue #559)', () => {
  let dir: string;
  let home: string;
  let originalHome: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'realm-559-'));
    home = mkdtempSync(join(tmpdir(), 'realm-559-home-'));
    mkdirSync(join(home, '.realm', 'workflows'), { recursive: true });
    originalHome = process.env['HOME'];
    process.env['HOME'] = home;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const write = (body: string): string => {
    const p = join(dir, 'workflow.yaml');
    writeFileSync(p, body, 'utf8');
    return p;
  };
  const logs = (): string[] => logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
  const all = (): string =>
    [logSpy, warnSpy, errSpy]
      .flatMap((s) => s.mock.calls.map((c: unknown[]) => String(c[0])))
      .join('\n');

  it('C1 validate: the crown fixture prints ONE line, the verdict tail carries the clause', async () => {
    await validateCommand.parseAsync([write(CROWN)], { from: 'user' });
    expect(exitSpy).not.toHaveBeenCalled();
    expect(logs()).toContain(
      'Valid: code-reviewer v1 (3 steps) — 1 extension key carried, never read by realm: x-category-enum',
    );
    // No standalone earlier line — the whole disclosure lives in the verdict tail, exactly once.
    expect(logs().filter((l) => l.includes('extension key'))).toHaveLength(1);
  });

  it('C2 two keys give the plural clause, in authored order', async () => {
    await validateCommand.parseAsync([write(`x-a: 1\nx-b: 2\n${PLAIN}`)], { from: 'user' });
    expect(logs()).toContain(
      'Valid: plain-wf v1 (1 step) — 2 extension keys carried, never read by realm: x-a, x-b',
    );
  });

  it('C3 --json carries extension_keys on the success arm', async () => {
    await validateCommand.parseAsync([write(CROWN), '--json'], { from: 'user' });
    const obj = JSON.parse(logs().join('\n')) as Record<string, unknown>;
    expect(obj['valid']).toBe(true);
    expect(obj['warning_count']).toBe(0);
    expect(obj['diagnostics']).toEqual([]);
    expect(obj['extension_keys']).toEqual(['x-category-enum']);
  });

  it('C4 CONTROL: no x- key means no clause at all, extension_keys []', async () => {
    await validateCommand.parseAsync([write(PLAIN), '--json'], { from: 'user' });
    const obj = JSON.parse(logs().join('\n')) as Record<string, unknown>;
    expect(obj['extension_keys']).toEqual([]);
    logSpy.mockClear();
    await validateCommand.parseAsync([write(PLAIN)], { from: 'user' });
    expect(all()).not.toContain('extension key');
    expect(logs()).toContain('Valid: plain-wf v1 (1 step)');
  });

  it('C5 --strict on the crown exits 0 (no warning exists — the namespace mints none)', async () => {
    await validateCommand.parseAsync([write(CROWN), '--strict'], { from: 'user' });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('C6 a reserved key refuses with the D2 message, and extension_keys is [] under --json', async () => {
    await expect(
      validateCommand.parseAsync([write(`x-realm-foo: 1\n${PLAIN}`)], { from: 'user' }),
    ).rejects.toThrow('process.exit');
    expect(all()).toContain(
      "⚠ workflow 'plain-wf': unknown key 'x-realm-foo' (line 1) — the 'x-realm-' prefix is reserved for realm's own future extension keys; any other 'x-' name is yours to use (an extension key is carried verbatim and never read).",
    );
    expect(all()).toContain(
      "Invalid: 1 warning, 1 escalated to an error by policy: UNKNOWN_WORKFLOW_KEY 'x-realm-foo'",
    );
    logSpy.mockClear();
    warnSpy.mockClear();
    errSpy.mockClear();
    await expect(
      validateCommand.parseAsync([write(`x-realm-foo: 1\n${PLAIN}`), '--json'], { from: 'user' }),
    ).rejects.toThrow('process.exit');
    const obj = JSON.parse(logs().join('\n')) as Record<string, unknown>;
    expect(obj['valid']).toBe(false);
    expect(obj['extension_keys']).toEqual([]);
  });

  it('C7 register: one line carries both the verdict and the clause; the stored copy round-trips the key', async () => {
    await registerCommand.parseAsync([write(CROWN)], { from: 'user' });
    expect(logs()).toContain(
      'Registered: code-reviewer v1 (3 steps) — 1 extension key carried, never read by realm: x-category-enum',
    );
    const got = (await new JsonWorkflowStore().get('code-reviewer')) as unknown as Record<
      string,
      unknown
    >;
    expect(got['x-category-enum']).toEqual(['billing', 'refund', 'other']);
    expect(
      (got['params_schema'] as { properties: { category: { enum: string[] } } }).properties.category
        .enum,
    ).toEqual(['billing', 'refund', 'other']);
    expect(
      (
        (got['steps'] as Record<string, { input_schema: { properties: { severity: unknown } } }>)[
          'review_changes'
        ]!.input_schema.properties.severity as { enum: string[] }
      ).enum,
    ).toEqual(['billing', 'refund', 'other']);
  });

  it('C7b register --strict on the crown registers clean (no warning exists)', async () => {
    await registerCommand.parseAsync([write(CROWN), '--strict'], { from: 'user' });
    expect(exitSpy).not.toHaveBeenCalled();
    expect(logs().some((l) => l.startsWith('Registered: code-reviewer'))).toBe(true);
  });

  it('C8 validate --registered: the clause on the verdict line, and in --json', async () => {
    await registerCommand.parseAsync([write(CROWN)], { from: 'user' });
    logSpy.mockClear();
    await validateCommand.parseAsync(['--registered', 'code-reviewer'], { from: 'user' });
    expect(logs()).toContain(
      'Valid: code-reviewer v1 (3 steps) — 1 extension key carried, never read by realm: x-category-enum',
    );
    logSpy.mockClear();
    await validateCommand.parseAsync(['--registered', 'code-reviewer', '--json'], {
      from: 'user',
    });
    const obj = JSON.parse(logs().join('\n')) as Record<string, unknown>;
    expect(obj['extension_keys']).toEqual(['x-category-enum']);
  });

  it('C9 a step-level x- key is refused with the D3 message (never the D2 one)', async () => {
    await expect(
      validateCommand.parseAsync(
        [
          write(
            'id: w\nname: W\nversion: 1\nsteps:\n  s:\n    description: d\n    execution: auto\n    x-foo: 1\n',
          ),
        ],
        { from: 'user' },
      ),
    ).rejects.toThrow('process.exit');
    expect(all()).toContain(
      "⚠ step 's': unknown key 'x-foo' (line 8) — 'x-' extension keys are accepted only at the top level of a workflow file; step keys are a closed set. Move it to the top of the file.",
    );
  });

  it('C10 the phrase "carried, never read by realm" is minted in exactly one non-test src file', () => {
    const hits: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d)) {
        const f = join(d, e);
        if (statSync(f).isDirectory()) {
          walk(f);
          continue;
        }
        if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
        if (readFileSync(f, 'utf8').includes('carried, never read by realm')) hits.push(f);
      }
    };
    walk(join(import.meta.dirname, '..'));
    expect(hits.map((h) => h.split('/src/')[1])).toEqual(['lib/loader-warnings.ts']);
  });

  it('C11 a case-only miss prints the lowercase arm, the escalation line, exit 1, and no keys', async () => {
    await expect(
      validateCommand.parseAsync([write(`X-Category-Enum: [a, b]\n${PLAIN}`)], { from: 'user' }),
    ).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(all()).toContain(
      "⚠ workflow 'plain-wf': unknown key 'X-Category-Enum' (line 1) — the extension namespace is lowercase: a key starting 'x-' is the author's, carried verbatim and never read; 'X-Category-Enum' is not one.",
    );
    expect(all()).toContain(
      "Invalid: 1 warning, 1 escalated to an error by policy: UNKNOWN_WORKFLOW_KEY 'X-Category-Enum'",
    );
  });

  it('C11b --json on the case-only arm: extension_keys is [], valid false (a CONTROL — already true pre-correction, no red-first)', async () => {
    await expect(
      validateCommand.parseAsync([write(`X-Category-Enum: [a, b]\n${PLAIN}`), '--json'], {
        from: 'user',
      }),
    ).rejects.toThrow('process.exit');
    const obj = JSON.parse(logs().join('\n')) as Record<string, unknown>;
    expect(obj['valid']).toBe(false);
    expect(obj['extension_keys']).toEqual([]);
  });

  it('the tail ORDER cell: not-run + extension + strict all compose, in that order', async () => {
    // A hand-planted stored record (the `register`-writes shape, issue #553's own fixture idiom):
    // source_dir/trust_root point at a tree that is then removed, so the project-extensions
    // check declares itself not-run; a top-level x-a key carries the extension clause; a
    // 'warn'-grade retry sub-key typo supplies the --strict-failing warning. All three fire on
    // one --registered --strict run, in the mandated order: not-run; extension; warning-strict.
    const tree = mkdtempSync(join(tmpdir(), 'realm-559-tree-'));
    mkdirSync(join(tree, 'wf'), { recursive: true });
    writeFileSync(
      join(home, '.realm', 'workflows', 'order-wf.json'),
      JSON.stringify({
        id: 'order-wf',
        name: 'Order',
        version: 1,
        schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
        origin: 'human',
        'x-a': 1,
        source_dir: join(tree, 'wf'),
        trust_root: join(tree, 'wf'),
        steps: {
          s: {
            description: 'd',
            execution: 'auto',
            timeout_seconds: 60,
            retry: { max_attempts: 3, backoff: 'fixed', base_delay_ms: 10, bogus_retry_key: 1 },
          },
        },
      }),
      'utf8',
    );
    rmSync(tree, { recursive: true, force: true });

    await expect(
      validateCommand.parseAsync(['--registered', 'order-wf', '--strict'], { from: 'user' }),
    ).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    // The detailed reason for the not-run count is its own earlier line (issue #553); the
    // verdict tail composes just the counts, in the mandated order: not-run; extension; strict.
    expect(all()).toContain(
      `1 check not run: project extensions (modules, manifest, config_schema) (trust_root ${join(tree, 'wf')} no longer exists)`,
    );
    expect(all()).toContain(
      'Valid: order-wf v1 (1 step) — 1 check not run; 1 extension key carried, never read by realm: x-a; 1 warning; failing due to --strict',
    );
  });
});
