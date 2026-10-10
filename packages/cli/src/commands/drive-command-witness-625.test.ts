// drive-command-witness-625.test.ts — issue #625 PR-2a, fold round 13, decision C89.
//
// Since #676, `realm agent` refuses to start without a model, so a `realm agent --run-id …` command
// realm prints for a person to run must carry the model flags (`--provider <provider> --model
// <model>`, or the drive's own flags, which `buildReattachFlags` builds with `--model` or
// `--provider-module`). `realm run advance`'s ready line printed the bare command until C89.
//
// The witness reads every non-test source file of the CLI: each line that prints `realm agent
// --run-id` (comment lines aside) carries `--model`. The four printers of today must be found
// (non-vacuity: a pattern that stops matching would otherwise pass with nothing checked); a fifth is
// checked by the same rule.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === 'test-support' || name === 'multi-copy') continue;
      out.push(...sourceFiles(path));
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

const isComment = (line: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(line);

describe('#625 PR-2a, C89 — every printed `realm agent --run-id` carries the model flags', () => {
  it('each line of non-test CLI source that prints the command names --model; the four printers are found', () => {
    const printers: string[] = [];
    const bare: string[] = [];
    for (const file of sourceFiles(SRC)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (!line.includes('realm agent --run-id') || isComment(line)) return;
          const where = `${relative(SRC, file)}:${i + 1}`;
          printers.push(relative(SRC, file));
          if (!line.includes('--model')) bare.push(where);
        });
    }
    // (a) a printer that drops the flags (C89's mutant on run-advance.ts) → listed here. (b) prints
    // each file:line.
    expect(bare).toEqual([]);
    // (a) the match pattern drifts and finds fewer printers → the witness would check nothing. (b)
    // prints the printers found.
    for (const known of [
      'agent/run-agent.ts',
      'commands/resume.ts',
      'commands/run.ts',
      'commands/run-advance.ts',
    ]) {
      expect(printers).toContain(known);
    }
  });
});
