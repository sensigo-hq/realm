// test-time-715b.test.ts — issue #715 (b) 04 §B.3 (D5 §5.3, D6-24, D6-40): the test-time rule. A
// test file that builds a JSON-file store, takes a store lock, or starts the CLI may not fake the
// global `Date` — `vi.useFakeTimers()` (which fakes `Date` unless its `toFake` list leaves it out),
// a `toFake` list naming `Date`, `vi.setSystemTime`, `vi.spyOn(Date, …)` — unless it is named below
// with its reason. Why: the lock library judges a held lock stale by the lock's mtime against the
// wall clock; a process that fakes `Date` writes its lock's mtime from the fake, and another process
// on the real clock then steals a live lock (measured: `plans/issue-715/reference/dr-phase2/
// lockprobe.out`). Faking `performance` stays allowed (#573's pins), and so does faking timers alone.
//
// A source scan, not an ESLint rule: ESLint sees one file's syntax, and "this file builds a JSON
// store" is a fact about what the file does across its cells. The scan covers every `*.test.ts` of the
// four packages and the files vitest loads as `setupFiles` (`vitest.config.mts`).
//
// Each cell carries (a) the change that turns it red and (b) what it prints on failure (file names).
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** A file that builds a JSON-file store, takes a lock, or starts the built CLI. */
const TAKES_REAL_LOCKS =
  /new JsonFileStore\(|lockfile\.lock\(|proper-lockfile|dist\/index\.js|spawnSync\(|execFileSync\(/;

/** A fake of the global `Date` (timers alone, or `performance`, are not). */
function fakesDate(text: string): boolean {
  if (/vi\.setSystemTime\(|vi\.spyOn\(Date\b|vi\.spyOn\(globalThis,\s*'Date'\)/.test(text))
    return true;
  for (const m of text.matchAll(/vi\.useFakeTimers\(([^)]*)\)/g)) {
    const args = m[1] ?? '';
    if (!/toFake/.test(args)) return true; // the default fakes Date
    if (/'Date'|"Date"/.test(args)) return true;
  }
  // A multi-line `vi.useFakeTimers({ toFake: [ … ] })`.
  for (const m of text.matchAll(/vi\.useFakeTimers\(\{\s*toFake:\s*\[([\s\S]*?)\]/g)) {
    if (/'Date'|"Date"/.test(m[1] ?? '')) return true;
  }
  return false;
}

/**
 * The files allowed to do both, each with its reason. A file not named here may not. (04 §D: each
 * file the rule flags is either converted — `settableClock` and `Clock.at`, an in-memory store, or a
 * `performance` spy — or named here.)
 */
const ALLOWED: Record<string, string> = {
  'packages/core/src/store/json-file-store-clock-715.test.ts':
    "the S4 cell: a JSON store beside a faked `Date`, by design — it shows the store's time is its clock's, not the faked global",
  'packages/core/src/engine/reliability.test.ts':
    "C1/C2 spy `Date.now` scoped to execution-loop frames only (#573's frame-scoped shape, J20); C3/C4b fake Date on an in-memory store (C4a builds none)",
  'packages/cli/src/agent/drive-failure.test.ts':
    'D7/D8 spy `Date.now` in cells that build no store (elapsed is monotonic whatever the wall does); the JSON-store cells run on the real clock',
  'packages/cli/src/agent/gate/slack-gate-notifier.test.ts':
    "the fake timers live in cells that build no store (the reminder timers and the Slack transport's deadline: host timers, D6-64); the JSON-store cells run on the real clock",
  'packages/cli/src/commands/listen.test.ts':
    'the dedup-window cells fake `Date` alone (the window is an `outside` read, #177) and build no store; the JSON-store cells run on the real clock',
  'packages/cli/src/output/writer.test.ts':
    "U1-6 fakes timers for the writer's idle flush (a duration) in a cell that starts nothing; the cells that start the CLI run on the real clock",
};

/**
 * #715 (b) 04 §D (B4), MA 3's Amendment 13 (1): no test waits on the real clock for a question to
 * expire, a claim to lapse or a lease to end — except the cells named here, each with its reason (a
 * named exemption, never a silent skip). The waits are SYNCHRONOUS holds (`while (Date.now() <= …)`):
 * the cell below fails when such a hold appears in any other test file, or a named cell is gone.
 */
const REAL_CLOCK_EXPIRY_WAITS: Record<string, { cells: string[]; reason: string }> = {
  'packages/cli/src/commands/run-prompt-625.test.ts': {
    cells: [
      'DIFFERENT choice: `⚠ … this run call first carried out …` once, then the refusal and `✗ not recorded`, on stderr',
      'SAME choice: the line once, then the same-choice sentence and `✗ not recorded`, on stdout',
      'abort: the line once, then the refusal and `✗ not recorded → aborted`, on stderr',
    ],
    reason:
      "C146's race: the answer must be handled past the deadline BEFORE this process's own expiry timer runs. Only a synchronous hold past a real deadline orders the two; a test location's clock moves by an asynchronous file write, during which the timer's watch can fire first",
  },
  'packages/cli/src/commands/phase-words-c5-inproc-729.test.ts': {
    cells: [
      'run.ts — a late answer, the same choice: `✗ not recorded — … → …` on stdout',
      'run.ts — a late answer, another choice: `✗ not recorded — … → …` on stderr',
      'run.ts — a late answer the expiry aborted: `✗ not recorded → …` (the declared route: `aborted`)',
    ],
    reason:
      "the same race as C146's (the late answer read before this process's own timer fires), held the same way",
  },
};

function testFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && e.name !== 'dist') walk(p);
      } else if (p.endsWith('.test.ts')) {
        out.push(relative(ROOT, p).split(sep).join('/'));
      }
    }
  };
  for (const pkg of ['core', 'cli', 'mcp-server', 'testing', 'store-sqlite'])
    walk(join(ROOT, 'packages', pkg, 'src'));
  return out.sort();
}

/** The `setupFiles` vitest loads (`vitest.config.mts`), repo-relative. */
function setupFiles(): string[] {
  const config = readFileSync(join(ROOT, 'vitest.config.mts'), 'utf8');
  const m = /setupFiles:\s*\[([^\]]*)\]/.exec(config);
  return [...(m?.[1] ?? '').matchAll(/'([^']+)'|"([^"]+)"/g)].map((x) =>
    relative(ROOT, join(ROOT, (x[1] ?? x[2])!.replace(/^\.\//, '')))
      .split(sep)
      .join('/'),
  );
}

/** This file: its seeded fixtures are text, not what it does. */
const SELF = 'packages/cli/src/commands/test-time-715b.test.ts';

function violations(files: ReadonlyArray<{ path: string; text: string }>): string[] {
  return files
    .filter(
      (f) =>
        f.path !== SELF &&
        TAKES_REAL_LOCKS.test(f.text) &&
        fakesDate(f.text) &&
        ALLOWED[f.path] === undefined,
    )
    .map((f) => f.path);
}

describe('#715 (b) 04 §B.3 — a test that takes real locks never fakes the global Date', () => {
  it('no test file outside the allowed list both takes real locks and fakes Date; the setup files fake no Date', () => {
    // (a) red when a file adds a `vi.useFakeTimers()`/`vi.setSystemTime` beside a JSON store, or a
    //     setup file fakes `Date`; (b) prints the file names.
    const files = [...testFiles()].map((path) => ({
      path,
      text: readFileSync(join(ROOT, path), 'utf8'),
    }));
    const setups = setupFiles()
      .filter((p) => fakesDate(readFileSync(join(ROOT, p), 'utf8')))
      .map((p) => `setup: ${p}`);
    expect([...violations(files), ...setups]).toEqual([]);
  });

  it('the rule is not vacuous: a seeded file that builds a JSON store and fakes Date is caught; timers alone, or a toFake without Date, are not', () => {
    // (a) red when the scan misses one of the fakes (a regex lost); (b) prints the flagged names.
    const store = 'const s = new JsonFileStore(dir);\n';
    const seeded = [
      { path: 'seed/default.test.ts', text: store + 'vi.useFakeTimers();' },
      { path: 'seed/system-time.test.ts', text: store + 'vi.setSystemTime(0);' },
      { path: 'seed/spy.test.ts', text: store + "vi.spyOn(Date, 'now');" },
      {
        path: 'seed/to-fake-date.test.ts',
        text: store + "vi.useFakeTimers({\n  toFake: [\n    'setTimeout',\n    'Date',\n  ],\n});",
      },
      {
        path: 'seed/timers-only.test.ts',
        text: store + "vi.useFakeTimers({ toFake: ['setTimeout'] });",
      },
      { path: 'seed/no-store.test.ts', text: 'vi.useFakeTimers();' },
    ];
    expect(violations(seeded)).toEqual([
      'seed/default.test.ts',
      'seed/system-time.test.ts',
      'seed/spy.test.ts',
      'seed/to-fake-date.test.ts',
    ]);
  });

  it('every allowed file still does both (a stale entry is removed, so the list stays the set)', () => {
    // (a) red when an allowed file was converted and its entry left behind; (b) prints the entries.
    const stale = Object.keys(ALLOWED).filter((p) => {
      const text = readFileSync(join(ROOT, p), 'utf8');
      return !(TAKES_REAL_LOCKS.test(text) && fakesDate(text));
    });
    expect(stale).toEqual([]);
  });
});

describe('#715 (b) 04 §D (B4) — the real-clock expiry waits are exactly the named ones', () => {
  it('a synchronous hold past a deadline appears only in the named files, and every named cell is still there', () => {
    // (a) red when a test file adds a `while (Date.now() <= …)` hold and is not named here, or a named
    //     cell is renamed or removed (a stale exemption); (b) prints the files and the cells.
    const holding = testFiles().filter(
      (path) =>
        path !== SELF && /while \(Date\.now\(\) <= /.test(readFileSync(join(ROOT, path), 'utf8')),
    );
    const missing = Object.entries(REAL_CLOCK_EXPIRY_WAITS).flatMap(([path, { cells }]) => {
      const text = readFileSync(join(ROOT, path), 'utf8');
      return cells.filter((c) => !text.includes(`it('${c}'`)).map((c) => `${path}: ${c}`);
    });
    expect({ holding, missing }).toEqual({
      holding: Object.keys(REAL_CLOCK_EXPIRY_WAITS).sort(),
      missing: [],
    });
  });
});
