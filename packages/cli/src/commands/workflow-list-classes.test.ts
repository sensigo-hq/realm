// issue #558 PR-T — `realm workflow list`'s census, per CLASS. Until this PR one sentence spoke
// for every failure ("could not be parsed"), which was FALSE for four of the five classes: a
// chmod-000 file was reported as unparseable (executed on main), and a `null`-root entry or an
// unreadable registry directory crashed the command with a stack trace.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workflowListCommand } from './workflow-list.js';
import { CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';

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
  let wfDir: string;
  let originalHome: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'realm-wf-class-'));
    wfDir = join(home, '.realm', 'workflows');
    mkdirSync(wfDir, { recursive: true });
    originalHome = process.env['HOME'];
    process.env['HOME'] = home;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    try {
      chmodSync(wfDir, 0o755);
    } catch {
      /* already removable */
    }
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const stderr = (): string => warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
  const plant = (base: string): void => {
    writeFileSync(join(wfDir, `${base}.json`), JSON.stringify(definition(base), null, 2), 'utf8');
  };

  it('K1 an unreadable file names its errno — not "could not be parsed"', async () => {
    plant('a');
    chmodSync(join(wfDir, 'a.json'), 0o000);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);

    await workflowListCommand.parseAsync([], { from: 'user' });

    expect(stderr()).toContain(
      `⚠ 1 file in the registry could not be read (EACCES): a.json${TAIL}`,
    );
    expect(stderr()).not.toContain('could not be parsed');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('K2 an empty file says empty; a directory entry says directory and names no errno', async () => {
    writeFileSync(join(wfDir, 'd.json'), '', 'utf8');
    mkdirSync(join(wfDir, 'e.json'));

    await workflowListCommand.parseAsync([], { from: 'user' });

    const out = stderr();
    expect(out).toContain(`⚠ 1 file in the registry is empty (0 bytes): d.json${TAIL}`);
    expect(out).toContain(
      `⚠ 1 entry in the registry is a directory, not a workflow file: e.json${TAIL}`,
    );
    expect(out).not.toMatch(/directory, not a workflow file.*\((E[A-Z]+)\)/);
  });

  it('K3 the parse sentence is byte-identical to the #427 original (the control that must not move)', async () => {
    writeFileSync(join(wfDir, 'garbage.json'), '{ not json', 'utf8');

    await workflowListCommand.parseAsync([], { from: 'user' });

    expect(stderr()).toContain(`⚠ 1 file in the registry could not be parsed: garbage.json${TAIL}`);
  });

  it('K4 a `null` root is a parse failure, not a crash (main threw a TypeError through this command)', async () => {
    writeFileSync(join(wfDir, 'nul.json'), 'null', 'utf8');
    plant('good');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);

    await workflowListCommand.parseAsync([], { from: 'user' });

    expect(stderr()).toContain('could not be parsed: nul.json');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('K5 TWO classes compose into TWO sentences, each with its own count and its own tail', async () => {
    plant('a');
    chmodSync(join(wfDir, 'a.json'), 0o000);
    writeFileSync(join(wfDir, 'b.json'), '{ not json', 'utf8');
    writeFileSync(join(wfDir, 'c.json'), '{ also not', 'utf8');

    await workflowListCommand.parseAsync([], { from: 'user' });

    const lines = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(lines).toContain(`⚠ 1 file in the registry could not be read (EACCES): a.json${TAIL}`);
    expect(lines).toContain(`⚠ 2 files in the registry could not be parsed: b.json, c.json${TAIL}`);
  });

  it('K6 an unreadable REGISTRY DIRECTORY prints exactly ONE line, no table, exit 0 (main crashed at readdirSync)', async () => {
    plant('a');
    chmodSync(wfDir, 0o000);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);

    await workflowListCommand.parseAsync([], { from: 'user' });

    const lines = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(lines).toEqual([`⚠ the workflow registry at ${wfDir} cannot be read (EACCES)${TAIL}`]);
    expect(logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toContain(
      '0 workflows registered.',
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
