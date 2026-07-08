// Enumeration partition test for the #134 pre-flight capability warning (anti-recurrence, Part B3).
//
// This is the structural discipline the orphan-guard thread earned: it partitions EVERY run-creating
// (`RunStore.create({...})`) call site across the runner packages into WARNED (the site emits the
// pre-flight capability warning) or N-A-with-reason, and FAILS LOUDLY on a new, unclassified create
// site. A missed warning is minor; silent drift — a future create path that never warns and nobody
// noticed — is the failure mode this prevents. Source-scan (not spawn) by design: classification needs
// no runtime, unlike the behavioral warn tests in start-run.test.ts / run-agent surface tests.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

// packages/cli/src/commands → packages/
const PACKAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCANNED_PACKAGES = ['cli', 'mcp-server', 'testing'];

// A run-creating call site: `<store>.create({ ... })`. Object.create(null), createDefaultRegistry(),
// and the empty-paren doc-comment `create()` do not match (no `{` after the paren).
const CREATE_SITE = /\.create\(\s*\{/;

/** Every non-test .ts source file under a package's src/. */
function sourceFiles(pkg: string): string[] {
  const root = join(PACKAGES_DIR, pkg, 'src');
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

// The partition. Keys are file basenames. Every create-site file MUST appear in exactly one map.
// WARNED: the site emits the pre-flight warning via unmetCapabilities + capabilityWarning.
const WARNED: Record<string, string> = {
  'start-run.ts': 'rides the existing warnings[] channel after registry resolution',
  'start-run-batch.ts':
    'warns per item (workflow-invariant, computed once) with a creation-time caveat',
  'run.ts': 'log line at run start (registry always resolved by loadProjectExtensions)',
  'run-agent.ts': 'log line on the CREATE path only; the --run-id attach path is N-A',
};
// N-A: the site legitimately does NOT warn. Reason required.
const N_A: Record<string, string> = {
  'listen.ts':
    'spawns a detached child agent that re-resolves extensions and attaches to the created run; ' +
    'the child drives via recoverable-settle + the A5 surfaces, so warning at spawn would duplicate it',
  'test-runner.ts':
    'test harness — emitting warnings here would change test output; not a production run-creating path',
};

describe('#134 pre-flight capability warning — create-site enumeration (Part B3)', () => {
  const createSiteFiles = SCANNED_PACKAGES.flatMap(sourceFiles).filter((f) =>
    CREATE_SITE.test(readFileSync(f, 'utf8')),
  );

  it('at least one create site is discovered (the scan is wired correctly)', () => {
    expect(createSiteFiles.length).toBeGreaterThan(0);
  });

  it('EVERY run-creating call site is classified WARNED or N-A-with-reason (fails loudly on drift)', () => {
    const unclassified = createSiteFiles
      .map((f) => basename(f))
      .filter((name) => !(name in WARNED) && !(name in N_A));
    expect(
      unclassified,
      `Unclassified run-creating site(s): ${unclassified.join(', ')}. Add a #134 pre-flight ` +
        `warning (and list it in WARNED) or document why it is N-A (add it to N_A with a reason).`,
    ).toEqual([]);
  });

  it('every WARNED file actually wires the pre-flight warning (unmetCapabilities)', () => {
    for (const name of Object.keys(WARNED)) {
      const file = createSiteFiles.find((f) => basename(f) === name);
      expect(file, `${name} is classified WARNED but has no create site`).toBeDefined();
      const src = readFileSync(file!, 'utf8');
      expect(src, `${name} is WARNED but does not call unmetCapabilities`).toContain(
        'unmetCapabilities',
      );
    }
  });

  it('no classification entry is stale (every WARNED/N-A file still has a create site)', () => {
    const present = new Set(createSiteFiles.map((f) => basename(f)));
    for (const name of [...Object.keys(WARNED), ...Object.keys(N_A)]) {
      expect(present.has(name), `${name} is classified but no longer has a create site`).toBe(true);
    }
  });
});
