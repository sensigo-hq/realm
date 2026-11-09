// issue #558 PR-T — `realm workflow list`'s census, per CLASS. Until this PR one sentence spoke
// for every failure ("could not be parsed"), which was FALSE for four of the five classes: a
// chmod-000 file was reported as unparseable (executed on main), and a `null`-root entry or an
// unreadable registry directory crashed the command with a stack trace.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workflowListCommand } from './workflow-list.js';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  legacyCopyError,
  newerCopyError,
  storedCopyFaultError,
  unreadableById,
} from '@sensigo/realm';
import type { UnreadableIdEntry, WorkflowDefinition } from '@sensigo/realm';
import type { CliHome } from '../lib/home.js';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

const TAIL = ' — realm cannot audit what it cannot read.';

function definition(id: string): WorkflowDefinition {
  return {
    id,
    name: `Name ${id}`,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    origin: 'human',
    steps: { a: { description: 'a', execution: 'agent' } },
  } as WorkflowDefinition;
}

describe('realm workflow list — one sentence per class (issue #558 PR-T)', () => {
  let home: string;
  let h: TempHome;
  let originalHome: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'realm-wf-class-'));
    h = await makeTempHome({ home: join(home, '.realm') });
    originalHome = process.env['HOME'];
    process.env['HOME'] = home;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    await h.cleanup();
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const stderr = (): string => warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');

  it("K8 a LEGACY record (the older cohort's shape) is never a crash (main died at `.length`; review fold C10) — named on the older-version ⚠ line with its way out (#819 U4), never a table row (correction 2, 8.6 (c))", async () => {
    // #819 (U3): the older cohort's shape — a string name and a number version (W-C2R-CORE-12).
    await h.home.workflowStore.register({ id: 'wleg', name: 'wleg', version: 1 } as never);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);

    await workflowListCommand.parseAsync([], { from: 'user' });

    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    // Correction 2 (8.6 (c)): every run path refuses a legacy copy, so it is never in the table.
    expect({
      row: out.split('\n').some((l: string) => l.startsWith('wleg')),
      footer: out.includes('0 workflows registered; 1 entry in the registry could not be read.'),
      // #819 (U4): red when the ⚠ line names no way out.
      warned: stderr().includes(
        '⚠ 1 workflow in the registry was registered by an older version of Realm: wleg; re-register each from its source (realm workflow register <path-to-workflow>) — realm cannot audit what it cannot read.',
      ),
    }).toEqual({ row: false, footer: true, warned: true });
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

// #616 PR-2c c5a — the id arm (a registry with no files, the SQLite registry): its entries name each
// workflow by id. The CLI home is the JSON registry, so the listing is injected through its
// `listWithDiagnostics`, with entries built by core's own builders (`unreadableById`).
describe('realm workflow list — entries by workflow id (#616 PR-2c c5a)', () => {
  let home: string;
  let h: TempHome;
  let originalHome: string | undefined;
  const out: string[] = [];
  const err: string[] = [];

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'realm-wf-ids-'));
    h = await makeTempHome({ home: join(home, '.realm') });
    originalHome = process.env['HOME'];
    process.env['HOME'] = home;
    out.length = 0;
    err.length = 0;
    vi.spyOn(console, 'log').mockImplementation((m: unknown) => void out.push(String(m)));
    vi.spyOn(console, 'warn').mockImplementation((m: unknown) => void err.push(String(m)));
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    await h.cleanup();
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const damaged = (id: string) =>
    unreadableById(id, storedCopyFaultError(id, { kind: 'not_a_workflow', fault: 'no_steps' }))!;
  const listing = (unreadable: UnreadableIdEntry[]): void => {
    // The prototype the handle's registry instance has: the command opens its own registry through the
    // door, an instance of the same class (c10a-2c-i).
    const proto = Object.getPrototypeOf(h.home.workflowStore) as CliHome['workflowStore'];
    vi.spyOn(proto, 'listWithDiagnostics').mockResolvedValue({
      workflows: [definition('ok')],
      unreadable,
      mismatched: [],
    } as never);
  };

  it('one ⚠ line per class, each naming its one id, and the count line as before', async () => {
    listing([
      unreadableById('old', legacyCopyError('old'))!,
      unreadableById('new', newerCopyError('new', 2))!,
      damaged('bad'),
    ]);
    await workflowListCommand.parseAsync([], { from: 'user' });
    // (1) red when the names are read from `file` (each line names "undefined"), or a class's line is
    //     missing or worded as the file arm's; (2) prints the count line and every ⚠ line.
    expect({ count: out.at(-1), lines: err }).toEqual({
      count: '\n1 workflow registered; 3 entries in the registry could not be read.',
      lines: [
        `⚠ 1 workflow in the registry has a damaged stored copy: bad${TAIL}`,
        `⚠ 1 workflow in the registry was registered by a later version of Realm: new${TAIL}`,
        `⚠ 1 workflow in the registry was registered by an older version of Realm: old; re-register each from its source (realm workflow register <path-to-workflow>)${TAIL}`,
      ],
    });
  });

  it('several ids in one class: one line, counted, naming each', async () => {
    listing([damaged('b1'), damaged('b2')]);
    await workflowListCommand.parseAsync([], { from: 'user' });
    // (1) red when the ids are read from `file`, or each id gets a line of its own; (2) prints the
    //     ⚠ lines.
    expect(err).toEqual([
      `⚠ 2 workflows in the registry have damaged stored copies: b1, b2${TAIL}`,
    ]);
  });

  it('--json: each entry as the registrar gave it — `workflow_id`, never `file`', async () => {
    const entries = [unreadableById('old', legacyCopyError('old'))!, damaged('bad')];
    listing(entries);
    await workflowListCommand.parseAsync(['--json'], { from: 'user' });
    const json = JSON.parse(out.join('\n')) as { unreadable: Array<Record<string, unknown>> };
    // (1) red when an entry gains a `file` or loses its `workflow_id`; (2) prints each entry and its
    //     keys.
    expect({
      unreadable: json.unreadable,
      keys: json.unreadable.map((u) => Object.keys(u).sort()),
    }).toEqual({
      unreadable: entries,
      keys: [
        ['class', 'reason', 'workflow_id'],
        ['class', 'reason', 'repair', 'workflow_id'],
      ],
    });
  });
});
