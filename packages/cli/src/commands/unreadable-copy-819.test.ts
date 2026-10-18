// unreadable-copy-819.test.ts — #819 (U2) on the CLI: a registered copy that is valid JSON at the
// current format but has no `steps` object is named, with its repair, by `realm run inspect` and
// `realm workflow list` — never a raw internal error (W's walk 1: "Cannot read properties of
// undefined (reading 'approve')"; the copy listed as a normal workflow).
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: file
// names, printed lines — never a token or an environment.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectRun } from './inspect.js';
import { workflowListCommand } from './workflow-list.js';

describe('#819 U2 — a copy with no steps, on the CLI', () => {
  let home: string;
  let wfDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'realm-copy-819-'));
    wfDir = join(home, '.realm', 'workflows');
    await mkdir(join(home, '.realm', 'runs'), { recursive: true });
    await mkdir(wfDir, { recursive: true });
    originalHome = process.env['HOME'];
    process.env['HOME'] = home;
    // W's walk 1: the copy at the current format, its `steps` key removed.
    await writeFile(
      join(wfDir, 'plain-gate.json'),
      JSON.stringify({ id: 'plain-gate', name: 'plain-gate', version: 1, schema_version: 1 }),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  it('realm run inspect names the copy and its repair, with no internal error', async () => {
    const { JsonFileStore, JsonWorkflowStore } = await import('@sensigo/realm');
    const store = new JsonFileStore();
    const { run } = await store.create({
      workflowId: 'plain-gate',
      workflowVersion: 1,
      params: {},
    });
    await store.update({
      ...run,
      pending_gate: {
        gate_id: 'g-1',
        step_name: 'approve',
        preview: {},
        choices: ['ship', 'hold'],
        opened_at: '2026-01-01T00:00:00.000Z',
      },
    });
    const text = await inspectRun(run.id, store, new JsonWorkflowStore());
    // (a) red when the copy passes the copy check (inspect then reads `steps` of undefined), or the
    //     repair is not named; (b) prints whether each part is there.
    expect({
      copy: text.includes(
        "the registered copy of 'plain-gate' is JSON but not a workflow object (its steps is not an object)",
      ),
      repair: text.includes(
        'To repair: re-register the workflow from its source (realm workflow register <path-to-workflow>), then answer the gate',
      ),
      internal: /Cannot read properties|Cannot convert undefined/.test(text),
    }).toEqual({ copy: true, repair: true, internal: false });
  });

  it('realm workflow list names the copy (⚠ line) and, in --json, its reason and repair — never a row of the table', async () => {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m: unknown) => void out.push(String(m)));
    vi.spyOn(console, 'warn').mockImplementation((m: unknown) => void err.push(String(m)));
    await workflowListCommand.parseAsync([], { from: 'user' });
    const text = { out: out.join('\n'), err: err.join('\n') };
    out.length = 0;
    await workflowListCommand.parseAsync(['--json'], { from: 'user' });
    const json = JSON.parse(out.join('\n')) as {
      workflows: unknown[];
      unreadable: Array<{ file: string; class: string; reason: string; repair?: string }>;
    };
    // (a) red when the copy is listed as a workflow (W's walk 1), or its --json entry names no
    //     repair; (b) prints the table's count, the ⚠ line and the entry.
    expect({
      registered: text.out.includes(
        '0 workflows registered; 1 entry in the registry could not be read.',
      ),
      warned: text.err.includes('⚠ 1 file in the registry could not be parsed: plain-gate.json'),
      entry: json.unreadable.find((u) => u.file === 'plain-gate.json'),
      listed: json.workflows.length,
    }).toEqual({
      registered: true,
      warned: true,
      entry: {
        file: 'plain-gate.json',
        class: 'parse',
        reason:
          "the registered copy of 'plain-gate' is JSON but not a workflow object (its steps is not an object)",
        repair: `re-register the workflow from its source (realm workflow register <path-to-workflow>); if it was never registered from a source, remove the file (rm ${join(wfDir, 'plain-gate.json')}) instead`,
      },
      listed: 0,
    });
  });
});
