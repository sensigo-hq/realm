// owed-undriven-592f1.test.ts — Q1 (#592) unit f1 (prompt q1-f1-owed-undriven.md) through the BUILT
// CLI and the MCP server: the owed threshold and `--older-than` (check 3), what each surface shows and
// that `realm run advance` clears it (check 4), the capability case per surface and the ready guard
// (check 5), and the pages and the help, word for word (check 6). The predicate's conjuncts are core's
// cells (packages/core/src/engine/owed-undriven-592f1.test.ts).
//
// Every cell runs on a TEST HOME (`createTestHome`): the clock is a file in the home, so the built
// `realm` child and the in-process store read the same instant, and an age of 59 s or 60 s is exact.
// The runs are saved through the CLI's own door with the `updated_at` each cell names. Every command
// is stopped after 60 s.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  createDefaultRegistry,
  type ExtensionRegistry,
  type RunRecord,
  type StepDefinition,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { createRealmMcpServer } from '@sensigo/realm-mcp';
import { createTestHome, type TestHome } from '@sensigo/realm-testing';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const T0 = '2031-03-04T05:06:07.000Z';
const ago = (ms: number): string => new Date(Date.parse(T0) - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const flat = (t: string) => t.replace(/\s+/g, ' ');

const auto = (handler: string, depends_on: string[] = []): StepDefinition => ({
  description: `Run ${handler}.`,
  execution: 'auto',
  handler,
  depends_on,
});
const def = (id: string, steps: Record<string, StepDefinition>): WorkflowDefinition => ({
  id,
  name: id,
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps,
});
/** An `auto` step owed first; an `agent` step after it, so the run stays open once it ran. */
const AUTO = def('f1-auto', {
  route: auto('route_h'),
  review: { description: 'Review it.', execution: 'agent', depends_on: ['route'] },
});
/** A guard ready after its agent step: owed to the engine, and awaiting settlement. */
const GUARD = def('f1-guard', {
  gated_step: { description: 'g', execution: 'agent', depends_on: [] },
  guard_after: {
    description: 'guard',
    execution: 'guard',
    depends_on: ['gated_step'],
    abort_unless: ['gated_step.status == "open"'],
  },
});
/** The commonest idle run: its next step is `realm agent`'s, so nothing is owed to the engine. */
const AGENT = def('f1-agent', { ask: { description: 'Ask.', execution: 'agent', depends_on: [] } });
/** Twelve `auto` steps ready at once: the owed list is longer than the reply's ten. */
const NAMES12 = Array.from({ length: 12 }, (_, i) => `s${String(i + 1).padStart(2, '0')}`);
const MANY = def('f1-many', Object.fromEntries(NAMES12.map((n) => [n, auto('h')])));

let scratch: string;
let testHome: TestHome;
let h: TempHome;

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'realm-q1f1-'));
  testHome = await createTestHome({ start: T0, root: join(scratch, '.realm') });
  h = await makeTempHome({ home: testHome.root });
  for (const d of [AUTO, GUARD, AGENT, MANY]) await h.home.workflowStore.register(d);
});

afterEach(async () => {
  await h.cleanup();
  await testHome.remove();
  rmSync(scratch, { recursive: true, force: true });
});

/** A `running` run with no step in progress, last changed at `updatedAt`. Returns its ID. */
async function plant(
  d: WorkflowDefinition,
  updatedAt: string,
  extra: Partial<RunRecord> = {},
): Promise<string> {
  const id = randomUUID();
  await h.home.runStore.save({
    id,
    workflow_id: d.id,
    workflow_version: 1,
    run_phase: 'running',
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    version: 1,
    params: {},
    evidence: [],
    created_at: ago(30 * HOUR),
    updated_at: updatedAt,
    terminal_state: false,
    ...extra,
  } as RunRecord);
  return id;
}

/** The built `realm` as a child process on the test home, with no colour. */
function realm(args: string[]): { code: number | null; out: string[]; err: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: scratch,
    env: { PATH: process.env['PATH'] ?? '', HOME: scratch, NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: r.status, out: r.stdout.split('\n').filter((l) => l !== ''), err: r.stderr };
}

/** `realm run list --stuck [args]`: the first line, and the end of each run's line, by run ID. */
function stuck(args: string[] = []): { head: string; ends: Record<string, string> } {
  const r = realm(['run', 'list', '--stuck', ...args]);
  const ends: Record<string, string> = {};
  for (const l of r.out.slice(1)) {
    const id = l.split(' ')[0]!;
    // What follows the idle age's instant: the label, or nothing (a bare idle line).
    ends[id] = l.replace(/^.*idle: [^()]+\(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\)/, '').trim();
  }
  return { head: r.out[0] ?? '', ends };
}

/** `realm run inspect <id>`: the lines under `Run Health:`, up to the next blank-led heading. */
function runHealthLines(id: string): string[] {
  const lines = realm(['run', 'inspect', id]).out;
  const at = lines.findIndex((l) => l.startsWith('Run Health'));
  if (at < 0) return [];
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((l) => !l.startsWith('  '));
  return end < 0 ? rest : rest.slice(0, end);
}

interface Finding {
  kind: string;
  step?: string;
  reason?: string;
  since?: string;
  idle_ms?: number;
  evidence?: Record<string, unknown>;
}

/** `get_run_state` through the MCP server on the same home, with `registry` when given. */
async function getRunState(
  id: string,
  registry?: ExtensionRegistry,
): Promise<{ run_health?: Finding[]; next_actions_status?: string }> {
  const server = createRealmMcpServer({
    runStore: h.home.runStore,
    traceBufferStore: h.home.traceBufferStore,
    failedAttemptStore: h.home.failedAttemptStore,
    workflowStore: h.home.workflowStore,
    ...(registry !== undefined ? { registry } : {}),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'q1f1', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const raw = (await client.callTool({ name: 'get_run_state', arguments: { run_id: id } })) as {
      content: Array<{ text: string }>;
    };
    return JSON.parse(raw.content[0]!.text) as {
      run_health?: Finding[];
      next_actions_status?: string;
    };
  } finally {
    await client.close();
  }
}

/** A registry that has the `auto` steps' handlers. */
function withHandlers(...names: string[]): ExtensionRegistry {
  const r = createDefaultRegistry();
  for (const n of names) r.register('handler', n, { id: n, execute: async () => ({ data: {} }) });
  return r;
}

const owedOf = (fs: Finding[] | undefined) => (fs ?? []).filter((f) => f.kind === 'owed_undriven');

describe('Q1 (#592) unit f1 — check 3: the owed threshold and --older-than (the built realm)', () => {
  it('no flag: owed at 60 s listed with its label, at 59 s not; idle 25 h listed bare, 23 h not; the first line names both limits', async () => {
    const o60 = await plant(AUTO, ago(60_000));
    const o59 = await plant(AUTO, ago(59_000));
    const i25 = await plant(AGENT, ago(25 * HOUR));
    const i23 = await plant(AGENT, ago(23 * HOUR));
    const r = stuck();
    // (a) red when the owed default is not one minute (59 s listed, or 60 s not), the idle finding's
    //     24 h moves, or the first line does not name both limits; (b) prints the head and the ends.
    expect(r).toEqual({
      head: 'Stuck runs (threshold 24h; owed work 1m):',
      ends: { [o60]: `route=owed_undriven (realm run advance ${o60})`, [i25]: '' },
    });
    expect(Object.keys(r.ends)).not.toContain(o59);
    expect(Object.keys(r.ends)).not.toContain(i23);
  }, 120_000);

  it('--older-than sets both limits: 7d omits a run owed for two minutes, 0m lists one owed for 5 s, 2h lists owed and idle runs past 2 h only; the first line names the one value', async () => {
    const o2m = await plant(AUTO, ago(2 * MIN));
    const o5s = await plant(AUTO, ago(5_000));
    const o90 = await plant(AUTO, ago(90 * MIN));
    const o3h = await plant(AUTO, ago(3 * HOUR));
    const i3h = await plant(AGENT, ago(3 * HOUR));
    const label = (id: string) => `route=owed_undriven (realm run advance ${id})`;
    const at7d = stuck(['--older-than', '7d']);
    const at0m = stuck(['--older-than', '0m']);
    const at2h = stuck(['--older-than', '2h']);
    // (a) red when the flag does not reach the owed threshold (7d lists o2m and the others; 0m
    //     misses o5s; 2h lists o90), or the idle threshold stops following it (2h misses i3h);
    //     (b) prints the three listings.
    expect({ at7d, at0m, at2h }).toEqual({
      at7d: { head: 'No stuck runs found (threshold 7d).', ends: {} },
      at0m: {
        head: 'Stuck runs (threshold 0m):',
        ends: {
          [o2m]: label(o2m),
          [o5s]: label(o5s),
          [o90]: label(o90),
          [o3h]: label(o3h),
          [i3h]: '',
        },
      },
      at2h: {
        head: 'Stuck runs (threshold 2h):',
        ends: { [o3h]: label(o3h), [i3h]: '' },
      },
    });
  }, 120_000);
});

describe('Q1 (#592) unit f1 — check 4: the surfaces, and realm run advance clears it', () => {
  it('list ends the line with the label and the advance pointer; inspect prints the Run Health line; get_run_state carries the finding; after realm run advance it is gone from all three', async () => {
    const id = await plant(AUTO, ago(61_000));
    const reason =
      "the engine owes 'route', and the run last changed 1m ago (2031-03-04T05:05:06Z)";
    const before = {
      list: stuck().ends[id],
      inspect: runHealthLines(id),
      state: owedOf((await getRunState(id, withHandlers('route_h'))).run_health),
    };
    // (a) red when the label case leaves renderFindingLabel (no label), the residual group drops
    //     the pointer, inspect leaves the finding out, or get_run_state changes a field;
    //     (b) prints the three surfaces.
    expect(before).toEqual({
      list: `route=owed_undriven (realm run advance ${id})`,
      inspect: [`  owed_undriven [route]: ${reason}`],
      state: [
        {
          kind: 'owed_undriven',
          step: 'route',
          reason,
          since: ago(61_000),
          idle_ms: 61_000,
          evidence: { owed: ['route'], owed_threshold_ms: 60_000 },
        },
      ],
    });
    const mod = join(scratch, 'route.mjs');
    writeFileSync(
      mod,
      "export default { handlers: { route_h: { id: 'route_h', execute: async () => ({ data: { routed: true } }) } } };\n",
      'utf8',
    );
    const advanced = realm(['run', 'advance', id, '--extensions-module', mod]);
    // Two minutes later than the advance: past the owed threshold, so only "nothing owed" keeps the
    // finding away.
    await testHome.clock.advance(2 * MIN);
    const after = {
      code: advanced.code,
      completed: (await h.home.runStore.get(id)).record.completed_steps,
      list: stuck(),
      inspect: runHealthLines(id),
      state: owedOf((await getRunState(id, withHandlers('route_h'))).run_health),
    };
    // (a) red when the finding outlives the step it named (the owed set read before the advance,
    //     or `review` — an agent step — counted as owed); (b) prints the advance and the surfaces.
    expect(after, advanced.err).toEqual({
      code: 0,
      completed: ['route'],
      list: { head: 'No stuck runs found (threshold 24h; owed work 1m).', ends: {} },
      inspect: [],
      state: [],
    });
  }, 180_000);

  it('get_run_state cuts the owed list at ten with owed_more; the reason names ten and the rest as a count', async () => {
    const id = await plant(MANY, ago(61_000));
    const [finding] = owedOf((await getRunState(id, withHandlers('h'))).run_health);
    // (a) red when the reply's list is not cut at ten, `owed_more` is not the count left out, or the
    //     reason is not bounded; (b) prints the finding.
    expect(finding).toEqual({
      kind: 'owed_undriven',
      step: 's01',
      reason:
        "the engine owes 's01', 's02', 's03', 's04', 's05', 's06', 's07', 's08', 's09', 's10' and 2 more, and the run last changed 1m ago (2031-03-04T05:05:06Z)",
      since: ago(61_000),
      idle_ms: 61_000,
      evidence: { owed: NAMES12.slice(0, 10), owed_more: 2, owed_threshold_ms: 60_000 },
    });
  }, 60_000);
});

describe('Q1 (#592) unit f1 — check 5: the capability case per surface, and the ready guard', () => {
  it('a step whose handler this program lacks: list and inspect (no registry: unknown) show the finding; get_run_state, whose registry lacks it, does not', async () => {
    const id = await plant(AUTO, ago(61_000));
    const reply = await getRunState(id);
    // (a) red when list or inspect pass a registry (or a capability-unknown step stops counting as
    //     owed), or get_run_state counts a step its own registry cannot run; (b) prints the surfaces.
    expect({
      list: stuck().ends[id],
      inspect: runHealthLines(id).filter((l) => l.startsWith('  owed_undriven')).length,
      state: owedOf(reply.run_health).length,
      status: reply.next_actions_status,
    }).toEqual({
      list: `route=owed_undriven (realm run advance ${id})`,
      inspect: 1,
      state: 0,
      status: 'blocked_on_capability',
    });
  }, 60_000);

  it('a ready guard after a minute: list ends the line with the owed label; inspect prints guard_awaiting_settlement and owed_undriven, both naming the guard', async () => {
    const id = await plant(GUARD, ago(61_000), { completed_steps: ['gated_step'] });
    // (a) red when a guard is not counted as owed, or the two findings stop co-firing; (b) prints
    //     the line's end and the Run Health lines.
    expect({
      list: stuck().ends[id],
      inspect: runHealthLines(id).map((l) => l.replace(/\]: .*/, ']')),
    }).toEqual({
      list: `guard_after=owed_undriven (realm run advance ${id})`,
      inspect: ['  guard_awaiting_settlement [guard_after]', '  owed_undriven [guard_after]'],
    });
  }, 60_000);
});

describe('Q1 (#592) unit f1 — check 6: the pages and the help say it, word for word', () => {
  const page = (p: string) => flat(readFileSync(join(ROOT, p), 'utf8'));
  /** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
  const claim = (p: string, sentence: string) =>
    expect(page(p), `${p} no longer says: ${sentence}`).toContain(flat(sentence));

  it('run-state-and-health.md: the owed_undriven row, its "Found when" and its label', () => {
    claim(
      'docs/reference/mcp/run-state-and-health.md',
      "| `owed_undriven` | The run is in `running`, no step is in progress, the engine owes work — a guard to decide or an `auto` step to run — and the run has not changed for a minute (`realm run list --older-than` moves the limit). `realm run advance <run-id>` runs what is owed, when the code it loads has the step's handler. A step that `realm agent` must run is not the engine's: a run waiting for it gets no such finding. A ready guard also shows `guard_awaiting_settlement`. A failed drive counts as a change, so after one the finding waits another minute; the run then also shows `drive_failing`. Added after version 0.50.0. | `<step>=owed_undriven (realm run advance <run-id>)` |",
    );
  });

  it('realm-run-reading.md: the --older-than row, the first line, the idle-line sentence and the label sentence', () => {
    const p = 'docs/reference/cli/realm-run-reading.md';
    claim(
      p,
      '| `--older-than <duration>` | With `--stuck`: how long a run must have been unchanged to be listed for the two age-gated findings, `never_claimed_idle` (default `24h`) and `owed_undriven` (default `1m`, added after version 0.50.0); one value sets both. Every other finding lists its run at any age. |',
    );
    claim(
      p,
      'With `--stuck`, a first line gives the limits (the one value `--older-than` gave, as below, or both defaults: `threshold 24h; owed work 1m`, added after version 0.50.0)',
    );
    claim(
      p,
      'the limit applies to that finding and to `owed_undriven`, whose own default is one minute (added after version 0.50.0); every other finding lists its run at any age',
    );
    claim(
      p,
      "A run whose next work is the engine's, and that has not changed for the limit, ends its line with `<step>=owed_undriven (realm run advance <run-id>)` (added after version 0.50.0).",
    );
  });

  it('realm-run-acting.md: list --stuck points at advance', () => {
    claim(
      'docs/reference/cli/realm-run-acting.md',
      "`realm run list --stuck` points here: a run whose next work is the engine's, and that has not changed for a minute, ends its line with `<step>=owed_undriven (realm run advance <run-id>)` (added after version 0.50.0).",
    );
  });

  it('CHANGELOG: the Added line under [Unreleased], naming RunHealthFinding and ClassifyRunHealthOptions', () => {
    const text = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
    const from = text.indexOf('## [Unreleased]');
    const unreleased = text.slice(from, text.indexOf('\n## [', from + 1));
    const added = unreleased.slice(unreleased.indexOf('### Added'));
    const line =
      "- **A run whose next work is the engine's, and that nobody is driving, shows on `realm run list --stuck` after a minute.** The new finding `owed_undriven` names the step and the command that moves it (`realm run advance <run-id>`); `realm run inspect` and `get_run_state`'s `run_health` carry it too. `--older-than` now sets this finding's limit as well as the idle finding's. `RunHealthFinding`'s `kind` gains the word: a program that switches exhaustively on it must add the case. `ClassifyRunHealthOptions` gains the owed threshold.";
    // (a) red when the line leaves [Unreleased]'s Added list or changes; (b) prints the sentence.
    expect(flat(added), `CHANGELOG [Unreleased] ### Added no longer says: ${line}`).toContain(
      flat(line),
    );
  });

  it('the --older-than help (the built realm) names both checks and both defaults', () => {
    const r = realm(['run', 'list', '--help']);
    const help =
      "With --stuck: how long a run must have been unchanged to be listed for the two age-gated findings — the never-claimed-idle check (default 24h) and the owed-undriven check (default 1m); one value sets both (e.g. 24h, 7d). '0m' lists every such run regardless of age; bare '0' is rejected — use '0m'. Distinct from 'realm run reclaim --older-than', which is a deadline-margin add-on for auto-reclaim selection, not an idle-age threshold.";
    // (a) red when the help is not the built one's; (b) prints the help.
    expect(flat(r.out.join(' ')), r.out.join('\n')).toContain(flat(help));
  }, 60_000);
});
