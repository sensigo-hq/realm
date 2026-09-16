// issue #558 PR-T — the eight shapes a registered workflow copy can be in, the ONE table that
// classifies them, and the composed remedy every run-context refusal now carries.
//
// The shapes: `rm` · `chmod 000` the file · a DIRECTORY where a file belongs · truncated to 0
// bytes · a `null` JSON root · corrupt JSON · a legacy record (no `schema_version`) · `chmod 000`
// the registry DIRECTORY. On `main` the first crashed with the #456 hedge on a file that exists,
// the third/fourth/fifth crashed `workflow list` with a stack trace, and the second escaped as a
// bare V8 `EACCES: permission denied` with no code and no remedy.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, chmod } from 'node:fs/promises';
import { readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonWorkflowStore,
  getWorkflowForRun,
  probeClassToError,
  parseFailureError,
  STUCK_DEFINITION_PARSE_CAP_BYTES,
} from './registrar.js';
import { WorkflowError } from '../types/workflow-error.js';
import type { RunRecord } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import { CURRENT_WORKFLOW_SCHEMA_VERSION } from './yaml-loader.js';

const ID = 'gate-558';

function makeDefinition(id: string): WorkflowDefinition {
  return {
    id,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: [{ id: 'one', execution: 'agent', description: 'step one' }],
  } as unknown as WorkflowDefinition;
}

function makeRun(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    workflow_id: ID,
    workflow_version: 1,
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'running',
    version: 1,
    params: {},
    evidence: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    terminal_state: false,
    ...over,
  } as RunRecord;
}

const TERMINAL = makeRun({
  terminal_state: true,
  failed_steps: ['one'],
  sealed_by: { arm: 'step_failure', at: '2026-01-01T00:00:00.000Z' },
} as Partial<RunRecord>);

const GATE_WAITING = makeRun({
  pending_gate: {
    gate_id: 'g1',
    step_name: 'confirm',
    preview: {},
    choices: ['approve', 'reject'],
    opened_at: '2026-01-01T00:00:00.000Z',
  },
} as Partial<RunRecord>);

const RESPOND = { retryVerb: 'respond again', verb: 'respond' };

let dir: string;
let store: JsonWorkflowStore;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'realm-pr-t-'));
  store = new JsonWorkflowStore(dir);
  file = join(dir, `${ID}.json`);
});

afterEach(async () => {
  // A chmod-000 directory cannot be removed by its own contents; restore before rm.
  try {
    chmodSync(dir, 0o755);
  } catch {
    /* already removable */
  }
  await rm(dir, { recursive: true, force: true });
});

/** The eight shapes, each built from the OS up — never from a mock of the OS. */
const shape = {
  async rm() {
    /* nothing written */
  },
  async chmod000() {
    await writeFile(file, JSON.stringify(makeDefinition(ID)));
    await chmod(file, 0o000);
  },
  async directory() {
    await mkdir(file);
  },
  async empty() {
    await writeFile(file, '');
  },
  async nullRoot() {
    await writeFile(file, 'null');
  },
  async corrupt() {
    await writeFile(file, '{"a"');
  },
  async legacy() {
    await writeFile(file, JSON.stringify({ id: ID, version: 1, steps: [] }));
  },
  async registryBroken() {
    await writeFile(file, JSON.stringify(makeDefinition(ID)));
    await chmod(dir, 0o000);
  },
};

describe('JsonWorkflowStore.probe — the eight shapes, classified before a byte is read', () => {
  it('P1 a missing copy is `missing` (and carries the path it looked for)', async () => {
    await shape.rm();
    expect(store.probe(ID)).toEqual({ ok: false, class: 'missing', path: file });
  });

  it('P2 a chmod-000 copy is `unreadable` with EACCES — statSync SUCCEEDS on it, so the accessSync call is what catches it', async () => {
    await shape.chmod000();
    expect(store.probe(ID)).toEqual({
      ok: false,
      class: 'unreadable',
      errno: 'EACCES',
      path: file,
    });
  });

  it('P3 a DIRECTORY where a file belongs is `not_a_file` and carries NO errno key (a directory is not an OS error)', async () => {
    await shape.directory();
    const result = store.probe(ID);
    expect(result).toEqual({ ok: false, class: 'not_a_file', path: file });
    expect(Object.keys(result)).not.toContain('errno');
  });

  it('P4 a zero-byte copy is `empty`', async () => {
    await shape.empty();
    expect(store.probe(ID)).toEqual({ ok: false, class: 'empty', path: file });
  });

  it('P5 a readable copy is `{ok:true}` with its byte count (what the --stuck cap reads)', async () => {
    const bytes = JSON.stringify(makeDefinition(ID));
    await writeFile(file, bytes);
    expect(store.probe(ID)).toEqual({ ok: true, bytes: Buffer.byteLength(bytes) });
  });

  it('P6 an unreadable registry DIRECTORY is `registry_broken`, keyed on the dir, not the file', async () => {
    await shape.registryBroken();
    expect(store.probe(ID)).toEqual({
      ok: false,
      class: 'registry_broken',
      errno: 'EACCES',
      path: dir,
    });
  });

  it('P7 the ENOENT carve-out: a registry directory that is GONE reports `missing`, never `registry_broken` — a fresh HOME must never be told its registry is unreadable', async () => {
    // A unit cell by necessity: `JsonWorkflowStore`'s constructor `mkdirSync`s the directory, so
    // no CLI journey can observe ENOENT on it. The carve-out is defensive, and this cell says so.
    await rm(dir, { recursive: true, force: true });
    expect(store.probe(ID)).toEqual({ ok: false, class: 'missing', path: file });
  });
});

describe('probeClassToError — the table, whole-message', () => {
  it('T1 missing keeps main’s bytes verbatim (28 pins ride on this string)', () => {
    const err = probeClassToError({ ok: false, class: 'missing', path: '/x/gate-558.json' }, ID);
    expect(err.message).toBe('Workflow not found: gate-558');
    expect(err.code).toBe('STATE_WORKFLOW_NOT_FOUND');
  });

  it('T2 unreadable names the errno and the path', () => {
    const err = probeClassToError(
      { ok: false, class: 'unreadable', errno: 'EACCES', path: '/x/gate-558.json' },
      ID,
    );
    expect(err.message).toBe(
      "the registered copy of 'gate-558' could not be read (EACCES: /x/gate-558.json)",
    );
    expect(err.code).toBe('STATE_WORKFLOW_UNREADABLE');
    expect(err.agentAction).toBe('stop');
    expect(err.retryable).toBe(false);
    expect(err.details).toEqual({ class: 'unreadable', errno: 'EACCES', path: '/x/gate-558.json' });
  });

  it('T3 not_a_file says directory and fabricates NO errno', () => {
    const err = probeClassToError({ ok: false, class: 'not_a_file', path: '/x/gate-558.json' }, ID);
    expect(err.message).toBe('/x/gate-558.json is a directory, not a workflow file');
    expect(err.code).toBe('STATE_WORKFLOW_UNREADABLE');
    expect(err.details).toEqual({ class: 'not_a_file', path: '/x/gate-558.json' });
    expect(Object.keys(err.details as Record<string, unknown>)).not.toContain('errno');
  });

  it('T4 empty is a RESOURCE refusal, not a STATE one', () => {
    const err = probeClassToError({ ok: false, class: 'empty', path: '/x/gate-558.json' }, ID);
    expect(err.message).toBe(
      "the registered copy of 'gate-558' is empty (0 bytes) — not a workflow",
    );
    expect(err.code).toBe('RESOURCE_FORMAT_INVALID');
  });

  it('T5 registry_broken names the DIRECTORY', () => {
    const err = probeClassToError(
      { ok: false, class: 'registry_broken', errno: 'EACCES', path: '/x' },
      ID,
    );
    expect(err.message).toBe('the workflow registry at /x cannot be read (EACCES)');
    expect(err.code).toBe('STATE_WORKFLOW_UNREADABLE');
  });

  it('T6 parseFailureError forks on the CAUSE — a thrown parser error vs a parsed non-object root', () => {
    let thrown: unknown;
    try {
      JSON.parse('{"a"');
    } catch (err) {
      thrown = err;
    }
    expect(parseFailureError(ID, '/x/gate-558.json', thrown).message).toBe(
      "the registered copy of 'gate-558' is not parseable JSON: Expected ':' after property name in JSON at position 4 (line 1 column 5)",
    );
    expect(parseFailureError(ID, '/x', null).message).toBe(
      "the registered copy of 'gate-558' is JSON but not a workflow object (it is null)",
    );
    expect(parseFailureError(ID, '/x', [1]).message).toBe(
      "the registered copy of 'gate-558' is JSON but not a workflow object (it is array)",
    );
    expect(parseFailureError(ID, '/x', 7).message).toBe(
      "the registered copy of 'gate-558' is JSON but not a workflow object (it is number)",
    );
  });

  it('T7 a path with non-ASCII bytes survives the sentence unmangled', () => {
    const p = '/tmp/é中文-✓/gate-558.json';
    const err = probeClassToError({ ok: false, class: 'unreadable', errno: 'EACCES', path: p }, ID);
    expect(err.message).toBe(`the registered copy of 'gate-558' could not be read (EACCES: ${p})`);
    expect(err.message).toContain('中文');
  });
});

describe('get() — every escape comes from the two builders (the source-text witness)', () => {
  it('W1 above the JSON.parse line there is no `new WorkflowError(` and every throw is a `throw probeClassToError(`', () => {
    // A FORM rule, not a count of one: `probe()` and `readFileSync` are two syscalls apart, so a
    // file that probes readable can still fail the read (a racing chmod, a racing unlink). That
    // TOCTOU escape is classified through the SAME table — a second `throw probeClassToError(`.
    const src = readFileSync(new URL('./registrar.ts', import.meta.url), 'utf8');
    const start = src.indexOf('  getSync(workflowId: string): WorkflowDefinition {');
    expect(start).toBeGreaterThan(-1);
    const parseAt = src.indexOf('JSON.parse(raw)', start);
    expect(parseAt).toBeGreaterThan(start);
    const above = src.slice(start, parseAt);
    expect(above.match(/new WorkflowError\(/g)).toBeNull();
    const throws = above.match(/throw [A-Za-z]+\(/g) ?? [];
    expect(throws.length).toBeGreaterThanOrEqual(1);
    for (const t of throws) expect(t).toBe('throw probeClassToError(');
    // Below the parse line: the parse builder and the untouched legacy mint, nothing else.
    const below = src.slice(parseAt, src.indexOf('  async list()', parseAt));
    const belowThrows = below.match(/throw [A-Za-z]+\(|throw new WorkflowError\(/g) ?? [];
    for (const t of belowThrows) {
      expect(['throw parseFailureError(', 'throw new WorkflowError(']).toContain(t);
    }
  });

  it('W2 the --stuck parse cap is 4 MB and is NOT applied by get() (#552 door B)', async () => {
    expect(STUCK_DEFINITION_PARSE_CAP_BYTES).toBe(4 * 1024 * 1024);
    const src = readFileSync(new URL('./registrar.ts', import.meta.url), 'utf8');
    const body = src.slice(
      src.indexOf('  getSync(workflowId: string): WorkflowDefinition {'),
      src.indexOf('  async list()'),
    );
    expect(body).not.toContain('STUCK_DEFINITION_PARSE_CAP_BYTES');
  });
});

describe('listWithDiagnostics — one class per entry, never a throw', () => {
  it('L1 a chmod-000 entry is `unreadable` with its errno, and is NEVER read', async () => {
    await shape.chmod000();
    const d = await store.listWithDiagnostics();
    expect(d.workflows).toEqual([]);
    expect(d.unreadable).toEqual([
      {
        file: `${ID}.json`,
        class: 'unreadable',
        errno: 'EACCES',
        reason: `the registered copy of '${ID}' could not be read (EACCES: ${file})`,
      },
    ]);
  });

  it('L2 a directory entry is `not_a_file` with no errno; an empty entry is `empty`', async () => {
    await shape.directory();
    await writeFile(join(dir, 'blank.json'), '');
    const d = await store.listWithDiagnostics();
    const byClass = Object.fromEntries(d.unreadable.map((u) => [u.class, u]));
    expect(byClass['not_a_file']?.errno).toBeUndefined();
    expect(byClass['empty']?.reason).toBe(
      "the registered copy of 'blank' is empty (0 bytes) — not a workflow",
    );
  });

  it('L3 a `null` root is `parse` and does NOT crash the walk (main threw a TypeError here)', async () => {
    await shape.nullRoot();
    const d = await store.listWithDiagnostics();
    expect(d.unreadable[0]?.class).toBe('parse');
    expect(d.unreadable[0]?.reason).toBe(
      "the registered copy of 'gate-558' is JSON but not a workflow object (it is null)",
    );
  });

  it('L4 an unreadable registry DIRECTORY returns ONE registry_broken diagnostic — never a throw (main crashed readdirSync)', async () => {
    await shape.registryBroken();
    const d = await store.listWithDiagnostics();
    expect(d.workflows).toEqual([]);
    expect(d.mismatched).toEqual([]);
    expect(d.unreadable).toEqual([
      {
        file: dir,
        class: 'registry_broken',
        errno: 'EACCES',
        reason: `the workflow registry at ${dir} cannot be read (EACCES)`,
      },
    ]);
  });

  it('L5 a LEGACY copy stays LISTED (readable — its SCHEMA column is the disclosure, #427)', async () => {
    await shape.legacy();
    const d = await store.listWithDiagnostics();
    expect(d.workflows).toHaveLength(1);
    expect(d.unreadable).toEqual([]);
  });
});

describe('getWorkflowForRun — the composed remedy, per code, per run', () => {
  it('C-a a LIVE run whose copy is chmod-000: the sentence names EACCES and the path, then the way out and the repair', async () => {
    await shape.chmod000();
    const err = (await getWorkflowForRun(store, makeRun(), RESPOND).catch(
      (e: unknown) => e,
    )) as WorkflowError;
    expect(err.code).toBe('STATE_WORKFLOW_UNREADABLE');
    expect(err.message).toBe(
      `the registered copy of 'gate-558' could not be read (EACCES: ${file}). ` +
        `This run's workflow cannot be read. To end the run: realm run abandon run-1. ` +
        `To repair: fix ${file} and respond again.`,
    );
  });

  it('C-b a TERMINAL run: "there is nothing to respond" REPLACES the retry remedy, and the repair clause survives (the copy is still broken for every other run)', async () => {
    await shape.chmod000();
    const err = (await getWorkflowForRun(store, TERMINAL, RESPOND).catch(
      (e: unknown) => e,
    )) as WorkflowError;
    expect(err.message).toBe(
      `the registered copy of 'gate-558' could not be read (EACCES: ${file}). ` +
        `The run is terminal (failed); there is nothing to respond. To repair: fix ${file}.`,
    );
  });

  it('C-c terminalOk:true suppresses the terminal conjunct — the SEVEN sites whose happy path IS terminal keep their remedy', async () => {
    await shape.rm();
    const err = (await getWorkflowForRun(store, TERMINAL, {
      retryVerb: 'resume again',
      verb: 'resume',
      terminalOk: true,
    }).catch((e: unknown) => e)) as WorkflowError;
    expect(err.message).toBe(
      'Workflow not found: gate-558 — most often this run was created from a file without ' +
        '--register. Register the workflow (realm workflow register <file>) and resume again.',
    );
  });

  it('C-k (review fold C9) a TERMINAL run through a terminalOk site never gets "To end the run" — abandon refuses a finished run — while the repair survives, whole-message', async () => {
    const unreadable = {
      get: async () => {
        throw new WorkflowError(
          "the registered copy of 'gate-558' could not be read (EACCES: /x)",
          {
            code: 'STATE_WORKFLOW_UNREADABLE',
            category: 'STATE',
            agentAction: 'stop',
            retryable: false,
            details: { class: 'unreadable', errno: 'EACCES', path: '/x' },
          },
        );
      },
    };
    const err = (await getWorkflowForRun(unreadable, TERMINAL, {
      retryVerb: 'drain again',
      verb: 'drain',
      terminalOk: true,
    }).catch((e: unknown) => e)) as WorkflowError;
    expect(err.message).toBe(
      "the registered copy of 'gate-558' could not be read (EACCES: /x). To repair: fix /x and drain again.",
    );
    expect(err.message).not.toContain('To end the run');
    // The LIVE control for the same store: the way out is back.
    const live = (await getWorkflowForRun(
      unreadable,
      { ...TERMINAL, terminal_state: false },
      {
        retryVerb: 'drain again',
        verb: 'drain',
        terminalOk: true,
      },
    ).catch((e: unknown) => e)) as WorkflowError;
    expect(live.message).toContain(`To end the run: realm run abandon ${TERMINAL.id}.`);
  });

  it('C-d the disposal fork, gate-LESS: "To end the run: realm run abandon <id>."', async () => {
    await shape.empty();
    const err = (await getWorkflowForRun(store, makeRun(), RESPOND).catch(
      (e: unknown) => e,
    )) as WorkflowError;
    expect(err.message).toBe(
      "the registered copy of 'gate-558' is empty (0 bytes) — not a workflow. " +
        'To end the run: realm run abandon run-1. To repair: re-register the workflow from its ' +
        'source (realm workflow register <path-to-workflow>), then respond again.',
    );
  });

  it('C-e the disposal fork, gate-WAITING (corrupt): the gate cannot be answered until the copy reads, abandon refuses, and the REPAIR ends in the answer command — never the failed command as the way out, never a ticket reference (review fold C12)', async () => {
    await shape.empty();
    const err = (await getWorkflowForRun(store, GATE_WAITING, RESPOND).catch(
      (e: unknown) => e,
    )) as WorkflowError;
    expect(err.message).toBe(
      "the registered copy of 'gate-558' is empty (0 bytes) — not a workflow. " +
        "This run is waiting on human gate 'confirm', which cannot be answered until its " +
        'workflow can be read; realm run abandon refuses a run that is waiting on a gate. ' +
        'To repair: re-register the workflow from its source (realm workflow register ' +
        '<path-to-workflow>), then answer the gate (realm run respond run-1 --gate g1 ' +
        '--choice <one of: approve, reject>).',
    );
    expect(err.message).not.toContain('To end the run');
    expect(err.message).not.toContain('PR-V');
    expect(err.message).not.toContain('answer it (');
  });

  it('C-e2 the gate fork on an UNREADABLE copy: "fix <path> and answer the gate (…)" — the per-member twin of C-e', async () => {
    await shape.chmod000();
    const err = (await getWorkflowForRun(store, GATE_WAITING, RESPOND).catch(
      (e: unknown) => e,
    )) as WorkflowError;
    expect(err.message).toBe(
      `the registered copy of 'gate-558' could not be read (EACCES: ${file}). ` +
        "This run is waiting on human gate 'confirm', which cannot be answered until its " +
        'workflow can be read; realm run abandon refuses a run that is waiting on a gate. ' +
        `To repair: fix ${file} and answer the gate (realm run respond run-1 --gate g1 ` +
        '--choice <one of: approve, reject>).',
    );
    expect(err.message).not.toContain("This run's workflow cannot be read.");
  });

  it('C-e3 the gate fork on a LEGACY copy: the store\'s own re-register remedy once, then "Once re-registered, answer the gate (…)"', async () => {
    await shape.legacy();
    const err = (await getWorkflowForRun(store, GATE_WAITING, RESPOND).catch(
      (e: unknown) => e,
    )) as WorkflowError;
    expect(err.message).toBe(
      'This workflow was registered with an older version of Realm. ' +
        'Re-register it with: realm workflow register <path-to-workflow>. ' +
        "This run is waiting on human gate 'confirm', which cannot be answered until its " +
        'workflow can be read; realm run abandon refuses a run that is waiting on a gate. ' +
        'Once re-registered, answer the gate (realm run respond run-1 --gate g1 ' +
        '--choice <one of: approve, reject>).',
    );
    expect(err.message.split('realm workflow register').length - 1).toBe(1); // one remedy, never doubled
  });

  it('C-f the suffix heuristic: an agent-shaped id gets the no-source sentence, a plain id keeps the #456 hedge, and a HUMAN id carrying a 16-hex suffix gets the agent one too (a SHAPE heuristic, stated)', async () => {
    const agent = (await getWorkflowForRun(
      store,
      makeRun({ workflow_id: 'dynamic-0123456789abcdef' }),
      RESPOND,
    ).catch((e: unknown) => e)) as WorkflowError;
    expect(agent.message).toBe(
      "Workflow 'dynamic-0123456789abcdef' not found — this run's workflow was created by an " +
        'agent (create_workflow) and its stored copy is gone; there is no source file to ' +
        'register. To end the run: realm run abandon run-1.',
    );

    const plain = (await getWorkflowForRun(
      store,
      makeRun({ workflow_id: 'plain-wf' }),
      RESPOND,
    ).catch((e: unknown) => e)) as WorkflowError;
    expect(plain.message).toBe(
      'Workflow not found: plain-wf — most often this run was created from a file without ' +
        '--register. Register the workflow (realm workflow register <file>) and respond again.',
    );

    // The control the heuristic's own JSDoc promises: realm has no provenance field, so a
    // human-registered id that happens to end in 16 hex chars is told the agent story. Pinned so
    // the trade-off is a decision on the record and not an accident.
    const lookalike = (await getWorkflowForRun(
      store,
      makeRun({ workflow_id: 'my-report-0123456789abcdef' }),
      RESPOND,
    ).catch((e: unknown) => e)) as WorkflowError;
    expect(lookalike.message).toContain('was created by an agent (create_workflow)');
  });

  it('C-g the LEGACY composition, whole-message: the store’s own remedy, then "To end the run instead:" (a sentence join, never a run-on)', async () => {
    await shape.legacy();
    const err = (await getWorkflowForRun(store, makeRun(), RESPOND).catch(
      (e: unknown) => e,
    )) as WorkflowError;
    expect(err.code).toBe('STATE_LEGACY_FORMAT');
    expect(err.message).toBe(
      'This workflow was registered with an older version of Realm. Re-register it with: ' +
        'realm workflow register <path-to-workflow>. To end the run instead: realm run abandon run-1.',
    );
  });

  it('C-h a corrupt copy on a LIVE run: one voice with the parse builder', async () => {
    await shape.corrupt();
    const err = (await getWorkflowForRun(store, makeRun(), RESPOND).catch(
      (e: unknown) => e,
    )) as WorkflowError;
    expect(err.code).toBe('RESOURCE_FORMAT_INVALID');
    expect(err.message).toContain(
      "the registered copy of 'gate-558' is not parseable JSON: Expected ':' after property name",
    );
    expect(err.message).toContain('To end the run: realm run abandon run-1.');
  });

  it('C-i a `not_a_file` copy on a LIVE run', async () => {
    await shape.directory();
    const err = (await getWorkflowForRun(store, makeRun(), RESPOND).catch(
      (e: unknown) => e,
    )) as WorkflowError;
    expect(err.message).toBe(
      `${file} is a directory, not a workflow file. This run's workflow cannot be read. ` +
        `To end the run: realm run abandon run-1. To repair: fix ${file} and respond again.`,
    );
  });

  it('C-j an unreadable REGISTRY on a LIVE run names the directory, not the file', async () => {
    await shape.registryBroken();
    const err = (await getWorkflowForRun(store, makeRun(), RESPOND).catch(
      (e: unknown) => e,
    )) as WorkflowError;
    expect(err.message).toBe(
      `the workflow registry at ${dir} cannot be read (EACCES). This run's workflow cannot be ` +
        `read. To end the run: realm run abandon run-1. To repair: fix ${dir} and respond again.`,
    );
  });
});
