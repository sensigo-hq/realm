// no-process-exit-guard.test.ts — issue #401: no provider may kill the process.
//
// A `process.exit(1)` inside a provider ended the run before any catch could record WHY the drive
// failed. The run then read healthy on every operator surface for 24 hours. Every one of those
// sites now throws instead, so the failure reaches a chokepoint and gets written down.
//
// Source-read guard (the terminal-writer-census idiom), homed in cli so Turbo's hash covers it.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROVIDERS_DIR = fileURLToPath(new URL('.', import.meta.url));

describe('#401 — providers throw, never exit', () => {
  it('no process.exit call exists anywhere under agent/providers/', () => {
    const offenders: string[] = [];
    for (const name of readdirSync(PROVIDERS_DIR)) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
      const src = readFileSync(join(PROVIDERS_DIR, name), 'utf8');
      // The CALL, not the words: a comment explaining why the exits were removed is fine and
      // desirable; an actual invocation is the thing that kills the record.
      if (/process\s*\.\s*exit\s*\(/.test(src)) offenders.push(name);
    }
    expect(
      offenders,
      `process.exit() found in ${offenders.join(', ')} — a provider that exits ends the run before ` +
        'the failure can be recorded, which is the defect issue #401 closes.',
    ).toEqual([]);
  });

  it('the scan is wired correctly — it actually reads provider sources', () => {
    const files = readdirSync(PROVIDERS_DIR).filter(
      (n) => n.endsWith('.ts') && !n.endsWith('.test.ts'),
    );
    expect(files.length).toBeGreaterThan(3);
    expect(files).toContain('anthropic-provider.ts');
  });
});
