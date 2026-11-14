// Fix 2 (agent-written workflows), on top of issue #524 — on the built `validate` command. A
// `gate:` block on a step that can never open a gate used to print the #524 `DEAD_GATE_CONFIG`
// block advisory and validate (exit 0; only `--strict` failed). Since fix 2 the loader refuses
// it, so plain `validate` fails. In-process via commander's parseAsync, the same pattern as
// validate-retry-timeout-advisory.test.ts. The step is named `approve` and its block sits at line
// 9, so the printed line is the one docs/reference/workflow/gates.md quotes.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCommand } from './validate.js';

/** Message A as validate prints it for the auto step `approve`, its block at line 9. */
const MSG_A_APPROVE =
  "Invalid workflow: Step 'approve': the 'gate:' block is refused at load — this step declares " +
  "no gate trust ('trust: human_confirmed' or 'trust: human_reviewed'), so Realm would never " +
  'open this gate: nobody would be asked, and the run would go on exactly as if the block were ' +
  "not there. Set 'trust: human_confirmed' on this step if a person must approve its result, or " +
  "remove the 'gate:' block. The workflow loads as soon as either is done. (line 9)";

describe('validate — fix 2: a gate: block that can never open a gate is refused (was the #524 advisory)', () => {
  let dir: string;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'realm-validate-gate-dead-block-'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** One step, `approve`; `stepFields` sit between `execution` and the block (none keeps the
   *  block at line 9); `gateBlock` empty leaves the block out. */
  function write(execution: string, stepFields: string, gateBlock: string): string {
    const wfPath = join(dir, 'workflow.yaml');
    writeFileSync(
      wfPath,
      `id: gate-dead-block-wf
name: Gate Dead Block
version: 1
steps:
  approve:
    description: approve
    execution: ${execution}
${stepFields}${gateBlock}`,
      'utf8',
    );
    return wfPath;
  }

  const ERRORED = (): string => errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
  const GATE = '    gate:\n      timeout_seconds: 300\n      on_expiry: abort\n';

  it('auto, no trust, the block at line 9: plain validate exits 1 and prints message A with the line', async () => {
    const wfPath = write('auto', '    handler: h\n', GATE);
    await expect(validateCommand.parseAsync([wfPath], { from: 'user' })).rejects.toThrow(
      'process.exit',
    );
    // (1) red when the refusal is removed: the file validates (exit 0, "Valid:"), so parseAsync
    //     resolves and this line fails first; (2) prints the expected and the received rejection.
    expect(exitSpy).toHaveBeenCalledWith(1);
    // (1) red when the message or its line cite changes; (2) prints everything validate printed
    //     on its error output.
    expect(ERRORED().split('\n')).toContain(MSG_A_APPROVE);
  });

  it('a guard with a gate block (no gate trust, never minted): exit 1, message B with the line', async () => {
    const wfPath = write('guard', "    abort_unless: ['approve.ok == true']\n", GATE);
    await expect(validateCommand.parseAsync([wfPath], { from: 'user' })).rejects.toThrow(
      'process.exit',
    );
    // (1) red when gate×guard is left as before (warning, Valid, exit 0); (2) prints the call.
    expect(exitSpy).toHaveBeenCalledWith(1);
    // (1) red when B's text or line changes; (2) prints the error output.
    expect(ERRORED().split('\n')).toContain(
      "Invalid workflow: Step 'approve': 'gate' is not valid on execution: guard steps — a " +
        "guard step never opens a gate (only an auto or agent step with 'trust: " +
        "human_confirmed' or 'trust: human_reviewed' does), so nobody would be asked. Put the " +
        'approval on the auto or agent step whose result a person must approve, or remove the ' +
        "'gate:' block. The workflow loads as soon as either is done. (line 9)",
    );
  });

  it.each([
    ['the trust added', '    handler: h\n    trust: human_confirmed\n', GATE],
    ['the block removed', '    handler: h\n', ''],
  ])(
    "following message A's remedy (%s), the same step validates — the message's 'loads as soon as either is done'",
    async (_remedy, stepFields, gateBlock) => {
      const wfPath = write('auto', stepFields, gateBlock);
      await validateCommand.parseAsync([wfPath], { from: 'user' });
      // (1) red when a remedy the message offers does not make the file load (it would exit, and
      //     parseAsync would reject above); (2) prints what validate logged.
      expect(logSpy.mock.calls.flat().map(String).join(' ')).toContain('Valid:');
      expect(exitSpy).not.toHaveBeenCalled();
    },
  );
});
