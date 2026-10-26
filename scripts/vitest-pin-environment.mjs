// The vitest setup file that the root `vitest.config.mts` gives every test file (#729 PR-3, RECORD 05
// "tests"). Realm's disclosure law hides environment values in what an agent, a log or a broadcast
// is shown, so a test's expected text would otherwise depend on the machine that runs it: a checkout
// under the developer's HOME, a CI runner's tokens. This pins it. Every variable the test process
// starts with is named in `REALM_NOT_SECRET` (the law's exemption by name), so none of them is hidden;
// a variable a test sets under a NEW name — every canary — is swept as on any machine. A test about
// the exemption itself sets `REALM_NOT_SECRET` (`vi.stubEnv`), which replaces this list.
//
// It runs in each test file's own process (forks, isolated), before the file's imports, and writes
// nothing but this one variable.
process.env['REALM_NOT_SECRET'] = Object.keys(process.env)
  .filter((name) => name !== 'REALM_NOT_SECRET')
  .join(',');
