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
    // forks + isolate give per-FILE process isolation — LOAD-BEARING: abandon/attempts mutate
    // process.env.HOME then lazily import @sensigo/realm, whose JsonFileStore captures its default
    // dir once at module-load; per-file isolation makes that capture correct with no cross-file leak.
    pool: 'forks',
    isolate: true,
    // Kept at the default 5s DELIBERATELY: once the pool is bounded, pure tests finish in ms
    // (100× margin) and the 3 genuinely-spawning CLI tests already self-protect with their own
    // 20-25s per-test it()-timeouts (which override the global). Raising the global would only
    // delay the loud-failure signal for a true hang. Explicit to document intent + guard a flip.
    testTimeout: 5000,
    // No retry, as policy: the flakiness is 100% owned defects (starvation here; the slack race in
    // PR-B), removed by construction. Retry would only mask a genuine future regression
    // (fails-then-passes is still broken). Quarantine a specific test if ever mid-fix — never a
    // global retry.
    retry: 0,
  },
});
