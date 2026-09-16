/**
 * Issue #586 — the CLI half of schema admission: `validate` (plain, `--json`, `--strict`),
 * `register`, `validate --registered`, and `realm agent --workflow --params`.
 *
 * Harness template = validate-json.test.ts (scratch HOME, four spies, throwing exit spy,
 * REALM_NO_NUDGE, clearProjectExtensionsCache).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCommand } from './validate.js';
import { registerCommand } from './register.js';
import { agentCommand } from './agent.js';
import { CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import { clearProjectExtensionsCache } from '../extensions/load-project-extensions.js';

const MALFORMED = `id: sa-wf
name: SA WF
version: 1
params_schema:
  type: banana
steps:
  s1:
    description: a
    execution: agent
`;

const ADVISORY = `id: sa-wf
name: SA WF
version: 1
params_schema:
  type: object
  properties:
    ticket_id:
      type: [string, number]
steps:
  s1:
    description: a
    execution: agent
`;

const PARAMS_WF = `id: sa-params
name: SA Params
version: 1
params_schema:
  type: object
  properties:
    ticket_id:
      type: string
  required: [ticket_id]
steps:
  s1:
    description: a
    execution: agent
`;

describe('#586 schema admission — the CLI surfaces', () => {
  let home: string;
  let dir: string;
  let wfDir: string;
  let originalHome: string | undefined;
  let savedNoNudge: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearProjectExtensionsCache();
    home = mkdtempSync(join(tmpdir(), 'realm-586-cli-'));
    dir = mkdtempSync(join(tmpdir(), 'realm-586-wf-'));
    wfDir = join(home, '.realm', 'workflows');
    mkdirSync(wfDir, { recursive: true });
    originalHome = process.env['HOME'];
    process.env['HOME'] = home;
    savedNoNudge = process.env['REALM_NO_NUDGE'];
    process.env['REALM_NO_NUDGE'] = '1';
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
    if (savedNoNudge === undefined) delete process.env['REALM_NO_NUDGE'];
    else process.env['REALM_NO_NUDGE'] = savedNoNudge;
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const out = (spy: ReturnType<typeof vi.spyOn>): string =>
    spy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');

  function write(body: string): string {
    const file = join(dir, 'workflow.yaml');
    writeFileSync(file, body, 'utf8');
    return file;
  }

  it('validate refuses a malformed params_schema on its own line and exits 1', async () => {
    const file = write(MALFORMED);
    await expect(validateCommand.parseAsync([file], { from: 'user' })).rejects.toThrow(
      'process.exit',
    );
    const errored = out(errSpy);
    expect(errored).toContain("'params_schema' is not a valid JSON Schema —");
    expect(errored).toContain('Every run start would be refused with that error at run time');
    // The `type: banana` line (5), not the `params_schema:` head (4) — walk #5, T1.
    expect(errored).toContain('(line 5)');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('validate --json carries the refusal in errors[] and nothing on stdout but the object', async () => {
    const file = write(MALFORMED);
    await expect(validateCommand.parseAsync([file, '--json'], { from: 'user' })).rejects.toThrow(
      'process.exit',
    );
    expect(logSpy.mock.calls).toHaveLength(1);
    const payload = JSON.parse(String(logSpy.mock.calls[0]![0])) as {
      valid: boolean;
      errors: string[];
    };
    expect(payload.valid).toBe(false);
    expect(
      payload.errors.some((e) => e.includes("'params_schema' is not a valid JSON Schema")),
    ).toBe(true);
  });

  it('register writes NOTHING when a block does not compile', async () => {
    const file = write(MALFORMED);
    await expect(registerCommand.parseAsync([file], { from: 'user' })).rejects.toThrow(
      'process.exit',
    );
    expect(readdirSync(wfDir)).toEqual([]);
    expect(out(errSpy)).toContain("'params_schema' is not a valid JSON Schema");
  });

  it('the strict-mode advisory: Valid + exit 0, the warning carries the key line', async () => {
    const file = write(ADVISORY);
    await validateCommand.parseAsync([file], { from: 'user' });
    const warned = out(warnSpy);
    expect(warned).toContain("'params_schema' compiles, but Ajv warns:");
    // The remedy the AUTHOR can type, on the operator's own screen (#586 walk J2-a): Ajv's own
    // advice is `use allowUnionTypes`, a constructor option with zero occurrences in realm's docs.
    expect(warned).toContain(
      'Remedy: realm does not enable union types — write anyOf: [{type: string}, {type: number}] instead.',
    );
    expect(warned).toContain('use allowUnionTypes');
    expect(warned).toContain(
      'This advisory clears when the schema is fixed; nothing is printed at run time.',
    );
    // The union `type:` line (8), where the fix goes.
    expect(warned).toContain('(line 8)');
    expect(out(logSpy)).toContain('Valid:');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('--strict escalates the advisory to exit 1', async () => {
    const file = write(ADVISORY);
    await expect(validateCommand.parseAsync([file, '--strict'], { from: 'user' })).rejects.toThrow(
      'process.exit',
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('--json on the advisory: valid true, diagnostics[0] carries the four-field position', async () => {
    const file = write(ADVISORY);
    await validateCommand.parseAsync([file, '--json'], { from: 'user' });
    const payload = JSON.parse(String(logSpy.mock.calls[0]![0])) as {
      valid: boolean;
      diagnostics: Array<Record<string, unknown>>;
    };
    expect(payload.valid).toBe(true);
    const d = payload.diagnostics.find((x) => x['code'] === 'SCHEMA_STRICT_ADVISORY');
    expect(d).toBeDefined();
    expect(d?.['severity']).toBe('warn');
    expect(d?.['scope']).toBe('workflow');
    expect(d?.['key']).toBe('params_schema');
    // The structured position is the union `type:` key's (line 8), the same the message cites.
    expect(d?.['line']).toBe(8);
    expect(d?.['column']).toBeTypeOf('number');
    expect(d?.['endLine']).toBeTypeOf('number');
    expect(d?.['endColumn']).toBeTypeOf('number');
  });

  it('validate --registered refuses a PLANTED malformed stored copy', async () => {
    // The grandfathered population: a copy registered before this release keeps RUNNING, and the
    // pre-upgrade audit is what tells the operator about it.
    writeFileSync(
      join(wfDir, 'planted.json'),
      JSON.stringify({
        id: 'planted',
        name: 'Planted',
        version: 1,
        schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
        origin: 'human',
        params_schema: { type: 'banana' },
        steps: { a: { description: 'a', execution: 'agent' } },
      }),
      'utf8',
    );
    await expect(
      validateCommand.parseAsync(['--registered', 'planted'], { from: 'user' }),
    ).rejects.toThrow('process.exit');
    const all = out(logSpy) + out(warnSpy) + out(errSpy);
    // The grandfathering header the walk read on this surface, then the block NAMED, with no
    // `(line N)`: a stored copy has no source file (the #454-boarded convention).
    expect(all).toContain("Auditing the registered copy of 'planted'");
    expect(out(errSpy)).toContain("'params_schema' is not a valid JSON Schema");
    expect(out(errSpy)).not.toContain('(line ');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('validate --registered renders a stored copy\u2019s ADVISORY uncited — no source file, no line', async () => {
    writeFileSync(
      join(wfDir, 'planted-union.json'),
      JSON.stringify({
        id: 'planted-union',
        name: 'Planted Union',
        version: 1,
        schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
        origin: 'human',
        params_schema: { type: 'object', properties: { a: { type: ['string', 'number'] } } },
        steps: { a: { description: 'a', execution: 'agent' } },
      }),
      'utf8',
    );
    await validateCommand.parseAsync(['--registered', 'planted-union'], { from: 'user' });
    const warned = out(warnSpy);
    expect(warned).toContain("'params_schema' compiles, but Ajv warns:");
    expect(warned).toContain('write anyOf: [{type: string}, {type: number}] instead');
    expect(warned).not.toContain('(line ');
    expect(out(logSpy)).toContain('Valid:');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('realm agent --workflow: a malformed params_schema in the FILE is refused by the loader, never by the params check', async () => {
    const savedKey = process.env['OPENAI_API_KEY'];
    process.env['OPENAI_API_KEY'] = 'sk-test-586';
    try {
      const file = write(MALFORMED);
      await expect(
        agentCommand.parseAsync(['--workflow', file, '--params', '{}'], { from: 'user' }),
      ).rejects.toThrow('process.exit');
      const errored = out(errSpy);
      expect(errored).toContain("'params_schema' is not a valid JSON Schema");
      expect(errored).not.toContain('Invalid params for workflow');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      if (savedKey === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = savedKey;
    }
  });

  it('realm agent --workflow --params: a violation is refused through the drive-wide catch, no run created', async () => {
    // A dummy API key is REQUIRED for this cell to measure #586 at all: `realm agent` refuses
    // with `Error: realm agent requires an LLM API key…` before it ever loads the workflow
    // (executed). Without it the cell passes on the wrong refusal — a confirmation-theatre trap.
    const savedKey = process.env['OPENAI_API_KEY'];
    process.env['OPENAI_API_KEY'] = 'sk-test-586';
    try {
      await runAgentCell();
    } finally {
      if (savedKey === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = savedKey;
    }
  });

  async function runAgentCell(): Promise<void> {
    const file = write(PARAMS_WF);
    await expect(
      agentCommand.parseAsync(['--workflow', file, '--params', '{"ticket_id":true}'], {
        from: 'user',
      }),
    ).rejects.toThrow('process.exit');
    const errored = out(errSpy);
    // The #425 family split: not an `Invalid workflow:` message, so it keeps the `Error: ` prefix
    // — the same sentence `realm run` prints, rendered by the catch that already existed.
    expect(errored).toContain(
      "Error: Invalid params for workflow 'sa-params': /ticket_id must be string",
    );
    expect(errored).not.toContain('Invalid input for step');
    expect(exitSpy).toHaveBeenCalledWith(1);
    let runFiles: string[];
    try {
      runFiles = readdirSync(join(home, '.realm', 'runs'));
    } catch {
      runFiles = [];
    }
    expect(runFiles.filter((f) => f.endsWith('.json'))).toEqual([]);
  }
});
