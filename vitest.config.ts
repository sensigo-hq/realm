import { defineConfig } from 'vitest/config';

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
    // Kept at the default 5s DELIBERATELY: once the pool is bounded, pure tests finish in ms
    // (100× margin). Raising the global would only delay the loud-failure signal for a true hang.
    // Explicit to document intent + guard a flip.
    //
    // CLASS RULE (issue #371 — the surgical-budget doctrine): heavy cells — child-spawn (`node
    // dist` cold start), a heavy dynamic import of a built server, concurrency hammers, real-sleep
    // retry fixtures — carry surgical 15-25s per-`it()` budgets AT BIRTH (which override this
    // global); the 5s default stays the tight floor for the pure majority. The stale predecessor
    // of this rule named "3 genuinely-spawning CLI tests" as self-protecting — the population grew
    // without inheriting budgets, which is exactly how #371's starvation flakes happened. A new
    // heavy cell that skips its budget re-arms the class loudly (a 5s timeout, not a silent pass)
    // — that loud failure is the enforcement; there is no separate guard script for it.
    // `turbo.json`'s `concurrency` key (also #371) now carries the other half of the de-starvation
    // pairing this config's `maxWorkers` comment describes below.
    testTimeout: 5000,
    // No retry, as policy: the flakiness is 100% owned defects (starvation here; the slack race in
    // PR-B), removed by construction. Retry would only mask a genuine future regression
    // (fails-then-passes is still broken). Quarantine a specific test if ever mid-fix — never a
    // global retry.
    retry: 0,
  },
});
