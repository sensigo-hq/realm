// separation/index.ts — #790 (01b #10): the ways from this login to Realm's service user, each read
// without acting (D1). `measureSeparation` calls it for condition 2; the live cell and the Mac walk
// call it directly, since `measureSeparation` takes no service user.
import type { SwitchPathReading } from '@sensigo/realm';
import { readDoas } from './doas.js';
import { lookups, type SwitchProbes } from './lookup.js';
import { readPolkit } from './polkit.js';
import { readSsh } from './ssh.js';
import { readSu } from './su.js';
import { readSudo } from './sudo.js';

export { rootEngineReach, ROOT_GROUPS } from './engines.js';
export { lookups, SYSTEM_DIRS, type SwitchProbes } from './lookup.js';
export { systemRunner, railOne, type Runner, type RunResult } from './runner.js';
// #819 (08, B Outside 5): where the no-way line also looked — polkitd's paths, ssh's unit folders.
export { POLKITD } from './polkit.js';
export { UNIT_DIRS } from './ssh.js';

/**
 * Reads every way from this login to `svc` (D13's paths): root, sudo, su, doas, polkit and ssh, in
 * that order; a way absent from this host is not listed. `svc` is the store owner's raw user name
 * (rail 5), or `uid <n>` when the owner has no name — then it is looked up by its uid.
 */
export async function measureSwitchPaths(args: {
  probes: SwitchProbes;
  svc: string;
}): Promise<SwitchPathReading[]> {
  const { probes } = args;
  const uid = probes.uid();
  if (uid === 0) return [{ path: 'root', outcome: 'yes', how: "this process's uid is 0" }];
  if (uid === undefined) {
    return [
      {
        path: 'root',
        outcome: 'unknown',
        how: "this process's uid",
        cause: "this login's uid could not be read",
      },
    ];
  }
  const byUid = /^uid (\d+)$/.exec(args.svc)?.[1];
  const lk = lookups(probes, args.svc);
  const svc = await lk.passwd(byUid ?? args.svc);
  if (byUid !== undefined && 'found' in svc) lk.svc = svc.found.name;
  const root = await lk.passwd('root');
  return [
    ...(await readSudo(lk, svc, root)),
    ...(await readSu(lk, svc)),
    ...(await readDoas(lk)),
    ...(await readPolkit(lk)),
    ...readSsh(lk),
  ];
}
