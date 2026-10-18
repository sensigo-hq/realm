// sudo.ts — #790 (D2, D3, D4, D5): every sudo present, asked in its listing mode only
// (`LC_ALL=C <sudo> -n -l`, plus `-n -ll` for classic sudo). Never a command, never a password.
// A listing is read for entries whose runas covers Realm's service user or root (any command
// counts); a refusal is read by its words; sudo's PAM stack is scanned whenever sudo needs a
// credential. Anything this reader does not recognise is `unknown`, with sudo's own line (P0).
import type { SwitchPathReading } from '@sensigo/realm';
import { findTools, toolLine, type Found, type Lookups, type PasswdEntry } from './lookup.js';
import { scanPam } from './pam.js';

/** One listed entry: who it runs as (users, groups), whether it needs no password, its commands. */
interface Entry {
  users: string[];
  groups: string[];
  nopasswd: boolean;
  commands: string[];
}

/** A `Defaults!<cmd>` or `Defaults><runas>` line of "Runas and Command-specific defaults". */
interface Specific {
  kind: '!' | '>';
  targets: string[];
  options: string[];
}

interface Listing {
  defaults: string[];
  specific: Specific[];
  entries: Entry[];
}

/** The short format's tags (`NOPASSWD:` …); any other tag is not read. */
const TAGS = new Set([
  'NOPASSWD',
  'PASSWD',
  'NOEXEC',
  'EXEC',
  'SETENV',
  'NOSETENV',
  'LOG_INPUT',
  'NOLOG_INPUT',
  'LOG_OUTPUT',
  'NOLOG_OUTPUT',
  'MAIL',
  'NOMAIL',
  'FOLLOW',
  'NOFOLLOW',
  'INTERCEPT',
  'NOINTERCEPT',
]);
/** The long format's fields; `Options` and the runas fields are read, the rest only restrict. */
const LONG_FIELDS = new Set([
  'RunAsUsers',
  'RunAsGroups',
  'Options',
  'Role',
  'Type',
  'Apparmor_Profile',
  'Privs',
  'Limitprivs',
  'Timeout',
  'NotBefore',
  'NotAfter',
  'Cwd',
  'Chroot',
]);

/** Splits a list on commas outside double quotes, trimmed. */
const commaList = (text: string): string[] => {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    if (ch === ',' && !quoted) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim() !== '') out.push(cur.trim());
  return out.filter((s) => s !== '');
};

/** Reads one listing (either format): its sections, every line recognised — or unknown. Exported
 *  for its cells only. */
export function parseListing(stdout: string): Listing | { unknown: string } {
  const listing: Listing = { defaults: [], specific: [], entries: [] };
  let mode: 'none' | 'defaults' | 'specific' | 'entries' = 'none';
  let header = false;
  let defaultsText = '';
  let entry: (Entry & { long: boolean; inCommands: boolean }) | undefined;
  const close = (): void => {
    if (entry !== undefined) listing.entries.push(entry);
    entry = undefined;
  };
  /** The short format's runas and tag state at the end of its last line: a wrapped line goes on
   *  with both (a line may end on a bare `PASSWD:`). */
  let short: { users: string[]; groups: string[]; nopasswd: boolean } | undefined;
  const unread = (line: string) => ({
    unknown: `sudo listed a line this check does not read: ${line.trim()}`,
  });
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    if (/^Matching Defaults entries for \S+ on \S+:$/.test(line)) {
      mode = 'defaults';
      continue;
    }
    if (/^Runas and Command-specific defaults for \S+:$/.test(line)) {
      mode = 'specific';
      continue;
    }
    if (/^User \S+ may run the following commands on \S+:$/.test(line)) {
      mode = 'entries';
      header = true;
      continue;
    }
    if (mode === 'defaults' && line.startsWith('    ')) {
      defaultsText += ` ${line.trim()}`;
    } else if (mode === 'specific' && /^ {4}Defaults[!>]/.test(line)) {
      const m = /^ {4}Defaults([!>])(\S+)\s+(.+)$/.exec(line);
      if (m === null) return unread(line);
      listing.specific.push({
        kind: m[1] as '!' | '>',
        targets: commaList(m[2]!),
        options: commaList(m[3]!),
      });
    } else if (mode === 'specific' && line.startsWith('        ') && listing.specific.length > 0) {
      listing.specific.at(-1)!.options.push(...commaList(line));
    } else if (mode === 'entries' && /^Sudoers entry:/.test(line)) {
      close();
      entry = {
        users: [],
        groups: [],
        nopasswd: false,
        commands: [],
        long: true,
        inCommands: false,
      };
    } else if (mode === 'entries' && entry?.long === true && line.startsWith('\t')) {
      if (!entry.inCommands) return unread(line);
      entry.commands.push(line.trim());
    } else if (mode === 'entries' && entry?.long === true && /^ {4}Commands:$/.test(line)) {
      entry.inCommands = true;
    } else if (mode === 'entries' && entry?.long === true && /^ {4}\w+: /.test(line)) {
      const [, field, value] = /^ {4}(\w+): (.*)$/.exec(line)!;
      if (!LONG_FIELDS.has(field!)) return unread(line);
      if (field === 'RunAsUsers') entry.users = commaList(value!);
      if (field === 'RunAsGroups') entry.groups = commaList(value!);
      if (field === 'Options') {
        const opts = commaList(value!);
        if (opts.includes('!authenticate')) entry.nopasswd = true;
        if (opts.includes('authenticate')) entry.nopasswd = false;
      }
    } else if (mode === 'entries' && /^ {4}\(/.test(line)) {
      close();
      const m = /^ {4}\(([^)]*)\)\s+(.*)$/.exec(line);
      if (m === null) return unread(line);
      const [usersText, groupsText] = m[1]!.split(' : ');
      short = {
        users: commaList(usersText ?? ''),
        groups: commaList(groupsText ?? ''),
        nopasswd: false,
      };
      const items = shortItems(m[2]!, short);
      if ('unknown' in items) return items;
      listing.entries.push(...items.entries);
    } else if (mode === 'entries' && line.startsWith('        ') && short !== undefined) {
      // a wrapped short line: it continues the line before, its runas and its tag state
      const items = shortItems(line.trim(), short);
      if ('unknown' in items) return items;
      listing.entries.push(...items.entries);
    } else {
      return unread(line);
    }
  }
  close();
  listing.defaults = commaList(defaultsText);
  // P0 (A §F11, A's Held B16): a listing with no rules header, or an entry naming no run-as user
  if (!header) return { unknown: 'sudo listed no rules section' };
  if (listing.entries.some((e) => e.users.length === 0))
    return { unknown: 'sudo listed a rule with no run-as user' };
  return listing;
}

/** The short format's items after `(runas) `: one entry per command, with the tag state in force;
 *  `state` carries the runas and the tag state on to the next wrapped line. */
function shortItems(
  text: string,
  state: { users: string[]; groups: string[]; nopasswd: boolean },
): { entries: Entry[] } | { unknown: string } {
  const entries: Entry[] = [];
  for (let item of text.split(/,\s*/).filter((i) => i !== '')) {
    // sudo-rs writes `CWD=<dir> ` / `APPARMOR_PROFILE=<p> ` … before the tags (A §F3)
    item = item.replace(
      /^(?:(?:APPARMOR_PROFILE|CWD|CHROOT|ROLE|TYPE|TIMEOUT|NOTBEFORE|NOTAFTER|PRIVS|LIMITPRIVS)=\S+\s+)+/,
      '',
    );
    for (
      let m = /^([A-Z][A-Z_]*):\s*/.exec(item);
      m !== null;
      m = /^([A-Z][A-Z_]*):\s*/.exec(item)
    ) {
      if (!TAGS.has(m[1]!))
        return { unknown: `sudo listed a tag this check does not read: ${m[1]}` };
      if (m[1] === 'NOPASSWD') state.nopasswd = true;
      if (m[1] === 'PASSWD') state.nopasswd = false;
      item = item.slice(m[0].length);
    }
    if (/\b[A-Z][A-Z_]*(?::\s|=)/.test(item))
      return { unknown: `sudo listed an option this check does not read: ${item}` };
    if (item !== '') {
      entries.push({
        users: state.users,
        groups: state.groups,
        nopasswd: state.nopasswd,
        commands: [item],
      });
    }
  }
  return { entries };
}

/** Who a runas covers, of Realm's service user and root — or unknown. */
type Covers = { svc: boolean; root: boolean } | { unknown: string };

/** A sudoers alias's shape: upper case (sudo-rs lists runas aliases unexpanded). */
const ALIAS = /^[A-Z][A-Z0-9_]*$/;

/** D3: whether one runas token covers ⟨svc⟩ or root. Negations count as covering (the safe
 *  direction); so does an alias this check cannot expand. */
async function tokenCovers(
  lk: Lookups,
  token: string,
  svc: Found<PasswdEntry>,
  root: Found<PasswdEntry>,
  asGroup: boolean,
): Promise<Covers> {
  if (token === 'ALL' || token.startsWith('!') || (ALIAS.test(token) && token !== lk.svc)) {
    return { svc: true, root: true };
  }
  const users = { svc, root };
  const out = { svc: false, root: false };
  for (const who of ['svc', 'root'] as const) {
    const entry = users[who];
    const name = who === 'svc' ? lk.svc : 'root';
    if (asGroup || token.startsWith('%')) {
      // a group: `%name`, `%#gid`; a bare group in the runas group list
      const group = token.startsWith('%') ? token.slice(1) : token;
      if (!('found' in entry)) {
        if (who === 'root' && (group === 'root' || group === '#0')) out.root = true;
        else if ('unknown' in entry) return { unknown: entry.unknown };
        continue;
      }
      const inGroup = await lk.userIn(entry.found, group);
      if ('unknown' in inGroup) return { unknown: inGroup.unknown };
      if ('found' in inGroup && inGroup.found) out[who] = true;
    } else if (token.startsWith('+')) {
      const net = await lk.netgroupUsers(token.slice(1));
      if ('unknown' in net) return { unknown: net.unknown };
      if ('found' in net && net.found.some((u) => u === '' || u === name)) out[who] = true;
    } else if (token.startsWith('#')) {
      const uid = who === 'root' ? 0 : uidOf(lk, entry);
      if (uid === undefined)
        out[who] = true; // svc's uid is not known: the safe direction
      else out[who] = token === `#${uid}`;
    } else if (token === name) {
      out[who] = true;
    } else if (token !== lk.login) {
      // A §F10: another name may share svc's uid or root's (a `toor`): compared by uid
      const other = await lk.passwd(token);
      if ('unknown' in other) return { unknown: other.unknown };
      const uid = who === 'root' ? 0 : uidOf(lk, entry);
      if ('found' in other && (uid === undefined || other.found.uid === uid)) out[who] = true;
    }
  }
  return out;
}

/** ⟨svc⟩'s uid: from its passwd entry, or from a `uid <n>` service user (A §F10). */
const uidOf = (lk: Lookups, entry: Found<PasswdEntry>): number | undefined =>
  'found' in entry
    ? entry.found.uid
    : ((n) => (n === undefined ? undefined : Number(n)))(/^uid (\d+)$/.exec(lk.svc)?.[1]);

/** Whether an entry covers ⟨svc⟩ or root: by its users, or by a group of ⟨svc⟩'s (review 15). */
async function entryCovers(
  lk: Lookups,
  e: Entry,
  svc: Found<PasswdEntry>,
  root: Found<PasswdEntry>,
): Promise<Covers> {
  const out = { svc: false, root: false };
  for (const [tokens, asGroup] of [
    [e.users, false],
    [e.groups, true],
  ] as const) {
    for (const t of tokens) {
      const c = await tokenCovers(lk, t, svc, root, asGroup);
      if ('unknown' in c) return c;
      out.svc ||= c.svc;
      // a runas group onto root's group does not make the command run as root
      if (!asGroup) out.root ||= c.root;
    }
  }
  return out;
}

/** Where a credential reading is composed: a listing, sudo-rs's refusal (both show a rule exists),
 *  or classic sudo's refusal (which hides whether one does) — F790-CAUD-01. */
type Site = 'listing' | 'rs-refusal' | 'classic-refusal';

/**
 * D5 (as corrected): sudo's PAM stacks — `sudo`, and `sudo-i` where it exists (or the services
 * `pam_service` / `pam_login_service` name) — read whenever sudo needs a credential; the most
 * permissive wins. A grant reads yes where a rule is known to exist and unknown at classic sudo's
 * refusal; a stack with no password and no person module reads unknown (B §1).
 */
async function withPam(
  lk: Lookups,
  base: SwitchPathReading[],
  how: string,
  tool: string,
  site: Site,
  services: { main: string; login: string | undefined } = { main: 'sudo', login: undefined },
): Promise<SwitchPathReading[]> {
  const login = services.login ?? 'sudo-i';
  const names = [services.main];
  if (
    services.login !== undefined ||
    ['/etc/pam.d', '/usr/lib/pam.d'].some((d) => lk.probes.exists(`${d}/${login}`))
  )
    names.push(login);
  const unknown = (cause: string): SwitchPathReading[] => [
    { path: 'sudo', tool, outcome: 'unknown', how, cause },
  ];
  const scans = await Promise.all(names.map((n) => scanPam(lk, n)));
  const files = [...new Set(scans.flatMap((x) => ('files' in x ? x.files : [])))].join(', ');
  const read = `${how}; ${files} read`;
  let worst: SwitchPathReading[] | undefined;
  let person = false;
  for (const scan of scans) {
    if ('unknown' in scan) worst ??= unknown(scan.unknown);
    else if (scan.grant !== undefined) {
      if (site === 'classic-refusal') {
        worst ??= unknown(
          `sudo's PAM stack grants it (${scan.grant}), and sudo does not say whether a rule exists`,
        );
      } else {
        const why = `${read}: ${scan.grant} lets this login through without a password`;
        return [{ path: 'sudo', tool, outcome: 'yes', how: why }];
      }
    } else if (scan.sshAgent) worst ??= unknown("sudo accepts an ssh agent's key");
    else if (!scan.password && !scan.person)
      worst ??= unknown("sudo's PAM stack names no password or person module this check reads");
    else person ||= scan.person;
  }
  if (worst !== undefined) return worst;
  const readings = base.map((r) => ({ ...r, how: `${r.how}; ${files} read` }));
  if (!person) return readings;
  return [
    ...readings,
    { path: 'sudo', tool, outcome: 'needs_credential', whose: 'person', how: read },
  ];
}

/** A §F4: where sudo shows no Defaults, the credential may be this login's, root's or ⟨svc⟩'s. */
function unseenDefaults(r: SwitchPathReading): SwitchPathReading[] {
  const cause = 'sudo does not list its Defaults, so rootpw or targetpw cannot be ruled out';
  const { or_not_allowed: _drop, ...rest } = r;
  return [r, { ...rest, whose: 'root', cause }, { ...rest, whose: 'svc', cause }];
}

/** Stderr lines sudo-rs prints for a sudoers line it ignores: `file:line:col: why`, the line, a caret. */
function withoutRsWarnings(stderr: string): string[] | undefined {
  const lines = stderr.split('\n').filter((l) => l !== '');
  const rest: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\/\S+:\d+:\d+: .+$/.test(lines[i]!)) {
      if (!/^\s*\^~*$/.test(lines[i + 2] ?? '')) return undefined;
      i += 2;
    } else rest.push(lines[i]!);
  }
  return rest;
}

const NNP =
  /^sudo: The "no new privileges" flag is set, which prevents sudo from running as root\.$/;

/** One sudo, read (D3, D4, D5). */
async function readOne(
  lk: Lookups,
  path: string,
  svc: Found<PasswdEntry>,
  root: Found<PasswdEntry>,
  noNewPrivs: boolean,
): Promise<SwitchPathReading[]> {
  const list = `LC_ALL=C ${path} -n -l`;
  const unknown = (how: string, cause: string): SwitchPathReading[] => [
    { path: 'sudo', tool: path, outcome: 'unknown', how, cause },
  ];
  const version = await lk.run([path, '-V']);
  // Classic sudo prints its version on stdout; sudo-rs on stderr (captured, ubuntu-25.10).
  const first =
    'exit' in version && version.exit === 0
      ? (version.stdout !== '' ? version.stdout : version.stderr).split('\n')[0]!
      : undefined;
  const flavour =
    first === undefined
      ? undefined
      : /^Sudo version \S+$/.test(first)
        ? 'classic'
        : /^sudo-rs \S+$/.test(first)
          ? 'rs'
          : undefined;
  if (flavour === undefined) return unknown(`${path} -V`, `${path} -V says: ${toolLine(version)}`);
  const r = await lk.run(['LC_ALL=C', path, '-n', '-l']);
  const outside = 'run the check outside the sandbox: the "no new privileges" flag is set';
  if (!('exit' in r)) return unknown(list, toolLine(r));
  const errLines =
    flavour === 'rs' ? withoutRsWarnings(r.stderr) : r.stderr.split('\n').filter((l) => l !== '');
  if (errLines === undefined) return unknown(list, `${list} says: ${toolLine(r)}`);
  const said = errLines.join(' ').replace(/^sudo(?:-rs)?: /, '');
  if (r.exit !== 0) {
    if (noNewPrivs || NNP.test(errLines[0] ?? '')) return unknown(list, outside);
    if (errLines.length !== 1) return unknown(list, `${list} says: ${toolLine(r)}`);
    if (flavour === 'classic' && said === 'a password is required') {
      // D4: classic sudo asks before it shows a refusal, so a rule may exist or not (clause c)
      const r: SwitchPathReading = {
        path: 'sudo',
        tool: path,
        outcome: 'needs_credential',
        whose: 'this_login',
        cache: 'sudo_timestamp',
        or_not_allowed: true,
        how: `${list} says: a password is required`,
      };
      return withPam(lk, unseenDefaults(r), list, path, 'classic-refusal');
    }
    if (flavour === 'rs' && said === 'interactive authentication is required') {
      const r: SwitchPathReading = {
        path: 'sudo',
        tool: path,
        outcome: 'needs_credential',
        whose: 'this_login',
        cache: 'sudo_timestamp',
        how: `${list} says: interactive authentication is required`,
      };
      return withPam(lk, unseenDefaults(r), list, path, 'rs-refusal');
    }
    if (/^Sorry, user \S+ may not run sudo on \S+\.$/.test(said)) {
      return [{ path: 'sudo', tool: path, outcome: 'not_allowed', how: `${list} says: ${said}` }];
    }
    return unknown(list, `${list} says: ${toolLine(r)}`);
  }
  if (noNewPrivs) return unknown(list, outside);
  if (errLines.length !== 0) return unknown(list, `${list} says: ${toolLine(r)}`);
  // A listing. Classic sudo is read from its long format (D2: `-ll`, wrapped lines unbroken).
  let text = r.stdout;
  let how = list;
  if (flavour === 'classic') {
    const ll = await lk.run(['LC_ALL=C', path, '-n', '-ll']);
    how = `${list} and -n -ll`;
    if (!('exit' in ll) || ll.exit !== 0 || ll.stderr !== '') {
      return unknown(how, `LC_ALL=C ${path} -n -ll says: ${toolLine(ll)}`);
    }
    text = ll.stdout;
  }
  const listing = parseListing(text);
  if ('unknown' in listing) return unknown(how, listing.unknown);
  return judge(lk, path, how, listing, svc, root, flavour);
}

/** D3: a listing's reading. */
async function judge(
  lk: Lookups,
  path: string,
  how: string,
  listing: Listing,
  svc: Found<PasswdEntry>,
  root: Found<PasswdEntry>,
  flavour: 'classic' | 'rs',
): Promise<SwitchPathReading[]> {
  const reading = (r: Omit<SwitchPathReading, 'path' | 'tool'>): SwitchPathReading => ({
    path: 'sudo',
    tool: path,
    ...r,
  });
  const opts = new Set(listing.defaults);
  if (opts.has('!authenticate')) {
    return [
      reading({
        outcome: 'yes',
        how: `${how}: its Defaults turn the password off (!authenticate)`,
      }),
    ];
  }
  const covering: { entry: Entry; svc: boolean; root: boolean }[] = [];
  for (const entry of listing.entries) {
    const c = await entryCovers(lk, entry, svc, root);
    if ('unknown' in c) return [reading({ outcome: 'unknown', how, cause: c.unknown })];
    if (c.svc || c.root) covering.push({ entry, ...c });
  }
  const runsAs = (c: { svc: boolean; root: boolean }) =>
    c.svc && c.root ? `${lk.svc} or root` : c.svc ? lk.svc : 'root';
  const open = covering.find((c) => c.entry.nopasswd);
  if (open !== undefined) {
    return [reading({ outcome: 'yes', how: `${how}: a NOPASSWD rule runs as ${runsAs(open)}` })];
  }
  for (const s of listing.specific) {
    if (!s.options.includes('!authenticate')) continue;
    for (const target of s.targets) {
      let hit: boolean;
      if (s.kind === '>') {
        const c = await tokenCovers(lk, target, svc, root, false);
        if ('unknown' in c) return [reading({ outcome: 'unknown', how, cause: c.unknown })];
        hit = c.svc || c.root;
      } else {
        // A §F2: a command, an alias, a folder or a glob counts, unless both are plain paths that
        // differ as strings and by their real files
        const plain = (p: string): boolean => /^\/[^\s*?[\]]*[^\s*?[\]/]$/.test(p);
        const rp = (p: string): string | undefined => lk.probes.realPath(p);
        const differs = (cmd: string): boolean =>
          plain(cmd) &&
          plain(target) &&
          cmd !== target &&
          rp(cmd) !== undefined &&
          rp(target) !== undefined &&
          rp(cmd) !== rp(target);
        hit = covering.some((c) => c.entry.commands.some((cmd) => !differs(cmd)));
      }
      if (hit) {
        return [
          reading({
            outcome: 'yes',
            how: `${how}: Defaults${s.kind}${target} !authenticate covers a rule`,
          }),
        ];
      }
    }
  }
  // D3 reads the entries that run as ⟨svc⟩ or root: with none, the listing names no way, whatever
  // let it be shown.
  if (covering.length === 0) {
    return [reading({ outcome: 'not_allowed', how: `${how}: no rule runs as ${lk.svc} or root` })];
  }
  const exempt = listing.defaults.find((o) => o.startsWith('exempt_group='));
  if (exempt !== undefined) {
    const m = await lk.loginIn(exempt.slice('exempt_group='.length));
    if (!('found' in m) || m.found)
      return [
        reading({ outcome: 'yes', how: `${how}: Defaults ${exempt}, and this login may be in it` }),
      ];
  }
  if (opts.has('listpw=all') && listing.entries.some((e) => !e.nopasswd)) {
    // A §F8: listpw=all asks a password unless every rule is NOPASSWD — it was waived somehow
    return [
      reading({
        outcome: 'yes',
        how: `${how}: listed under listpw=all although a rule needs a password`,
      }),
    ];
  }
  if (listing.entries.every((e) => !e.nopasswd)) {
    // D3 (review 19): listed although no rule waives the password — a cache, exempt_group,
    // listpw=never: the cause is not known, and a cached credential lets the agent through
    return [
      reading({
        outcome: 'yes',
        how: `${how}: the rules were listed without a password (the cause is not known)`,
      }),
    ];
  }
  const runasDefault = listing.defaults
    .find((o) => o.startsWith('runas_default='))
    ?.slice('runas_default='.length);
  const cache = listing.defaults.some((o) => /^timestamp_timeout=0(?:\.0*)?$/.test(o))
    ? {}
    : { cache: 'sudo_timestamp' as const };
  const why = `${how}: a rule runs as ${runsAs({ svc: covering.some((c) => c.svc), root: covering.some((c) => c.root) })} with a password`;
  let base: SwitchPathReading[];
  if (opts.has('rootpw')) {
    base = [
      reading({
        outcome: 'needs_credential',
        whose: 'root',
        ...cache,
        how: `${why} (Defaults rootpw)`,
      }),
    ];
  } else if (opts.has('targetpw')) {
    base = [
      ...(covering.some((c) => c.svc)
        ? [
            reading({
              outcome: 'needs_credential',
              whose: 'svc',
              ...cache,
              how: `${why} (Defaults targetpw)`,
            }),
          ]
        : []),
      ...(covering.some((c) => c.root)
        ? [
            reading({
              outcome: 'needs_credential',
              whose: 'root',
              ...cache,
              how: `${why} (Defaults targetpw)`,
            }),
          ]
        : []),
    ];
  } else if (opts.has('runaspw')) {
    if (runasDefault !== undefined && runasDefault !== 'root' && runasDefault !== lk.svc) {
      return [
        reading({
          outcome: 'unknown',
          how,
          cause: `sudo asks for ${runasDefault}'s password (Defaults runaspw)`,
        }),
      ];
    }
    base = [
      reading({
        outcome: 'needs_credential',
        whose: runasDefault === lk.svc ? 'svc' : 'root',
        ...cache,
        how: `${why} (Defaults runaspw)`,
      }),
    ];
  } else {
    const r = reading({ outcome: 'needs_credential', whose: 'this_login', ...cache, how: why });
    base = flavour === 'rs' ? unseenDefaults(r) : [r];
  }
  const option = (k: string) =>
    listing.defaults.find((o) => o.startsWith(`${k}=`))?.slice(k.length + 1);
  const services = { main: option('pam_service') ?? 'sudo', login: option('pam_login_service') };
  return withPam(lk, base, how, path, 'listing', services);
}

/** D2: every sudo present (`sudo`, `sudo.ws`, `sudo-rs`) — every root-owned copy in D2's folders,
 *  each real file asked once (A §F14). */
export async function readSudo(
  lk: Lookups,
  svc: Found<PasswdEntry>,
  root: Found<PasswdEntry>,
): Promise<SwitchPathReading[]> {
  const status = lk.probes.readText('/proc/self/status');
  const noNewPrivs = status !== undefined && /^NoNewPrivs:\s*1$/m.test(status);
  const readings: SwitchPathReading[] = [];
  const seen = new Set<string>();
  for (const name of ['sudo', 'sudo.ws', 'sudo-rs']) {
    const found = findTools(lk.probes, name);
    for (const cause of found.unknown) {
      const how = `${name} looked for in the system folders`;
      readings.push({ path: 'sudo', tool: name, outcome: 'unknown', how, cause });
    }
    for (const path of found.paths) {
      const real = lk.probes.realPath(path) ?? path;
      if (seen.has(real)) continue;
      seen.add(real);
      readings.push(...(await readOne(lk, path, svc, root, noNewPrivs)));
    }
  }
  return readings;
}
