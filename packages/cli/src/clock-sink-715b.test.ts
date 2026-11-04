// clock-sink-715b.test.ts — issue #715 (b) 03 §A.1 (D-22): the CLI is the host that sets the
// process's waiter-error sink, once, before any command runs; the sink writes `error: <message>` to
// standard error through the one writer. (core's own cells pin the sink's semantics: read at fire
// time, loud with none set — packages/core/src/utils/clock.test.ts.)
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clockErrorSink, setClockErrorSink } from '@sensigo/realm';
import { installClockErrorSink } from './commands-registry.js';

const previous = clockErrorSink();
afterEach(() => {
  if (previous !== undefined) setClockErrorSink(previous);
  vi.restoreAllMocks();
});

describe('#715 (b) 03 §A.1 — the CLI’s waiter-error sink', () => {
  it('installClockErrorSink sets a sink that writes `error: <message>` to standard error, once per failure', () => {
    // (a) red when the installer sets no sink, or the sink writes elsewhere or other words; (b)
    //     prints the lines written.
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      lines.push(a.join(' '));
    });
    installClockErrorSink();
    clockErrorSink()?.(new Error('the waiter failed'));
    clockErrorSink()?.('a thrown string');
    expect(lines).toEqual(['error: the waiter failed', 'error: a thrown string']);
  });

  it('the CLI’s entry installs it before it parses its arguments (realm listen and realm mcp run inside)', () => {
    // (a) red when index.ts no longer installs the sink, or installs it after the commands run; (b)
    //     prints the two positions.
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8');
    const installed = src.indexOf('installClockErrorSink();');
    const parsed = src.indexOf('await program.parseAsync();');
    expect({ installed: installed > 0, before: installed < parsed }).toEqual({
      installed: true,
      before: true,
    });
  });
});
