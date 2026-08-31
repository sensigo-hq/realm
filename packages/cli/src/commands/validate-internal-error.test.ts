// #123 correction, test 3 — genuine-bug-still-loud. validate's from-string branch catches
// ONLY `WorkflowError` (→ `Invalid:` + exit 1) and MUST rethrow anything else, so a real
// internal defect surfaces as a loud stack trace, never mislabeled as `Invalid`. If a future
// change broadens the catch to `catch (err)`, this test goes red. In-process (mocked) because
// a plain (non-WorkflowError) throw cannot be induced through the real from-string loader.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Make loadWorkflowFromStringWithDiagnostics throw a PLAIN Error (an "internal bug") — this is
// the variant validate.ts's from-string branch now calls (issue #169); keep everything else
// (WorkflowError, findTrustRoot, …) real.
//
// issue #445 adds the EXTENSIONS-arm sibling below, which needs the FILE-based loader mocked too.
// Two `vi.mock` factories for one specifier cannot coexist, so this single factory serves both:
// FromString throws unconditionally (the original cell), FromFile is counter-keyed — the first
// call (pass 1) delegates to the real implementation so the workflow genuinely loads and
// loadProjectExtensions genuinely runs, and the second call (pass 2) throws the planted bug.
// The counter lives in `vi.hoisted` because a plain module-level `let` is in the factory's TDZ.
const planted = vi.hoisted(() => ({ fileCalls: 0 }));

vi.mock('@sensigo/realm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sensigo/realm')>();
  return {
    ...actual,
    loadWorkflowFromStringWithDiagnostics: () => {
      throw new Error('internal bug — not a WorkflowError');
    },
    loadWorkflowFromFileWithDiagnostics: (
      ...args: Parameters<typeof actual.loadWorkflowFromFileWithDiagnostics>
    ) => {
      planted.fileCalls += 1;
      if (planted.fileCalls === 1) return actual.loadWorkflowFromFileWithDiagnostics(...args);
      throw new Error('internal bug on pass 2 — not a WorkflowError');
    },
  };
});

import { validateCommand } from './validate.js';
import { clearProjectExtensionsCache } from '../extensions/load-project-extensions.js';

describe('validate — non-WorkflowError is NOT swallowed as Invalid', () => {
  let dir: string;
  let wfPath: string;

  beforeEach(() => {
    // A real, extension-free workflow file so readFileSync succeeds and the from-string
    // branch is reached (where the mocked loadWorkflowFromString throws its plain Error).
    dir = mkdtempSync(join(tmpdir(), 'realm-validate-internal-'));
    wfPath = join(dir, 'workflow.yaml');
    writeFileSync(wfPath, 'id: x\nname: X\nversion: 1\nsteps: {}\n', 'utf8');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('rethrows a plain Error from the from-string branch (loud), never printing Invalid or exiting 1', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called — should not happen for an internal bug');
    }) as never);

    // parseAsync must REJECT with the plain Error (the `else throw err`), not resolve via
    // the Invalid+exit path.
    await expect(validateCommand.parseAsync([wfPath], { from: 'user' })).rejects.toThrow(
      'internal bug — not a WorkflowError',
    );

    expect(exitSpy).not.toHaveBeenCalled();
    const logged = errSpy.mock.calls.flat().map(String).join(' ');
    expect(logged).not.toContain('Invalid:');
  });
});

// issue #445 — the same doctrine, now on the EXTENSIONS arm.
//
// That arm used to render ANY error as `Invalid: …`, so an internal bug was swallowed and
// relabelled as the author's workflow being wrong — the exact failure the cell above exists to
// prevent, one branch over. Both arms route through one chokepoint now, and this is its sibling
// pin: pass 2 throws a plain Error, and it must come out loud.
describe('validate — the EXTENSIONS arm does not swallow an internal error either', () => {
  let proj: string;
  let workflowDir: string;

  beforeEach(() => {
    planted.fileCalls = 0;
    clearProjectExtensionsCache();
    proj = mkdtempSync(join(tmpdir(), 'realm-validate-internal-ext-'));
    workflowDir = join(proj, 'workflows', 'wf');
    mkdirSync(join(proj, 'dist'), { recursive: true });
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(join(proj, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    writeFileSync(join(proj, 'dist', 'registry.js'), 'export default {};', 'utf8');
    writeFileSync(
      join(workflowDir, 'workflow.yaml'),
      `id: ext-internal
name: Ext Internal
version: 1
extensions: ../../dist/registry.js
steps:
  fetch_data:
    description: fetch
    execution: auto
    handler: h
`,
      'utf8',
    );
  });

  afterEach(() => {
    rmSync(proj, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('rethrows a plain Error from pass 2 (loud), never printing Invalid or exiting 1', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called — should not happen for an internal bug');
    }) as never);

    await expect(
      validateCommand.parseAsync([join(workflowDir, 'workflow.yaml')], { from: 'user' }),
    ).rejects.toThrow('internal bug on pass 2 — not a WorkflowError');

    expect(exitSpy).not.toHaveBeenCalled();
    const logged = errSpy.mock.calls.flat().map(String).join(' ');
    expect(logged).not.toContain('Invalid:');
    // Pass 1 really ran (delegated to the real loader), so the planted throw is unambiguously
    // pass 2 rather than an earlier failure wearing the same message.
    expect(planted.fileCalls).toBe(2);
  });
});
