// Contract probe suite — live third-party API tests requiring real credentials.
// Run via `npm run test:contract --workspace=packages/core`. Excluded from the
// default `vitest run`, whose include pattern does not match *.probe.ts.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.probe.ts'],
  },
});
