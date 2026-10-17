// separation-check-noentry-627.test.ts — #627 W correction 2 (5.2): a login with no passwd entry. The
// real probes read the uid from the process itself (it needs no passwd entry), name the login by it,
// and give no login home — never a `$HOME` fallback. `osLogin` is replaced here — a passthrough of
// `./program-identity.js` that replaces only it — in a file of its own, because `vi.mock` applies to
// the whole file.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: the
// uid, the login's name and whether a home was given — never an environment.
import { describe, it, expect, vi } from 'vitest';
import { systemProbes } from './separation-check.js';

vi.mock('./program-identity.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./program-identity.js')>()),
  osLogin: () => undefined,
}));

describe('#627 W correction 2 (5.2) — the real probes with no passwd entry', () => {
  it.skipIf(process.getuid === undefined)(
    'uid() is the process’s own; the login is named by it; there is no login home',
    () => {
      const probes = systemProbes();
      const uid = process.getuid!();
      // (a) red when the uid falls back to -1 (every store then reads as another user's), the login is
      //     unnamed, or the login home falls back to HOME; (b) prints the three.
      expect({ uid: probes.uid(), login: probes.login(), home: probes.loginHome() }).toEqual({
        uid,
        login: `uid ${uid}`,
        home: undefined,
      });
    },
  );
});
