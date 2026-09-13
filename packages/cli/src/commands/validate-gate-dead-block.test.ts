// Issue #524 — the `DEAD_GATE_CONFIG` block advisory (the gate-remedy silence) on the built
// `validate` command. In-process via commander's parseAsync, same pattern as
// validate-retry-timeout-advisory.test.ts. New sibling: no cli/mcp file referenced
// `DEAD_GATE_CONFIG` before this round.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCommand } from './validate.js';

describe('validate — DEAD_GATE_CONFIG block advisory (issue #524, the gate-remedy silence)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'realm-validate-gate-dead-block-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function write(gateBlock: string): string {
    const wfPath = join(dir, 'workflow.yaml');
    writeFileSync(
      wfPath,
      `id: gate-dead-block-wf
name: Gate Dead Block
version: 1
steps:
  check:
    description: check
    execution: guard
    abort_unless: ["true == true"]
    gate:
${gateBlock}
`,
      'utf8',
    );
    return wfPath;
  }

  it('a guard with gate.on_expiry (no gate trust — never minted) renders the block advisory, exit 0', async () => {
    const wfPath = write('      timeout_seconds: 300\n      on_expiry: abort');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await validateCommand.parseAsync([wfPath], { from: 'user' });

    const warned = warnSpy.mock.calls.flat().map(String).join(' ');
    expect(warned).toContain("the 'gate:' block is inert");
    expect(warned).toContain(
      "this step declares no gate trust ('trust: human_confirmed' or 'trust: human_reviewed')",
    );
    expect(warned).toContain('on an auto or agent step');
    expect(logSpy.mock.calls.flat().map(String).join(' ')).toContain('Valid:');
  });

  it('following the OLD remedy (adding gate.timeout_seconds) does NOT silence the advisory — it STILL prints, exit 0 (the gate-remedy silence, fixed)', async () => {
    // Same shape as the cell above — the point is that "add a timeout" (the pre-#524 remedy)
    // changes nothing: the block is exactly as inert with a timeout declared as without one,
    // because the mint never reads either without gate trust.
    const wfPath = write('      timeout_seconds: 300\n      on_expiry: abort');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await validateCommand.parseAsync([wfPath], { from: 'user' });

    const warned = warnSpy.mock.calls.flat().map(String).join(' ');
    expect(warned).toContain("the 'gate:' block is inert"); // never silenced by "following the remedy"
  });

  it('--strict fails on the same fixture', async () => {
    const wfPath = write('      timeout_seconds: 300\n      on_expiry: abort');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);

    await expect(
      validateCommand.parseAsync([wfPath, '--strict'], { from: 'user' }),
    ).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
