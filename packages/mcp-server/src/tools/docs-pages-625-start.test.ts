// docs-pages-625-start.test.ts — issue #625 PR-2a, decision C174 (round 22, lane E1): every
// sentence docs/concepts/step-kinds.md, docs/start/how-a-run-moves.md and docs/start/what-is-realm.md
// say about behaviour #625 PR-2a adds or changes is quoted here (read from the repository, whitespace
// folded), and the case it states is driven over a real MCP client (`createRealmMcpServer`,
// in-memory transport; `realm mcp` over stdio where the page names it), the built `realm` (a child
// process with a fresh HOME that shares the client's stores) or the library, so neither the page nor
// the behaviour can change alone. An example screen is compared to the real reply line by line.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  JsonFileStore,
  JsonWorkflowStore,
  ExtensionRegistry,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  describePending,
  describeNext,
  loadWorkflowFromString,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createRealmMcpServer } from '../server.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CLI = join(ROOT, 'packages/cli/dist/index.js');
const LLM = pathToFileURL(join(ROOT, 'packages/cli/dist/agent/providers/llm-provider.js')).href;
const KINDS = 'docs/concepts/step-kinds.md';
const MOVES = 'docs/start/how-a-run-moves.md';
const WHAT = 'docs/start/what-is-realm.md';
const flat = (t: string) => t.replace(/\s+/g, ' ');

/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(page: string, sentence: string): void {
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

/** The lines of the page's first fenced block that holds `marker`. */
function block(page: string, marker: string): string[] {
  const text = readFileSync(join(ROOT, page), 'utf8');
  const blocks = text.split(/^```[a-z]*\n/m).filter((_, i) => i % 2 === 1);
  const found = blocks.find((b) => b.includes(marker));
  if (found === undefined) throw new Error(`${page} has no block with: ${marker}`);
  return found.replace(/\n```[\s\S]*$/, '').split('\n');
}

/** A `<step>`-style template the page quotes, filled in. */
const fill = (template: string, values: Record<string, string>) =>
  Object.entries(values).reduce((t, [k, v]) => t.replaceAll(`<${k}>`, v), template);

type Reply = Record<string, unknown>;
const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

/**
 * A fresh HOME whose `.realm` stores the client and the built `realm` share, and a provider module
 * (`p.mjs`) for `realm agent` that answers every agent step with `{ ok: true }` and logs the first
 * line of each prompt it is asked (the step's description) to `calls`.
 */
function home(): string {
  const h = mkdtempSync(join(tmpdir(), 'realm-pages-625-'));
  homes.push(h);
  mkdirSync(join(h, '.realm', 'workflows'), { recursive: true });
  mkdirSync(join(h, '.realm', 'runs'), { recursive: true });
  writeFileSync(
    join(h, 'p.mjs'),
    [
      `import { LlmProvider } from '${LLM}';`,
      "import { appendFileSync } from 'node:fs';",
      'class P extends LlmProvider {',
      '  async callStep(prompt) {',
      "    appendFileSync(process.env.CALLS_LOG, prompt.split('\\n')[0] + '\\n');",
      '    return { ok: true };',
      '  }',
      '}',
      'export default new P();',
      '',
    ].join('\n'),
  );
  return h;
}

async function connect(h: string, registry?: ExtensionRegistry) {
  const runStore = new JsonFileStore(join(h, '.realm', 'runs'));
  const workflowStore = new JsonWorkflowStore(join(h, '.realm', 'workflows'));
  const server = createRealmMcpServer({
    runStore,
    workflowStore,
    ...(registry !== undefined ? { registry } : {}),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'docs-pages-625', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown>): Promise<Reply> => {
    const raw = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
    };
    return JSON.parse(raw.content[0]!.text) as Reply;
  };
  return { call, runStore, workflowStore };
}

/** The built `realm` as a child process, on the same HOME. */
function realm(h: string, args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: h,
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: h,
      NO_COLOR: '1',
      CALLS_LOG: join(h, 'calls'),
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const lines = (t: string) => t.split('\n').filter((l) => l !== '');
  return { code: r.status, out: lines(r.stdout), err: lines(r.stderr) };
}

/** What `realm agent` asked the model, one line per call (the step's description). */
const calls = (h: string): string[] =>
  existsSync(join(h, 'calls'))
    ? readFileSync(join(h, 'calls'), 'utf8')
        .split('\n')
        .filter((l) => l !== '')
    : [];

const tools = (r: Reply): string[] =>
  ((r['next_actions'] as Array<{ instruction?: { tool?: string } }>) ?? []).map(
    (n) => n.instruction?.tool ?? '',
  );

const wf = (lines: string[]): WorkflowDefinition => loadWorkflowFromString(lines.join('\n'));

const batchRun = async (call: (n: string, a: Reply) => Promise<Reply>, id: string, p = {}) =>
  (
    (await call('start_run_batch', { workflow_id: id, items: [{ params: p }] }))[
      'started'
    ] as Array<{
      run_id: string;
    }>
  )[0]!.run_id;

const TRUST =
  "'trust: \"bogus_value\"' is not a recognized value — the engine will refuse this step at dispatch (VALIDATION_TRUST_VALUE). Accepts auto, human_confirmed, human_reviewed — correct the value and 'realm workflow register <path>'.";
const NOT_HERE = "handler 'missing_h' is not registered here";
const WAS_NOT = "handler 'missing_h' was not registered in the runner that last attempted it";
const WAY_OUT_HERE = ' — load the missing extension, or run the step on a runner that has it';

describe(
  '#625 PR-2a, C174 — step-kinds.md, how-a-run-moves.md and what-is-realm.md',
  { timeout: 60_000 },
  () => {
    it('step-kinds.md: a bare auto step records its one dependency’s output, the run’s params, `{}`, or what the caller’s dispatcher returned — and its evidence says which', async () => {
      claim(
        KINDS,
        "A step with neither records an output it did not compute: when the engine runs it, the recorded output of its one `depends_on` step (with no `depends_on`, the run's params; with several, `{}`); when a caller names it, what the caller's dispatcher returned. Its evidence says which (`output_source`).",
      );
      const h = home();
      const { call, workflowStore, runStore } = await connect(h);
      await workflowStore.register(
        wf([
          'id: bare',
          'name: bare',
          'version: 1',
          'steps:',
          '  first:',
          '    description: First.',
          '    execution: auto',
          '  copy:',
          '    description: Copy.',
          '    execution: auto',
          '    depends_on: [first]',
          '  both:',
          '    description: Both.',
          '    execution: auto',
          '    depends_on: [first, copy]',
          '',
        ]),
      );
      const outputs = async (id: string) =>
        (await runStore.get(id)).evidence.map((e) => [
          e.step_id,
          e.output_summary,
          e.output_source,
        ]);
      // The engine runs all three in start_run.
      const engineRun = (await call('start_run', { workflow_id: 'bare', params: { order: 7 } }))[
        'run_id'
      ] as string;
      // A batch run runs no step; the caller then names `first` with its own params.
      const named = await batchRun(call, 'bare', { order: 8 });
      await call('execute_step', { run_id: named, command: 'first', params: { picked: 'caller' } });
      // (a) red when a bare step records anything else, or its evidence names another source;
      //     (b) prints each step's output and source.
      expect({ engine: await outputs(engineRun), named: await outputs(named) }).toEqual({
        engine: [
          ['first', { order: 7 }, 'run_params'],
          ['copy', { order: 7 }, 'dependency'],
          ['both', {}, 'none'],
        ],
        named: [
          ['first', { picked: 'caller' }, 'driven_step'],
          ['copy', { picked: 'caller' }, 'dependency'],
          ['both', {}, 'none'],
        ],
      });
    });

    it('step-kinds.md: an auto step refused before its claim never fails and is named by get_run_state, realm run inspect and realm agent; a missing handler cannot run here, and a program that has it runs it', async () => {
      claim(
        KINDS,
        "An auto step the run's view refuses before it is claimed — an invalid `trust`, a failed precondition, or an input its schema rejects — is never submitted, so it never fails; it cannot run anywhere until the run or the workflow changes. A step whose handler or adapter this program has not registered is different: it cannot run here, and a program that has it can run it.",
      );
      const named = claim.bind(null, KINDS);
      named(
        "Either way the step is named: `get_run_state` lists it under `engine_runnable` with the check that refused it (an input refusal names the field and what it must be, or the property the schema does not allow: `'<property>' is not allowed`), `realm run inspect` prints `Cannot run '<step>' (<check>): <why>`, and `realm agent` prints `• Step '<step>' cannot run (<check>): <why>` — `cannot run here (capability)` for a missing handler or adapter, ending `— load the missing extension, or run the step on a runner that has it` — once, and goes on with any agent step that is ready.",
      );
      named(
        'An invalid `trust` is named in the words the run-health finding uses (`the engine will refuse this step at dispatch (VALIDATION_TRUST_VALUE)`): nothing has been dispatched.',
      );
      named(
        "When nothing else can run, `realm agent` stops on the first such step in the workflow's order and exits 1.",
      );
      const page = flat(readFileSync(join(ROOT, KINDS), 'utf8'));
      const stopTemplate =
        /For a refusal before the claim it prints one line, `(✗ The drive stops: [^`]+)`/.exec(
          page,
        )![1]!;
      // F15: the page's own words for each step's way out.
      const fixWayTemplate =
        /— `(for '<step>', correct the workflow and register it again)` for a refused/.exec(
          page,
        )![1]!;
      const inputWayTemplate =
        /`(for '<step>', start a run with params that fit, or correct its input_schema and register the workflow again)` for an input refused with no `depends_on`/.exec(
          page,
        )![1]!;
      const h = home();
      const { call, workflowStore, runStore } = await connect(h);
      // The loader refuses an invalid trust, so the stored definition is written as an object: a
      // workflow registered before the value was refused, as a run meets it.
      const def = {
        id: 'kinds',
        name: 'kinds',
        version: 1,
        schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
        steps: {
          t: { description: 'T.', execution: 'auto', depends_on: [], trust: 'bogus_value' },
          p: {
            description: 'P.',
            execution: 'auto',
            depends_on: [],
            preconditions: ['run.params.ok == true'],
          },
          s: {
            description: 'S.',
            execution: 'auto',
            depends_on: [],
            input_schema: {
              type: 'object',
              additionalProperties: false,
              properties: { ok: {}, count: {} },
            },
          },
          n: {
            description: 'N.',
            execution: 'auto',
            depends_on: [],
            input_schema: { type: 'object', properties: { count: { type: 'number' } } },
          },
          h: { description: 'H.', execution: 'auto', depends_on: [], handler: 'missing_h' },
          review: { description: 'Review the order.', execution: 'agent', depends_on: [] },
        },
      } as unknown as WorkflowDefinition;
      await workflowStore.register(def);
      const id = (
        await call('start_run', { workflow_id: 'kinds', params: { extra: 1, count: 'x' } })
      )['run_id'] as string;
      const why: Record<string, [string, string]> = {
        t: ['trust', TRUST],
        p: [
          'precondition',
          "Precondition failed for step 'p'. Precondition failed: 'run.params.ok == true'. Resolved value: undefined.",
        ],
        s: ['input_schema', "Invalid input for step 's': 'extra' is not allowed"],
        n: ['input_schema', "Invalid input for step 'n': 'count' must be number"],
      };
      const state = await call('get_run_state', { run_id: id });
      // (a) red when get_run_state leaves a refused step out of engine_runnable, or names another
      //     check or reason (an input refusal without its field, or the property not allowed);
      //     (b) prints the list.
      expect(state['engine_runnable']).toEqual([
        ...Object.entries(why).map(([step, [check, refusal]]) => ({
          step,
          runnable_here: false,
          refused_by: check,
          refusal,
        })),
        {
          step: 'h',
          runnable_here: false,
          refused_by: 'capability',
          refusal: NOT_HERE,
          basis: 'registry',
        },
      ]);
      const finding = (state['run_health'] as Array<Record<string, unknown>>).find(
        (f) => f['kind'] === 'trust_value_invalid',
      );
      // (a) red when the trust refusal is not in the run-health finding's own words; (b) prints both.
      expect(JSON.stringify(finding)).toContain(JSON.stringify(TRUST).slice(1, -1));
      const inspect = realm(h, ['run', 'inspect', id]).out;
      // (a) red when inspect does not print each refused step in the page's words; (b) prints them.
      for (const [step, [check, reason]] of Object.entries(why)) {
        expect(inspect).toContain(
          fill("Cannot run '<step>' (<check>): <why>", { step, check, why: reason }),
        );
      }
      const agent = realm(h, ['agent', '--run-id', id, '--provider-module', './p.mjs']);
      const lines = [
        ...Object.entries(why).map(([step, [check, reason]]) =>
          fill("• Step '<step>' cannot run (<check>): <why>", { step, check, why: reason }),
        ),
        `• Step 'h' cannot run here (capability): ${NOT_HERE}${WAY_OUT_HERE}`,
      ];
      // (a) red when realm agent names a refused step other than once, in other words, or does not go
      //     on with the ready agent step; (b) prints the screen and what the model was asked.
      expect({
        named: lines.map((l) => agent.out.filter((o) => o === l).length),
        ranReview: agent.out.includes('→ [agent] review'),
        asked: calls(h),
      }).toEqual({ named: [1, 1, 1, 1, 1], ranReview: true, asked: ['Review the order.'] });
      // (a) red when the drive does not stop on the FIRST refused step in the workflow's order (`t`,
      //     not the alphabetical `n`) with the page's one line, or exits other than 1; (b) prints it.
      expect({ code: agent.code, err: agent.err }).toEqual({
        code: 1,
        // F15: two of the refused steps are refused for their input, so the line gives each step's
        // own way out, in the workflow's order, in the page's words.
        err: [
          fill(stopTemplate, { step: 't', check: 'trust', id, phase: 'running' }).replace(
            /: correct the workflow, register it again, then realm run advance .*$/,
            `: ${['t', 'p', 's', 'n']
              .map((step) =>
                fill(why[step]![0] === 'input_schema' ? inputWayTemplate : fixWayTemplate, {
                  step,
                }),
              )
              .join(
                '; ',
              )}; then, after a fix, realm run advance ${id} — or end it: realm run abandon ${id}`,
          ),
        ],
      });
      // A program that has the handler runs it; the refused steps stay refused there too.
      const capable = new ExtensionRegistry();
      capable.register('handler', 'missing_h', {
        async execute() {
          return { data: { done: true } };
        },
      } as never);
      const other = await connect(h, capable);
      await other.call('advance_run', { run_id: id });
      const after = await other.call('get_run_state', { run_id: id });
      const record = await runStore.get(id);
      // (a) red when a refused step fails, is dispatched (gets an evidence entry), or runs on the
      //     capable program, or when that program does not run the step with the handler;
      //     (b) prints the record's facts.
      expect({
        failed: record.failed_steps,
        completed: [...record.completed_steps].sort(),
        dispatched: record.evidence.map((e) => e.step_id).filter((s) => s in why),
        stillRefused: (after['engine_runnable'] as Array<{ step: string }>).map((e) => e.step),
      }).toEqual({
        failed: [],
        completed: ['h', 'review'],
        dispatched: [],
        stillRefused: ['t', 'p', 's', 'n'],
      });
    });

    it('step-kinds.md: the advance_run act stops naming a refused auto step', async () => {
      claim(KINDS, 'The `advance_run` act stops naming it.');
      const h = home();
      const { call, workflowStore } = await connect(h);
      await workflowStore.register(
        wf([
          'id: act',
          'name: act',
          'version: 1',
          'steps:',
          '  ready:',
          '    description: Ready.',
          '    execution: auto',
          '  p:',
          '    description: P.',
          '    execution: auto',
          "    preconditions: ['run.params.ok == true']",
          '',
        ]),
      );
      const id = await batchRun(call, 'act');
      const before = await call('get_run_state', { run_id: id });
      await call('advance_run', { run_id: id });
      const after = await call('get_run_state', { run_id: id });
      const act = (r: Reply) =>
        ((r['next_actions'] as Array<{ human_readable: string }>) ?? []).map(
          (a) => a.human_readable,
        );
      // (a) red when the act names the refused step, or is still offered once only it is owed;
      //     (b) prints both lists.
      expect({ before: act(before), after: [act(after), after['next_actions_status']] }).toEqual({
        before: [
          "Call advance_run to run the step the engine owes: 'ready'. It runs it with this server's extensions and environment.",
        ],
        after: [[], 'ok'],
      });
    });

    it('step-kinds.md: an agent step refused for trust or a precondition is never offered, named everywhere, and never sent to the model; its input schema is not judged', async () => {
      claim(
        KINDS,
        'An agent step is judged the same way for an invalid `trust` and a failed precondition, before any model is asked to answer it (its input schema is not judged: its input is the answer).',
      );
      claim(
        KINDS,
        "A refused agent step is never offered: `get_run_state` lists it under `agent_refused`, every reply that says what comes next names it with the same `'<step>' cannot run (<check>): <why>.` words instead of `Ready for the agent`, `realm run inspect` prints `Cannot run '<step>' (<check>): <why>`, and `realm agent` names it once and never calls the model for it.",
      );
      const h = home();
      const { call, workflowStore } = await connect(h);
      await workflowStore.register({
        id: 'agents',
        name: 'agents',
        version: 1,
        schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
        steps: {
          a_t: {
            description: 'Bad trust.',
            execution: 'agent',
            depends_on: [],
            trust: 'bogus_value',
          },
          a_p: {
            description: 'Failing precondition.',
            execution: 'agent',
            depends_on: [],
            preconditions: ['run.params.ok == true'],
          },
          a_s: {
            description: 'With a schema.',
            execution: 'agent',
            depends_on: [],
            input_schema: {
              type: 'object',
              required: ['ok'],
              properties: { ok: { type: 'boolean' } },
            },
          },
          last: { description: 'Last.', execution: 'agent', depends_on: ['a_s'] },
        },
      } as unknown as WorkflowDefinition);
      const refused = {
        a_t: ['trust', TRUST],
        a_p: [
          'precondition',
          "Precondition failed for step 'a_p'. Precondition failed: 'run.params.ok == true'. Resolved value: undefined.",
        ],
      } as const;
      const words = Object.entries(refused).map(([step, [check, why]]) =>
        fill("'<step>' cannot run (<check>): <why>.", { step, check, why }).replace(/\.\.$/, '.'),
      );
      const started = await call('start_run', { workflow_id: 'agents' });
      const id = started['run_id'] as string;
      const state = await call('get_run_state', { run_id: id });
      const answered = await call('execute_step', {
        run_id: id,
        command: 'a_s',
        params: { ok: true },
      });
      // (a) red when a refused agent step is offered, left out of agent_refused, or the step with an
      //     input schema is judged on it; (b) prints the replies.
      expect({
        offered: (
          started['next_actions'] as Array<{ instruction: { params: { command: string } } }>
        ).map((a) => a.instruction.params.command),
        agentRefused: (state['agent_refused'] as Array<{ step: string; refused_by: string }>).map(
          (e) => [e.step, e.refused_by],
        ),
      }).toEqual({
        offered: ['a_s'],
        agentRefused: [
          ['a_t', 'trust'],
          ['a_p', 'precondition'],
        ],
      });
      // (a) red when a reply that says what comes next does not name each refused step in the same
      //     words, or names it as ready; (b) prints the hints.
      for (const hint of [String(started['context_hint']), String(answered['context_hint'])]) {
        for (const w of words) expect(hint).toContain(w);
        expect(hint).not.toMatch(/Ready for the agent: [^.]*'a_[tp]'/);
      }
      // (a) red when the step that is not refused is not named ready; (b) prints the hint.
      expect(String(started['context_hint'])).toContain("Ready for the agent: 'a_s'.");
      const inspect = realm(h, ['run', 'inspect', id]).out;
      // (a) red when inspect does not print each refused agent step in the page's words;
      //     (b) prints the screen.
      for (const [step, [check, why]] of Object.entries(refused)) {
        expect(inspect).toContain(
          fill("Cannot run '<step>' (<check>): <why>", { step, check, why }),
        );
      }
      const agent = realm(h, ['agent', '--run-id', id, '--provider-module', './p.mjs']);
      // (a) red when realm agent names a refused agent step other than once, or calls the model for
      //     it; (b) prints the screen and what the model was asked.
      expect({
        named: Object.keys(refused).map(
          (s) => agent.out.filter((l) => l.startsWith(`• Step '${s}' cannot run (`)).length,
        ),
        asked: calls(h),
      }).toEqual({ named: [1, 1], asked: ['Last.'] });
    });

    it('step-kinds.md: a drive stopped on an input its schema rejects records a drive failure that run list --stuck names; correcting and registering the workflow, then realm run advance, runs the step', async () => {
      claim(
        KINDS,
        "Correcting the workflow and registering it again is the fix: the run picks up the corrected definition, and `realm run advance` then runs the step when it is an `auto` step; for an agent step it names the drive (`Nothing is owed to the engine: an agent step is ready: '<step>' — drive it with realm agent --run-id <id> --provider <provider> --model <model>`). An input its schema rejects is also recorded as a drive failure, so `realm run list --stuck` names the step.",
      );
      const h = home();
      const yaml = (field: string) =>
        [
          'id: sch',
          'name: sch',
          'version: 1',
          'steps:',
          '  s:',
          '    description: S.',
          '    execution: auto',
          '    input_schema:',
          '      type: object',
          `      required: [${field}]`,
          '',
        ].join('\n');
      writeFileSync(join(h, 'workflow.yaml'), yaml('sku'));
      // (a) red when the fixture's workflow cannot be registered; (b) prints the exit.
      expect(realm(h, ['workflow', 'register', 'workflow.yaml']).code, 'fixture').toBe(0);
      const { call, runStore } = await connect(h);
      const id = await batchRun(call, 'sch', { order: 1 });
      const agent = realm(h, ['agent', '--run-id', id, '--provider-module', './p.mjs']);
      const stuck = realm(h, ['run', 'list', '--stuck']).out.find((l) => l.startsWith(id));
      // (a) red when the drive does not stop on the step, records no drive failure, or list --stuck
      //     does not name the step; (b) prints the exit, the record and the line.
      expect({
        code: agent.code,
        failures: (await runStore.get(id)).drive_failures?.entries.map((f) => [
          f.step,
          f.error_class,
        ]),
        stuck,
      }).toEqual({
        code: 1,
        failures: [['s', 'validation_rejected']],
        stuck: expect.stringContaining('s=drive_failing(validation_rejected)'),
      });
      writeFileSync(join(h, 'workflow.yaml'), yaml('order'));
      // (a) red when the corrected workflow cannot be registered; (b) prints the exit.
      expect(realm(h, ['workflow', 'register', 'workflow.yaml']).code, 'fixture').toBe(0);
      const advance = realm(h, ['run', 'advance', id]);
      // (a) red when the run does not pick up the corrected definition, or advance does not run the
      //     step; (b) prints advance's screen.
      expect({ code: advance.code, completed: (await runStore.get(id)).completed_steps }).toEqual({
        code: 0,
        completed: ['s'],
      });
    });

    it('step-kinds.md: a missing handler — each drive attempts it once and records it; programs judge with their own extensions, a caller with none by the record, and with neither the step is unknown and the act names it', async () => {
      claim(
        KINDS,
        "For a missing handler or adapter, each drive that has nothing else to run attempts the step once and records each attempt in `capability_blocks`, so the run says which one is missing; the drive then prints the block's `⚠ … re-attach` line.",
      );
      claim(
        KINDS,
        "A program judges a missing handler or adapter with its own extensions: `realm agent`, `realm run advance`, and `realm mcp` or `realm serve` — a server with no project extensions has an empty set, so it says `handler '<name>' is not registered here`.",
      );
      claim(
        KINDS,
        "Only a caller that passes no extensions at all — a program that embeds the engine, or `realm run inspect` — judges by the run's record, in the past tense: `could not run (capability): handler '<name>' was not registered in the runner that last attempted it` (`Could not run '<step>' (capability): … — from a program that has it: realm run advance <id>` on `inspect`).",
      );
      claim(KINDS, 'With neither, the step is `unknown`, and the act still names it.');
      const h = home();
      const { call, workflowStore, runStore } = await connect(h);
      await workflowStore.register(
        wf([
          'id: cap',
          'name: cap',
          'version: 1',
          'steps:',
          '  h:',
          '    description: H.',
          '    execution: auto',
          '    handler: missing_h',
          '',
        ]),
      );
      const def = await workflowStore.get('cap');
      const id = await batchRun(call, 'cap');
      // Neither extensions nor a record: unknown, and the act names it (the library and inspect).
      const fresh = describePending(def, await runStore.get(id), undefined, new Date());
      const owedLine = realm(h, ['run', 'inspect', id]).out.find((l) => l.startsWith('Owed'));
      // (a) red when a caller with neither judges the step, or the act stops naming it; (b) prints both.
      expect({
        view: fresh.engine_runnable,
        act: fresh.act?.orientation,
        inspect: owedLine,
      }).toEqual({
        view: [{ step: 'h', runnable_here: 'unknown' }],
        act: "Run is active. Engine work is owed: 'h'.",
        inspect: `Owed to the engine: 'h' — realm run advance ${id}`,
      });
      // `realm mcp` (no project extensions) judges with its empty set: not registered here.
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [CLI, 'mcp'],
        env: { PATH: process.env['PATH'] ?? '', HOME: h },
        cwd: h,
        stderr: 'ignore',
      });
      const stdio = new Client({ name: 'docs-pages-625-stdio', version: '0' });
      await stdio.connect(transport);
      const viaMcp = (await stdio.callTool({
        name: 'get_run_state',
        arguments: { run_id: id },
      })) as {
        content: Array<{ text: string }>;
      };
      await stdio.close();
      const advance = realm(h, ['run', 'advance', id]);
      // (a) red when realm mcp or realm run advance judges by anything but its own (empty) set;
      //     (b) prints both.
      expect({
        mcp: (JSON.parse(viaMcp.content[0]!.text) as Reply)['engine_runnable'],
        advance: [advance.code, advance.out.at(-1)],
      }).toEqual({
        mcp: [
          {
            step: 'h',
            runnable_here: false,
            refused_by: 'capability',
            refusal: NOT_HERE,
            basis: 'registry',
          },
        ],
        advance: [
          1,
          `The engine can run nothing now: 'h' cannot run here (capability): ${NOT_HERE}${WAY_OUT_HERE}.`,
        ],
      });
      const drive = () => realm(h, ['agent', '--run-id', id, '--provider-module', './p.mjs']);
      const first = drive();
      const once = await runStore.get(id);
      const second = drive();
      const twice = await runStore.get(id);
      const attempts = (r: typeof once) => r.evidence.filter((e) => e.step_id === 'h').length;
      // (a) red when a drive does not attempt the step exactly once, does not record the attempt in
      //     capability_blocks, does not judge with its own extensions, or does not end with the
      //     block's re-attach line; (b) prints the screens and the record.
      expect({
        screen: [first.code, first.out.slice(2), first.err],
        blocks: [once.capability_blocks?.['h']?.requirement, attempts(once), attempts(twice)],
        recordedAgain: twice.capability_blocks?.['h']?.at !== once.capability_blocks?.['h']?.at,
        secondExit: second.code,
      }).toEqual({
        screen: [
          1,
          ['→ [auto] h', `• Step 'h' cannot run here (capability): ${NOT_HERE}${WAY_OUT_HERE}`],
          [
            `⚠ Step 'h' is blocked: handler 'missing_h' is not registered in this runner. The run is NOT failed — add handler 'missing_h' and re-attach (\`realm agent --run-id ${id} --provider-module ./p.mjs\`).`,
          ],
        ],
        blocks: [{ kind: 'handler', name: 'missing_h' }, 1, 2],
        recordedAgain: true,
        secondExit: 1,
      });
      // A caller that passes no extensions now judges by the record, in the past tense.
      const marked = describePending(def, twice, undefined, new Date());
      const inspected = realm(h, ['run', 'inspect', id]).out;
      // (a) red when a caller with no extensions does not judge by the record in the past tense, or
      //     inspect does not print the page's line; (b) prints the view, the sentence and the screen.
      expect({
        view: marked.engine_runnable,
        next: describeNext(marked, twice, def),
        inspect: inspected.find((l) => l.startsWith('Could not run')),
      }).toEqual({
        view: [
          {
            step: 'h',
            runnable_here: false,
            refused_by: 'capability',
            refusal: WAS_NOT,
            basis: 'marker',
          },
        ],
        next: expect.stringContaining(`'h' could not run (capability): ${WAS_NOT}`),
        inspect: `Could not run 'h' (capability): ${WAS_NOT} — from a program that has it: realm run advance ${id}`,
      });
    });

    it('how-a-run-moves.md: not every call runs the steps now allowed — a gate answer decides only guards, batch and an idempotent match run nothing, nothing runs after a failed or refused step; advance_run runs what is left owed', async () => {
      claim(
        MOVES,
        'Not every call does step 2. An answer to a gate (`submit_human_response`, or `realm run respond`) decides only the `guard` steps the answer makes ready. `start_run_batch`, and a `start_run` that matches an existing run by its idempotency key, run no step. After a step that fails, or a step you called that is refused, nothing more runs in that call; a step the engine refuses before its claim is skipped, and the rest run. What such a call leaves owed, `advance_run` runs (see below).',
      );
      const h = home();
      const registry = new ExtensionRegistry();
      registry.register('handler', 'boom', {
        async execute() {
          throw new Error('boom');
        },
      } as never);
      const { call, workflowStore, runStore } = await connect(h, registry);
      const done = async (id: string) => [...(await runStore.get(id)).completed_steps];
      await workflowStore.register(
        wf([
          'id: gated',
          'name: gated',
          'version: 1',
          'steps:',
          '  pre:',
          '    description: Pre.',
          '    execution: auto',
          '  confirm:',
          '    description: Confirm.',
          '    execution: auto',
          '    depends_on: [pre]',
          '    trust: human_confirmed',
          '    gate:',
          '      choices: [yes, no]',
          '  check:',
          '    description: Check.',
          '    execution: guard',
          '    depends_on: [confirm]',
          '    abort_unless: ["confirm.choice == \'yes\'"]',
          '  after:',
          '    description: After.',
          '    execution: auto',
          '    depends_on: [confirm]',
          '',
        ]),
      );
      const batch = await call('start_run_batch', {
        workflow_id: 'gated',
        items: [{ params: {}, idempotency_key: 'k-625' }],
      });
      const id = (batch['started'] as Array<{ run_id: string }>)[0]!.run_id;
      const afterBatch = await done(id);
      const match = await call('start_run', {
        workflow_id: 'gated',
        params: {},
        idempotency_key: 'k-625',
      });
      const afterMatch = await done(id);
      await call('advance_run', { run_id: id });
      const gateId = (await runStore.get(id)).pending_gate!.gate_id;
      await call('submit_human_response', { run_id: id, gate_id: gateId, choice: 'yes' });
      const afterAnswer = await done(id);
      await call('advance_run', { run_id: id });
      // The same answer from a shell: `realm run respond`.
      const shellRun = (await call('start_run', { workflow_id: 'gated' }))['run_id'] as string;
      const shellGate = (await runStore.get(shellRun)).pending_gate!.gate_id;
      const respond = realm(h, [
        'run',
        'respond',
        shellRun,
        '--gate',
        shellGate,
        '--choice',
        'yes',
      ]);
      // (a) red when start_run_batch or the idempotent match runs a step, an answer (over MCP or
      //     from realm run respond) runs the auto step or leaves the guard undecided, or advance_run
      //     does not run what is owed; (b) prints what each call left done.
      expect({
        afterBatch,
        match: [match['deduped'], match['run_id'] === id],
        afterMatch,
        afterAnswer,
        afterAdvance: await done(id),
        afterRespond: [respond.code, await done(shellRun)],
      }).toEqual({
        afterBatch: [],
        match: [true, true],
        afterMatch: [],
        afterAnswer: ['pre', 'confirm', 'check'],
        afterAdvance: ['pre', 'confirm', 'check', 'after'],
        afterRespond: [0, ['pre', 'confirm', 'check']],
      });
      await workflowStore.register(
        wf([
          'id: stops',
          'name: stops',
          'version: 1',
          'steps:',
          '  f:',
          '    description: Fails.',
          '    execution: auto',
          '    handler: boom',
          '  b:',
          '    description: B.',
          '    execution: auto',
          '',
        ]),
      );
      await workflowStore.register(
        wf([
          'id: refuses',
          'name: refuses',
          'version: 1',
          'steps:',
          '  b:',
          '    description: B.',
          '    execution: auto',
          '  ask:',
          '    description: Ask.',
          '    execution: agent',
          '    input_schema:',
          '      type: object',
          '      required: [verdict]',
          '',
        ]),
      );
      // A step that fails: start_run runs `f`, which fails; `b` is left owed.
      const failed = (await call('start_run', { workflow_id: 'stops' }))['run_id'] as string;
      const afterFail = [await done(failed), (await runStore.get(failed)).failed_steps];
      await call('advance_run', { run_id: failed });
      // A step that is refused: an answer the schema refuses, in a run where `b` is owed.
      const refused = await batchRun(call, 'refuses');
      const answer = await call('execute_step', { run_id: refused, command: 'ask', params: {} });
      const afterRefusal = await done(refused);
      await call('advance_run', { run_id: refused });
      // (a) red when anything runs in the call after the failed or refused step, or advance_run does
      //     not run what it left owed; (b) prints each.
      expect({
        afterFail,
        failedThenAdvanced: await done(failed),
        answer: answer['status'],
        afterRefusal,
        refusedThenAdvanced: await done(refused),
      }).toEqual({
        afterFail: [[], ['f']],
        failedThenAdvanced: ['b'],
        answer: 'error',
        afterRefusal: [],
        refusedThenAdvanced: ['b'],
      });
    });

    it('how-a-run-moves.md, what-is-realm.md: the pull-request review example — the screens of start_run, the refusals before and at the gate, and the answer that leaves post_approval owed', async () => {
      claim(
        WHAT,
        "While the gate was open, the agent's attempt to post anyway was refused, and the run stayed where it was:",
      );
      claim(
        MOVES,
        'The `auto` steps after the gate are owed to the engine, and the reply names the one call that runs them, until a step opens a question, fails or ends the run.',
      );
      claim(MOVES, '`next_actions` then holds `advance_run`.');
      const arrow = (marker: string) => {
        const [tool, hint] = block(MOVES, marker)[0]!
          .split('→')
          .map((x) => x.trim());
        return { tool, hint };
      };
      const startShown = arrow("Step 'fetch_pr' completed.");
      const answerShown = arrow("Gate 'confirm_review' resolved");
      const orderShown = block(WHAT, 'its dependencies are not settled')[0]!;
      const gateShown = block(WHAT, 'it waits on the question on step')[0]!;
      const h = home();
      // The example calls GitHub; a stand-in adapter answers here.
      const registry = new ExtensionRegistry();
      registry.register('adapter', 'github', {
        id: 'github',
        async fetch() {
          return { status: 200, data: { files: [{ filename: 'a.ts', patch: '+a' }] } };
        },
        async create() {
          return { status: 201, data: { id: 1 } };
        },
        async update() {
          return { status: 200, data: {} };
        },
      } as never);
      const { call, workflowStore, runStore } = await connect(h, registry);
      await workflowStore.register(
        loadWorkflowFromString(
          readFileSync(join(ROOT, 'examples/08-pr-review/workflow.yaml'), 'utf8'),
        ),
      );
      const started = await call(startShown.tool!, {
        workflow_id: 'pr-review',
        params: { repo: 'owner/repo', pr_number: 42 },
      });
      const id = started['run_id'] as string;
      const early = await call('execute_step', {
        run_id: id,
        command: 'post_approval',
        params: {},
      });
      await call('execute_step', {
        run_id: id,
        command: 'write_review',
        params: {
          risk: 'low',
          key_changes: ['a.ts'],
          recommendation: 'approve',
          review_comment: 'Approve. Small change.',
        },
      });
      const atGate = await runStore.get(id);
      const late = await call('execute_step', { run_id: id, command: 'post_approval', params: {} });
      const stayed = await runStore.get(id);
      const answer = await call(answerShown.tool!, {
        run_id: id,
        gate_id: atGate.pending_gate!.gate_id,
        choice: 'approve',
      });
      // (a) red when a reply is not the page's screen, or the refused attempt at the gate changes the
      //     run; (b) prints each.
      expect({
        start: started['context_hint'],
        early: early['context_hint'],
        late: [late['status'], late['context_hint']],
        stayed: JSON.stringify(stayed) === JSON.stringify(atGate),
        answer: answer['context_hint'],
        next: tools(answer),
      }).toEqual({
        start: startShown.hint,
        early: orderShown,
        late: ['blocked', gateShown],
        stayed: true,
        answer: answerShown.hint,
        next: ['advance_run'],
      });
      await call('advance_run', { run_id: id });
      // (a) red when advance_run does not run the owed step; (b) prints the completed steps.
      expect((await runStore.get(id)).completed_steps).toContain('post_approval');
    });

    it('how-a-run-moves.md: realm agent makes the advance_run call for you, and realm run advance runs the owed steps without a model', async () => {
      claim(
        MOVES,
        '`realm agent` makes that call for you; a client that drives the run itself calls `advance_run`; from a shell, `realm run advance <run-id>` runs the owed steps without a model.',
      );
      const h = home();
      const { call, workflowStore, runStore } = await connect(h);
      await workflowStore.register(
        wf([
          'id: owed',
          'name: owed',
          'version: 1',
          'steps:',
          '  confirm:',
          '    description: Confirm.',
          '    execution: auto',
          '    trust: human_confirmed',
          '    gate:',
          '      choices: [approve, reject]',
          '  post:',
          '    description: Post.',
          '    execution: auto',
          '    depends_on: [confirm]',
          '',
        ]),
      );
      const answered = async () => {
        const id = (await call('start_run', { workflow_id: 'owed' }))['run_id'] as string;
        const gateId = (await runStore.get(id)).pending_gate!.gate_id;
        const r = await call('submit_human_response', {
          run_id: id,
          gate_id: gateId,
          choice: 'approve',
        });
        // (a) red when the answer does not leave the step owed (the fixture); (b) prints the acts.
        expect(tools(r), 'fixture').toEqual(['advance_run']);
        return id;
      };
      const byAgent = await answered();
      const byShell = await answered();
      const byClient = await answered();
      const agent = realm(h, ['agent', '--run-id', byAgent, '--provider-module', './p.mjs']);
      const shell = realm(h, ['run', 'advance', byShell]);
      await call('advance_run', { run_id: byClient });
      const phase = async (id: string) => (await runStore.get(id)).completed_steps.includes('post');
      // (a) red when realm agent, realm run advance or advance_run leaves the owed step unrun, or
      //     the model is asked anything; (b) prints the exits and what ran.
      expect({
        agent: [agent.code, await phase(byAgent)],
        shell: [shell.code, await phase(byShell)],
        client: await phase(byClient),
        asked: calls(h),
      }).toEqual({ agent: [0, true], shell: [0, true], client: true, asked: [] });
    });
  },
);
