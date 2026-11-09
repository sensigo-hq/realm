// issue #427 — `realm workflow list`. In-process, with $HOME patched before the store is
// constructed (JsonWorkflowStore resolves its directory from homedir() at construction and
// mkdirSyncs it — the #285 lazy-resolution precedent).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workflowListCommand, sortedById, schemaCell } from './workflow-list.js';
import { CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

function definition(id: string, over: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id,
    name: `Name ${id}`,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    origin: 'human',
    steps: { a: { description: 'a', execution: 'agent' } },
    ...over,
  } as WorkflowDefinition;
}

describe('realm workflow list (issue #427)', () => {
  let home: string;
  let h: TempHome;
  let originalHome: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'realm-wf-list-'));
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

  const stdout = (): string => logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
  const stderr = (): string => warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');

  it('L1 prints a row per workflow, sorted by id', async () => {
    // Registered out of order deliberately. This is an operator smoke check, NOT the sort's
    // discriminator — readdirSync returns alphabetical order on this filesystem, so this cell
    // stays green with the sort deleted. L1b is the pin that bites.
    await h.home.workflowStore.register(definition('zebra-wf') as never);
    await h.home.workflowStore.register(definition('alpha-wf') as never);

    await workflowListCommand.parseAsync([], { from: 'user' });

    const out = stdout();
    expect(out).toContain('ID');
    expect(out.indexOf('alpha-wf')).toBeLessThan(out.indexOf('zebra-wf'));
    expect(out).toContain('2 workflows registered.');
  });

  it('L1b sortedById orders by id, independent of the filesystem', () => {
    const sorted = sortedById([definition('zebra'), definition('alpha'), definition('mid')]);
    expect(sorted.map((w) => w.id)).toEqual(['alpha', 'mid', 'zebra']);
  });

  it('L2 a legacy entry is named on the older-version ⚠ line, never a table row; a current one is in the table (correction 2, 8.6 (c); was: marked in the table)', async () => {
    await h.home.workflowStore.register({
      id: 'ancient',
      name: 'Ancient',
      version: 2,
      steps: {},
    } as never);
    await h.home.workflowStore.register(definition('modern') as never);

    await workflowListCommand.parseAsync([], { from: 'user' });

    const out = stdout();
    // Correction 2 (8.6 (c)): every run path refuses a legacy copy, so the table never lists it.
    expect({
      ancientRow: out.split('\n').some((l) => l.startsWith('ancient')),
      modern: out.includes('1 (current)'),
      undefinedWord: out.includes('undefined'),
      // #819 (U4): red when the ⚠ line names no way out.
      warned: stderr().includes(
        '⚠ 1 file in the registry was registered by an older version of Realm: ancient.json; re-register each from its source (realm workflow register <path-to-workflow>) — realm cannot audit what it cannot read.',
      ),
    }).toEqual({ ancientRow: false, modern: true, undefinedWord: false, warned: true });
  });

  it('#819 correction 1 (02 C1): the SCHEMA column says "(current)" only for the current format; another value prints as itself', () => {
    // (a) red when "(current)" is printed for any value (U4's unconditional cell); (b) prints the
    //     three cells.
    expect({
      current: schemaCell(1),
      older: schemaCell(0),
      none: schemaCell(undefined),
    }).toEqual({ current: '1 (current)', older: '0', none: 'none' });
  });

  it('L5 an empty registry prints the header and a zero footer', async () => {
    // No directory is pre-created: the store's constructor mkdirSyncs it.
    await workflowListCommand.parseAsync([], { from: 'user' });

    const out = stdout();
    expect(out).toContain('ID');
    expect(out).toContain('0 workflows registered.');
  });
});
