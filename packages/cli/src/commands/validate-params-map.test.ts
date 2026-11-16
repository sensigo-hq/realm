// Fix 1, piece 2b — a webhook's `params_map` checked against `params_schema`, on the built commands.
// A name a closed `params_schema` does not have, or a required parameter left unfilled, is refused
// by `validate` and `register` (their codes' policy is 'error'); `realm listen` mounts such a file,
// prints the finding as a warning, and answers its requests as before. In-process via commander's
// parseAsync for validate and register; `realm listen` is the built CLI, as
// listen-result-read-r11-real.test.ts starts it. The loader-level cells are core's
// params-map-check.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  loadWorkflowFromStringWithDiagnostics,
} from '@sensigo/realm';
import { validateCommand } from './validate.js';
import { registerCommand } from './register.js';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'index.js');
const SECRET = 'u2b-listen-secret-0123456789';

/** Check 1's file: a misspelt `params_map` name at a closed `params_schema`. */
const MISSPELT = `id: tickets
name: Tickets
version: 1
trigger:
  type: webhook
  path: /tickets
  auth:
    mode: shared_secret
    header: X-Token
    secret_from: WH_SECRET
  params_map:
    tikcet_id: body.id
params_schema:
  type: object
  additionalProperties: false
  properties:
    ticket_id: { type: string }
steps:
  record:
    description: Record the ticket.
    execution: auto
`;
const MISSPELT_FINDING =
  "⚠ trigger.params_map.tikcet_id: params_schema has no parameter 'tikcet_id' and allows no " +
  'others, so realm listen answers 400 params_invalid to every request that passes its auth, ' +
  "filter and dedup checks and carries this value. Did you mean 'ticket_id'? (line 12)";
const MISSPELT_REFUSAL =
  "Invalid: 1 warning, 1 escalated to an error by policy: PARAMS_MAP_UNKNOWN_PARAM 'tikcet_id'";

/** Check 2's file with a `filter`: `source` is required and `params_map` does not fill it. */
const UNFILLED = `id: tickets
name: Tickets
version: 1
trigger:
  type: webhook
  path: /tickets
  auth:
    mode: shared_secret
    header: X-Token
    secret_from: WH_SECRET
  filter: { path: body.type, value: ticket-updated }
  params_map:
    ticket_id: body.id
params_schema:
  type: object
  additionalProperties: false
  required: [source]
  properties:
    ticket_id: { type: string }
    source: { type: string }
steps:
  record:
    description: Record the ticket.
    execution: auto
`;
const UNFILLED_FINDING =
  "⚠ trigger.params_map: params_schema requires 'source', but params_map does not fill it, so " +
  'realm listen starts no run from this trigger: it answers 400 params_invalid to every request ' +
  'that passes its auth, filter and dedup checks. Map ' +
  "'source' to a path in the request, or make it optional in params_schema. (line 12)";

describe('validate and register — fix 1, piece 2b: `params_map`', () => {
  let h: TempHome & { readonly root: string };
  let originalHome: string | undefined;
  let dir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    h = await makeTempHome();
    originalHome = process.env['HOME'];
    process.env['HOME'] = h.root;
    dir = mkdtempSync(join(tmpdir(), 'realm-validate-params-map-'));
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    vi.restoreAllMocks();
    await h.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  function write(yaml: string): string {
    const file = join(dir, 'workflow.yaml');
    writeFileSync(file, yaml, 'utf8');
    return file;
  }
  const lines = (spy: ReturnType<typeof vi.spyOn>): string[] =>
    spy.mock.calls.map((c: unknown[]) => String(c[0]));

  it('check 1: `validate` exits 1 with the finding, its line and the did-you-mean, then the refusal', async () => {
    await expect(validateCommand.parseAsync([write(MISSPELT)], { from: 'user' })).rejects.toThrow(
      'process.exit',
    );
    // (1) red when keys are not judged (exit 0); (2) prints the calls.
    expect(exitSpy).toHaveBeenCalledWith(1);
    // (1) red when the message, its did-you-mean or its line change; (2) prints the warnings.
    expect(lines(warnSpy)).toEqual([MISSPELT_FINDING]);
    // (1) red when the code's policy is 'warn', or the finding carries another key; (2) prints them.
    expect(lines(errSpy)).toEqual([MISSPELT_REFUSAL]);
  });

  it('check 1: `register` exits 1 and stores nothing', async () => {
    write(MISSPELT);
    await expect(registerCommand.parseAsync([dir], { from: 'user' })).rejects.toThrow(
      'process.exit',
    );
    // (1) red when the code's policy is 'warn' (register stores it); (2) prints the calls.
    expect(exitSpy).toHaveBeenCalledWith(1);
    // The first error line is the refusal (the mocked exit's throw lands in register's own catch).
    expect(lines(errSpy)[0]).toBe(MISSPELT_REFUSAL);
    expect((await h.home.workflowStore.list()).map((d) => d.id)).toEqual([]);
  });

  it("check 6: `validate` refuses check 2's file with its escalation line", async () => {
    await expect(validateCommand.parseAsync([write(UNFILLED)], { from: 'user' })).rejects.toThrow(
      'process.exit',
    );
    // (1) red when `required` is not judged; (2) prints the calls.
    expect({ warnings: lines(warnSpy), errors: lines(errSpy) }).toEqual({
      warnings: [UNFILLED_FINDING],
      errors: [
        "Invalid: 1 warning, 1 escalated to an error by policy: PARAMS_MAP_REQUIRED_UNMAPPED 'source'",
      ],
    });
  });
  it('check 8, the Upgrading item: `validate --registered <id>` refuses a stored copy whose params_map leaves a required parameter unfilled', async () => {
    // A copy stored before this release: the registry is written directly, past the loader that
    // would refuse it today (validate-registered.test.ts's seeding).
    await h.home.workflowStore.register({
      id: 'tickets',
      name: 'Tickets',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      trigger: {
        type: 'webhook',
        path: '/tickets',
        auth: { mode: 'shared_secret', header: 'X-Token', secret_from: 'WH_SECRET' },
        params_map: { ticket_id: 'body.id' },
      },
      params_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['source'],
        properties: { ticket_id: { type: 'string' }, source: { type: 'string' } },
      },
      steps: { record: { description: 'Record the ticket.', execution: 'auto' } },
    } as never);
    await expect(
      validateCommand.parseAsync(['--registered', 'tickets', '--json'], { from: 'user' }),
    ).rejects.toThrow('process.exit');
    const out = JSON.parse(
      vi
        .mocked(console.log)
        .mock.calls.map((c: unknown[]) => String(c[0]))
        .join('\n'),
    ) as { valid: boolean; diagnostics: { code: string; key?: string }[] };
    // (1) red when a stored copy's params_map is not judged; (2) prints the verdict and the codes.
    expect({
      valid: out.valid,
      codes: out.diagnostics
        .filter((d) => d.code.startsWith('PARAMS_MAP_'))
        .map((d) => `${d.code} ${d.key}`),
    }).toEqual({ valid: false, codes: ['PARAMS_MAP_REQUIRED_UNMAPPED source'] });
  });
});

describe('realm listen (built) — fix 1, piece 2b: item 3, executed', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'realm-u2b-listen-'));
    mkdirSync(join(root, 'home'));
    mkdirSync(join(root, 'project'));
    writeFileSync(join(root, 'project', 'workflow.yaml'), UNFILLED, 'utf8');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  /** Starts the built `realm listen` in the project folder; returns its port and its output so far. */
  async function startListen(): Promise<{ port: number; output: () => string }> {
    const proc: ChildProcess = spawn(
      process.execPath,
      [CLI, 'listen', '--model', 'm', '--provider', 'anthropic', '--port', '0'],
      {
        cwd: join(root, 'project'),
        env: {
          PATH: process.env['PATH'] ?? '',
          HOME: join(root, 'home'),
          ANTHROPIC_API_KEY: 'k-fake-u2b',
          // A run's agent would reach a model only here: a closed local port, so no request leaves
          // the machine whatever the agent does (correction 1).
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
          WH_SECRET: SECRET,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    onTestFinished(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    });
    let out = '';
    proc.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    proc.stderr!.on('data', (d: Buffer) => (out += d.toString()));
    const deadline = performance.now() + 30_000;
    for (;;) {
      const m = /realm listen on 127\.0\.0\.1:(\d+)/.exec(out);
      if (m !== null) return { port: Number(m[1]), output: () => out };
      if (proc.exitCode !== null || performance.now() > deadline) {
        throw new Error(`realm listen did not start: ${out.slice(0, 2000)}`);
      }
      await sleep(50);
    }
  }

  /** One POST with Node's own client. */
  function post(
    port: number,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: '/tickets',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-token': SECRET },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (d: string) => (text += d));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
  }

  it('listen mounts the file and prints the warning; a POST through the filter gets 400 params_invalid, one the filter drops 200 ignored', async () => {
    const { port, output } = await startListen();
    // (1) red when the escalation is applied at `realm listen` (it refuses to mount, and the start
    //     above throws); (2) prints listen's lines.
    expect(output()).toContain(UNFILLED_FINDING.replace('⚠ ', ''));
    const through = await post(port, { type: 'ticket-updated', id: '102' });
    const dropped = await post(port, { type: 'ticket-created', id: '103' });
    // (1) red when the claim is false (the request starts a run, or the filter is not first);
    //     (2) prints both replies.
    expect({
      through: {
        status: through.status,
        error: (JSON.parse(through.body) as Record<string, unknown>)['error'],
      },
      dropped: { status: dropped.status, body: JSON.parse(dropped.body) as unknown },
    }).toEqual({
      through: { status: 400, error: 'params_invalid' },
      dropped: { status: 200, body: { status: 'ignored' } },
    });
  }, 60_000);
  it("the closed arm's claim: listen answers 400 params_invalid to a request carrying the misnamed value, and starts a run from one without it", async () => {
    writeFileSync(join(root, 'project', 'workflow.yaml'), MISSPELT, 'utf8');
    const { port, output } = await startListen();
    // (1) red when the escalation is applied at `realm listen` (it refuses to mount); (2) prints
    //     listen's lines.
    expect(output()).toContain(MISSPELT_FINDING.replace('⚠ ', ''));
    const carrying = await post(port, { id: '102' });
    const without = await post(port, { other: 1 });
    const runId = String((JSON.parse(without.body) as Record<string, unknown>)['run_id']);
    // The 202 run's agent: `realm listen` spawns it detached, so it outlives listen. Wait until it
    // reports the run done, then until no process for this run is left; kill any that is.
    const agents = (): number[] =>
      spawnSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' })
        .stdout.split('\n')
        .filter((l) => l.includes('--spawned-by-listen') && l.includes(runId))
        .map((l) => Number(l.trim().split(/\s+/)[0]));
    onTestFinished(() => {
      for (const pid of agents()) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    });
    // `seen` is the most agent processes found at once while waiting: at least one shows the search
    // finds them, so an empty `left` below is not a search that finds nothing.
    const deadline = performance.now() + 30_000;
    let seen = 0;
    while (!output().includes(`Run complete: ${runId}`) && performance.now() < deadline) {
      seen = Math.max(seen, agents().length);
      await sleep(50);
    }
    while (agents().length > 0 && performance.now() < deadline) await sleep(100);
    // (1) red when the claim is false (the misnamed value starts a run, or its absence is refused);
    //     (2) prints both replies.
    expect({
      carrying: {
        status: carrying.status,
        error: (JSON.parse(carrying.body) as Record<string, unknown>)['error'],
      },
      without: without.status,
    }).toEqual({ carrying: { status: 400, error: 'params_invalid' }, without: 202 });
    // (1) red when the run's agent makes a model call (its workflow has no agent step, and any call
    //     could reach only 127.0.0.1:9), or is still running; (2) prints listen's lines and the pids.
    expect({
      noModelCall: output().includes(
        'Caching: no step is cached; this workflow has no agent step.',
      ),
      completed: output().includes(`Run complete: ${runId}`),
      agentSeen: seen > 0,
      left: agents(),
    }).toEqual({ noModelCall: true, completed: true, agentSeen: true, left: [] });
  }, 60_000);
});

describe('fix 1, piece 2b — the words the docs and the changelog carry (check 8)', () => {
  const flat = (s: string): string => s.replace(/\s+/g, ' ');
  function claim(page: string, sentence: string): void {
    expect(
      flat(readFileSync(join(ROOT, page), 'utf8')).includes(flat(sentence)),
      `${page} no longer says: ${sentence}`,
    ).toBe(true);
  }

  it('webhook-trigger.md: the params_map paragraph and the three rows', () => {
    // (1) red when a sentence or row is changed or lost; (2) prints it.
    claim(
      'docs/reference/workflow/webhook-trigger.md',
      'When the file is loaded, a name `params_schema` does not list in `properties` is refused when `params_schema` says `additionalProperties: false` and uses none of `patternProperties`, `allOf`, `anyOf`, `oneOf`, `$ref`, `if`, `then` or `dependentSchemas`, and gets a warning otherwise. A parameter `params_schema` requires that `params_map` does not fill is refused too, because `realm listen` would then answer `400 params_invalid` to every request that passes its auth, filter and dedup checks. This was added after version 0.49.0.',
    );
    claim(
      'docs/reference/workflow/webhook-trigger.md',
      "| A `params_map` name a closed `params_schema` does not have (added after version 0.49.0) | `trigger.params_map.tikcet_id: params_schema has no parameter 'tikcet_id' and allows no others, …` with \"Did you mean 'ticket_id'?\" |",
    );
    claim(
      'docs/reference/workflow/webhook-trigger.md',
      "| A required parameter `params_map` does not fill (added after version 0.49.0) | `trigger.params_map: params_schema requires 'source', but params_map does not fill it, …` |",
    );
    claim(
      'docs/reference/workflow/webhook-trigger.md',
      '| A `params_map` name an open `params_schema` does not list in `properties` (added after version 0.49.0) | a warning, not a refusal |',
    );
  });

  it("webhook-trigger.md's two examples are what the build prints (their text up to the …)", () => {
    // Each example row's code span, read from the page, up to its `…` (correction 1: it read only
    // this file's constants before).
    const page = readFileSync(join(ROOT, 'docs/reference/workflow/webhook-trigger.md'), 'utf8');
    const row = (start: string): string => {
      const found = page.split('\n').find((l) => l.startsWith(start));
      if (found === undefined) throw new Error(`webhook-trigger.md has no row starting: ${start}`);
      return found;
    };
    const example = (r: string): string => /`([^`]*)…`/.exec(r)?.[1] ?? '';
    const unknownRow = row('| A `params_map` name a closed `params_schema` does not have');
    const unfilledRow = row('| A required parameter `params_map` does not fill');
    // What the build prints for each matching fixture.
    const printed = (yaml: string): string =>
      loadWorkflowFromStringWithDiagnostics(yaml).warnings.find((w) =>
        w.code.startsWith('PARAMS_MAP_'),
      )?.message ?? '';
    const misspelt = printed(MISSPELT);
    const unfilled = printed(UNFILLED);
    // (1) red when a page's example, or the message it quotes, changes; (2) prints both.
    expect({
      unknown: {
        page: example(unknownRow),
        printed: misspelt.slice(0, example(unknownRow).length),
      },
      dym: {
        page: /with "([^"]*)"/.exec(unknownRow)?.[1],
        printed: misspelt.includes("Did you mean 'ticket_id'?"),
      },
      unfilled: {
        page: example(unfilledRow),
        printed: unfilled.slice(0, example(unfilledRow).length),
      },
    }).toEqual({
      unknown: { page: example(unknownRow), printed: example(unknownRow) },
      dym: { page: "Did you mean 'ticket_id'?", printed: true },
      unfilled: { page: example(unfilledRow), printed: example(unfilledRow) },
    });
    expect(example(unknownRow).length).toBeGreaterThan(20);
    expect(example(unfilledRow).length).toBeGreaterThan(20);
  });

  it('loader-diagnostics.md: 33 codes, ten of them errors, the three new rows', () => {
    claim('docs/reference/workflow/loader-diagnostics.md', 'lists all 33 warning codes');
    claim(
      'docs/reference/workflow/loader-diagnostics.md',
      "The loader has 33 warning codes. Ten of them count as errors and make `validate`, `register` and `watch` fail: an unknown key at the top of the file or on a step; an `input_map` path that can never be found; a `when` condition that reads a path that can never be found or compares a gate's answer with a choice it does not offer; a webhook `params_map` that names a parameter a closed `params_schema` does not have, or leaves a required one unfilled; and a template that uses a filter Realm does not have, gives a filter an argument no value accepts, or is not text.",
    );
    claim(
      'docs/reference/workflow/loader-diagnostics.md',
      '| `PARAMS_MAP_UNKNOWN_PARAM` | Error | A webhook `params_map` names a parameter a closed `params_schema` does not have. Added after version 0.49.0. |',
    );
    claim(
      'docs/reference/workflow/loader-diagnostics.md',
      "| `PARAMS_MAP_REQUIRED_UNMAPPED` | Error | `params_schema` requires a parameter the webhook's `params_map` does not fill. Added after version 0.49.0. |",
    );
    claim(
      'docs/reference/workflow/loader-diagnostics.md',
      '| `PARAMS_MAP_UNDECLARED_PARAM` | Warning | A webhook `params_map` names a parameter an open `params_schema` does not list in its `properties`. Added after version 0.49.0. |',
    );
  });

  it('CHANGELOG.md: the line under Changed, and the Upgrading item numbered after the last', () => {
    claim(
      'CHANGELOG.md',
      '- **BREAKING: `realm workflow validate`, `register` and `watch` refuse a webhook `params_map` that names a parameter a closed `params_schema` does not have, or that leaves a required parameter unfilled**, with its line and, for a misspelt name, a did-you-mean. `realm listen` answered `400 params_invalid` to every request that passed its filter when a required parameter was left unfilled, and to each one carrying the value of a name a closed `params_schema` does not have. A name an open `params_schema` does not list gets a warning. `realm listen` is not changed: it mounts such a file and prints each finding as a warning.',
    );
    claim(
      'CHANGELOG.md',
      "**6. `register` and `watch` refuse a webhook `params_map` that names a parameter a closed `params_schema` does not have, or leaves a required one unfilled.** Run `realm workflow validate` on each file with a `trigger:` block, or `realm workflow validate --registered <id>` on each stored one, and fix what the refusal names. Such a trigger's requests that passed its filter were refused: all of them for a required parameter left unfilled, and those carrying a misnamed parameter's value. A stored copy keeps running as it was until you register it again.",
    );
    const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
    const unreleased = changelog.slice(
      changelog.indexOf('## [Unreleased]'),
      changelog.indexOf('\n## [', changelog.indexOf('## [Unreleased]') + 1),
    );
    const upgrading = unreleased.slice(
      unreleased.indexOf('### Upgrading'),
      unreleased.indexOf('\n### ', unreleased.indexOf('### Upgrading') + 1),
    );
    // (1) red when the item is misnumbered or lost; (2) prints the numbers. #597 D1b's Slack
    // questions item, landed after this one, is 7; fix 1 piece 3a-i's template item is 8; the
    // filter-mask scan's item is 9; #603 A3a's Slack
    // answerer item is 10.
    expect(upgrading.match(/^\*\*\d+\. /gm)).toEqual([
      '**1. ',
      '**2. ',
      '**3. ',
      '**4. ',
      '**5. ',
      '**6. ',
      '**7. ',
      '**8. ',
      '**9. ',
      '**10. ',
    ]);
  });
});
