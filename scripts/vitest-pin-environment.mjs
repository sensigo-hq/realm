// The vitest setup file that the root `vitest.config.mts` gives every test file. It writes two things.
//
// 1. `HOME`, a fresh temp folder of the file's own (#616 PR-2b): a test that forgets to stub its HOME
//    lands in this folder, never in the developer's real `~/.realm`. n8n's #39118 is the record of what
//    this prevents: two test files overwrote a developer's real config. The folder is removed when the
//    file's tests are done; the file's own `afterAll` hooks run before this one (vitest's
//    `sequence.hooks` defaults to "stack"). Only `HOME` is set; nothing else about the environment
//    changes.
// 2. `REALM_NOT_SECRET` (#729 PR-3, RECORD 05 "tests"). Realm's disclosure law hides environment values
//    in what an agent, a log or a broadcast is shown, so a test's expected text would otherwise depend
//    on the machine that runs it: a checkout under the developer's HOME, a CI runner's tokens. This
//    pins it. Every variable the test process starts with is named in `REALM_NOT_SECRET` (the law's
//    exemption by name), so none of them is hidden; a variable a test sets under a NEW name — every
//    canary — is swept as on any machine. A test about the exemption itself sets `REALM_NOT_SECRET`
//    (`vi.stubEnv`), which replaces this list. It is written after `HOME`, so `HOME` is in the list by
//    name whatever the machine's environment.
//
// It runs in each test file's own process (forks, isolated), before the file's imports.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const home = mkdtempSync(join(tmpdir(), 'realm-vitest-home-'));
process.env['HOME'] = home;
afterAll(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});

process.env['REALM_NOT_SECRET'] = Object.keys(process.env)
  .filter((name) => name !== 'REALM_NOT_SECRET')
  .join(',');
