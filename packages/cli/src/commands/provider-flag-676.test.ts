// provider-flag-676.test.ts — issue #676: `--provider` accepts only `openai` or `anthropic`.
// Version 0.45.0 took any other word as Anthropic, silently.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InvalidArgumentError } from 'commander';
import { describe, expect, it } from 'vitest';
import { parseProvider } from './agent.js';

const CLI_ENTRY = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

describe('parseProvider (issue #676)', () => {
  it('accepts openai and anthropic', () => {
    expect(parseProvider('openai')).toBe('openai');
    expect(parseProvider('anthropic')).toBe('anthropic');
  });

  it('refuses any other word with the message', () => {
    expect(() => parseProvider('antropic')).toThrow(InvalidArgumentError);
    expect(() => parseProvider('antropic')).toThrow('--provider must be openai or anthropic.');
  });

  it('realm agent --provider antropic through the built CLI: exit 1, Commander’s line', () => {
    // A scratch HOME and working folder: nothing of the real ~/.realm is read, and no `.env` of
    // this repository is loaded.
    const home = mkdtempSync(join(tmpdir(), 'realm-676-provider-'));
    try {
      const r = spawnSync(
        process.execPath,
        [CLI_ENTRY, 'agent', '--workflow', './x', '--provider', 'antropic'],
        {
          cwd: home,
          env: { PATH: process.env['PATH'] ?? '', HOME: home },
          encoding: 'utf8',
          timeout: 20_000,
        },
      );
      expect(r.status).toBe(1);
      expect(r.stderr.trim()).toBe(
        "error: option '--provider <provider>' argument 'antropic' is invalid. --provider must be openai or anthropic.",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
