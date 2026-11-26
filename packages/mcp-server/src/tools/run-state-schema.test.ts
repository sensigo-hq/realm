// run-state-schema.test.ts — Q1 (#592) d2a: the drift gate of the published schema of
// `get_run_state`'s reply. `scripts/generate-run-state-schema.mjs` renders the zod tree of
// `run-state-schema.ts` (read from the BUILT package) to `docs/reference/mcp/run-state.schema.json`
// and writes `run-state.added-after.json`; this test runs it as a process on a temporary folder.
//
// THE CELLS: (a) the committed files are the script's output byte for byte, from the committed
// sidecar and from none, and a second run changes nothing; (b) every `openWord` argument is a list
// imported from its home (the tree's other compile cells fail `tsc`: run-state-schema.ts); (c) the
// built declarations of the reply, walked path by path: every string-literal union is rendered open
// at its path with EQUAL words, every object has the type's keys and `required` = the keys every
// variant requires, no `enum`/`const` lacks its `{ "type": "string" }` sibling, no
// `additionalProperties: false`; (d) the sidecar names every field and word of the file and nothing
// else, and `described_loosely` = the placeholders; (e) three checks from bugs the MCP SDK shipped:
// (i) #2614 the file and the wire rendering compile with the SDK's validator and a strict Ajv,
// (ii) #2464 real replies, as the wire carries them, validate, also with an unknown word in every
// list and an unknown key in every object, and when the door withholds values (a number or
// true/false inside `steps` arrives as its shape), (iii) #2748 real refusals validate against the
// refusal arm and the file, and the ok arm rejects them; (f) the page's section, its consumer
// table, the compatibility sentence and the CHANGELOG line, word for word.
//
// TO REGENERATE (a change made on purpose — a new field or word): give it its release in
// `RUN_STATE_ADDED_AFTER`, then `npm run build` and `npm run docs:schema` (from the repository root),
// and commit both files.
//
// Each cell carries (a) the change that turns it red and (b) what it prints on failure.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  SKIP_KINDS,
  WorkflowError,
  compileDisclosure,
  priceFromEconomics,
  writeTestClockFile,
  type CacheEconomics,
  type ClassTable,
  type DisclosureClass,
  type PriceSource,
  type RunRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { createRealmMcpServer } from '../server.js';
import { FAILURE_TEXT_SHAPED, MCP_ENVELOPE_TABLE, toolContentOf } from '../render-reply.js';
import { makeTempHome, seedRun, type TempHome } from '../test-support/temp-home.js';
import { handleGetRunState, RUN_STATE_PLAN, RUN_STATE_SUMMARY_TABLE } from './get-run-state.js';
import {
  RUN_STATE_DESCRIBED_LOOSELY,
  RUN_STATE_OK,
  RUN_STATE_REFUSAL,
  runStateSchemaFile,
} from './run-state-schema.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');
const SCRIPT = join(ROOT, 'scripts/generate-run-state-schema.mjs');
const DIR = join(ROOT, 'docs/reference/mcp');
const SCHEMA = 'run-state.schema.json';
const SIDECAR = 'run-state.added-after.json';
const REGENERATE = '`npm run build`, then `npm run docs:schema` (from the repository root)';
// The script reads the built package; the declaration walk builds a TypeScript program.
const BUDGET = 120_000;
// The paths the file describes loosely: none since d2b, which described the cost view in full.
const LOOSE: string[] = [];

type Json = Record<string, unknown>;
const committed = (name: string): string => readFileSync(join(DIR, name), 'utf8');
const file = (): Json => JSON.parse(committed(SCHEMA)) as Json;
const arms = (): Json[] => file()['anyOf'] as Json[];

/** Runs the script on a temporary folder holding `sidecar` (none: the first publication). */
function runOn(sidecar: string | undefined, again = false) {
  const dir = mkdtempSync(join(tmpdir(), 'realm-run-state-schema-'));
  try {
    if (sidecar !== undefined) writeFileSync(join(dir, SIDECAR), sidecar);
    const run = () =>
      spawnSync(process.execPath, [SCRIPT, '--out', dir], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: BUDGET,
      });
    let result = run();
    const first = { schema: readOr(join(dir, SCHEMA)), sidecar: readOr(join(dir, SIDECAR)) };
    if (again) result = run();
    return {
      status: result.status,
      stderr: result.stderr,
      first,
      schema: readOr(join(dir, SCHEMA)),
      sidecar: readOr(join(dir, SIDECAR)),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function readOr(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

// ─── The file, path by path ─────────────────────────────────────────────────────────────────────

/** Every schema node of one arm by its sidecar path (dotted keys, `[]`, `.*`), through `anyOf`. */
function nodesByPath(arm: Json): Map<string, Json[]> {
  const out = new Map<string, Json[]>();
  const visit = (node: unknown, path: string): void => {
    if (node === null || typeof node !== 'object') return;
    const n = node as Json;
    out.set(path, [...(out.get(path) ?? []), n]);
    for (const branch of (n['anyOf'] as unknown[] | undefined) ?? []) visit(branch, path);
    for (const [key, child] of Object.entries((n['properties'] as Json | undefined) ?? {})) {
      visit(child, path === '' ? key : `${path}.${key}`);
    }
    if (n['items'] !== undefined) visit(n['items'], `${path}[]`);
    if (n['propertyNames'] !== undefined) visit(n['additionalProperties'], `${path}.*`);
  };
  visit(arm, '');
  return out;
}
/** The words the nodes at one path list (`enum` values and `const`s). */
const wordsOf = (nodes: readonly Json[]): string[] =>
  [
    ...new Set(
      nodes.flatMap((n) =>
        Array.isArray(n['enum'])
          ? (n['enum'] as string[])
          : 'const' in n
            ? [n['const'] as string]
            : [],
      ),
    ),
  ].sort();
/** The fields and words of one arm, as the sidecar lists them. */
function inventory(arm: Json): { fields: string[]; words: Record<string, string[]> } {
  const fields: string[] = [];
  const words: Record<string, string[]> = {};
  for (const [path, nodes] of nodesByPath(arm)) {
    if (path !== '' && !fields.includes(path)) fields.push(path);
    const listed = wordsOf(nodes);
    if (listed.length > 0) words[path] = listed;
  }
  return { fields: fields.filter((p) => !p.endsWith('[]') && !p.endsWith('.*')).sort(), words };
}
/** Every `enum`/`const` of the file that has no `{ "type": "string" }` sibling in its own `anyOf`,
 *  and every `additionalProperties: false`, by where it sits. */
function closedSites(root: unknown): string[] {
  const sites: string[] = [];
  const open = (members: Json[]) =>
    members.some((m) => m['type'] === 'string' && !('enum' in m) && !('const' in m));
  const visit = (node: unknown, where: string, siblings: Json[] | undefined): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach((n, i) => visit(n, `${where}/${i}`, undefined));
    const n = node as Json;
    if (('enum' in n || 'const' in n) && (siblings === undefined || !open(siblings))) {
      sites.push(`${where}: ${JSON.stringify(n)}`);
    }
    if (n['additionalProperties'] === false) sites.push(`${where}: additionalProperties false`);
    for (const [key, child] of Object.entries(n)) {
      if (key === 'anyOf' && Array.isArray(child)) {
        child.forEach((m, i) => visit(m, `${where}/anyOf/${i}`, child as Json[]));
      } else visit(child, `${where}/${key}`, undefined);
    }
  };
  visit(root, '', undefined);
  return sites;
}

// ─── The declarations, path by path (5(c)) ──────────────────────────────────────────────────────

interface Declared {
  /** path → the string literals the type admits there, merged over a union's variants. */
  words: Map<string, Set<string>>;
  /** object path → its keys, and the keys every variant requires (not optional, not undefined). */
  objects: Map<string, { keys: Set<string>; required: Set<string> }>;
}
/** The twin `RunStateSummary & { disclosure: DisclosureReceipt }`, read from the BUILT declarations. */
function declared(): Declared {
  const program = ts.createProgram(
    [
      join(ROOT, 'packages/mcp-server/dist/tools/get-run-state.d.ts'),
      join(ROOT, 'packages/core/dist/utils/disclosure-walk.d.ts'),
    ],
    {
      strict: true,
      exactOptionalPropertyTypes: true,
      noEmit: true,
      skipLibCheck: true,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
    },
  );
  const checker = program.getTypeChecker();
  const typeNamed = (fileEnd: string, name: string): ts.Type => {
    for (const sf of program.getSourceFiles()) {
      if (!sf.fileName.endsWith(fileEnd)) continue;
      for (const st of sf.statements) {
        if (
          (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) &&
          st.name.text === name
        )
          return checker.getTypeAtLocation(st.name);
      }
    }
    throw new Error(`no ${name} in ${fileEnd}`);
  };
  const out: Declared = { words: new Map(), objects: new Map() };
  const flat = (types: readonly ts.Type[]): ts.Type[] =>
    types.flatMap((t) => (t.isUnion() ? flat(t.types) : [t]));
  const admitsUndefined = (t: ts.Type) =>
    flat([t]).some((p) => (p.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0);
  const walk = (types: readonly ts.Type[], path: string): void => {
    if (LOOSE.includes(path)) return;
    const objects: ts.Type[] = [];
    const elements: ts.Type[] = [];
    for (const t of flat(types)) {
      if (t.flags & ts.TypeFlags.StringLiteral) {
        out.words.set(
          path,
          (out.words.get(path) ?? new Set()).add((t as ts.StringLiteralType).value),
        );
      } else if (checker.isArrayType(t) || checker.isTupleType(t)) {
        elements.push(...checker.getTypeArguments(t as ts.TypeReference));
      } else if (t.flags & ts.TypeFlags.Object || t.isIntersection()) objects.push(t);
    }
    if (elements.length > 0) walk(elements, `${path}[]`);
    const indexed = objects.flatMap((t) => checker.getIndexInfosOfType(t).map((i) => i.type));
    if (indexed.length > 0) return walk(indexed, `${path}.*`);
    if (objects.length === 0) return;
    const variants = objects.map((t) => checker.getPropertiesOfType(t));
    const keys = new Set(variants.flat().map((p) => p.name));
    const required = new Set(
      [...keys].filter((k) =>
        variants.every((v) => {
          const p = v.find((s) => s.name === k);
          if (p === undefined || (p.flags & ts.SymbolFlags.Optional) !== 0) return false;
          return !admitsUndefined(checker.getTypeOfSymbol(p));
        }),
      ),
    );
    const seen = out.objects.get(path);
    out.objects.set(path, {
      keys: new Set([...(seen?.keys ?? []), ...keys]),
      required:
        seen === undefined ? required : new Set([...seen.required].filter((k) => required.has(k))),
    });
    for (const k of keys) {
      const child = path === '' ? k : `${path}.${k}`;
      walk(
        variants.flatMap((v) =>
          v.filter((s) => s.name === k).map((s) => checker.getTypeOfSymbol(s)),
        ),
        child,
      );
    }
  };
  walk([typeNamed('mcp-server/dist/tools/get-run-state.d.ts', 'RunStateSummary')], '');
  walk([typeNamed('core/dist/utils/disclosure-walk.d.ts', 'DisclosureReceipt')], 'disclosure');
  const root = out.objects.get('')!;
  root.keys.add('disclosure');
  root.required.add('disclosure');
  return out;
}

// ─── Real replies (5(e)) ────────────────────────────────────────────────────────────────────────

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:00:01.000Z';
const T2 = '2026-01-01T00:00:02.000Z';
const LATER = '2099-01-01T00:00:00.000Z';
const agentStep = (depends_on: string[], extra: Json = {}) => ({
  description: 'A step.',
  execution: 'agent',
  depends_on,
  ...extra,
});
const BLOCKED = Array.from({ length: 11 }, (_, i) => `blocked_${i}`);
const flow = (id: string, steps: Json): WorkflowDefinition =>
  ({ id, name: id, version: 1, schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION, steps }) as never;
// The fresh run's first step carries a prompt, so its entry says where the prompt stops repeating.
const FRESH = flow('fresh-flow', { a: agentStep([], { prompt: 'Do A.' }), b: agentStep(['a']) });
const RICH = flow('rich-flow', {
  a: agentStep([]),
  answered: agentStep([], { trust: 'human_confirmed' }),
  old_answered: agentStep([], { trust: 'human_confirmed' }),
  ask: agentStep(['a'], { trust: 'human_confirmed' }),
  held: agentStep(['a']),
  broke: agentStep([]),
  old_broke: agentStep([]),
  gone: agentStep([]),
  when_skipped: agentStep([], { when: 'run.params.go == true' }),
  rule_skipped: agentStep(['broke'], { trigger_rule: 'all_success' }),
  claimed: agentStep([]),
  claimed_quiet: agentStep([]),
  ...Object.fromEntries(
    BLOCKED.map((s) => [
      s,
      { description: 'Blocked.', execution: 'auto', depends_on: [], handler: 'missing_handler' },
    ]),
  ),
});
const WAIT = flow('wait-flow', { ask: agentStep([], { trust: 'human_confirmed' }) });
const ELIGIBLE = flow('eligible-flow', {
  done: agentStep([]),
  guard: {
    description: 'Guard.',
    execution: 'guard',
    depends_on: ['done'],
    abort_unless: ['done.ok == true'],
  },
  prep: { description: 'Prep.', execution: 'auto', depends_on: [] },
  needs: { description: 'Needs.', execution: 'auto', depends_on: [], handler: 'missing_handler' },
  refused: agentStep([], { preconditions: ['run.params.ok == true'] }),
});
const exec = (step_id: string, status: string, extra: Json = {}) => ({
  step_id,
  kind: 'execution',
  status,
  started_at: T0,
  completed_at: T1,
  duration_ms: 1,
  input_summary: {},
  output_summary: {},
  evidence_hash: `h-${step_id}`,
  driven_by: { by: 'asker@host', by_source: 'ambient', channel: 'run' },
  ...extra,
});
const failed = () =>
  exec('broke', 'failed', {
    error: 'boom',
    error_code: 'ENGINE_HANDLER_FAILED',
    error_category: 'NOT_A_CATEGORY',
    driven_by: undefined,
  });
const BLOCK = {
  requirement: { kind: 'handler', name: 'missing_handler' },
  code: 'ENGINE_HANDLER_NOT_REGISTERED',
  at: T0,
};
const record = (id: string, workflow_id: string, extra: Json): RunRecord =>
  ({
    id,
    workflow_id,
    workflow_version: 1,
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'running',
    version: 2,
    params: {},
    evidence: [],
    created_at: T0,
    updated_at: T1,
    terminal_state: false,
    ...extra,
  }) as never;
/** Every planted run: what it carries, and the get_run_state call that reads it. */
const PLANTED: Array<[string, RunRecord, Json]> = [
  [
    // an open question, two answered ones (one naming nobody), three failures (one with a word it
    // cannot read, one written before failures had words, one with no entry), two skips, two claims
    // (one stale, one naming no holder), eleven capability blocks, a drive failure, a step settled
    // by default
    'rich',
    record('rich-1', RICH.id, {
      completed_steps: ['a', 'answered', 'old_answered'],
      in_progress_steps: ['claimed', 'claimed_quiet'],
      failed_steps: ['broke', 'old_broke', 'gone'],
      skipped_steps: ['when_skipped', 'rule_skipped'],
      skip_details: {
        when_skipped: {
          kind: 'when_false',
          expression: 'run.params.go == true',
          leaves: [{ leaf: 'run.params.go == true', lhs_present: false, passed: false }],
        },
        rule_skipped: {
          kind: 'trigger_rule_unsatisfiable',
          rule: 'all_success',
          blocking_deps: [{ dep: 'broke', state: 'failed' }],
        },
      },
      claims: {
        claimed: {
          deadline: T0,
          token: 'tok',
          holder: { by: 'claimer@host', by_source: 'stated', channel: 'mcp-http' },
          since: T0,
        },
        claimed_quiet: { deadline: LATER },
      },
      capability_blocks: Object.fromEntries(BLOCKED.map((s) => [s, BLOCK])),
      run_phase: 'gate_waiting',
      version: 3,
      params: { note: 'x' },
      evidence: [
        exec('a', 'success', {
          diagnostics: {
            input_token_estimate: 1,
            precondition_trace: [],
            settled_by_default: true,
          },
        }),
        exec('answered', 'success'),
        {
          ...exec('answered', 'success'),
          kind: 'gate_response',
          started_at: T2,
          completed_at: T2,
          input_summary: { choice: 'approve' },
          output_summary: { choice: 'approve' },
          evidence_hash: 'g2',
          responded_by: 'alice',
          claim_proof: { proof: 'unverifiable', cause: 'store_keeps_no_claims' },
          answer: {
            route: 'slack',
            channel_evidence: { team: 'T1', user: 'U0ALICE', ts: '1.2', thread_ts: '1.1' },
          },
          admitted_by: 'no_named_answerer',
          driven_by: undefined,
        },
        exec('old_answered', 'success'),
        {
          ...exec('old_answered', 'success'),
          kind: 'gate_response',
          started_at: T2,
          completed_at: T2,
          input_summary: { choice: 'reject' },
          output_summary: { choice: 'reject' },
          evidence_hash: 'g4',
          driven_by: undefined,
        },
        failed(),
        exec('old_broke', 'failed', { error: 'old' }),
        exec('ask', 'success'),
      ],
      drive_failures: {
        first_failed_at: T0,
        total: 1,
        entries: [
          {
            at: T0,
            step: 'a',
            provider: 'anthropic',
            error_class: 'api_status',
            message: 'm',
            elapsed_ms: 1,
            last_observed_status: 529,
          },
        ],
      },
      pending_gate: {
        gate_id: 'gate-1',
        step_name: 'ask',
        preview: { q: 'ok?' },
        choices: ['approve', 'reject'],
        opened_at: T1,
        expires_at: LATER,
        on_expiry: 'abort',
        owner: 'alice',
        answerers: ['bob'],
        resolved_message: 'Thanks, noted.',
      },
      updated_at: T2,
    }),
    { include_steps: true, step_names: [...Object.keys(RICH.steps), 'nope'] },
  ],
  [
    // ended by an operator: who, by which command, re-judged
    'operator-ended',
    record('ended-1', RICH.id, {
      rerun_of: 'older-run',
      completed_steps: ['a'],
      failed_steps: ['broke'],
      run_phase: 'failed',
      version: 5,
      evidence: [exec('a', 'success'), failed()],
      aborted_at: {
        step_id: 'broke',
        conditions: [{ condition: 'x == 1', resolved_value: 2, passed: false }],
        abort_message: 'stopped',
      },
      sealed_by: {
        arm: 'step_failure',
        step: 'broke',
        classified: true,
        by: { by: 'op@host', by_source: 'stated', channel: 'cli' },
        door: 'realm_run_cleanup',
        adjudicated: { by: 'op', at: T2, previous_arm: null, reason: 'r' },
      },
      terminal_reason: 'step broke failed',
      updated_at: T2,
      terminal_state: true,
    }),
    { include_steps: true },
  ],
  [
    // nothing to do but wait for the answer
    'waiting',
    record('wait-1', WAIT.id, {
      run_phase: 'gate_waiting',
      evidence: [exec('ask', 'success')],
      pending_gate: {
        gate_id: 'gate-w',
        step_name: 'ask',
        preview: {},
        choices: ['yes', 'no'],
        opened_at: T1,
        expires_at: LATER,
        on_expiry: 'settle_default',
        default_choice: 'no',
      },
    }),
    {},
  ],
  [
    // d2c: waiting at a gate that says what each answer means (its per-choice messages)
    'waiting, with messages',
    record('wait-messages-1', WAIT.id, {
      run_phase: 'gate_waiting',
      evidence: [exec('ask', 'success')],
      pending_gate: {
        gate_id: 'gate-m',
        step_name: 'ask',
        preview: { draft: 'Dear customer, …' },
        choices: ['send', 'reject'],
        opened_at: T1,
        resolution_messages: {
          send: 'The reply is on its way.',
          reject: 'The draft was rejected.',
        },
      },
    }),
    {},
  ],
  [
    // a guard owed, an auto step the engine could run and one it cannot, an agent step refused
    // before its claim
    'eligible',
    record('elig-1', ELIGIBLE.id, {
      completed_steps: ['done'],
      capability_blocks: { needs: BLOCK },
      evidence: [exec('done', 'success', { output_summary: { ok: true } })],
    }),
    {},
  ],
  [
    // a handler ended it
    'aborted',
    record('abort-1', RICH.id, {
      run_phase: 'aborted',
      terminal_state: true,
      completed_steps: ['a'],
      evidence: [exec('a', 'success')],
      aborted_at: { step_id: 'a', abort_message: 'stop' },
      // a name that cannot be read
      sealed_by: { arm: 'handler_abort', step: 'a', classified: true, by: { by: 7 } },
      terminal_reason: 'handler aborted',
    }),
    {},
  ],
  [
    // a workflow this server has never registered
    'unregistered',
    record('unreg-1', 'no-such-flow', {}),
    {},
  ],
  [
    // an engine failure: the way back in, and a cleanup step left pending
    'failed',
    record('fail-1', RICH.id, {
      run_phase: 'failed',
      terminal_state: true,
      failed_steps: ['broke'],
      evidence: [failed()],
      sealed_by: { arm: 'step_failure', step: 'broke' },
      finalizer_ledger: { cleanup: { status: 'pending', rank: 0 } },
      terminal_reason: 'step broke failed',
    }),
    {},
  ],
];

// ─── The cost view (d2b): a priced run with every cost fact ─────────────────────────────────────
// The requests of the cost-view parity fixtures (a gateway request, mixed models, the split cache
// controls, a cache miss with its reference), with a request whose `auto` choice read the price
// file, the five-minute and one-hour writes, and the provider's cache diagnostics; the same requests
// on a failed drive, with its failed model tries and one usage entry that is not an object.
const COSTS = flow('cost-flow', {
  gateway_step: agentStep([]),
  mixed_step: agentStep([]),
  split_step: agentStep([]),
  miss_step: agentStep([]),
  list_miss_step: agentStep([]),
  auto_step: agentStep([]),
  no_prices_step: agentStep([]),
});
const GATEWAY_REQUEST = {
  request_index: 0,
  request_start: '2026-01-01T00:00:00.000Z',
  model: 'claude-x-20260101',
  provider: 'anthropic',
  endpoint: 'custom',
  cache_requested: 'lifetime',
  cache_lifetime_s: 3600,
  cache_ttl_sent: true,
  cache_requested_source: 'stated',
  cache_requested_by: 'realm agent',
  prompt_tokens: 5000,
  output_tokens: 10,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 30,
  cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 },
};
const MIXED_REQUESTS = [
  {
    request_index: 0,
    request_start: '2026-01-01T00:00:00.000Z',
    model: 'gpt-5',
    prompt_tokens: 100,
    output_tokens: 1,
  },
  {
    request_index: 1,
    request_start: '2026-01-01T00:00:00.200Z',
    prompt_tokens: 100,
    output_tokens: 1,
  },
];
const SPLIT_FACTS = {
  provider: 'openai',
  endpoint: 'custom',
  cache_requested: 'provider_rules',
  cache_requested_source: 'stated',
  cache_requested_by: 'realm agent',
  prompt_tokens: 900,
  output_tokens: 5,
  prefix_sha256: 'a'.repeat(64),
  prefix_chars: 48,
  prefix_parts: { system: 'b'.repeat(64), prompt: 'a'.repeat(64) },
  request_strict_sent: false,
};
const SPLIT_REQUESTS = [
  {
    request_index: 0,
    request_start: '2026-01-01T00:00:00.000Z',
    ...SPLIT_FACTS,
    cache_marked: ['key'],
    cache_key_sent: true,
  },
  {
    request_index: 1,
    request_start: '2026-01-01T00:00:01.000Z',
    ...SPLIT_FACTS,
    // An earlier request of the same step, whose `auto` read the price file.
    reference: {
      from: 'earlier_run',
      request_start: '2025-12-31T00:00:00.000Z',
      cache_auto: {
        basis: 'step_gaps',
        gaps_s: [300],
        prices: { from: 'economics', excluded: ['short'], missing: ['cache_write_5m'] },
      },
    },
    cache_controls_rejected: {
      status: 400,
      dropped: ['cache_fields'],
      proven: 'cache_fields',
      fields: ['prompt_cache_key'],
    },
  },
];
const MISS_FACTS = {
  provider: 'openai',
  model: 'gpt-5.6-luna',
  endpoint: 'default',
  cache_requested: 'provider_rules',
  request_strict_sent: false,
  prefix_parts: { tools: 'a'.repeat(64), system: 'b'.repeat(64), prompt: 'c'.repeat(64) },
};
const MISS_REQUESTS = [
  {
    request_index: 0,
    request_in_call: 0,
    request_start: '2026-11-08T05:00:00.000Z',
    ...MISS_FACTS,
    request_id: 'req_1',
    response_id: 'resp_1',
    prompt_tokens: 4015,
    output_tokens: 40,
    cache_split_offered: false,
    cache_read_input_tokens: 0,
    cache_write_tokens: 4012,
    cache_diagnostics: {
      asked: true,
      reference_id: 'resp_0',
      result: { type: 'messages_changed', cache_missed_input_tokens: 4012 },
    },
    reference: {
      from: 'run',
      request_start: '2026-11-07T05:00:00.000Z',
      ...MISS_FACTS,
      request_id: 'req_0',
      cache_read_input_tokens: 0,
      cache_write_tokens: 4012,
      cache_creation_input_tokens: 4012,
      cache_creation: { ephemeral_5m_input_tokens: 4000, ephemeral_1h_input_tokens: 12 },
      cache_lifetime_s: 300,
      cache_ttl_sent: false,
      cache_auto: {
        basis: 'step_gaps',
        gaps_s: [420],
        prices: { from: 'none', cause: 'model_unknown' },
      },
      prefix_parts: { ...MISS_FACTS.prefix_parts, format: 'd'.repeat(64) },
      prefix_chars: 64,
      cache_marked: ['system'],
      agent_profile_changed: true,
    },
  },
  {
    request_index: 1,
    request_in_call: 1,
    request_start: '2026-11-08T05:00:02.000Z',
    ...MISS_FACTS,
    prompt_tokens: 4034,
    output_tokens: 40,
    cache_read_input_tokens: 4012,
    cache_write_tokens: 19,
    cache_diagnostics: {
      asked: true,
      cause: 'rejected',
      reference_id: null,
      result: 'no_divergence',
    },
  },
];
const AUTO_REQUEST = {
  request_index: 0,
  request_start: '2026-01-01T00:00:00.000Z',
  model: 'claude-x-20260101',
  provider: 'anthropic',
  cache_requested: 'lifetime',
  cache_lifetime_s: 300,
  cache_requested_source: 'runner_default',
  cache_auto: {
    basis: 'step_gaps',
    gaps_s: [420, 720],
    prices: { from: 'economics', excluded: ['long'], missing: ['cache_write_1h'] },
  },
  prefix_parts: {
    tools: 'a'.repeat(64),
    system: 'b'.repeat(64),
    prompt: 'c'.repeat(64),
    format: 'd'.repeat(64),
  },
  prompt_tokens: 100,
  uncached_input_tokens: 70,
  output_tokens: 2,
};
const NO_PRICES_REQUEST = {
  request_index: 0,
  request_start: '2026-01-01T00:00:00.000Z',
  model: 'claude-x-20260101',
  cache_requested: 'lifetime',
  cache_lifetime_s: 300,
  cache_requested_source: 'runner_default',
  cache_auto: {
    basis: 'step_gaps',
    gaps_s: [600],
    prices: { from: 'none', cause: 'rate_missing', missing: ['cache_read'] },
  },
  prompt_tokens: 100,
  output_tokens: 2,
};
/** Two requests of one call: the second missed the head the first wrote (a predecessor in the list). */
const LIST_MISS_REQUESTS = [0, 1].map((i) => ({
  request_index: i,
  request_in_call: i,
  request_start: `2026-11-08T05:00:0${2 * i}.000Z`,
  ...MISS_FACTS,
  prompt_tokens: 4015 + i,
  output_tokens: 40,
  cache_read_input_tokens: 0,
  cache_write_tokens: 4012,
}));
/** A request recorded before request facts existed: counters only. */
const BARE_REQUEST = {
  request_index: 0,
  request_start: '2026-01-01T00:00:00.000Z',
  prompt_tokens: 5,
  cache_read_input_tokens: 3,
  cache_creation_input_tokens: 2,
};
const pricedAttempt = (step_id: string, requests: readonly Json[]) =>
  exec(step_id, 'success', {
    evidence_hash: `p-${step_id}`,
    diagnostics: {
      input_token_estimate: 1,
      precondition_trace: [],
      cache: { state: 'engaged', basis: 'provider_reported', requests },
    },
  });
const ATTEMPTS = [
  {
    request: 0,
    kind: 'transient',
    error_class: 'api_status',
    status: 429,
    wait_ms: 30000,
    retry_after_ms: 30000,
  },
  {
    request: 0,
    kind: 'transient',
    error_class: 'api_status',
    status: 429,
    wait_ms: null,
    retry_after_ms: 30000,
    exhausted_by: 'attempts',
  },
  {
    request: 1,
    kind: null,
    error_class: null,
    status: null,
    wait_ms: 0,
    retry_after_ms: null,
    then: 'gateway',
  },
];
const COST_RUN = record('cost-1', COSTS.id, {
  completed_steps: [
    'gateway_step',
    'mixed_step',
    'split_step',
    'miss_step',
    'list_miss_step',
    'auto_step',
    'no_prices_step',
  ],
  evidence: [
    pricedAttempt('gateway_step', [GATEWAY_REQUEST]),
    pricedAttempt('mixed_step', MIXED_REQUESTS),
    pricedAttempt('split_step', SPLIT_REQUESTS),
    pricedAttempt('miss_step', MISS_REQUESTS),
    pricedAttempt('list_miss_step', LIST_MISS_REQUESTS),
    pricedAttempt('auto_step', [AUTO_REQUEST]),
    pricedAttempt('no_prices_step', [NO_PRICES_REQUEST]),
  ],
  drive_failures: {
    first_failed_at: '2026-11-08T05:01:00.000Z',
    total: 7,
    // The door shows three usage entries of a failed drive: each entry carries three at most.
    entries: [
      [GATEWAY_REQUEST, ...SPLIT_REQUESTS],
      MISS_REQUESTS,
      LIST_MISS_REQUESTS,
      [AUTO_REQUEST],
      [NO_PRICES_REQUEST],
      [BARE_REQUEST],
      // A foreign provider module's usage entry that is not an object, kept as recorded.
      [null, MIXED_REQUESTS[0]],
    ].map((usage, i) => ({
      at: `2026-11-08T05:0${i + 1}:00.000Z`,
      step: 'miss_step',
      provider: i === 6 ? 'foreign' : 'openai',
      error_class: 'api_status',
      message: 'rate limited',
      elapsed_ms: 1,
      usage,
      ...(i === 0 ? { model_attempts: ATTEMPTS } : {}),
    })),
  },
});
/** Prices: the economics file for `gpt-5.6-luna` and `claude-x` (an `extra_usd` on the miss), the
 *  price list's shape for every other model. */
const ECONOMICS: CacheEconomics = {
  version: 1,
  currency: 'USD',
  models: {
    'gpt-5.6-luna': {
      prices: [{ per_million_tokens: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 } }],
    },
    'claude-x': {
      prices: [
        { per_million_tokens: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } },
      ],
    },
  },
};
const PRICES: PriceSource = {
  price(input) {
    if (input.model.startsWith('gpt-5.6') || input.model.startsWith('claude-x')) {
      return priceFromEconomics(
        ECONOMICS,
        input.model.replace(/-\d{8}$/, ''),
        input.at,
        input.usage,
      );
    }
    return {
      priced: { total: 0.125, uncached_counterfactual: 0.125 },
      priced_by: {
        source_class: 'price_list',
        source_ref: '@pydantic/genai-prices',
        version: '0.1.12',
        matched_model: input.model,
        matched_provider: 'openai',
        date_basis: 'current',
        endpoint_note: "a custom endpoint, priced at the provider's list price",
        source_note: 'the installed price list',
      },
    };
  },
};

/** Each list of the reply plan, copied `n` times under new step names. */
function inflated(reply: Json, n: number): Json {
  const out: Json = { ...reply };
  const renamed = (v: unknown, i: number): unknown =>
    typeof v === 'string'
      ? `${v}_${i}`
      : v !== null && typeof v === 'object' && 'step' in v
        ? { ...v, step: `${(v as { step: string }).step}_${i}` }
        : v;
  for (const [key, value] of Object.entries(reply)) {
    if (key === 'params' || key === 'disclosure') continue;
    if (Array.isArray(value) && value.length > 0) {
      out[key] = Array.from({ length: n }, (_, i) => renamed(value[i % value.length], i));
    } else if (key === 'steps' || key === 'skip_details') {
      const entries = Object.entries(value as Json);
      out[key] = Object.fromEntries(
        Array.from({ length: n * (key === 'steps' ? 10 : 1) }, (_, i) => {
          const [name, entry] = entries[i % entries.length]!;
          return [`${name}_${i}`, entry];
        }),
      );
    }
  }
  return out;
}

interface Replies {
  /** label → the reply's text, as the wire carries it (`content[0].text`), parsed. */
  ok: Map<string, Json>;
  /** label → the same reply when the door withholds values: every leaf of `steps` its shape. */
  withheld: Map<string, Json>;
  refusals: Map<string, Json>;
}
let root: string;
let home: TempHome;
let replies: Replies;
beforeAll(async () => {
  // A test location: the store's clock is the home's clock file, so the basis says so.
  root = await mkdtemp(join(tmpdir(), 'realm-run-state-schema-'));
  await writeTestClockFile(root, new Date('2026-01-01T00:10:00.000Z'));
  home = await makeTempHome({ home: root });
  for (const d of [FRESH, RICH, WAIT, ELIGIBLE, COSTS]) await home.stores.workflowStore.register(d);
  for (const [, run] of PLANTED) await seedRun(home.stores.runStore, run);
  await seedRun(home.stores.runStore, COST_RUN);
  // The default answers setting: the agent never answers a question, so an open one is a wait.
  const server = createRealmMcpServer({ ...home.stores });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'd2a', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const text = async (args: Json, tool = 'get_run_state'): Promise<Json> => {
    const r = await client.callTool({ name: tool, arguments: args });
    expect(r.isError, `${tool} ${JSON.stringify(args)}`).not.toBe(true);
    return JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as Json;
  };
  replies = { ok: new Map(), withheld: new Map(), refusals: new Map() };
  const started = await text({ workflow_id: FRESH.id, params: { note: 'x' } }, 'start_run');
  replies.ok.set('fresh', await text({ run_id: started['run_id'] }));
  for (const [label, run, args] of PLANTED) {
    replies.ok.set(label, await text({ run_id: run.id, ...args }));
  }
  replies.refusals.set('run not found', await text({ run_id: 'no-such-run' }));
  replies.refusals.set(
    'a refused cursor',
    await text({ run_id: started['run_id'], include_steps: true, cursor: 'no-such-step' }),
  );
  await client.close();
  // The project's code fails to load on this server: the basis names the load failure's code.
  const failing = createRealmMcpServer({
    ...home.stores,
    registryProvider: async () => {
      throw new WorkflowError('fixture: the project code does not load', {
        code: 'VALIDATION_WORKFLOW_SCHEMA',
        category: 'VALIDATION',
        agentAction: 'report_to_user',
        retryable: false,
      });
    },
  });
  const [ct2, st2] = InMemoryTransport.createLinkedPair();
  const second = new Client({ name: 'd2a-load-failed', version: '0' });
  await Promise.all([failing.connect(st2), second.connect(ct2)]);
  const loadFailed = await second.callTool({
    name: 'get_run_state',
    arguments: { run_id: 'elig-1' },
  });
  replies.ok.set(
    'project code not loaded',
    JSON.parse((loadFailed.content as Array<{ text: string }>)[0]!.text) as Json,
  );
  await second.close();
  // The cost view: the priced run read by a server that prices with `PRICES`.
  const pricing = createRealmMcpServer({ ...home.stores, priceSourceProvider: async () => PRICES });
  const [ct3, st3] = InMemoryTransport.createLinkedPair();
  const third = new Client({ name: 'd2b-costs', version: '0' });
  await Promise.all([pricing.connect(st3), third.connect(ct3)]);
  // The reply ceiling pages the steps: read every page by its cursor, as a client does.
  let cursor: string | undefined;
  do {
    const page = await third.callTool({
      name: 'get_run_state',
      arguments: { run_id: COST_RUN.id, include_steps: true, ...(cursor ? { cursor } : {}) },
    });
    const body = JSON.parse((page.content as Array<{ text: string }>)[0]!.text) as Json;
    replies.ok.set(cursor === undefined ? 'costs' : `costs, steps after ${cursor}`, body);
    cursor = body['next_cursor'] as string | undefined;
  } while (cursor !== undefined);
  await third.close();
  // The door withholding values (the declared values failed to load): each planted reply walked by
  // the tool's own table under that set.
  const stores = { runStore: home.stores.runStore, workflowStore: home.stores.workflowStore };
  const { set: withheld } = compileDisclosure([], {
    declared: 'partial',
    cause: 'load_failed',
    audience: 'agent',
    environment: 'swept',
  });
  for (const [label, run, args] of PLANTED) {
    const raw = await handleGetRunState({ run_id: run.id, ...args } as never, stores);
    const walked = toolContentOf(
      { ...raw },
      { set: withheld, audience: 'agent', table: RUN_STATE_SUMMARY_TABLE },
      RUN_STATE_PLAN,
    );
    replies.withheld.set(label, JSON.parse(walked.content[0]!.text) as Json);
  }
  // d2c: the gate with per-choice messages under a set whose declared values changed — the door's
  // other sentence.
  const { set: changed } = compileDisclosure([], {
    declared: 'partial',
    cause: 'manifest_changed',
    audience: 'agent',
    environment: 'swept',
  });
  replies.withheld.set(
    'waiting, with messages, declared values changed',
    JSON.parse(
      toolContentOf(
        { ...(await handleGetRunState({ run_id: 'wait-messages-1' }, stores)) },
        { set: changed, audience: 'agent', table: RUN_STATE_SUMMARY_TABLE },
        RUN_STATE_PLAN,
      ).content[0]!.text,
    ) as Json,
  );
  const costsRaw = await handleGetRunState(
    { run_id: COST_RUN.id, include_steps: true },
    { ...stores, priceSourceProvider: async () => PRICES },
  );
  replies.withheld.set(
    'costs',
    JSON.parse(
      toolContentOf(
        { ...costsRaw },
        { set: withheld, audience: 'agent', table: RUN_STATE_SUMMARY_TABLE },
        RUN_STATE_PLAN,
      ).content[0]!.text,
    ) as Json,
  );
  // Over the reply ceiling: the rich run's reply and the eligible run's three lists, each list many
  // times over, through the tool's own walk and plan (every list cut, its count left out kept).
  const rich = await handleGetRunState({ run_id: 'rich-1', include_steps: true }, stores);
  const eligible = await handleGetRunState({ run_id: 'elig-1' }, stores);
  const big = inflated(
    {
      ...rich,
      pending_guards: eligible.pending_guards,
      engine_runnable: eligible.engine_runnable,
      agent_refused: eligible.agent_refused,
      params: { long: 'p'.repeat(2_000) },
    },
    40,
  );
  // Under a set whose declared values failed to load (every value withheld, the question too), the
  // environment left to the host, and a failure's message shown as its shape.
  const { set } = compileDisclosure([], {
    declared: 'partial',
    cause: 'load_failed',
    audience: 'agent',
    environment: 'not_swept',
    environmentCause: 'host_set',
  });
  const result = toolContentOf(
    { ...big, [FAILURE_TEXT_SHAPED]: ['failures[0].message'] },
    { set, audience: 'agent', table: RUN_STATE_SUMMARY_TABLE },
    RUN_STATE_PLAN,
  );
  replies.ok.set('over the ceiling', JSON.parse(result.content[0]!.text) as Json);
}, BUDGET);
afterAll(async () => {
  await home?.cleanup();
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

/** The cost view's six roots (d2b), and its fields no planted reply can carry, each with why. */
const COST_VIEW = [
  'steps.*.attempts[].cost',
  'steps.*.total',
  'run_cost',
  'drive_failure_costs[].cost',
  'drive_failures.entries[].usage',
  'drive_failures.entries[].model_attempts',
];
const NO_COST_FIELD = [
  // `composeDriveFailureCosts` never sets a failed drive's `basis` or `state` (step-view.ts): a
  // drive failure's usage carries no cache classification.
  'drive_failure_costs[].cost.basis',
  'drive_failure_costs[].cost.state',
];

/** The word paths no planted reply can carry a value at, each with why. */
const NO_UNKNOWN_WORD = [
  // `also` lists reading and ending the run: never a step with a prompt.
  'also[].stable_prefix.unit',
  // A step the run refuses before its claim is refused by a precondition or a trust value, never
  // by a capability: no basis, no requirement.
  'agent_refused[].basis',
  'agent_refused[].requirement.kind',
];

/** The SDK's own validator, as its client builds it (`validation/ajv-provider.js`). */
const sdkValidator = () => new AjvJsonSchemaValidator();
/** An Ajv a client builds itself, the one the SDK ships: the draft-07 class for the wire's
 *  rendering, the 2020-12 class for the file. At Ajv's defaults an unknown keyword is refused at
 *  compile; at `{ strict: true }` a `type` array (`["number", "string"]`) is refused too. */
const sdkRequire = createRequire(
  createRequire(import.meta.url).resolve('@modelcontextprotocol/sdk/validation/ajv'),
);
type AjvClass = new (options?: object) => { compile(schema: object): unknown };
const ajvOf = (draft2020: boolean, options: object = {}): { compile(schema: object): unknown } => {
  const mod = sdkRequire(draft2020 ? 'ajv/dist/2020' : 'ajv') as { default: AjvClass };
  return new mod.default(options);
};
/** Validates `value` against `schema` with the SDK's validator; the errors when it fails. */
function errorsOf(schema: Json, value: unknown): string | undefined {
  const result = sdkValidator().getValidator(schema)(value);
  return result.valid ? undefined : result.errorMessage;
}
/** The wire's rendering of the ok arm, exactly as `registerTool` renders an output schema. */
const wire = (): Json =>
  toJsonSchemaCompat(RUN_STATE_OK, { strictUnions: true, pipeStrategy: 'output' }) as Json;

/** `reply` with an unknown word at every path the ok arm lists words at, and an unknown key in every
 *  object it describes; how many of each it planted. */
function withUnknowns(reply: Json, nodes: Map<string, Json[]>) {
  const counts = { words: new Set<string>(), keys: 0, fields: new Set<string>() };
  const visit = (value: unknown, path: string): unknown => {
    const at = nodes.get(path) ?? [];
    // A word, or what stands beside one (`runnable_here`: true, false or 'unknown').
    if ((typeof value === 'string' || typeof value === 'boolean') && wordsOf(at).length > 0) {
      counts.words.add(path);
      return 'zz_not_a_realm_word';
    }
    if (Array.isArray(value)) return value.map((v) => visit(v, `${path}[]`));
    if (value === null || typeof value !== 'object') return value;
    if (nodes.has(`${path}.*`)) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, visit(v, `${path}.*`)]));
    }
    if (!at.some((n) => n['properties'] !== undefined)) return value;
    counts.keys += 1;
    for (const k of Object.keys(value)) counts.fields.add(path === '' ? k : `${path}.${k}`);
    return {
      ...Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, visit(v, path === '' ? k : `${path}.${k}`)]),
      ),
      zz_not_a_realm_key: 1,
    };
  };
  return { reply: visit(reply, '') as Json, ...counts };
}

// ─── The door × the schema (d2c) ────────────────────────────────────────────────────────────────

/** A path's schema alternatives: every `anyOf` member, flattened. */
const alternatives = (nodes: readonly Json[]): Json[] =>
  nodes.flatMap((n) => (Array.isArray(n['anyOf']) ? alternatives(n['anyOf'] as Json[]) : [n]));
const typesOf = (n: Json): string[] =>
  n['type'] === undefined
    ? []
    : Array.isArray(n['type'])
      ? (n['type'] as string[])
      : [n['type'] as string];
const isNode = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
/** Whether one alternative admits any string the door writes: a plain string, or anything at all. */
const admitsString = (nodes: readonly Json[]): boolean =>
  alternatives(nodes).some(
    (n) =>
      (typesOf(n).length === 0 || typesOf(n).includes('string')) &&
      !['const', 'enum', 'pattern', 'format', 'maxLength', 'not'].some((k) => k in n),
  );
const SHAPED_TYPES = ['number', 'integer', 'boolean'];

/**
 * Where the door writes a string when it withholds values (disclosure-walk.ts, `walkRow`), checked
 * against one arm of the schema: a `question` row's whole child becomes one sentence; under a
 * `value`, `bounded` or `choose` row every number and true/false leaf becomes its shape; a table's
 * or a map's node that is not the object it describes is walked as a value. Two rules the door
 * imposes: (a) a key no table classes is walked as a value — the receipt `disclosure` is attached
 * after the walk, so it is skipped by name at the root, and any other such key is a finding; (b) a
 * table chosen by its value is resolved for every value it can be chosen by.
 */
function doorAgainstSchema(table: ClassTable, arm: Json) {
  const findings = new Set<string>();
  const skipped: string[] = [];
  const rows = new Map<string, Set<string>>();
  const shapedLeaves = new Set<string>();
  const met = (cls: string, path: string) => rows.set(cls, (rows.get(cls) ?? new Set()).add(path));
  const at = (path: string, key: string) => (path === '' ? key : `${path}.${key}`);
  const shaped = (n: Json) => typesOf(n).some((t) => SHAPED_TYPES.includes(t));
  /** Every number and true/false leaf of `walked` (alternatives at `path`) and below, as `walkValue`
   *  shapes them; a string is admitted when any alternative at the path (`all`) admits one. */
  const leaves = (walked: readonly Json[], path: string, all: readonly Json[] = walked): void => {
    if (walked.some(shaped)) shapedLeaves.add(path);
    if (walked.some(shaped) && !admitsString(all)) {
      findings.add(`${path}: a number or true/false with no string beside it`);
    }
    for (const n of walked) {
      for (const [key, child] of Object.entries((n['properties'] as Json | undefined) ?? {})) {
        leaves(alternatives([child as Json]), at(path, key));
      }
      if (isNode(n['additionalProperties'])) {
        leaves(alternatives([n['additionalProperties']]), `${path}.*`);
      }
      if (isNode(n['items'])) leaves(alternatives([n['items']]), `${path}[]`);
    }
  };
  /** The tables a row's table resolves to — rule (b) for the two the reply chooses by value. */
  const tablesOf = (
    given: ClassTable | ((value: unknown) => ClassTable),
    nodes: readonly Json[],
    path: string,
  ): ClassTable[] => {
    if (typeof given !== 'function') return [given];
    if (path === 'skip_details.*') {
      const unknown = given({ kind: 'zz_not_a_skip_kind' });
      if (Object.keys(unknown).length > 0)
        findings.add(`${path}: the unknown kind's table classes a key`);
      skipped.push(
        `${path} (a kind this release does not know): its table classes nothing — a later release's kind brings its own keys, admitted as unknown`,
      );
      return SKIP_KINDS.map((kind) => given({ kind }));
    }
    const anything = alternatives(nodes).every(
      (n) =>
        typesOf(n).includes('object') &&
        isNode(n['additionalProperties']) &&
        Object.keys(n['additionalProperties']).length === 0 &&
        n['properties'] === undefined,
    );
    if (path === 'run_health[].evidence' && anything) {
      skipped.push(`${path}: a record of unknowns, which admits anything — no walk needed`);
      return [];
    }
    findings.add(`${path}: a table chosen by its value that this cell has no rule for`);
    return [];
  };
  /** A node a table describes (`walkTable`): its entries when an array, its keys when an object. */
  const described = (tables: readonly ClassTable[], nodes: readonly Json[], path: string): void => {
    const alts = alternatives(nodes);
    // Not the object the table describes (a number or true/false beside it): walked as a value.
    leaves(alts.filter(shaped), path, alts);
    for (const n of alts) {
      if (isNode(n['items'])) described(tables, [n['items']], `${path}[]`);
      for (const [key, child] of Object.entries((n['properties'] as Json | undefined) ?? {})) {
        const classes = [
          ...new Set(tables.filter((t) => Object.hasOwn(t, key)).map((t) => t[key]!)),
        ];
        if (classes.length === 0) {
          if (path === '' && key === 'disclosure') {
            skipped.push('disclosure: the receipt, attached after the walk (never shaped)');
          } else findings.add(`${at(path, key)}: a key no table classes (walked as a value)`);
          continue;
        }
        for (const cls of classes) row(cls, [child as Json], at(path, key));
      }
    }
  };
  const row = (cls: DisclosureClass, nodes: readonly Json[], path: string): void => {
    if (cls === 'fact' || cls === 'frozen') return;
    if (cls === 'question') {
      met('question', path);
      if (!admitsString(nodes)) findings.add(`${path}: a withheld question's sentence is refused`);
      return;
    }
    if (cls === 'value' || cls === 'bounded' || 'choose' in cls) {
      met(typeof cls === 'string' ? cls : 'choose', path);
      return leaves(alternatives(nodes), path);
    }
    if ('map' in cls) {
      // `walkMap`: a node that is not a map is walked as a value; each entry by its table.
      const alts = alternatives(nodes);
      leaves(
        alts.filter((n) => !isNode(n['additionalProperties'])),
        path,
        alts,
      );
      for (const n of alts) {
        if (!isNode(n['additionalProperties'])) continue;
        const entry = [n['additionalProperties']];
        described(tablesOf(cls.map, entry, `${path}.*`), entry, `${path}.*`);
      }
      return;
    }
    described(tablesOf(cls.nested, nodes, path), nodes, path);
  };
  described([table], [arm], '');
  return {
    findings: [...findings].sort(),
    skipped,
    met: Object.fromEntries([...rows].map(([cls, paths]) => [cls, paths.size])),
    shapedLeaves: shapedLeaves.size,
    questions: [...(rows.get('question') ?? [])].sort(),
  };
}

// ─── The words a reader reads (item 4) ──────────────────────────────────────────────────────────

const PAGE_SECTION = [
  "`get_run_state`'s reply is described by `docs/reference/mcp/run-state.schema.json` in the repository, a JSON Schema (draft 2020-12) built from the same word lists the engine uses, so the file and the code cannot drift: a test regenerates it and fails when they differ. Every list in it is open and every object accepts a key it does not know. Added after version 0.50.0.",
  "The file describes both replies: the run's state, and a refusal (for example, the run is not found). Every field in it is kept under the rule of [Compatibility](../compatibility.md), so a new word or field is never a breaking change. When Realm withholds values (the receipt's `values` is `withheld`), a number or true/false inside `steps` or a failed drive's cost (`drive_failure_costs[].cost`) can arrive as its shape, a string such as `‹number›`; the schema allows it. A gate's per-choice messages (`pending_gate.resolution_messages`) arrive then as one sentence, `withheld (declared values could not be read)` or `withheld (declared values changed)`, in place of the map; the schema allows that too.",
  'A program that reads the reply must accept a word it does not know in any list, and a key it does not know in any object. For a word it does not know, it acts as for the most cautious word of that list:',
  'Where the reply types a field as a plain string, the file says so; the rule still applies to the word it carries.',
  "`docs/reference/mcp/run-state.added-after.json` says the release each field and each word arrived after: `\"0.50.0\"` marks what was there when the file was first published. A path in it is dotted keys, with `[]` for a list's entries and `.*` for a map's values (`steps.*.attempts[].status`), and `described_loosely` names the fields the schema does not yet describe in full (none today). It is a file of its own because a validator in strict mode, Ajv's default, refuses a keyword it does not know, so a release marker inside the schema would stop such a client from using it.",
];
const CONSUMER_TABLE = [
  ['The list', 'What a word it does not know means'],
  ['`next_actions_status`', 'Act as for `report_to_user`.'],
  ['`agent_action`', 'Act as for `report_to_user`.'],
  [
    "`failures[].stop_reason`, and `exhausted_by` in a drive failure's `model_attempts`",
    'Act as for `non_retryable`: do not retry.',
  ],
  [
    "`error_code` (`basis.enactor`'s, and a refusal's), `failures[].code`, `failures[].category`",
    'The error is not retryable: report it.',
  ],
  ['`run_phase`', 'Read `terminal_state` for whether the run ended.'],
  ['`run_health[].kind`', 'A finding to show the person.'],
  ['`stuck_claims[].state`', 'The step is stuck.'],
  ['A status word', 'Not a success.'],
  ["A skip's `kind` or `rule`", 'The step did not run.'],
  ["A drive failure's `error_class`, and a model attempt's", 'The drive failed.'],
  ["A model attempt's `kind`", 'Do not retry; a person decides.'],
  ["A model attempt's `then`", 'A re-send followed; its kind is unknown.'],
  [
    '`cost_unrecorded`, a not-priced cause (`not_priced[].cause`)',
    'The cost is unknown: do not add it to a total.',
  ],
  [
    "A cache miss's `derived.cause` or `provider.reason`, a request's `cache_diagnostics.result` and its `type`",
    'Why the cache missed is unknown.',
  ],
  ["A cache miss's `derived.rule`", 'How the miss was judged is unknown.'],
  ['`cache_controls_rejected.proven` and its `fields`', 'Treat the cache controls as not proven.'],
  [
    "The `auto` choice's `prices.from`, `prices.cause`, `prices.excluded[]` and `prices.missing[]`, a price's `source_class`",
    'Where the price came from is unknown.',
  ],
  [
    '`predecessor.from`, `reference.from`',
    'Which earlier request it was compared with is unknown.',
  ],
  [
    "A lifetime's source (`lifetime_from`), the `auto` choice's `basis`",
    'How long the cache entry lives is unknown.',
  ],
  [
    'What a request asked of the cache (`cache_requested`, `cache_requested_source`, `cache_marked`, `marked`) and its `endpoint`',
    "Treat the request's cache setting as unknown.",
  ],
  ['A seal arm (`sealed_by_arm`)', 'How the run ended is not verified.'],
  ['`poll_reason`', 'Poll as for `fixed`.'],
  ['`on_expiry`', 'The question may end without an answer: ask the person.'],
  [
    "The receipt's words (`declared`, `declared_cause`, `environment`, `question`)",
    'Treat the value as withheld or unverified.',
  ],
  [
    'An absence cause, an admission word or a class word (`absent_cause`, `admitted_by`, `by_source`, …)',
    'The fact is unknown.',
  ],
];
const COMPATIBILITY_SENTENCE =
  "The shape of `get_run_state`'s reply — every field and every word — is published as a JSON Schema in the repository, `docs/reference/mcp/run-state.schema.json`, built from the same lists the engine uses; every list in it is open and every object accepts a key it does not know, so a new word or field is never a breaking change. Added after version 0.50.0.";
const CHANGELOG_LINE =
  "- **`get_run_state`'s reply has a published schema.** `docs/reference/mcp/run-state.schema.json` describes every field and word of the reply, built from the same lists the engine uses, so the file and the code cannot drift (a test regenerates it). Every list in it is open and every object accepts a key it does not know: a new word or field is never a breaking change. `run-state.added-after.json` says the release each field and word arrived after, and the page says what a program does with a word it does not know.";

describe('Q1 (#592) d2a — the published schema of get_run_state', () => {
  it(
    '(a) the committed files are the script output, from the committed sidecar and from none; a second run changes nothing',
    () => {
      const kept = runOn(committed(SIDECAR), true);
      const fresh = runOn(undefined);
      // (a) red when the tree, the script or a committed file changes without a regeneration; (b)
      //     prints the exit status, what the script printed and how to regenerate.
      expect(
        {
          status: [kept.status, fresh.status],
          schema: [kept.first.schema, kept.schema, fresh.schema].map(
            (s) => s === committed(SCHEMA),
          ),
          sidecar: [kept.first.sidecar, kept.sidecar, fresh.sidecar].map(
            (s) => s === committed(SIDECAR),
          ),
        },
        `regenerate with ${REGENERATE}\n${kept.stderr}${fresh.stderr}`,
      ).toEqual({ status: [0, 0], schema: [true, true, true], sidecar: [true, true, true] });
    },
    BUDGET,
  );

  it(
    '(a) a new field with no release, and a field the tree no longer has, stop the script writing nothing',
    () => {
      const sidecar = JSON.parse(committed(SIDECAR)) as {
        ok: { fields: Record<string, string> };
      };
      delete sidecar.ok.fields['run_id'];
      sidecar.ok.fields['a_field_the_tree_lacks'] = '0.50.0';
      const run = runOn(JSON.stringify(sidecar));
      // (a) red when the script stamps a new field silently or drops one; (b) prints what it printed.
      expect({
        status: run.status,
        schema: run.first.schema,
        lines: run.stderr.trim().split('\n'),
      }).toEqual({
        status: 1,
        schema: undefined,
        lines: [
          `${SIDECAR}: ok field run_id is new: give it a release in RUN_STATE_ADDED_AFTER`,
          `${SIDECAR}: ok field a_field_the_tree_lacks is gone from the tree`,
        ],
      });
    },
    BUDGET,
  );

  it('(b) every openWord argument is a list imported from its home, never minted here', () => {
    const source = readFileSync(join(HERE, 'run-state-schema.ts'), 'utf8');
    const imported = new Set(
      [...source.matchAll(/^import \{([^}]*)\} from '(@sensigo\/realm|\.\.\/render-reply\.js)';/gm)]
        .flatMap((m) => m[1]!.split(','))
        .map((s) => s.trim())
        .filter((s) => s !== '' && !s.startsWith('type ')),
    );
    const args = [...source.matchAll(/openWord\(([^)]*)\)/g)].map((m) => m[1]!.trim());
    // (a) red when a list is written inline or a const is defined in the module; (b) prints them.
    expect(args.filter((a) => a !== 'words' && !imported.has(a))).toEqual([]);
    expect(args.length).toBeGreaterThan(30);
  });

  it(
    '(c) every word list of the declarations is open at its path with equal words; every object has its keys and required keys',
    () => {
      const decl = declared();
      const [ok] = arms();
      const nodes = nodesByPath(ok!);
      const fileWords = new Map(
        [...nodes].map(([p, n]) => [p, wordsOf(n)] as const).filter(([, w]) => w.length > 0),
      );
      const wordsDiffer = [...new Set([...decl.words.keys(), ...fileWords.keys()])]
        .sort()
        .map((p) => ({
          path: p,
          type: [...(decl.words.get(p) ?? [])].sort(),
          file: fileWords.get(p) ?? [],
        }))
        .filter((r) => JSON.stringify(r.type) !== JSON.stringify(r.file));
      const objectsDiffer = [...decl.objects]
        .map(([p, o]) => {
          const shown = (nodes.get(p) ?? []).filter((n) => n['properties'] !== undefined);
          return {
            path: p,
            keys: [
              [...o.keys].sort(),
              shown.flatMap((n) => Object.keys(n['properties'] as Json)).sort(),
            ],
            required: [
              [...o.required].sort(),
              shown.flatMap((n) => (n['required'] as string[] | undefined) ?? []).sort(),
            ],
          };
        })
        .filter(
          (r) =>
            JSON.stringify(r.keys[0]) !== JSON.stringify(r.keys[1]) ||
            JSON.stringify(r.required[0]) !== JSON.stringify(r.required[1]),
        );
      // (a) red when a list is closed or names other words (a wrong const), a key is added or left
      //     out, or a key is required that a variant leaves out or that admits undefined; (b) prints
      //     each differing path with the type's side first.
      expect({ wordsDiffer, objectsDiffer }).toEqual({ wordsDiffer: [], objectsDiffer: [] });
      expect({ wordPaths: decl.words.size, objects: decl.objects.size }).toEqual({
        wordPaths: 122,
        objects: 124,
      });
    },
    BUDGET,
  );

  it('(c) no enum or const without its string sibling, and no additionalProperties: false, anywhere in the file', () => {
    // (a) red when a list or a one-word field is rendered closed (z.enum, z.literal alone) or an
    //     object closed (z.object); (b) prints where each sits.
    expect(closedSites(file())).toEqual([]);
    expect(committed(SCHEMA)).not.toMatch(/"additionalProperties": false/);
  });

  it('(d) the sidecar names every field and word of the file and nothing else; described_loosely = the placeholders', () => {
    const sidecar = JSON.parse(committed(SIDECAR)) as Record<
      'ok' | 'refusal',
      { fields: Record<string, string>; words: Record<string, Record<string, string>> }
    > & { described_loosely: string[] };
    const [ok, refusal] = arms();
    const nodes = nodesByPath(ok!);
    const differs = (['ok', 'refusal'] as const).map((arm, i) => {
      const inv = inventory([ok!, refusal!][i]!);
      const fields = Object.keys(sidecar[arm].fields).sort();
      const words = Object.fromEntries(
        Object.entries(sidecar[arm].words).map(([p, l]) => [p, Object.keys(l).sort()]),
      );
      return {
        arm,
        fieldsMissing: inv.fields.filter((f) => !fields.includes(f)),
        fieldsStray: fields.filter((f) => !inv.fields.includes(f)),
        wordsDiffer: [...new Set([...Object.keys(inv.words), ...Object.keys(words)])].filter(
          (p) => JSON.stringify(inv.words[p]) !== JSON.stringify(words[p]),
        ),
      };
    });
    // (a) red when a field or word is missing from the sidecar or one is there the file lacks, or
    //     a placeholder is left out of described_loosely; (b) prints each.
    expect(differs).toEqual([
      { arm: 'ok', fieldsMissing: [], fieldsStray: [], wordsDiffer: [] },
      { arm: 'refusal', fieldsMissing: [], fieldsStray: [], wordsDiffer: [] },
    ]);
    expect([...sidecar.described_loosely].sort()).toEqual([...LOOSE].sort());
    expect([...RUN_STATE_DESCRIBED_LOOSELY].sort()).toEqual([...LOOSE].sort());
    // Each placeholder is loose in the file: a map of anything, or a list of anything.
    expect(
      LOOSE.map((p) =>
        (nodes.get(p) ?? []).filter((n) => n['type'] !== undefined).map((n) => JSON.stringify(n)),
      ),
    ).toEqual(
      LOOSE.map((p) => [
        p.endsWith('usage') || p.endsWith('model_attempts')
          ? '{"type":"array","items":{}}'
          : '{"type":"object","propertyNames":{"type":"string"},"additionalProperties":{}}',
      ]),
    );
  });

  it('(e)(i) #2614: the file and the wire rendering compile with the SDK validator, with Ajv at its defaults and with Ajv at strict', () => {
    const compiles = (compile: () => unknown): string => {
      try {
        compile();
        return 'compiles';
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    };
    // (a) red when the tree carries a keyword a strict validator refuses (`.meta()`), a `type` array
    //     strict mode refuses (`.or(z.string())` on a number), or cannot be rendered (`z.date()`);
    //     (b) prints each validator's error.
    expect({
      sdkFile: compiles(() => sdkValidator().getValidator(file())),
      sdkWire: compiles(() => sdkValidator().getValidator(wire())),
      defaultFile: compiles(() => ajvOf(true).compile(file())),
      defaultWire: compiles(() => ajvOf(false).compile(wire())),
      strictFile: compiles(() => ajvOf(true, { strict: true }).compile(file())),
      strictWire: compiles(() => ajvOf(false, { strict: true }).compile(wire())),
    }).toEqual({
      sdkFile: 'compiles',
      sdkWire: 'compiles',
      defaultFile: 'compiles',
      defaultWire: 'compiles',
      strictFile: 'compiles',
      strictWire: 'compiles',
    });
  });

  it('(e)(ii) #2464: every planted reply validates as the wire carries it, also with an unknown word in every list and an unknown key in every object', () => {
    const [ok] = arms();
    const nodes = nodesByPath(ok!);
    const words = new Set<string>();
    const fields = new Set<string>();
    const results = [...replies.ok].map(([label, reply]) => {
      const odd = withUnknowns(reply, nodes);
      odd.words.forEach((w) => words.add(w));
      odd.fields.forEach((f) => fields.add(f));
      return {
        label,
        okArm: errorsOf(ok!, reply) ?? 'valid',
        file: errorsOf(file(), reply) ?? 'valid',
        wire: errorsOf(wire(), reply) ?? 'valid',
        withUnknowns: errorsOf(wire(), odd.reply) ?? errorsOf(file(), odd.reply) ?? 'valid',
        keysPlanted: odd.keys > 0,
      };
    });
    // (a) red when the tree refuses a real reply: a key required that a reply leaves out, a closed
    //     list or object, a union of variants; (b) prints each reply's errors.
    expect(results).toEqual(
      [...replies.ok.keys()].map((label) => ({
        label,
        okArm: 'valid',
        file: 'valid',
        wire: 'valid',
        withUnknowns: 'valid',
        keysPlanted: true,
      })),
    );
    // Reality pinned: every top-level key is carried by a planted reply, and every word path gets
    // an unknown word but those no reply can carry (a reason each, above).
    const carried = new Set([...replies.ok.values()].flatMap((r) => Object.keys(r)));
    const top = Object.keys((ok!['properties'] as Json) ?? {});
    const listed = [...nodes].filter(([, n]) => wordsOf(n).length > 0).map(([p]) => p);
    const costView = inventory(ok!).fields.filter((f) =>
      COST_VIEW.some((root) => f.startsWith(`${root}.`) || f.startsWith(`${root}[]`)),
    );
    expect({
      notCarried: top.filter((k) => !carried.has(k)),
      noUnknownWord: listed.filter((p) => !words.has(p)),
      costViewNotReached: costView.filter((f) => !fields.has(f)),
    }).toEqual({
      notCarried: [],
      noUnknownWord: NO_UNKNOWN_WORD,
      costViewNotReached: NO_COST_FIELD,
    });
  });

  it('(e)(ii) #2464: every planted reply validates when the door withholds values (a leaf of steps arrives as its shape)', () => {
    const [ok] = arms();
    const rendered = runStateSchemaFile();
    // (a) red when a number or true/false inside `steps` is described with no string beside it, or
    //     (d2c) a gate's per-choice messages admit no sentence in place of the map — in the committed
    //     file or in the module's own rendering; (b) prints each reply's errors.
    expect(
      [...replies.withheld].map(([label, reply]) => ({
        label,
        file: errorsOf(file(), reply) ?? 'valid',
        okArm: errorsOf(ok!, reply) ?? 'valid',
        module: errorsOf(rendered, reply) ?? 'valid',
      })),
    ).toEqual(
      [...replies.withheld.keys()].map((label) => ({
        label,
        file: 'valid',
        okArm: 'valid',
        module: 'valid',
      })),
    );
    // The set did withhold: the rich run's steps were shown as their shape, and the gate's messages
    // as the door's two sentences.
    expect((replies.withheld.get('rich')!['disclosure'] as Json)['values']).toBe('withheld');
    const messages = (label: string) =>
      (replies.withheld.get(label)!['pending_gate'] as Json)['resolution_messages'];
    expect([
      messages('waiting, with messages'),
      messages('waiting, with messages, declared values changed'),
    ]).toEqual([
      'withheld (declared values could not be read)',
      'withheld (declared values changed)',
    ]);
  });

  it('(e)(iv) d2c: wherever the door writes a string when it withholds values, the schema admits one — every row of both tables that is not a fact', () => {
    const [ok, refusal] = runStateSchemaFile()['anyOf'] as Json[];
    // (a) red when a row the door withholds as a string — a question's sentence, a number or
    //     true/false shown as its shape — is described with no string beside it, when a key no table
    //     classes appears, or when a table chosen by its value meets no rule; (b) prints each path.
    expect({
      ok: doorAgainstSchema(RUN_STATE_SUMMARY_TABLE, ok!),
      refusal: doorAgainstSchema(MCP_ENVELOPE_TABLE, refusal!),
    }).toEqual({
      ok: {
        findings: [],
        skipped: [
          "skip_details.* (a kind this release does not know): its table classes nothing — a later release's kind brings its own keys, admitted as unknown",
          'run_health[].evidence: a record of unknowns, which admits anything — no walk needed',
          'disclosure: the receipt, attached after the walk (never shaped)',
        ],
        // What the cell met, so a zero is not a blind one: the rows by class, and the number and
        // true/false leaves below them — every path where the file gives such a leaf a string.
        met: { value: 12, bounded: 12, choose: 7, question: 2 },
        shapedLeaves: 135,
        questions: ['pending_gate.resolution_messages', 'pending_gate.resolved_message'],
      },
      refusal: {
        findings: [],
        skipped: ['disclosure: the receipt, attached after the walk (never shaped)'],
        met: { value: 2, bounded: 4 },
        shapedLeaves: 0,
        questions: [],
      },
    });
  });

  it('(e)(iii) #2748: real refusals validate against the refusal arm and the file, and the ok arm rejects them', () => {
    const [ok, refusal] = arms();
    // (a) red when the refusal arm is left out of the file, or describes a key the refusal does
    //     not carry as required; or when the arms stop being distinct; (b) prints the errors.
    expect(
      [...replies.refusals].map(([label, reply]) => ({
        label,
        refusalArm: errorsOf(refusal!, reply) ?? 'valid',
        file: errorsOf(file(), reply) ?? 'valid',
        okArmRejects: errorsOf(ok!, reply) !== undefined,
        wireRejects: errorsOf(wire(), reply) !== undefined,
      })),
    ).toEqual(
      [...replies.refusals.keys()].map((label) => ({
        label,
        refusalArm: 'valid',
        file: 'valid',
        okArmRejects: true,
        wireRejects: true,
      })),
    );
    // The arms are the module's: the refusal one renders as the file's second arm.
    expect(RUN_STATE_REFUSAL).toBeDefined();
  });
  it('(f) the words: the section, the consumer table, the compatibility sentence and the CHANGELOG line, word for word', () => {
    const page = readFileSync(join(ROOT, 'docs/reference/mcp/run-state-and-health.md'), 'utf8');
    const from = page.indexOf('\n## The schema\n');
    const section = page.slice(from, page.indexOf('\n## See also\n', from));
    const count = (text: string, words: string) => text.split(words).length - 1;
    const rows = section
      .split('\n')
      .filter((l) => l.startsWith('| ') && !l.startsWith('| ---'))
      .map((l) =>
        l
          .split('|')
          .slice(1, -1)
          .map((c) => c.trim()),
      );
    // (a) red when a word of the section, a cell of the table, the compatibility sentence or the
    //     changelog line changes, or the section moves after "See also"; (b) prints the counts and
    //     the table's cells.
    expect({
      before: from > 0 && from < page.indexOf('\n## See also\n'),
      section: PAGE_SECTION.map((p) => count(section, `\n${p}\n`)),
      rows,
      compatibility: count(
        readFileSync(join(ROOT, 'docs/reference/compatibility.md'), 'utf8'),
        `\n${COMPATIBILITY_SENTENCE}\n`,
      ),
      changelog: count(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'), `\n${CHANGELOG_LINE}\n`),
    }).toEqual({
      before: true,
      section: PAGE_SECTION.map(() => 1),
      rows: CONSUMER_TABLE,
      compatibility: 1,
      changelog: 1,
    });
  });
});
