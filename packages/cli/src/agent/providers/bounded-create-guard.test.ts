// bounded-create-guard.test.ts — issue #401: every model request goes through the ceiling.
//
// The bound is only worth what its coverage is worth. A new create site added later — a new turn,
// a new extraction call, a fourth provider — would be unbounded and completely invisible: nothing
// fails, the request just has no ceiling. This guard is the thing that notices.
//
// Source-read (the terminal-writer-census idiom), homed in cli so Turbo's hash covers it.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROVIDERS_DIR = fileURLToPath(new URL('.', import.meta.url));

/** Provider sources only — never the tests, and never this guard. */
function providerSources(): Array<{ name: string; src: string }> {
  return readdirSync(PROVIDERS_DIR)
    .filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))
    .map((name) => ({ name, src: readFileSync(join(PROVIDERS_DIR, name), 'utf8') }));
}

/** Prose that happens to mention a create is not a create. */
const isComment = (line: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(line);

describe('#401 — no provider calls an SDK create outside the ceiling', () => {
  it('every `.create(` line is a rawCreate wrapper, which is what driveCreate bounds', () => {
    const offenders: string[] = [];
    for (const { name, src } of providerSources()) {
      src.split('\n').forEach((line, i) => {
        if (isComment(line) || !line.includes('.create(')) return;
        if (!line.includes('rawCreate ='))
          offenders.push(`${name}:${String(i + 1)}: ${line.trim()}`);
      });
    }
    expect(
      offenders,
      `unbounded SDK create(s) found:\n${offenders.join('\n')}\nRoute the call through a ` +
        '`rawCreate = (b, o) => client.X.create(b, o)` wrapper and hand it to driveCreate.',
    ).toEqual([]);
  });

  it('NON-VACUITY — the scan finds the six wrappers it is supposed to be guarding', () => {
    // A matcher that stops matching does not fail, it stops guarding (#189). This is the cell
    // that notices: six wrappers covering the twelve create sites the census enumerated —
    // anthropic 2 (ladder, tools loop), openai 3 (callStep, strict ladder, tools loop),
    // reasoning 1.
    const wrappers = providerSources().flatMap(({ name, src }) =>
      src
        .split('\n')
        .map((line, i) => ({ name, i, line }))
        .filter(({ line }) => !isComment(line) && line.includes('rawCreate ='))
        .map(({ name, i }) => `${name}:${String(i + 1)}`),
    );
    expect(wrappers).toHaveLength(6);
    expect(wrappers.filter((w) => w.startsWith('anthropic-provider'))).toHaveLength(2);
    expect(wrappers.filter((w) => w.startsWith('openai-provider'))).toHaveLength(3);
    expect(wrappers.filter((w) => w.startsWith('openai-reasoning-provider'))).toHaveLength(1);
  });

  it('never the `.create({` shape — the capability-warn census scans for exactly that', () => {
    // The census that counts capability-declaring sites keys on `.create({`. Writing a create in
    // that shape here would silently enter a population this code is not part of.
    for (const { name, src } of providerSources()) {
      expect(src, `${name} uses the .create({ shape`).not.toMatch(/\.create\(\s*\{/);
    }
  });
});
