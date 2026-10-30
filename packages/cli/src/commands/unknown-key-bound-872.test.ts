// unknown-key-bound-872.test.ts — #872 (b1) A5, the CLI side: `realm workflow register`'s warning line
// for an unknown key names a key over 500 characters by its length (`‹N characters, not kept›`, I4),
// as the MCP replies do — core's one producer of the line (`renderUnknownKeyMessage`). An unknown
// `retry` key stays a warning (an unknown step key is refused first). Beside the cell: (a) what turns
// it red; (b) what it prints on failure — the warning lines (the key is fake).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerCommand } from './register.js';

describe('#872 (b1) B8 — the CLI’s unknown-key line', () => {
  let home: string;
  let originalHome: string | undefined;
  const printed: string[] = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'realm-unknown-key-872-'));
    mkdirSync(join(home, '.realm', 'workflows'), { recursive: true });
    originalHome = process.env['HOME'];
    process.env['HOME'] = home;
    printed.length = 0;
    for (const method of ['log', 'error', 'warn'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        printed.push(args.map(String).join(' '));
      });
    }
    vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  it('register: a 600-character unknown retry key → the line names it by its length, never whole', async () => {
    const key = 'r'.padEnd(600, 'q');
    const wfDir = mkdtempSync(join(tmpdir(), 'realm-unknown-key-872-wf-'));
    writeFileSync(
      join(wfDir, 'workflow.yaml'),
      `id: long-key-872
name: Long key
version: 1
steps:
  step-one:
    description: a step
    execution: auto
    retry:
      max_attempts: 2
      ${key}: 1
`,
      'utf8',
    );
    await registerCommand.parseAsync([wfDir], { from: 'user' });
    const lines = printed.filter((l) => l.includes('unknown key'));
    rmSync(wfDir, { recursive: true, force: true });
    // (a) red when the line quotes the key whole; (b) prints the unknown-key lines.
    expect({
      marker: lines.some((l) => l.includes("unknown key '‹600 characters, not kept›'")),
      whole: lines.some((l) => l.includes(key)),
    }).toEqual({ marker: true, whole: false });
  });
});
