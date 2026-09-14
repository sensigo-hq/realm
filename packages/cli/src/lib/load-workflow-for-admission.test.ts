// issue #553 — the relocation: register's admission helper is now the ONE path register, watch
// and validate take. The behavioural cells for the helper live in register-extensions.test.ts
// (they moved with it); these pin the wiring the collapse depends on.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExtensionLoadError } from './load-workflow-for-admission.js';
import { validateCommand } from '../commands/validate.js';
import { clearProjectExtensionsCache } from '../extensions/load-project-extensions.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const commandSource = (name: string): string =>
  readFileSync(join(SRC, 'commands', `${name}.ts`), 'utf8');

describe('loadWorkflowForAdmission — wiring (issue #553)', () => {
  it.each(['register', 'watch', 'validate'])('%s imports the helper from lib/', (name) => {
    expect(commandSource(name)).toContain("from '../lib/load-workflow-for-admission.js'");
  });

  it('hasTopLevelExtensions is gone from the cli source tree (the pre-scan that split the path)', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      );
    const hits = walk(SRC).filter(
      (f) =>
        f.endsWith('.ts') &&
        !f.endsWith('.test.ts') &&
        readFileSync(f, 'utf8').includes('hasTopLevelExtensions'),
    );
    expect(hits).toEqual([]);
  });

  it('the SENTINEL-credentials advisory is minted exactly ONCE across production source (issue #553 correction C2 — the #444/#508 two-mints-of-one-string class)', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      );
    // Source text, comments included — the count is of the literal wherever it appears, not just
    // executable mint sites. `validate --registered`'s own extensions arm used to hand-type a
    // second copy of this exact sentence; correction C2 collapsed it to the one call through
    // `admitProjectExtensions`.
    const hits = walk(SRC).filter(
      (f) =>
        f.endsWith('.ts') &&
        !f.endsWith('.test.ts') &&
        readFileSync(f, 'utf8').includes('with SENTINEL credentials'),
    );
    expect(hits).toEqual([join(SRC, 'lib', 'load-workflow-for-admission.ts')]);
  });

  it('ExtensionLoadError carries the pass-1 definition when given one, and no field when not', () => {
    const def = { id: 'x', name: 'X', version: 1, steps: {} } as never;
    const withDef = new ExtensionLoadError(new Error('boom'), undefined, def);
    expect(withDef.definition).toBe(def);
    expect(withDef.message).toBe('boom');
    // `toBeUndefined`, not `in`: an ES2022 class field declaration creates an own property
    // initialised to undefined (the #424 find), so presence is the wrong probe.
    const without = new ExtensionLoadError(new Error('boom'));
    expect(without.definition).toBeUndefined();
    expect(without.warnings).toBeUndefined();
  });
});

describe('--extensions-module travels through the helper on validate (cell 9, issue #553)', () => {
  let proj: string;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearProjectExtensionsCache();
    proj = mkdtempSync(join(tmpdir(), 'realm-553-flag-'));
    mkdirSync(join(proj, 'wf'));
    writeFileSync(join(proj, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    writeFileSync(
      join(proj, 'wf', 'workflow.yaml'),
      'id: ok\nname: OK\nversion: 1\nsteps:\n  s1:\n    description: a\n    execution: agent\n',
      'utf8',
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(() => {
    rmSync(proj, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('an unresolvable override on a workflow that passes pass 1 → the whole flag-travel message', async () => {
    // A VALID workflow, deliberately (audit round 2 F4): on a missing-profile fixture pass 1
    // refuses first and the module is never resolved. A helper that drops `overrideModule` on
    // either load prints `Valid` here — the #353/#466 flag-travel class.
    await expect(
      validateCommand.parseAsync(
        [join(proj, 'wf', 'workflow.yaml'), '--extensions-module', './nope.mjs'],
        {
          from: 'user',
        },
      ),
    ).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    const lines = errSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(lines).toEqual([
      `Error loading extensions: Cannot resolve --extensions-module './nope.mjs': ENOENT: no such file or directory, lstat '${resolve('./nope.mjs')}'`,
    ]);
  });
});
