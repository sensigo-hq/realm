// lazy-home-resolution-285.test.ts — issue #285 red-first regression pin: JsonFileStore must
// resolve its default `runsDir` at CONSTRUCTION time, never at module load. Companion CLI pin
// (JsonFileReplayStore) lives at packages/cli/src/commands/lazy-home-resolution-285.test.ts.
//
// A static top-level import IS safe here, unlike a command module: this file imports
// json-file-store.ts DIRECTLY (a relative, source-level import) — post-fix, that module performs
// NO `homedir()` read at all until a `JsonFileStore` is actually constructed, so importing it
// early no longer freezes anything. Read-only discrimination: `runsDirPath` is a pure string
// getter, never touches the filesystem.
//
// STALE-INSTRUMENT TRAP: zero core tests import the published `@sensigo/realm` package specifier
// — it resolves to BUILT DIST via the package's `exports` map, and a single-file `vitest run`
// does not rebuild first, so a package-specifier import here would silently test yesterday's
// build. Always import relatively from source, as every other core test in this directory does.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from './json-file-store.js';
import { JsonWorkflowStore } from '../workflow/registrar.js';

describe('JsonFileStore — construction-time home resolution (issue #285)', () => {
  it('resolves the default runsDir under $HOME AT CONSTRUCTION TIME — red-first: this pin FAILS on the module-scope-capture code this PR removes (the module was already imported, transitively, before this test body ever runs — $HOME set here is set long after any module-load-time capture would have already frozen the wrong value)', async () => {
    const originalHome = process.env['HOME'];
    const fakeHome = await mkdtemp(join(tmpdir(), 'realm-285-core-pin-'));
    try {
      process.env['HOME'] = fakeHome;
      const store = new JsonFileStore();
      expect(store.runsDirPath).toBe(join(fakeHome, '.realm', 'runs'));
    } finally {
      if (originalHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = originalHome;
      await rm(fakeHome, { recursive: true, force: true });
    }
  });
});

describe('JsonWorkflowStore — construction-time home resolution (companion assertion, issue #285)', () => {
  it('mkdirSyncs <fakeHome>/.realm/workflows at construction — EXCLUDED from the #285 red-first gate: registrar.ts:26 has ALWAYS resolved homedir() inside its constructor (this is the house pattern the other two stores now conform TO, not something #285 changed), so this assertion is green on main both before and after this PR', async () => {
    const originalHome = process.env['HOME'];
    const fakeHome = await mkdtemp(join(tmpdir(), 'realm-285-workflowstore-pin-'));
    try {
      process.env['HOME'] = fakeHome;
      // eslint-disable-next-line no-new -- the constructor's own mkdirSync side effect IS the assertion.
      new JsonWorkflowStore();
      const { existsSync } = await import('node:fs');
      expect(existsSync(join(fakeHome, '.realm', 'workflows'))).toBe(true);
    } finally {
      if (originalHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = originalHome;
      await rm(fakeHome, { recursive: true, force: true });
    }
  });
});
