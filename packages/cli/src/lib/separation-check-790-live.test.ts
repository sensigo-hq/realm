// separation-check-790-live.test.ts — #790 (02, D2 §3): the one live cell. It reads the switch paths
// of THIS host through the real probes and the real runner, which refuses any argv that is not one of
// rail 1's read-only calls (S3). Skipped unless REALM_LIVE_SEPARATION=1: CI does not run it (04 item
// 8), and no red-first run sets it, so no break reaches a real tool. Its readings go only to the
// local log REALM_LIVE_SEPARATION_LOG names (under reports/, never committed).
//
// D2 §3's expectations are hypotheses (guardrail 4), for a host like the one D2 measured: classic
// sudo that refuses this login's listing, a `daemon` user whose shell is nologin, and polkitd with
// pkcheck. Each assertion carries (a) the change that turns it red and (b) what it prints: readings
// and outcomes.
import { describe, expect, it } from 'vitest';
import { appendFileSync } from 'node:fs';
import { switchClausesOf, type SwitchPathReading } from '@sensigo/realm';
import { measureSwitchPaths, railOne } from './separation/index.js';
import { systemProbes } from './separation-check.js';

const LIVE = process.env['REALM_LIVE_SEPARATION'] === '1';
const view = (r: SwitchPathReading): string =>
  [r.path, r.outcome, r.whose, r.cache, r.or_not_allowed === true ? 'or not allowed' : undefined]
    .filter((x) => x !== undefined)
    .join(' ');

describe.skipIf(!LIVE)('#790 — the live cell on this host (D2 §3)', () => {
  it('measureSwitchPaths({ probes: systemProbes(), svc: "daemon" }) reads only through rail 1, and reads D2 §3', async () => {
    const real = systemProbes();
    const argvs: string[][] = [];
    const probes = {
      ...real,
      run: (argv: readonly string[]) => {
        argvs.push([...argv]);
        return real.run(argv);
      },
    };
    const rs = await measureSwitchPaths({ probes, svc: 'daemon' });
    const clauses = switchClausesOf(rs).map((c) => (c.clause === 'a' ? `a:${c.whose}` : c.clause));
    const log = process.env['REALM_LIVE_SEPARATION_LOG'];
    if (log !== undefined && log !== '') {
      const record = { readings: rs, clauses, calls: argvs.map((a) => a.join(' ')) };
      appendFileSync(log, `${JSON.stringify(record, null, 2)}\n`);
    }
    const sudo = rs.filter((r) => r.path === 'sudo').map(view);
    const su = rs.filter((r) => r.path === 'su').map(view);
    const polkit = rs.filter((r) => r.path === 'polkit');
    // (a) red when a reader asks anything outside rail 1, or the runner refuses a reader's call
    //     (a reading then says so); (b) prints the argv and the causes.
    expect({
      offRail: argvs.filter((a) => !railOne(a)).map((a) => a.join(' ')),
      refused: rs.filter((r) => r.cause?.includes('the check refused to run') === true).map(view),
    }).toEqual({ offRail: [], refused: [] });
    // Every reading's how names a rail-1 call or a plain read (R14).
    const how =
      /^(?:LC_ALL=C \/\S+ -n -l|\/\S+ -V|\/\S+ --action-id |\/\S+ -C |getent passwd |\/\S+(?:, \/\S+)* read|\/etc\/doas\.conf|\S+ looked for in the system folders|su's PAM stacks read|an sshd is present|this process's uid)/;
    // (a) red when a reading's how names no call it came from; (b) prints the hows that do not.
    expect(rs.filter((r) => !how.test(r.how)).map((r) => r.how)).toEqual([]);
    // D2 §3. (a) red when the su reader ignores daemon's no-command shell (02's named red: "needs
    //     daemon's password"), sudo's refusal loses (b) or (c), or polkit reads otherwise; (b)
    //     prints the readings and clauses.
    expect({
      sudo,
      su,
      polkit: polkit.every(
        (r) =>
          r.outcome === 'unknown' ||
          (r.outcome === 'needs_credential' && r.cache === 'polkit_keep'),
      ),
      polkitRead: polkit.length > 0,
      clauses: ['b', 'c', 'd'].filter((c) => clauses.includes(c)),
    }).toEqual({
      sudo: ['sudo needs_credential this_login sudo_timestamp or not allowed'],
      su: ['su not_allowed'],
      polkit: true,
      polkitRead: true,
      clauses: ['b', 'c', 'd'],
    });
  });
});
