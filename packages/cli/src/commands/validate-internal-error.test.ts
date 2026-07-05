// #123 correction, test 3 — genuine-bug-still-loud. validate's from-string branch catches
// ONLY `WorkflowError` (→ `Invalid:` + exit 1) and MUST rethrow anything else, so a real
// internal defect surfaces as a loud stack trace, never mislabeled as `Invalid`. If a future
// change broadens the catch to `catch (err)`, this test goes red. In-process (mocked) because
// a plain (non-WorkflowError) throw cannot be induced through the real from-string loader.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Make loadWorkflowFromString throw a PLAIN Error (an "internal bug"); keep everything else
// (WorkflowError, findTrustRoot, …) real.
vi.mock('@sensigo/realm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sensigo/realm')>();
  return {
    ...actual,
    loadWorkflowFromString: () => {
      throw new Error('internal bug — not a WorkflowError');
    },
  };
});

import { validateCommand } from './validate.js';

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
