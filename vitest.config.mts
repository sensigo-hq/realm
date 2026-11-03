import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// `.mts`, so Node and Vite load it as the ES module it is (the root package.json has no "type";
// as `.ts` Vite warned it would stop loading it, and `import.meta` was refused).
//
// Root vitest config — DISCOVERED and applied by each package's own `vitest run` (verified for
// vitest 4.1.8: `root` resolves to the package cwd, so every package still runs only its own
// files). Deliberately NOT using `projects` — that breaks `npm run test --workspace <pkg>` (its
// glob resolves relative to the subpackage cwd). See plans/flaky-test-suite-design.md (issue: the
// CLI suite intermittently reds under parallel turbo — nested-parallelism CPU starvation).
export default defineConfig({
  test: {
    // De-starvation lever: each vitest takes half the box; paired with `turbo run test
    // --concurrency=2` (root package.json) => 2 × round(0.5·C) = C => exactly full subscription,
    // zero oversubscription, on any core count (12-core dev, 4-vCPU CI alike).
    maxWorkers: '50%',
    // Pin the verified vitest 4.1.8 defaults so a future default-flip can't silently break us.
    // forks + isolate give per-FILE process isolation — LOAD-BEARING (re-grounded, issue #285,
    // 2026-08-13: the original rationale here named one now-fixed bug — JsonFileStore's default
    // dir used to be captured once at module-load, so a test mutating process.env.HOME needed its
    // OWN process to make that capture correct; #285 fixed the capture at the root, but per-file
    // isolation is still load-bearing for the GENERAL class that bug was one instance of): several
    // tests (abandon/attempts/drain/resume-wedge-e2e/gc-heal-composition/…) mutate
    // `process.env.HOME` (or similar ambient env) around a real store construction. Per-file
    // process isolation is what makes that safe regardless of ANY particular module's capture
    // timing — a shared-process pool would let one file's env mutation leak into another's timing
    // window (a concurrently-running or immediately-following file observing the wrong value)
    // however carefully each individual module resolves its own defaults. The config VALUE is
    // unchanged by this re-grounding; only the justification is.
    pool: 'forks',
    isolate: true,
    // 30 s default for every test. It was 5 s DELIBERATELY (once the pool is bounded, pure tests finish
    // in ms, 100x margin, and a true hang then fails loudly and fast); the owner decided on 2026-10-30
    // to raise it: he said "yes" (session aaefd3da, uuid 359abf57-54f1-4af3-b7e5-2df4b96e18d0,
    // 2026-10-30T11:45:06Z) to "raise the default from 5 to 30 s in one config line" (the orchestrator's
    // words for the question). Why: under load the 5 s floor voided counted runs in cells that no
    // guard reaches (an in-process ESLint cell, the glossary sweeps of docs-claims-625, a docs example
    // that runs the CLI in process: plans/issue-938-census/second-step-slow-cells.txt), and a clean
    // full run already had 61 cells over 5 s (56 in cli; measured on reports/fix-918-*.suite2-final-A).
    // The cost, named: a hung cell now takes 30 s to fail, and #371's tight floor for the pure majority
    // is gone. KEPT: every written per-cell budget (they override this global), and the spawn-budget
    // guard (`packages/cli/src/spawn-budget-guard.test.ts`, the owner's yes uuid 37bb7e82-5e97-43a6-9603-74d1182addf2),
    // which still fails a cell that starts a child process without a budget of its own. No slow-test
    // report is turned on (a 5 s `slowTestThreshold` would list those 61 cells in every clean run).
    //
    // CLASS RULE (issue #371 — the surgical-budget doctrine): heavy cells — child-spawn (`node
    // dist` cold start), a heavy dynamic import of a built server, concurrency hammers, real-sleep
    // retry fixtures — carry surgical per-`it()` budgets AT BIRTH (which override this global; one
    // above 30 s is how a cell asks for more). The stale predecessor of this rule named "3
    // genuinely-spawning CLI tests" as self-protecting — the population grew without inheriting
    // budgets, which is exactly how #371's starvation flakes happened; 2026-10-29: 31 of 478
    // spawning cells had drifted that way, and the guard above now fails the build for the next one
    // (the owner's yes, session aaefd3da, uuid 37bb7e82-5e97-43a6-9603-74d1182addf2: "add the narrow
    // time-limit check"). It is narrow on purpose — spawning cells only; its header says what counts
    // as declared and what it cannot see.
    // `turbo.json`'s `concurrency` key (also #371) now carries the other half of the de-starvation
    // pairing this config's `maxWorkers` comment describes below.
    testTimeout: 30_000,
    // No retry, as policy: the flakiness is 100% owned defects (starvation here; the slack race in
    // PR-B), removed by construction. Retry would only mask a genuine future regression
    // (fails-then-passes is still broken). Quarantine a specific test if ever mid-fix — never a
    // global retry.
    retry: 0,
    // Tests read built output and never build: the run refuses to start when the build is older
    // than the source (the reason, and how the check stays read-only, are in the file).
    globalSetup: [fileURLToPath(new URL('./scripts/vitest-build-is-current.mjs', import.meta.url))],
    // #729 PR-3: the disclosure law hides environment values in what an agent or a log is shown; this
    // pins the environment every test file starts with as not secret, so no expected text depends on
    // the machine (the reason is in the file).
    setupFiles: [fileURLToPath(new URL('./scripts/vitest-pin-environment.mjs', import.meta.url))],
  },
});
