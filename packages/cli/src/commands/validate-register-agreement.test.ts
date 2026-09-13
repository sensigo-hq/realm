// issue #553 — validate ≡ register, executed at the COMMAND boundary on the built dist (the
// validate-orphan-manifest idiom: a unit call can pass while the command path stays blind).
//
// Red-first on `05439cf` (executed, origin dist): c1–c5 → validate `Valid: wf v1 (1 step)` exit 0
// while register refused each; the invalid manifest → validate `Valid`, register `Error loading
// extensions:`; the sentinel manifest → validate printed only `Valid`, register the ⚠ block;
// the missing file → validate `Error: ENOENT: …` from its own readFileSync, register the
// loader's `Failed to read workflow file:` sentence.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_CLI = join(CLI_DIR, 'dist', 'index.js');

let home: string;
let base: string;

function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [DIST_CLI, ...args],
      { timeout: 20_000, env: { ...process.env, HOME: home, REALM_NO_NUDGE: '1' } },
      (err, stdout, stderr) => {
        const code = err !== null && typeof err.code === 'number' ? err.code : err !== null ? 1 : 0;
        resolvePromise({ code, stdout, stderr });
      },
    );
  });
}

const HEAD = 'id: wf\nname: WF\nversion: 1\n';
const STEP = 'steps:\n  s1:\n    description: a\n    execution: agent\n';

function fixture(name: string, yaml: string, extra: Record<string, string> = {}): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'workflow.yaml'), yaml, 'utf8');
  for (const [file, content] of Object.entries(extra))
    writeFileSync(join(dir, file), content, 'utf8');
  return dir;
}

const firstLine = (s: string): string => s.split('\n')[0] ?? '';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'realm-553-home-'));
  base = mkdtempSync(join(tmpdir(), 'realm-553-fx-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
});

describe('cell 1 — the five census members: validate refuses byte-identically to register', () => {
  const census: ReadonlyArray<{ name: string; yaml: string; message: (dir: string) => string }> = [
    {
      name: 'c1 agent_profile not found',
      yaml: `${HEAD}${STEP}    agent_profile: nope\n`,
      message: (dir) =>
        `Invalid workflow: Step 's1': agent_profile 'nope' not found. Searched: ${join(dir, 'profiles', 'nope.md')}`,
    },
    {
      name: 'c2 context_wrapper enum',
      yaml: `${HEAD}${STEP}context_wrapper: bogus_format\n`,
      message: () =>
        "Invalid workflow: 'context_wrapper' must be 'xml', 'brackets', or 'none' (found: 'bogus_format') (line 8)",
    },
    {
      name: 'c3 workflow_context name ends .raw',
      yaml: `${HEAD}${STEP}workflow_context:\n  notes.raw:\n    source:\n      path: ./n.md\n`,
      message: () =>
        "Invalid workflow: workflow_context entry 'notes.raw' must not end with '.raw' (line 9)",
    },
    {
      name: 'c4 workflow_context name charset',
      yaml: `${HEAD}${STEP}workflow_context:\n  my-notes:\n    source:\n      path: ./n.md\n`,
      message: () =>
        "Invalid workflow: workflow_context entry 'my-notes' must match [\\w.]+ (underscores and dots only — no hyphens) (line 9)",
    },
    {
      name: 'c5 source.path required',
      yaml: `${HEAD}${STEP}workflow_context:\n  notes:\n    description: no source\n`,
      message: () => 'Invalid workflow: workflow_context.notes.source.path is required (line 9)',
    },
  ];

  it.each(census)(
    '$name',
    async ({ name, yaml, message }) => {
      const dir = fixture(name.slice(0, 2), yaml);
      const v = await runCli(['workflow', 'validate', dir]);
      const r = await runCli(['workflow', 'register', dir]);
      expect(v.code).toBe(1);
      expect(r.code).toBe(1);
      expect(v.stdout).toBe('');
      expect(firstLine(v.stderr)).toBe(message(dir));
      expect(firstLine(r.stderr)).toBe(message(dir));
      expect(v.stderr).toBe(r.stderr);
    },
    25_000,
  );
});

describe('cell 2 — the manifest pass runs on validate exactly as on register', () => {
  it('an invalid realm.yaml at the trust root → both `Error loading extensions:`, byte-identical, exit 1', async () => {
    const dir = fixture('mcase', `${HEAD}${STEP}`, {
      'package.json': '{"type":"module"}',
      'realm.yaml': 'version: 1\nadapters: [\n',
    });
    const v = await runCli(['workflow', 'validate', dir]);
    const r = await runCli(['workflow', 'register', dir]);
    expect(v.code).toBe(1);
    expect(r.code).toBe(1);
    expect(firstLine(v.stderr)).toBe(
      `Error loading extensions: Deployment manifest '${join(dir, 'realm.yaml')}' is not valid YAML: unexpected end of the stream within a flow collection (3:1)`,
    );
    expect(v.stderr).toBe(r.stderr);
  }, 25_000);

  it('twin — an unresolvable manifest secret: the same ⚠ block, `Validating` vs `Registering`, both exit 0', async () => {
    const dir = fixture('stree', `${HEAD}${STEP}`, {
      'package.json': '{"type":"module"}',
      'realm.yaml':
        "version: 1\nadapters:\n  github:\n    use: github\n    config: { auth: { token: '${secret:GITHUB_TOKEN}' } }\n",
    });
    const v = await runCli(['workflow', 'validate', dir]);
    const r = await runCli(['workflow', 'register', dir]);
    expect(v.code).toBe(0);
    expect(r.code).toBe(0);
    const vLines = v.stderr.split('\n');
    const rLines = r.stderr.split('\n');
    expect(vLines[0]).toBe('⚠ Deployment manifest secrets: 1 unresolved secret reference(s):');
    expect(vLines[0]).toBe(rLines[0]);
    // Real-then-sentinel: the message names the dotenv source it READ before degrading.
    expect(v.stderr).toContain(`dotenv (${join(dir, '.env')})`);
    const vSentinel = vLines.find((l) => l.includes('with SENTINEL credentials'));
    const rSentinel = rLines.find((l) => l.includes('with SENTINEL credentials'));
    expect(vSentinel).toBe(
      '⚠ Validating with SENTINEL credentials — execution paths still require real secret resolution.',
    );
    expect(rSentinel).toBe(
      '⚠ Registering with SENTINEL credentials — execution paths still require real secret resolution.',
    );
    expect(v.stderr.replace('Validating', 'Registering')).toBe(r.stderr);
    expect(firstLine(v.stdout)).toBe('Valid: wf v1 (1 step)');
    expect(firstLine(r.stdout)).toBe('Registered: wf v1 (1 step)');
  }, 25_000);
});

describe('cell 3 — read failure: one SENTENCE, the last remaining channel split', () => {
  it('missing file → validate `Invalid:`-prefixed, register `Error:`-prefixed, the loader sentence on both', async () => {
    const missing = join(base, 'missing', 'workflow.yaml');
    const v = await runCli(['workflow', 'validate', missing]);
    const r = await runCli(['workflow', 'register', missing]);
    expect(v.code).toBe(1);
    expect(r.code).toBe(1);
    // validate's `exitOnLoadFailure` → `renderLoadFailure` fallback prefix; register's family
    // split prefixes `Error:`. The prefix split is the `Invalid workflow:`-less mint at
    // yaml-loader.ts's read-failure throw — reported, never fixed here (audit round 2 F2).
    expect(firstLine(v.stderr)).toBe(
      `Invalid: Failed to read workflow file: ENOENT: no such file or directory, open '${missing}'`,
    );
    expect(firstLine(r.stderr)).toBe(
      `Error: Failed to read workflow file: ENOENT: no such file or directory, open '${missing}'`,
    );
  }, 25_000);

  it('--json carries the bare sentence and checks_not_run: [] in file mode', async () => {
    const missing = join(base, 'missing', 'workflow.yaml');
    const v = await runCli(['workflow', 'validate', missing, '--json']);
    expect(v.code).toBe(1);
    const parsed = JSON.parse(v.stdout) as Record<string, unknown>;
    expect(parsed['errors']).toEqual([
      `Failed to read workflow file: ENOENT: no such file or directory, open '${missing}'`,
    ]);
    expect(parsed['checks_not_run']).toEqual([]);
    const ok = fixture('ok', `${HEAD}${STEP}`);
    const v2 = await runCli(['workflow', 'validate', ok, '--json']);
    expect(v2.code).toBe(0);
    expect((JSON.parse(v2.stdout) as Record<string, unknown>)['checks_not_run']).toEqual([]);
  }, 25_000);
});

describe('cell 5 — one voice across surfaces', () => {
  it('`workflow run` (the dev runner) renders the re-homed message with the same cite as validate/register', async () => {
    const dir = fixture('c2t', `${HEAD}${STEP}context_wrapper: bogus_format\n`);
    const t = await runCli(['workflow', 'run', dir]);
    expect(t.code).toBe(1);
    expect(t.stderr + t.stdout).toContain(
      "Invalid workflow: 'context_wrapper' must be 'xml', 'brackets', or 'none' (found: 'bogus_format') (line 8)",
    );
  }, 25_000);

  it('two refusals compose under the #425 per-line grammar on validate AND register', async () => {
    const dir = fixture(
      'two',
      `${HEAD}${STEP}context_wrapper: bogus\nworkflow_context:\n  my-notes:\n    source:\n      path: ./n.md\n`,
    );
    const v = await runCli(['workflow', 'validate', dir]);
    const r = await runCli(['workflow', 'register', dir]);
    expect(v.stderr).toBe(r.stderr);
    expect(v.stderr.split('\n').slice(0, 3)).toEqual([
      'Invalid workflow — 2 errors:',
      "  'context_wrapper' must be 'xml', 'brackets', or 'none' (found: 'bogus') (line 8)",
      "  workflow_context entry 'my-notes' must match [\\w.]+ (underscores and dots only — no hyphens) (line 10)",
    ]);
  }, 25_000);
});
