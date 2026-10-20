// sudo.ts — #790 (D2, D3, D4, D5): every sudo present, asked in its listing mode only
// (`LC_ALL=C <sudo> -n -l`, plus `-n -ll` for classic sudo). Never a command, never a password.
// A listing is read for entries whose runas covers Realm's service user or root (any command
// counts); a refusal is read by its words; sudo's PAM stack is scanned whenever sudo needs a
// credential. Anything this reader does not recognise is `unknown`, with sudo's own line (P0).
// #819 correction 1 (SEP-00): every item of every list it reads — the Defaults, the `Defaults!…` and
// `Defaults>…` lines, the long format's `Options:` — is acted on, known harmless (by name, with its
// reason), or not read; an item not read makes every reading short of yes `unknown`.
import type { SwitchPathReading } from '@sensigo/realm';
import {
  findTools,
  lookedFor,
  numericId,
  toolLine,
  type Found,
  type Lookups,
  type PasswdEntry,
} from './lookup.js';
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
  /** Every value of the long format's `Options:` fields, in order (#819 correction 1). */
  options: string[];
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

/** #819 correction 1 (SEP-00): the keyword of a Defaults item as sudo prints it — `var`, `!var`,
 *  `var=value`, `var+=value`, `var-=value` (fmtsudoers.c, AUD-10). Exported for its cells only. */
export function defaultsKeyword(item: string): string {
  let k = item;
  if (k.startsWith('!')) k = k.slice(1);
  k = k.replace(/[+-]=[\s\S]*$/, '');
  k = k.replace(/=[\s\S]*$/, '');
  return k;
}

/** The global Defaults keywords this reader acts on (SEP-00): who must authenticate, whose password,
 *  which PAM stacks, the cache, the run-as default, and how run-as names are matched. */
const GLOBAL_ACTED = new Set([
  'authenticate',
  'exempt_group',
  'listpw',
  'runas_default',
  'timestamp_timeout',
  'rootpw',
  'runaspw',
  'targetpw',
  'pam_service',
  'pam_login_service',
  'pam_askpass_service',
  'case_insensitive_user',
  'case_insensitive_group',
  // #819 follow-up 2 (member 3, the audit's S3): how a run-as and the exempt group are matched —
  // by gid (exactly) when set, by name in any case when not; listed twice, it reads unknown
  'match_group_by_gid',
]);

/**
 * #819 correction 1 (SEP-00): the Defaults keywords that cannot change who can become whom without
 * a credential — sudoers(5) at 1.9.15p5, grouped by its types, each with its reason (the sweep's
 * table B1, as the audit corrected it). Not here, so `unknown`: `timestampdir` and `timestampowner`
 * (the folder and owner sudo trusts for tickets), `group_plugin` (a run-as `%group` resolved where
 * getent cannot see), `timestamp_type` but `tty`/`ppid` and `!tty_tickets` (one ticket for every
 * session), and any keyword newer than that man page.
 */
const HARMLESS = new Set([
  // boolean (76)
  'always_query_group_plugin', // invoker group matching; the listing already shows what matched
  'always_set_home', // environment of the run command
  'closefrom_override', // file descriptors
  'compress_io', // I/O log
  'exec_background', // how the command is started
  'env_editor', // sudoedit editor choice
  'env_reset', // environment of the run command
  'fast_glob', // command wildcard matching; any command counts for the reading
  'log_passwords', // I/O logging
  'fqdn', // host matching; the listing is already per host
  'ignore_audit_errors', // logging
  'ignore_dot', // PATH search
  'ignore_iolog_errors', // logging
  'ignore_logfile_errors', // logging
  'ignore_local_sudoers', // which sudoers source applies; the listing shows the result
  'ignore_unknown_defaults', // parse diagnostics
  'insults', // prompt text
  'log_allowed', // logging
  'log_denied', // logging
  'log_exit_status', // logging
  'log_host', // logging
  'log_input', // I/O logging
  'log_output', // I/O logging
  'log_server_keepalive', // log server
  'log_server_verify', // log server
  'log_stderr', // I/O logging
  'log_stdin', // I/O logging
  'log_stdout', // I/O logging
  'log_subcmds', // logging
  'log_ttyin', // I/O logging
  'log_ttyout', // I/O logging
  'log_year', // logging
  'long_otp_prompt', // prompt text
  'mail_all_cmnds', // mail
  'mail_always', // mail
  'mail_badpass', // mail
  'mail_no_host', // mail
  'mail_no_perms', // mail
  'mail_no_user', // mail
  'intercept', // policy on sub-commands after the command runs
  'intercept_allow_setid', // same
  'intercept_authenticate', // asks MORE authentication, never less
  'intercept_verify', // same family
  'netgroup_tuple', // netgroup triple matching; the check takes the user field of every triple (over-covers)
  'noexec', // restricts what the command may exec
  'noninteractive_auth', // the PAM stack is read either way; when listed, the reading says the check's own -n ran it (#819 follow-up 2, A MINOR 3)
  'pam_acct_mgmt', // account phase on/off; the scanner skips account lines; the phase only adds restrictions
  'pam_rhost', // PAM items set for logging; no admitted module grants by them
  'pam_ruser', // PAM items set for logging; no admitted module grants by them
  'pam_session', // session and credential phases
  'pam_setcred', // session and credential phases
  'passprompt_override', // prompt text
  'path_info', // error text
  'preserve_groups', // group vector of the run command
  'pwfeedback', // prompt echo
  'requiretty', // a restriction
  'root_sudo', // a restriction on root
  'runas_allow_unknown_id', // lets #uid outside passwd match; the check compares #uid numerically and ALL already covers
  'runas_check_shell', // a restriction (target's shell must be listed)
  'selinux', // security context of the command
  'set_home', // environment / utmp of the run command
  'set_logname', // environment / utmp of the run command
  'set_utmp', // environment / utmp of the run command
  'setenv', // environment
  'shell_noargs', // which command runs with no arguments; any command counts
  'stay_setuid', // sudo's own uids
  'sudoedit_checkdir', // sudoedit file handling
  'sudoedit_follow', // sudoedit file handling
  'syslog_pid', // logging
  'umask_override', // umask of the command
  'use_netgroups', // user/host matching; the listing shows the result; runas +netgroup is expanded by the check
  'use_pty', // terminal handling
  'user_command_timeouts', // time limits
  'utmp_runas', // environment / utmp of the run command
  'visiblepw', // prompt echo (!visiblepw is Fedora's stock)
  // integer (9)
  'closefrom', // file descriptors
  'command_timeout', // time limit
  'log_server_timeout', // log server
  'maxseq', // I/O log sequence
  'passwd_tries', // number of tries; fewer tries is a restriction
  'syslog_maxlen', // logging
  'loglinelen', // logging
  'passwd_timeout', // prompt time limit
  'umask', // umask of the command
  // string (51)
  'apparmor_profile', // confinement of the command
  'authfail_message', // message text
  'badpass_message', // message text
  'editor', // sudoedit
  'intercept_type', // intercept mechanism
  'iolog_dir', // I/O log storage
  'iolog_file', // I/O log storage
  'iolog_flush', // I/O log storage
  'iolog_group', // I/O log storage
  'iolog_mode', // I/O log storage
  'iolog_user', // I/O log storage
  'lecture_status_dir', // lecture state
  'log_server_cabundle', // log server TLS
  'log_server_peer_cert', // log server TLS
  'log_server_peer_key', // log server TLS
  'mailsub', // mail
  'noexec_file', // noexec library
  'passprompt', // prompt text
  'role', // SELinux context
  'sudoers_locale', // parse locale
  'type', // SELinux context
  'admin_flag', // a marker file
  'env_file', // environment
  'fdexec', // how the command is executed
  'lecture', // lecture text
  'lecture_file', // lecture text
  'log_format', // logging
  'logfile', // logging
  'mailerflags', // mail
  'mailerpath', // mail
  'mailfrom', // mail
  'mailto', // mail
  'rlimit_as', // resource limits of the command
  'rlimit_core', // resource limits of the command
  'rlimit_cpu', // resource limits of the command
  'rlimit_data', // resource limits of the command
  'rlimit_fsize', // resource limits of the command
  'rlimit_locks', // resource limits of the command
  'rlimit_memlock', // resource limits of the command
  'rlimit_nofile', // resource limits of the command
  'rlimit_nproc', // resource limits of the command
  'rlimit_rss', // resource limits of the command
  'rlimit_stack', // resource limits of the command
  'restricted_env_file', // environment
  'runchroot', // where the command runs
  'runcwd', // where the command runs
  'secure_path', // PATH of the command
  'syslog', // logging
  'syslog_badpri', // logging
  'syslog_goodpri', // logging
  'verifypw', // governs -v only; with authentication off, -v opens no time stamp (AUD-17)
  // list (5)
  'env_check', // environment of the command
  'env_delete', // environment of the command
  'env_keep', // environment of the command
  'log_servers', // a log destination (AUD-07)
  'passprompt_regex', // a prompt pattern (AUD-07)
]);

/** The long format's `Options:` names sudo prints for the tags (display.c, AUD-09): each restricts
 *  or logs what the command does, never who may run it. */
const OPTIONS_HARMLESS = new Set(
  ['setenv', 'noexec', 'intercept', 'log_input', 'log_output'].flatMap((n) => [n, `!${n}`]),
);

/** What one Defaults item is to this reader: acted on, harmless, or not read. */
type Kind = 'acted' | 'harmless' | 'unread';

/** (d): the ticket's scope — `tty` and `ppid` keep one ticket per terminal or parent (harmless);
 *  `global`, `kernel` or `!tty_tickets` one for every session of the login (not read). */
function ticketKind(item: string, k: string): Kind | undefined {
  if (k === 'timestamp_type')
    return /^timestamp_type=(?:tty|ppid)$/.test(item) ? 'harmless' : 'unread';
  if (k === 'tty_tickets') return item === 'tty_tickets' ? 'harmless' : 'unread';
  return undefined;
}

/** A global Defaults item's kind. (e): `!case_insensitive_*` is acted on; the positive forms state
 *  sudo's default. */
function globalKind(item: string): Kind {
  const k = defaultsKeyword(item);
  const ticket = ticketKind(item, k);
  if (ticket !== undefined) return ticket;
  if (k === 'case_insensitive_user' || k === 'case_insensitive_group')
    return item.startsWith('!') ? 'acted' : 'harmless';
  if (GLOBAL_ACTED.has(k)) return 'acted';
  return HARMLESS.has(k) ? 'harmless' : 'unread';
}

/** A `Defaults!…`/`Defaults>…` item's kind: `!authenticate` and `timestamp_timeout` are acted on;
 *  `authenticate` restores the password and `listpw` changes no credential; a credential keyword
 *  here — which the global reading never sees — is not read. */
function specificKind(item: string): Kind {
  const k = defaultsKeyword(item);
  if (item === '!authenticate' || k === 'timestamp_timeout') return 'acted';
  if (item === 'authenticate' || k === 'listpw') return 'harmless';
  const ticket = ticketKind(item, k);
  if (ticket !== undefined) return ticket;
  return HARMLESS.has(k) ? 'harmless' : 'unread';
}

/** #819 follow-up 2 (A MINOR 1): a ticket setting the check reads by its value, and refuses, is one it
 *  "does not accept"; any other unread item is one it "does not read". */
const notReadVerb = (item: string): 'accept' | 'read' =>
  ticketKind(item, defaultsKeyword(item)) === 'unread' ? 'accept' : 'read';

/** (b): `timestamp_timeout=0`, the value that keeps no ticket. */
const ZERO_TIMEOUT = /^timestamp_timeout=0(?:\.0*)?$/;

/** The first item of `listing` this reader does not read, as its cause (P0) — or none. (a): an
 *  acted-on keyword listed with different forms or values is not read either: sudo applies the
 *  last matching entry, and the listing does not show which that is (AUD-11). */
function unreadItem(listing: Listing): string | undefined {
  const global = listing.defaults.find((i) => globalKind(i) === 'unread');
  if (global !== undefined)
    return `sudo listed a Defaults setting this check does not ${notReadVerb(global)}: ${global}`;
  const forms = new Map<string, string[]>();
  for (const item of listing.defaults) {
    const k = defaultsKeyword(item);
    if (!GLOBAL_ACTED.has(k)) continue;
    const seen = forms.get(k) ?? [];
    if (!seen.includes(item)) seen.push(item);
    forms.set(k, seen);
  }
  const repeated = [...forms.values()].find((items) => items.length > 1);
  if (repeated !== undefined)
    return `sudo listed a Defaults setting more than once, and does not show which one it applies: ${repeated.join(', ')}`;
  for (const s of listing.specific) {
    const item = s.options.find((o) => specificKind(o) === 'unread');
    if (item !== undefined)
      return `sudo listed a Defaults setting this check does not ${notReadVerb(item)}: Defaults${s.kind}${s.targets.join(',')} ${item}`;
  }
  const option = listing.options.find(
    (o) => o !== 'authenticate' && o !== '!authenticate' && !OPTIONS_HARMLESS.has(o),
  );
  if (option !== undefined)
    return `sudo listed an Options value this check does not read: ${option}`;
  return undefined;
}

/** Splits a list on commas outside double quotes, trimmed. #819 follow-up 2 (member 6, A S4): a
 *  backslash escapes the next character, as sudo prints it (SUDOERS_QUOTED: `mailto=root\,ops@…`) —
 *  it only changes where the list splits; each item keeps the text sudo printed. */
const commaList = (text: string): string[] => {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let escaped = false;
  for (const ch of text) {
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      cur += ch;
      escaped = true;
      continue;
    }
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
  const listing: Listing = { defaults: [], specific: [], entries: [], options: [] };
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
        listing.options.push(...opts);
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
    // #819 (08, A F5): only the item's head — before its command's first `/` — can hold an option
    // sudo writes; `FOO=1` among a command's arguments is the command's
    const head = item.includes('/') ? item.slice(0, item.indexOf('/')) : item;
    if (/\b[A-Z][A-Z_]*(?::\s|=)/.test(head))
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

/** Who a runas covers, of Realm's service user and root — or unknown. `listed`: the token does not
 *  cover ⟨svc⟩, and that rested on a group's listed members (clause (g), #819 correction 1). */
type Covers = { svc: boolean; root: boolean; listed?: true } | { unknown: string };

/** (e): how sudo matches run-as names — case-insensitively unless `!case_insensitive_user` /
 *  `!case_insensitive_group` is listed (sudo's default, defaults.c; AUD-16). #819 follow-up 2
 *  (member 3, A S2): `group` is false under `match_group_by_gid`, where sudo looks the group up by
 *  name (`getgrnam`, exact) and compares gids (pwutil.c:1172-1193). */
interface NameMatch {
  user: boolean;
  group: boolean;
}

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
  ci: NameMatch,
): Promise<Covers> {
  if (token === 'ALL' || token.startsWith('!') || (ALIAS.test(token) && token !== lk.svc)) {
    return { svc: true, root: true };
  }
  const users = { svc, root };
  const out = { svc: false, root: false };
  // #819 (08, A Outside 2): a group whose members may be hidden reads unknown — and a cover already
  // read outranks it (yes > unknown, 01b #6). A runas GROUP never makes the command run as root
  // (`entryCovers`), so root is not judged for one.
  let unread: string | undefined;
  let listed = false;
  const same = (a: string, b: string): boolean =>
    ci.user ? a.toLowerCase() === b.toLowerCase() : a === b;
  for (const who of asGroup ? (['svc'] as const) : (['svc', 'root'] as const)) {
    const entry = users[who];
    const name = who === 'svc' ? lk.svc : 'root';
    if (asGroup || token.startsWith('%')) {
      // a group: `%name`, `%#gid`; a bare group in the runas group list
      const group = token.startsWith('%') ? token.slice(1) : token;
      if (!('found' in entry)) {
        // #819 follow-up 2 (member 5): `%#0` as sudo reads it, a number (`%#00` too)
        if (who === 'root' && (group === 'root' || numericId(group) === 0)) out.root = true;
        else if ('unknown' in entry) return { unknown: entry.unknown };
        continue;
      }
      // #819 correction 1 (e): sudo matches a group name in any case unless told otherwise, and
      // getent only exactly — a name it finds no group for may name one of another case
      const anyCase = ci.group && !lk.darwin && !group.startsWith('#');
      if (anyCase && who === 'svc') {
        // #819 follow-up 2 (member 3, the audit's S2): svc's primary group, named by its gid
        // (`getent group <gid>`, rail 1's call), matched in any case as sudo matches it
        const primary = await lk.group(String(entry.found.gid));
        if ('found' in primary && primary.found.name.toLowerCase() === group.toLowerCase()) {
          out[who] = true;
          continue;
        }
        if ('unknown' in primary) unread ??= primary.unknown;
      }
      const exact = anyCase ? await lk.group(group) : undefined;
      if (exact !== undefined && 'absent' in exact) {
        unread ??= `getent group ${group} finds no group of that name, and sudo matches group names in any case (case_insensitive_group, on by default)`;
        continue;
      }
      const inGroup = await lk.userIn(entry.found, group);
      if ('unknown' in inGroup) unread ??= inGroup.unknown;
      else if ('found' in inGroup && inGroup.found) out[who] = true;
      // #819 follow-up 2 (member 3, A B3): a name of another case than its lower one may name, for
      // sudo, a group of another case that getent's exact answer is not — unknown unless it covers
      else if (anyCase && group !== group.toLowerCase())
        unread ??= `getent group ${group} reads only the group of that exact case, and sudo matches group names in any case (case_insensitive_group, on by default)`;
      else if (who === 'svc' && 'listed' in inGroup) listed = true;
    } else if (token.startsWith('+')) {
      const net = await lk.netgroupUsers(token.slice(1));
      if ('unknown' in net) return { unknown: net.unknown };
      if ('found' in net && net.found.some((u) => u === '' || u === name)) out[who] = true;
    } else if (token.startsWith('#')) {
      const uid = who === 'root' ? 0 : uidOf(lk, entry);
      // #819 follow-up 2 (member 5, A Q3's P1): `#0999` is the uid 999, as sudo reads it
      const id = numericId(token);
      if (uid === undefined || id === 'negative')
        out[who] = true; // svc's uid is not known, or a negative id: the safe direction
      else out[who] = id === uid;
    } else if (same(token, name)) {
      out[who] = true;
    } else if (token !== lk.login) {
      // A §F10: another name may share svc's uid or root's (a `toor`): compared by uid
      const other = await lk.passwd(token);
      if ('unknown' in other) return { unknown: other.unknown };
      const uid = who === 'root' ? 0 : uidOf(lk, entry);
      if ('found' in other && (uid === undefined || other.found.uid === uid)) out[who] = true;
    }
  }
  // #819 correction 1 (A MINOR 1): a cover read for root never drops ⟨svc⟩'s unknown
  if (unread !== undefined && !out.svc) return { unknown: unread };
  return listed && !out.svc ? { ...out, listed: true } : out;
}

/**
 * Whether this login is in sudo's `exempt_group`. #819 follow-up 2 (member 4, the audit's S4 text;
 * #838 row 1): for `exempt_group` only — `loginIn` (which `pam_wheel` and doas also use, both
 * matching exactly) first; then this process's groups, each named by `getent group <gid>` and
 * compared as sudo compares them: in any case under `case_insensitive_group` without
 * `match_group_by_gid`, exactly otherwise (`user_in_group`, pwutil.c:1172-1193, via `user_is_exempt`,
 * check.c:321). A gid getent cannot name reads unknown. An exact reading: no host flips to unknown.
 */
async function exemptIn(lk: Lookups, name: string, ci: NameMatch): Promise<Found<boolean>> {
  const byName = await lk.loginIn(name);
  if (!('found' in byName) || byName.found) return byName;
  const gids = lk.probes.groups();
  if (gids === undefined) return { unknown: "this process's groups could not be read" };
  const same = (a: string): boolean =>
    ci.group ? a.toLowerCase() === name.toLowerCase() : a === name;
  let unnamed: string | undefined;
  for (const gid of [...new Set(gids)]) {
    const g = await lk.group(String(gid));
    if ('found' in g) {
      if (same(g.found.name)) return { found: true };
    } else unnamed ??= 'unknown' in g ? g.unknown : `getent group ${gid} names no group`;
  }
  return unnamed !== undefined ? { unknown: unnamed } : { found: false };
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
  ci: NameMatch,
): Promise<Covers> {
  const out: { svc: boolean; root: boolean; listed?: true } = { svc: false, root: false };
  for (const [tokens, asGroup] of [
    [e.users, false],
    [e.groups, true],
  ] as const) {
    for (const t of tokens) {
      const c = await tokenCovers(lk, t, svc, root, asGroup, ci);
      if ('unknown' in c) return c;
      out.svc ||= c.svc;
      // a runas group onto root's group does not make the command run as root
      if (!asGroup) out.root ||= c.root;
      if (c.listed === true) out.listed = true;
    }
  }
  return out.svc ? { svc: out.svc, root: out.root } : out;
}

/** Where a credential reading is composed: a listing, sudo-rs's refusal (both show a rule exists),
 *  or classic sudo's refusal (which hides whether one does) — F790-CAUD-01. */
type Site = 'listing' | 'rs-refusal' | 'classic-refusal';

/**
 * D5 (as corrected): sudo's PAM stacks — `sudo`, and `sudo-i` where it exists (or the services
 * `pam_service` / `pam_login_service` name), and the stack `pam_askpass_service` names (#819
 * correction 1) — read whenever sudo needs a credential; the most
 * permissive wins. A grant reads yes where a rule is known to exist and unknown at classic sudo's
 * refusal; a stack with no password and no person module reads unknown (B §1).
 */
async function withPam(
  lk: Lookups,
  base: SwitchPathReading[],
  how: string,
  tool: string,
  site: Site,
  services: { main: string; login: string | undefined; askpass?: string } = {
    main: 'sudo',
    login: undefined,
  },
): Promise<SwitchPathReading[]> {
  const login = services.login ?? 'sudo-i';
  const names = [services.main];
  if (
    services.login !== undefined ||
    ['/etc/pam.d', '/usr/lib/pam.d'].some((d) => lk.probes.exists(`${d}/${login}`))
  )
    names.push(login);
  // #819 correction 1 (A BLOCKING 1): the stack sudo consults under -A, when one is named
  if (services.askpass !== undefined) names.push(services.askpass);
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

/** A §F4: where sudo shows no Defaults, the credential may be this login's, root's or ⟨svc⟩'s; the
 *  cause says why each may be needed (#819, 08 A F1: printed as "may need"). */
const UNSEEN_LISTED = 'sudo does not list its Defaults, so rootpw or targetpw cannot be ruled out';
/** #819 (08, A F1): the original sudo's refusal hides its Defaults and whether a rule exists. */
const UNSEEN_REFUSED =
  'sudo does not show its Defaults or whether a rule exists, so rootpw or targetpw cannot be ruled out';
function unseenDefaults(r: SwitchPathReading, cause = UNSEEN_LISTED): SwitchPathReading[] {
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
      return withPam(lk, unseenDefaults(r, UNSEEN_REFUSED), list, path, 'classic-refusal');
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
  // #819 follow-up 2 (A MINOR 3): with noninteractive_auth on, sudo -n runs its PAM stack, so the
  // check's own listing is a login attempt sudo's PAM stack may log or count — said where it is listed
  if (listing.defaults.includes('noninteractive_auth'))
    how = `${how}, which ran sudo's PAM stack (its noninteractive_auth setting is on) and may count as a login attempt`;
  return judge(lk, path, how, listing, svc, root, flavour);
}

/**
 * D3: a listing's reading. #819 correction 1 (SEP-00, 01b #6 yes > unknown): an item the reader
 * does not read never shadows a yes; every other reading — the not-allowed exit, a credential, what
 * the PAM stacks leave short of yes — becomes unknown, with the first such item as its cause. A
 * reading that rested on a group's listed members not holding ⟨svc⟩ says so (clause (g)).
 */
async function judge(
  lk: Lookups,
  path: string,
  how: string,
  listing: Listing,
  svc: Found<PasswdEntry>,
  root: Found<PasswdEntry>,
  flavour: 'classic' | 'rs',
): Promise<SwitchPathReading[]> {
  const unread = unreadItem(listing);
  const seen = { listed: false };
  const rs = await judgeListing(lk, path, how, listing, svc, root, flavour, seen);
  if (rs.some((r) => r.outcome === 'yes' || r.outcome === 'unknown')) return rs;
  if (unread !== undefined)
    return [{ path: 'sudo', tool: path, outcome: 'unknown', how, cause: unread }];
  return seen.listed ? rs.map((r) => ({ ...r, member_list: true as const })) : rs;
}

/** D3: a listing's reading, before what the reader did not read is composed in (`judge`). */
async function judgeListing(
  lk: Lookups,
  path: string,
  how: string,
  listing: Listing,
  svc: Found<PasswdEntry>,
  root: Found<PasswdEntry>,
  flavour: 'classic' | 'rs',
  seen: { listed: boolean },
): Promise<SwitchPathReading[]> {
  const reading = (r: Omit<SwitchPathReading, 'path' | 'tool'>): SwitchPathReading => ({
    path: 'sudo',
    tool: path,
    ...r,
  });
  const opts = new Set(listing.defaults);
  const ci: NameMatch = {
    user: !opts.has('!case_insensitive_user'),
    group: !opts.has('!case_insensitive_group') && !opts.has('match_group_by_gid'),
  };
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
    const c = await entryCovers(lk, entry, svc, root, ci);
    if ('unknown' in c) return [reading({ outcome: 'unknown', how, cause: c.unknown })];
    if (c.listed === true) seen.listed = true;
    if (c.svc || c.root) covering.push({ entry, svc: c.svc, root: c.root });
  }
  // #819 correction 1 (A MINOR 4): with Realm's service user root, it is named once
  const runsAs = (c: { svc: boolean; root: boolean }) =>
    c.svc && c.root ? (lk.svc === 'root' ? 'root' : `${lk.svc} or root`) : c.svc ? lk.svc : 'root';
  const open = covering.find((c) => c.entry.nopasswd);
  if (open !== undefined) {
    return [reading({ outcome: 'yes', how: `${how}: a NOPASSWD rule runs as ${runsAs(open)}` })];
  }
  for (const s of listing.specific) {
    if (!s.options.includes('!authenticate')) continue;
    for (const target of s.targets) {
      let hit: boolean;
      if (s.kind === '>') {
        const c = await tokenCovers(lk, target, svc, root, false, ci);
        if ('unknown' in c) return [reading({ outcome: 'unknown', how, cause: c.unknown })];
        if (c.listed === true) seen.listed = true;
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
    const m = await exemptIn(lk, exempt.slice('exempt_group='.length), ci);
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
  // #819 correction 1 (b): a non-zero timeout anywhere keeps a ticket — a `Defaults!…`/`Defaults>…`
  // line applies before sudo authenticates and governs the ticket (AUD-13); `=0` drops it only when
  // no line sets another value
  const timeouts = [...listing.defaults, ...listing.specific.flatMap((s) => s.options)].filter(
    (o) => defaultsKeyword(o) === 'timestamp_timeout',
  );
  const cache =
    listing.defaults.some((o) => ZERO_TIMEOUT.test(o)) &&
    timeouts.every((o) => ZERO_TIMEOUT.test(o))
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
  } else if (opts.has('runaspw')) {
    // #819 (08, A Outside 1): sudo's own order — rootpw, then runaspw, then targetpw (check.c:60-75)
    // #819 follow-up 2 (member 5): a `#uid` runas_default is the number sudo reads
    const asId = runasDefault !== undefined ? numericId(runasDefault) : undefined;
    const svcUid = uidOf(lk, svc);
    const runsAs =
      asId === undefined || asId === 'negative'
        ? runasDefault
        : asId === 0
          ? 'root'
          : svcUid !== undefined && asId === svcUid
            ? lk.svc
            : runasDefault;
    if (runsAs !== undefined && runsAs !== 'root' && runsAs !== lk.svc) {
      return [
        reading({
          outcome: 'unknown',
          how,
          cause: `sudo asks for ${runsAs}'s password (Defaults runaspw)`,
        }),
      ];
    }
    base = [
      reading({
        outcome: 'needs_credential',
        whose: runsAs === lk.svc ? 'svc' : 'root',
        ...cache,
        how: `${why} (Defaults runaspw)`,
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
  } else {
    const r = reading({ outcome: 'needs_credential', whose: 'this_login', ...cache, how: why });
    base = flavour === 'rs' ? unseenDefaults(r) : [r];
  }
  const option = (k: string) =>
    listing.defaults.find((o) => o.startsWith(`${k}=`))?.slice(k.length + 1);
  const askpass = option('pam_askpass_service');
  const services = {
    main: option('pam_service') ?? 'sudo',
    login: option('pam_login_service'),
    ...(askpass !== undefined ? { askpass } : {}),
  };
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
      const how = lookedFor(name);
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
