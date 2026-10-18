// polkit.ts — #790 (D9, 01b #5): polkit asked in its check mode with no interaction
// (`pkcheck --action-id <A> --process <pid>`, never `--allow-user-interaction`), for the actions that
// become another user: pkexec, run0 and `systemd-run --uid` (manage-units), machinectl's shells, and
// every program pkexec runs by annotation. polkit decides by session, and the check's session may not
// be the agent's (the session rule): each action's readable defaults count too, the most permissive
// winning. polkitd is never run; its presence is a stat.
import type { SwitchPathReading, SwitchOutcome, SwitchWhose } from '@sensigo/realm';
import { mostPermissive } from '@sensigo/realm';
import { join } from 'node:path';
import { findTool, presence, toolLine, type Lookups } from './lookup.js';

const ACTIONS_DIR = '/usr/share/polkit-1/actions';
/** 01b #5: polkitd's install paths (Ubuntu, Debian, Fedora, Alpine: the first; F790-IA rows). */
const POLKITD = [
  '/usr/lib/polkit-1/polkitd',
  '/usr/libexec/polkitd',
  '/usr/lib/policykit-1/polkitd',
] as const;
/** The actions asked by id where their .policy exists (D9). */
const ASKED = new Set([
  'org.freedesktop.policykit.exec',
  'org.freedesktop.systemd1.manage-units',
  'org.freedesktop.machine1.shell',
  'org.freedesktop.machine1.host-shell',
]);
const EXEC_PATH = 'org.freedesktop.policykit.exec.path';

interface Action {
  id: string;
  defaults: string[];
  execPath: boolean;
}

/** One .policy file's actions: id, the three defaults, and whether pkexec runs a program for it. */
function actionsOf(xml: string): Action[] | undefined {
  const blocks = [...xml.matchAll(/<action\s+id="([^"]+)"\s*>([\s\S]*?)<\/action>/g)];
  if (blocks.length !== (xml.match(/<action[\s>]/g) ?? []).length) return undefined;
  return blocks.map((b) => {
    const body = b[2]!;
    const value = (tag: string): string =>
      new RegExp(`<${tag}>\\s*([^<\\s]+)\\s*</${tag}>`).exec(body)?.[1] ?? 'no';
    return {
      id: b[1]!,
      defaults: [value('allow_any'), value('allow_inactive'), value('allow_active')],
      execPath: body.includes(`key="${EXEC_PATH}"`),
    };
  });
}

/** A default's reading: `yes`; `auth_self*` this login's password; `auth_admin*` an administrator's. */
function defaultReading(d: string): { outcome: SwitchOutcome; whose?: SwitchWhose } {
  if (d === 'yes') return { outcome: 'yes' };
  if (d.startsWith('auth_self')) return { outcome: 'needs_credential', whose: 'this_login' };
  if (d.startsWith('auth_admin')) return { outcome: 'needs_credential', whose: 'administrator' };
  return { outcome: d === 'no' ? 'not_allowed' : 'unknown' };
}

/** D9: the polkit path — none when polkit is not on this host (01b #5). */
export async function readPolkit(lk: Lookups): Promise<SwitchPathReading[]> {
  const inFolders = (n: string): boolean => {
    const where = presence(lk.probes, n);
    return where !== undefined && 'system' in where;
  };
  const here =
    ['pkcheck', 'pkexec', 'run0'].some(inFolders) || POLKITD.some((p) => lk.probes.exists(p));
  if (!here) return [];
  const unknown = (how: string, cause: string): SwitchPathReading[] => [
    { path: 'polkit', tool: 'pkcheck', outcome: 'unknown', how, cause },
  ];
  const pkcheck = findTool(lk.probes, 'pkcheck');
  if (pkcheck === undefined)
    return unknown(
      'pkcheck looked for in the system folders',
      'polkit is here, but pkcheck is not',
    );
  if ('unknown' in pkcheck)
    return unknown('pkcheck looked for in the system folders', pkcheck.unknown);
  const names = lk.probes.list(ACTIONS_DIR);
  if (names === undefined) return unknown(`${ACTIONS_DIR} listed`, `${ACTIONS_DIR} cannot be read`);
  const actions: Action[] = [];
  for (const name of names.filter((n) => n.endsWith('.policy')).sort()) {
    const xml = lk.probes.readText(join(ACTIONS_DIR, name));
    const parsed = xml === undefined ? undefined : actionsOf(xml);
    if (parsed === undefined)
      return unknown(`${ACTIONS_DIR} read`, `${join(ACTIONS_DIR, name)} cannot be read`);
    actions.push(...parsed.filter((a) => ASKED.has(a.id) || a.execPath));
  }
  const pid = String(lk.probes.pid());
  const found: { outcome: SwitchOutcome; whose?: SwitchWhose; id: string; cause?: string }[] = [];
  let keep = false;
  for (const a of actions) {
    const argv = [pkcheck.path, '--action-id', a.id, '--process', pid];
    const r = await lk.run(argv);
    const code = 'exit' in r ? r.exit : undefined;
    const fromDefaults = a.defaults.map(defaultReading);
    if (a.defaults.some((d) => d.endsWith('_keep'))) keep = true;
    found.push(...fromDefaults.map((d) => ({ ...d, id: a.id })));
    if (code === 0) found.push({ outcome: 'yes', id: a.id });
    else if (code === 1) found.push({ outcome: 'not_allowed', id: a.id });
    else if (code === 2) {
      // a challenge: whose credential comes from the action's defaults; none of them asks → unknown
      const whose = fromDefaults.flatMap((d) => (d.whose !== undefined ? [d.whose] : []));
      if (whose.length === 0) {
        found.push({
          outcome: 'unknown',
          id: a.id,
          cause: `pkcheck asks a credential for ${a.id}, and its defaults do not say whose`,
        });
      }
    } else {
      found.push({ outcome: 'unknown', id: a.id, cause: `${argv.join(' ')}: ${toolLine(r)}` });
    }
  }
  const how = `${pkcheck.path} --action-id <each> --process ${pid} asked for ${actions.length} actions`;
  const best = mostPermissive(
    found.map((f) => ({ path: 'polkit' as const, outcome: f.outcome, how: '' })),
  );
  if (best === undefined) {
    return [
      {
        path: 'polkit',
        tool: pkcheck.path,
        outcome: 'not_allowed',
        how: `${ACTIONS_DIR} holds none of the actions asked`,
      },
    ];
  }
  if (best === 'yes') {
    const ids = [...new Set(found.filter((f) => f.outcome === 'yes').map((f) => f.id))];
    return [
      {
        path: 'polkit',
        tool: pkcheck.path,
        outcome: 'yes',
        how: `${how}: allowed for ${ids.join(', ')}`,
      },
    ];
  }
  if (best === 'unknown') {
    const causes = [
      ...new Set(
        found.flatMap((f) => (f.outcome === 'unknown' ? [f.cause ?? `${f.id}'s defaults`] : [])),
      ),
    ];
    return unknown(how, causes.join('; '));
  }
  if (best === 'not_allowed')
    return [{ path: 'polkit', tool: pkcheck.path, outcome: 'not_allowed', how }];
  const whose = [
    ...new Set(
      found.flatMap((f) =>
        f.outcome === 'needs_credential' && f.whose !== undefined ? [f.whose] : [],
      ),
    ),
  ];
  return whose.map((w) => ({
    path: 'polkit',
    tool: pkcheck.path,
    outcome: 'needs_credential',
    whose: w,
    ...(keep ? { cache: 'polkit_keep' as const } : {}),
    how,
  }));
}
