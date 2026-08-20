// terminal-writer-census.test.ts — issue #367 (part 2): the source-text census of every place a
// run's `terminal_state` is written, and of every suppression of the seal-writer lint rules.
//
// WHY A CENSUS AND NOT JUST THE LINT RULES. The rules see one object literal at a time. They
// cannot see the two architectures the engine actually uses — the `applyTerminalPostconditions`
// chokepoint (two-stage by design) and the conditional-spread stamp — so those sites are
// suppressed with reasons. A suppression that nobody counts is a hole, so this guard pins the
// COUNT per file: a ninth writer appearing inside the suppressed chokepoint file still fails here,
// even though the linter is silent about it.
//
// It is fail-closed in both directions. A new hit in an unmapped file fails; a mapped count that
// drops fails too, because a writer disappearing silently is how coverage rots.
//
// ---------------------------------------------------------------------------
// WHICH VERIFICATION TASKS TRUST WHICH HASH (issue #367 part 2, the class sweep)
//
// Turbo caches every task. A task that READS files outside its own hash universe can therefore be
// served a cached green while the thing it checks has changed. That hole was found twice, one
// instance at a time, so here is the whole enumeration — every test that resolves above its own
// directory, classified. The rule for adding a row: if your guard reads something, say where that
// something lives in the hash.
//
// | reader                                   | reads                        | why it is safe                                    |
// |------------------------------------------|------------------------------|---------------------------------------------------|
// | purge-guard / store-fs-guard / list      | all four packages' src       | COVERED TRANSITIVELY: cli's test depends on cli's  |
// | capability-warn-enumeration (all in cli) |                              | build, which depends on ^build, so a change in any |
// |                                          |                              | dependency's src re-hashes cli's test. Executed:   |
// |                                          |                              | edit core/src ⇒ cli test "0 cached, 5 total".      |
// | THIS census (cli)                        | all four packages' src       | same chain …                                      |
// |                                          | + root `scripts/**/*.mjs`    | … EXCEPT root scripts/, which no package hashes —  |
// |                                          |                              | now in `globalDependencies`. Executed as a real    |
// |                                          |                              | hole first: a writer added to a script served a    |
// |                                          |                              | cached green.                                      |
// | the `lint` task                          | root `eslint.config.ts`      | the task's hash never saw it — a mutated rule      |
// |                                          |                              | served "FULL TURBO" green. Now in                  |
// |                                          |                              | `globalDependencies`.                              |
// | settlement.test.ts (in CORE)             | core/src/engine +            | DOCUMENTED-COLD, and the one row that is not       |
// |                                          | mcp-server/src               | closed. Core is the base package, so nothing flows |
// |                                          |                              | upward: an mcp-server change does NOT re-hash      |
// |                                          |                              | core's test (executed: "2 cached, 2 total"). CI is |
// |                                          |                              | safe because it runs with an EMPTY turbo cache —   |
// |                                          |                              | no remote cache is configured and `.turbo/` is     |
// |                                          |                              | gitignored — so the guard always runs there. The   |
// |                                          |                              | residual is LOCAL staleness only. Not added to     |
// |                                          |                              | `globalDependencies` because mcp-server/src is a   |
// |                                          |                              | frequently-changing tree and the entry would       |
// |                                          |                              | re-hash every task on every edit. See the report.  |
// | own-package readers (provider-conformance| their own package's src      | covered by that package's own hash, by definition. |
// | agent-manifest-gate, claim-liveness,     | or its own dist              |                                                    |
// | json-trace-buffer-store-lock-guard,      |                              |                                                    |
// | read-only-no-extensions, github-adapter, |                              |                                                    |
// | gc-heal-note, validate-extensions,       |                              |                                                    |
// | validate-orphan-manifest,                |                              |                                                    |
// | listen-extensions-child, server.entry)   |                              |                                                    |
//
// Nothing reads `examples/`, `docs/`, or a root config at runtime — the two apparent hits are
// string assertions about a docs PATH inside generated content, not file reads (verified).
// ---------------------------------------------------------------------------
// HOME: the cli package on purpose. Turbo hashes a package's own sources, so a core-side guard
// would go stale-green locally whenever core changed without cli changing. cli depends on all
// three sibling packages, so its test task invalidates on any of their src edits.
import { describe, it, expect } from 'vitest';
import {
  readdirSync,
  readFileSync,
  statSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

// packages/cli/src/commands → the monorepo root.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SCANNED_PACKAGES = ['core', 'cli', 'mcp-server', 'testing'];

/**
 * Any quoting form, bracketed or not, and an assignment that is not a comparison.
 *
 * `=(?!=)` is deliberate: the naive `[:=]` form matches `===` comparisons and floods the census
 * with reads. The optional `[` / `]` are deliberate too — without them a `]` sits between the
 * quote and the `:` or `=`, so `{['terminal_state']: true}` and `o['terminal_state'] = true` slid
 * past this token entirely. The lint rules do catch both, but inside the five files where those
 * rules are suppressed by authorization they were invisible to BOTH source-text layers, leaving
 * only the store boundary to catch them at runtime. Closed here.
 */
const TOKEN = /\[?['"`]?terminal_state['"`]?\]?\s*(:|=(?!=))/;

/** A suppression of the seal-writer rules, in any of eslint's disable spellings. */
const DISABLE = /eslint-disable(?:-next-line|-line)?\s+[^\n]*no-restricted-syntax/;

/** What a `terminal_state` hit IS. A file may hold several kinds; the map lists all of them. */
type HitClass =
  | 'writer-stamped' // a real terminal write, stamped in the same literal or via a chokepoint
  | 'stripper-false' // `terminal_state: false` — a resume/strip write, which never carries a seal
  | 'type-decl' // an interface/type field declaration
  | 'echo' // an envelope echoing a stored value; reaches no store
  | 'fixture-input' // a published contract fixture constructing a shape to drive a law
  | 'string-literal' // the token inside a message or a test name
  | 'guard-self'; // this guard's own source

interface CensusEntry {
  count: number;
  classes: HitClass[];
  reason: string;
  /** Authorized `eslint-disable` of the seal-writer rules in this file, with its reason. */
  suppression?: string;
}

/**
 * THE MAP. Every count here was recomputed from the tree, not inherited: 84 raw hits strip to 68
 * once comments are removed, across 13 files.
 */
const EXPECTED: Record<string, CensusEntry> = {
  'packages/cli/src/agent/run-attach.ts': {
    count: 1,
    classes: ['stripper-false'],
    reason: 'The retry path flips the run live again and strips the seal in the same write.',
  },
  'packages/core/src/engine/apply-resume.ts': {
    count: 1,
    classes: ['stripper-false'],
    reason: 'Resume: the seal fact leaves in the write that makes the run live.',
  },
  'packages/core/src/engine/eligibility.ts': {
    count: 1,
    classes: ['writer-stamped'],
    reason: '`sealRunLevel` — the one chokepoint for the four run-level bypass writers.',
  },
  'packages/core/src/engine/execution-loop.ts': {
    count: 12,
    classes: ['writer-stamped', 'stripper-false'],
    reason:
      'The legacy seal layer: 8 stamped terminal writes, 4 non-terminal forks that carry no seal.',
    suppression:
      'One inline disable at the buildFinalizedSeal drain: the stamp IS in the literal, as a ' +
      'conditional spread that `exactOptionalPropertyTypes` forces and the selector cannot see.',
  },
  'packages/core/src/engine/settlement.ts': {
    count: 8,
    classes: ['writer-stamped'],
    reason:
      'The eight settlement arms. Each builds a draft; `applyTerminalPostconditions` applies the ' +
      'seal. THIS COUNT IS THE POINT: the file is lint-suppressed, so a ninth writer that ' +
      'bypasses the chokepoint is caught here and nowhere else in the source layer.',
    suppression:
      'Per-file: the layer stamps through the applyTerminalPostconditions chokepoint, which is ' +
      'two-stage by design and invisible to a same-object rule.',
  },
  'packages/core/src/store/json-file-store.ts': {
    count: 1,
    classes: ['writer-stamped'],
    reason: 'The create branch mints a fresh, non-terminal run record.',
  },
  'packages/core/src/types/run-record.ts': {
    count: 1,
    classes: ['type-decl'],
    reason: 'The `RunRecord.terminal_state` field declaration itself.',
  },
  'packages/mcp-server/src/tools/abandon-run.ts': {
    count: 2,
    classes: ['type-decl', 'echo'],
    reason: 'The response type field, and the envelope echo of the stored value.',
    suppression: 'Inline at the echo: an envelope shape, not a writer — it reaches no store.',
  },
  'packages/mcp-server/src/tools/get-run-state.ts': {
    count: 2,
    classes: ['type-decl', 'echo'],
    reason: 'The response type field, and the envelope echo of the stored value.',
    suppression: 'Inline at the echo: an envelope shape, not a writer — it reaches no store.',
  },
  'packages/testing/src/runner/test-runner.ts': {
    count: 1,
    classes: ['stripper-false'],
    reason: 'The simulated resume in the fixture runner strips the seal as it goes live.',
  },
  'packages/testing/src/store/in-memory-store.ts': {
    count: 1,
    classes: ['writer-stamped'],
    reason: 'The create branch mints a fresh, non-terminal run record.',
  },
  'packages/testing/src/store/run-store-fidelity-contract.ts': {
    count: 1,
    classes: ['fixture-input'],
    reason: 'SEALED_BY_ROUNDTRIP seals a run properly to prove the arm survives a round trip.',
  },
  'packages/testing/src/store/settlement-contract.ts': {
    count: 37,
    classes: ['fixture-input', 'string-literal'],
    reason:
      'The published settlement TCK: fixtures constructing the shapes its laws drive, plus law ' +
      'names and assertion messages that mention the field. 36 → 37 with issue #367 part 3: the ' +
      'five stampSeal laws share one terminal fixture helper.',
    suppression:
      'Inline at the SEAL_FRESH_WRITE_REFUSED fixture: that violation IS the law — the case ' +
      'exists to prove the store refuses an unstamped fresh seal.',
  },
};

// ---------------------------------------------------------------------------
// The scanner — exported over an injectable root so the self-cells can plant shapes in a scratch
// directory instead of in the live tree.
// ---------------------------------------------------------------------------

export interface ScanResult {
  /** repo-relative path → the line numbers that matched, comments already stripped. */
  hits: Record<string, number[]>;
  /** repo-relative path → true when the file suppresses the seal-writer rules. */
  suppressions: Record<string, true>;
}

/** Blanks out comment text while preserving line structure — the guards-1-6 precedent. */
function stripComments(source: string): string[] {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''));
}

function walk(dir: string, accept: (name: string) => boolean, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, accept, out);
    else if (accept(entry)) out.push(full);
  }
  return out;
}

export function scanTerminalWriters(root: string): ScanResult {
  const files: string[] = [];
  for (const pkg of SCANNED_PACKAGES) {
    files.push(
      ...walk(
        join(root, 'packages', pkg, 'src'),
        (n) => n.endsWith('.ts') && !n.endsWith('.test.ts') && !n.endsWith('.d.ts'),
      ),
    );
  }
  // `scripts/` is in scope and carries NO zero-count entries: coverage there is
  // fail-closed-on-first-hit, because a zero entry would itself trip the staleness cell.
  files.push(...walk(join(root, 'scripts'), (n) => n.endsWith('.mjs')));

  const hits: Record<string, number[]> = {};
  const suppressions: Record<string, true> = {};
  for (const file of files.sort()) {
    const rel = relative(root, file).split(sep).join('/');
    const raw = readFileSync(file, 'utf8');
    if (DISABLE.test(raw)) suppressions[rel] = true;
    const matched = stripComments(raw)
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => TOKEN.test(line))
      .map(([n]) => n);
    if (matched.length > 0) hits[rel] = matched;
  }
  return { hits, suppressions };
}

/** The violations a scan produces against an expected map — each one a sentence, not a code. */
export function censusViolations(
  scan: ScanResult,
  expected: Record<string, CensusEntry>,
): string[] {
  const problems: string[] = [];
  for (const [file, lines] of Object.entries(scan.hits)) {
    const entry = expected[file];
    if (entry === undefined) {
      problems.push(
        `${file}: writes terminal_state at line(s) ${lines.join(', ')} but has NO census entry. ` +
          `Add it to EXPECTED in terminal-writer-census.test.ts with a count, a class and a ` +
          `reason — and make sure the write names its seal arm in the same object literal.`,
      );
      continue;
    }
    if (lines.length !== entry.count) {
      const direction = lines.length > entry.count ? 'MORE' : 'FEWER';
      problems.push(
        `${file}: ${lines.length} terminal_state write(s), census says ${entry.count} — ${direction} ` +
          `than expected. If you added a terminal write, stamp its seal arm in the same literal ` +
          `and raise the count; if you removed one, lower it. Lines: ${lines.join(', ')}.`,
      );
    }
  }
  for (const file of Object.keys(expected)) {
    if (scan.hits[file] === undefined) {
      problems.push(
        `${file}: census expects ${expected[file]!.count} terminal_state write(s) and the file has ` +
          `none. Remove its entry from EXPECTED if the file is gone or no longer writes.`,
      );
    }
  }
  for (const file of Object.keys(scan.suppressions)) {
    const entry = expected[file];
    if (entry?.suppression === undefined) {
      problems.push(
        `${file}: suppresses the seal-writer lint rules with no authorized reason. Every ` +
          `suppression needs a \`suppression\` reason on its census entry in ` +
          `terminal-writer-census.test.ts — a silent disable is how a writer gap ships.`,
      );
    }
  }
  return problems;
}

describe('#367 — the terminal-writer census', () => {
  it('the tree matches the census exactly, in both directions', () => {
    expect(censusViolations(scanTerminalWriters(REPO_ROOT), EXPECTED)).toEqual([]);
  });

  it('every authorized suppression is actually present in the tree', () => {
    // The other direction of the disable-policing: a `suppression` reason left behind after the
    // disable was removed is a stale licence, and the next author reads it as permission.
    const scan = scanTerminalWriters(REPO_ROOT);
    const claimed = Object.entries(EXPECTED)
      .filter(([, e]) => e.suppression !== undefined)
      .map(([f]) => f);
    for (const file of claimed) expect(scan.suppressions[file]).toBe(true);
    expect(claimed).toHaveLength(5);
  });

  it("turbo.json globalDependencies matches the sweep table's join-list", () => {
    // A text pin is weak, but it makes a silent removal red something. Both entries are here
    // because each was EXECUTED as a real cache hole: without them, a mutated lint rule and a new
    // writer in `scripts/` both served cached greens. If a row in the table above moves into the
    // join-list, it moves here too — that is what stops the table drifting from the config.
    const turbo = JSON.parse(readFileSync(join(REPO_ROOT, 'turbo.json'), 'utf8')) as {
      globalDependencies?: string[];
    };
    expect(turbo.globalDependencies).toEqual(['eslint.config.ts', 'scripts/**/*.mjs']);
  });

  it('the post-strip total is 69 across 13 files — the figure the map is built from', () => {
    const scan = scanTerminalWriters(REPO_ROOT);
    const total = Object.values(scan.hits).reduce((n, l) => n + l.length, 0);
    expect(total).toBe(69);
    expect(Object.keys(scan.hits)).toHaveLength(13);
  });
});

// ---------------------------------------------------------------------------
// Self-cells — the guard's own instrument, exercised on a scratch tree. A guard nobody has seen
// FAIL is a guard nobody knows works.
// ---------------------------------------------------------------------------

describe('#367 — the census guard catches what it claims to', () => {
  /** Builds a throwaway tree and hands it to `fn`, then removes it. */
  function withScratchTree(files: Record<string, string>, fn: (root: string) => void): void {
    const root = join(tmpdir(), `realm-census-${Math.random().toString(36).slice(2)}`);
    try {
      for (const [rel, content] of Object.entries(files)) {
        const full = join(root, rel);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
      }
      fn(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('a planted UNSTAMPED writer in an unmapped file is caught, and the message names it', () => {
    withScratchTree(
      { 'packages/core/src/engine/sneaky.ts': 'export const x = { terminal_state: true };\n' },
      (root) => {
        const problems = censusViolations(scanTerminalWriters(root), {});
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain('packages/core/src/engine/sneaky.ts');
        expect(problems[0]).toContain('NO census entry');
        expect(problems[0]).toContain('names its seal arm in the same object literal'); // the fix path
      },
    );
  });

  it('drift UP is caught — an extra write in a mapped file', () => {
    withScratchTree(
      {
        'packages/core/src/engine/a.ts':
          'const a = { terminal_state: true };\nconst b = { terminal_state: true };\n',
      },
      (root) => {
        const problems = censusViolations(scanTerminalWriters(root), {
          'packages/core/src/engine/a.ts': { count: 1, classes: ['writer-stamped'], reason: 'x' },
        });
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain('MORE than expected');
        expect(problems[0]).toContain('packages/core/src/engine/a.ts');
        expect(problems[0]).toContain('raise the count');
      },
    );
  });

  it('drift DOWN is caught — a write that quietly disappeared', () => {
    withScratchTree(
      { 'packages/core/src/engine/a.ts': 'const a = { terminal_state: true };\n' },
      (root) => {
        const problems = censusViolations(scanTerminalWriters(root), {
          'packages/core/src/engine/a.ts': { count: 2, classes: ['writer-stamped'], reason: 'x' },
        });
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain('FEWER than expected');
        expect(problems[0]).toContain('lower it');
      },
    );
  });

  it('a file that vanished entirely is caught', () => {
    withScratchTree({ 'packages/core/src/engine/a.ts': 'export const x = 1;\n' }, (root) => {
      const problems = censusViolations(scanTerminalWriters(root), {
        'packages/core/src/engine/gone.ts': { count: 1, classes: ['writer-stamped'], reason: 'x' },
      });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('packages/core/src/engine/gone.ts');
      expect(problems[0]).toContain('no longer writes');
    });
  });

  it('an UNREASONED suppression is caught, and the message says what is missing', () => {
    withScratchTree(
      {
        'packages/core/src/engine/a.ts':
          '/* eslint-disable no-restricted-syntax */\nconst a = { terminal_state: true };\n',
      },
      (root) => {
        const problems = censusViolations(scanTerminalWriters(root), {
          'packages/core/src/engine/a.ts': { count: 1, classes: ['writer-stamped'], reason: 'x' },
        });
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain('no authorized reason');
        expect(problems[0]).toContain('a silent disable is how a writer gap ships');
      },
    );
  });

  it('a REASONED suppression passes', () => {
    withScratchTree(
      {
        'packages/core/src/engine/a.ts':
          '// eslint-disable-next-line no-restricted-syntax -- reason\nconst a = { terminal_state: true };\n',
      },
      (root) => {
        expect(
          censusViolations(scanTerminalWriters(root), {
            'packages/core/src/engine/a.ts': {
              count: 1,
              classes: ['writer-stamped'],
              reason: 'x',
              suppression: 'because',
            },
          }),
        ).toEqual([]);
      },
    );
  });

  it('POSITIVE HALF: the token matches every plain quoting form, and never a comparison', () => {
    withScratchTree(
      {
        'packages/core/src/engine/forms.ts':
          [
            'const a = { terminal_state: true };', // 1 bare
            "const b = { 'terminal_state': true };", // 2 single-quoted
            'const c = { "terminal_state": true };', // 3 double-quoted
            'o.terminal_state = true;', // 4 dot assignment
            'if (o.terminal_state === true) { void 0; }', // NOT a hit — a comparison, not a write
            'if (o.terminal_state == true) { void 0; }', // NOT a hit — likewise
          ].join('\n') + '\n',
      },
      (root) => {
        expect(scanTerminalWriters(root).hits['packages/core/src/engine/forms.ts']).toEqual([
          1, 2, 3, 4,
        ]);
      },
    );
  });

  it('BRACKET forms are caught too — the seam that used to reach only the store boundary', () => {
    // These forms slid past the earlier token, and inside the five lint-suppressed files that made
    // them invisible to BOTH source-text layers. The census sees them now, so a bracket-form write
    // is caught wherever it is written.
    withScratchTree(
      {
        'packages/core/src/engine/computed.ts':
          "const a = { ['terminal_state']: true };\no['terminal_state'] = true;\n",
      },
      (root) => {
        expect(scanTerminalWriters(root).hits['packages/core/src/engine/computed.ts']).toEqual([
          1, 2,
        ]);
      },
    );
  });

  it('only truly DYNAMIC name construction escapes both instruments', () => {
    // The honest floor, pinned so nobody reads the widening as total. A name assembled at runtime
    // is not a token any regex can see, and no AST selector can resolve it either — the store
    // boundary is the observer for that one, at runtime.
    withScratchTree(
      {
        'packages/core/src/engine/dynamic.ts':
          "const k = 'terminal_' + 'state';\nconst a = { [k]: true };\n",
      },
      (root) => {
        expect(
          scanTerminalWriters(root).hits['packages/core/src/engine/dynamic.ts'],
        ).toBeUndefined();
      },
    );
  });

  it('COMMENTS are stripped — a commented write is not a write', () => {
    withScratchTree(
      {
        'packages/core/src/engine/c.ts':
          [
            '// const a = { terminal_state: true };',
            '/* const b = { terminal_state: true }; */',
            'const c = { terminal_state: true };',
          ].join('\n') + '\n',
      },
      (root) => {
        expect(scanTerminalWriters(root).hits['packages/core/src/engine/c.ts']).toEqual([3]);
      },
    );
  });

  it('SELF-SCAN: this guard file is excluded, or its own EXPECTED map would be a census entry', () => {
    // The scanner skips `*.test.ts`, and this file is one. Asserted rather than assumed: the map
    // above mentions the token dozens of times, so a scoping slip would make the guard fail on
    // itself and read as tree drift.
    const scan = scanTerminalWriters(REPO_ROOT);
    expect(scan.hits['packages/cli/src/commands/terminal-writer-census.test.ts']).toBeUndefined();
  });

  it('scripts/ is scanned, fail-closed on the first hit', () => {
    withScratchTree({ 'scripts/thing.mjs': 'const a = { terminal_state: true };\n' }, (root) => {
      const problems = censusViolations(scanTerminalWriters(root), {});
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('scripts/thing.mjs');
    });
  });
});
