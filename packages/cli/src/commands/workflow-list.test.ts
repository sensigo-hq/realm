// issue #427 — `realm workflow list`. In-process, with $HOME patched before the store is
// constructed (JsonWorkflowStore resolves its directory from homedir() at construction and
// mkdirSyncs it — the #285 lazy-resolution precedent).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workflowListCommand, sortedById, schemaCell } from './workflow-list.js';
import { CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';

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
  let wfDir: string;
  let originalHome: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'realm-wf-list-'));
    wfDir = join(home, '.realm', 'workflows');
    originalHome = process.env['HOME'];
    process.env['HOME'] = home;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function plant(fileBase: string, def: unknown): void {
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(wfDir, `${fileBase}.json`), JSON.stringify(def, null, 2), 'utf8');
  }

  const stdout = (): string => logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
  const stderr = (): string => warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');

  it('L1 prints a row per workflow, sorted by id', async () => {
    // Registered out of order deliberately. This is an operator smoke check, NOT the sort's
    // discriminator — readdirSync returns alphabetical order on this filesystem, so this cell
    // stays green with the sort deleted. L1b is the pin that bites.
    plant('zebra-wf', definition('zebra-wf'));
    plant('alpha-wf', definition('alpha-wf'));

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

  it('L2 a legacy entry is marked, with the remedy in the cell', async () => {
    plant('ancient', { id: 'ancient', name: 'Ancient', version: 2, steps: {} });
    plant('modern', definition('modern'));

    await workflowListCommand.parseAsync([], { from: 'user' });

    const out = stdout();
    expect(out).toContain('legacy (re-register)');
    expect(out).toContain('1 (current)');
    // An absent schema_version has no number to print; `undefined — legacy` would be worse.
    expect(out).not.toContain('undefined');
  });

  it('L3 an unparseable file is REPORTED, and the exit stays 0', async () => {
    // list() would silently skip this. An operator asking what is in their registry needs to
    // know realm cannot read one of the entries — that is the signal, which is also why this
    // surface never exits non-zero for it.
    plant('good', definition('good'));
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(wfDir, 'garbage.json'), '{ not json', 'utf8');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);

    await workflowListCommand.parseAsync([], { from: 'user' });

    expect(stderr()).toContain(
      '⚠ 1 file in the registry could not be parsed: garbage.json — realm cannot audit what it cannot read.',
    );
    expect(stdout()).toContain('1 workflow registered.'); // singular, and the good one still lists
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('L4 --json carries the workflows, the unreadable and the mismatched', async () => {
    plant('good', definition('good'));
    plant('probe-mismatch', definition('inner-id'));
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(wfDir, 'garbage.json'), '{ not json', 'utf8');

    await workflowListCommand.parseAsync(['--json'], { from: 'user' });

    const parsed = JSON.parse(stdout()) as {
      workflows: Array<{ id: string; current: boolean; schema_version: number | null }>;
      unreadable: Array<{ file: string }>;
      mismatched: Array<{ file: string; id: string }>;
    };
    expect(parsed.workflows.map((w) => w.id).sort()).toEqual(['good', 'inner-id']);
    expect(parsed.workflows.every((w) => w.current)).toBe(true);
    expect(parsed.unreadable.map((u) => u.file)).toEqual(['garbage.json']);
    expect(parsed.mismatched).toEqual([{ file: 'probe-mismatch.json', id: 'inner-id' }]);
  });

  it('L5 an empty registry prints the header and a zero footer', async () => {
    // No directory is pre-created: the store's constructor mkdirSyncs it.
    await workflowListCommand.parseAsync([], { from: 'user' });

    const out = stdout();
    expect(out).toContain('ID');
    expect(out).toContain('0 workflows registered.');
  });

  it('L6 a file whose stored id differs from its filename is disclosed', async () => {
    // Hand-constructible, and invisible otherwise: `--registered` resolves by FILENAME while
    // this listing prints the inner id, so without the census line the entry is reachable under
    // a name the list never showed.
    plant('probe-mismatch', definition('something-else'));

    await workflowListCommand.parseAsync([], { from: 'user' });

    expect(stderr()).toContain(
      "⚠ 1 file whose stored id differs from its filename: probe-mismatch.json (id 'something-else') — '--registered' resolves by filename.",
    );
  });

  it('schemaCell names the remedy for every non-current shape', () => {
    expect(schemaCell(CURRENT_WORKFLOW_SCHEMA_VERSION)).toBe('1 (current)');
    expect(schemaCell(undefined)).toBe('legacy (re-register)');
    expect(schemaCell(0)).toBe('0 — legacy (re-register)');
  });
});
