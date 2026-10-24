// sudo.ts — #790 (D2, D3, D4, D5): every sudo present, asked in its listing mode only
// (`LC_ALL=C <sudo> -n -l`, plus `-n -ll` for classic sudo). Never a command, never a password.
// A listing is read for entries whose runas covers Realm's service user or root (any command
// counts); a refusal is read by its words; sudo's PAM stack is scanned whenever sudo needs a
// credential. Anything this reader does not recognise is `unknown`, with sudo's own line (P0).
// #819 correction 1 (SEP-00): every item of every list it reads — the Defaults, the `Defaults!…` and
// `Defaults>…` lines, the long format's `Options:` — is acted on, known harmless (by name, with its
// reason), or not read; an item not read makes every reading short of yes `unknown`.
import type { SwitchPathReading, SwitchWhose } from '@sensigo/realm';
import {
  findTools,
  lookedFor,
  numericId,
  RAIL_NAME,
  toolLine,
  type Found,
  type Lookups,
  type PasswdEntry,
} from './lookup.js';
import { scanPam } from './pam.js';

/** One listed entry: who it runs as (users, groups), whether it needs no password, its commands.
 *  #819 Unit A (A1): each run-as member unquoted and unescaped, as sudo stores it. */
interface Entry {
  users: string[];
  groups: string[];
  nopasswd: boolean;
  commands: string[];
}

/** #819 Unit A (A1): one Defaults item as sudo printed it — its text, its keyword (with `!`), its
 *  operator, and its value: a quoted one with each `\"` read as the one valid reading chose, an
 *  unquoted one as printed (`defaultsValue` unescapes it by sudo's version). Exported for its cells. */
export interface DefaultsItem {
  text: string;
  key: string;
  op?: '=' | '+=' | '-=';
  value?: string;
  quoted: boolean;
}

/** A `Defaults!<cmd>` or `Defaults><runas>` line of "Runas and Command-specific defaults": its
 *  targets (a `Defaults>` target unquoted and unescaped, as a run-as member is), its items. */
interface Specific {
  kind: '!' | '>';
  targets: string[];
  options: string[];
  items: DefaultsItem[];
}

interface Listing {
  defaults: string[];
  /** #819 Unit A (A1): the global Defaults items, read. */
  items: DefaultsItem[];
  specific: Specific[];
  entries: Entry[];
  /** Every value of the long format's `Options:` fields, in order (#819 correction 1). */
  options: string[];
  /** #819 follow-up 3, Unit A (A1, A4): why a list could not be split, each a cause as printed —
   *  unknown unless sudo already reads yes. */
  unsplit: string[];
  /** #819 Unit A (A1): the sudo that printed it, read from `sudo -V`, or not known. */
  version: SudoVersion | undefined;
}

/** #819 Unit A (A1): sudo's version, from the first line of `sudo -V` (`Sudo version 1.9.15p5`). */
export interface SudoVersion {
  major: number;
  minor: number;
  patch: number;
  p: number;
}

/** The version `sudo -V`'s first line names, or `undefined` when it names none this check reads.
 *  Exported for its cells. */
export function sudoVersion(first: string | undefined): SudoVersion | undefined {
  const m = /^Sudo version (\d+)\.(\d+)\.(\d+)(?:p(\d+))?$/.exec(first ?? '');
  if (m === null) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), p: Number(m[4] ?? 0) };
}

/** Whether `v` is `at` or later. */
function atLeast(v: SudoVersion, at: readonly [number, number, number, number]): boolean {
  const own = [v.major, v.minor, v.patch, v.p];
  for (let i = 0; i < 4; i++) if (own[i] !== at[i]) return own[i]! > at[i]!;
  return true;
}

/** sudo ≤ 1.9.9 escapes a backslash outside quotes (`\\`); 1.9.10 stopped (W-UA-L1-02). */
const BACKSLASH_PLAIN_FROM = [1, 9, 10, 0] as const;
/** The characters sudo ≥ 1.9.10 escapes outside quotes (≤ 1.9.9 escapes a backslash too). */
const PRINTED_ESCAPES = ':,=#"';
/** A `Defaults!`/`Defaults>` target list is separated by ", " from 1.9.8, by " ," before it
 *  (W-UA-L1-15, W-UA-L3-11). */
const TARGET_COMMA_FROM = [1, 9, 8, 0] as const;

/**
 * #819 Unit A (A1): a value printed outside quotes, unescaped as sudo printed it — on ≤ 1.9.9 `\X` is
 * `X`; on ≥ 1.9.10 `\X` is `X` for `X` in `:,=#"`, and a backslash before any other character is
 * itself. `undefined` when the version cannot be read and the value holds a backslash. Exported for
 * its cells.
 */
export function unescapePrinted(raw: string, version: SudoVersion | undefined): string | undefined {
  if (!raw.includes('\\')) return raw;
  if (version === undefined) return undefined;
  const old = !atLeast(version, BACKSLASH_PLAIN_FROM);
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const next = raw[i + 1];
    if (raw[i] === '\\' && next !== undefined && (old || PRINTED_ESCAPES.includes(next))) {
      out += next;
      i++;
    } else out += raw[i];
  }
  return out;
}

/** #819 Unit A (A1): one Defaults item's keyword (with `!`, and `+`/`-` for `+=`/`-=`) and its
 *  value as sudo stores it — or why it cannot be read. Exported for its cells (T1). */
export function defaultsValue(
  item: DefaultsItem,
  version: SudoVersion | undefined,
): { key: string; value?: string } | { unknown: string } {
  const key = item.key + (item.op === '+=' ? '+' : item.op === '-=' ? '-' : '');
  if (item.value === undefined) return { key };
  if (item.quoted) return { key, value: item.value };
  const value = unescapePrinted(item.value, version);
  return value === undefined ? { unknown: cannotUnescape(item.text) } : { key, value };
}

/** #819 Unit A (A1): why a printed backslash cannot be read without sudo's version. */
const cannotUnescape = (text: string): string =>
  `sudo's version could not be read, and sudo prints a backslash differently before and after 1.9.10: ${text}`;

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

/** #819 Unit A (A1): the keywords whose VALUE this reader reads — every key `judgeListing` and
 *  `unreadItem` read a value of (`GLOBAL_ACTED`'s valued keys, and `timestamp_type`); their values
 *  are unescaped by sudo's version before they are read. `rootpw`, `runaspw`, `targetpw`,
 *  `authenticate`, `case_insensitive_*` and `match_group_by_gid` are booleans: no value. */
const VALUE_ACTED = new Set([
  'exempt_group',
  'listpw',
  'runas_default',
  'timestamp_timeout',
  'timestamp_type',
  'pam_service',
  'pam_login_service',
  'pam_askpass_service',
]);

/** #819 Unit A (A1): the value of the first item keyed `key`, as sudo stores it — `undefined` when
 *  none is listed or it cannot be unescaped (`unreadItem` then reports it). */
function valueOf(
  items: readonly DefaultsItem[],
  key: string,
  version: SudoVersion | undefined,
): string | undefined {
  const item = items.find((i) => i.key === key && i.op === '=');
  if (item === undefined) return undefined;
  const read = defaultsValue(item, version);
  return 'unknown' in read ? undefined : read.value;
}

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
  // #819 follow-up 3, Unit A (A1, A4): a list whose split cannot be told may hide a setting — first
  const unsplit = listing.unsplit[0];
  if (unsplit !== undefined) return unsplit;
  // Unit A (A1): a value the check acts on, which it cannot unescape without sudo's version
  for (const item of [...listing.items, ...listing.specific.flatMap((s) => s.items)]) {
    if (!VALUE_ACTED.has(defaultsKeyword(item.text))) continue;
    const read = defaultsValue(item, listing.version);
    if ('unknown' in read) return read.unknown;
  }
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
  const repeated = [...forms.entries()].find(([, items]) => items.length > 1);
  if (repeated !== undefined)
    // the Unit A correction (C6): Fedora's and Rocky's stock sudoers list match_group_by_gid; the capped
    // correction (the walk's wording item): no other image has that stock line
    return `sudo listed a Defaults setting more than once, and does not show which one it applies: ${repeated[1].join(', ')}${repeated[0] === 'match_group_by_gid' ? ' (keep one of them; on Fedora and Rocky Linux, change the stock line instead of adding a second)' : ''}`;
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

// ─── #819 Unit A (A1): sudo's printout read by its grammar (D3 D1; the prompt's rules) ──────────
//
// A Defaults list as sudo prints it (`sudoers_format_default`, W-UA-L1-01): items separated by ", ";
// a value quoted exactly when it holds a space or a tab, so a `"` opens a quote only right after `=`,
// `+=` or `-=`. Outside quotes, ", " always ends an item, even right after a backslash (an unquoted
// value never holds a space); there a backslash and the next character are a pair where that sudo
// printed one — any character on sudo ≤ 1.9.9, only `:` `,` `=` `#` `"` on ≥ 1.9.10, where a backslash
// before any other character is a step of its own (the Unit A correction, C1). Inside quotes only `\"`
// is an escape; a backslash is otherwise raw on every version. So the one choice a reading makes is,
// for each `\"` inside quotes, an escaped quote or a raw backslash before the closing quote. A reading
// is valid when every quote that opens closes; each closing quote and each unquoted item is followed by
// ", ", the end of its entry's text, or a candidate boundary that starts an entry; and no bare `"` sits
// inside a quoted value. Exactly one valid reading is taken; with none, or more than one, the list is
// unsplit, and every reading short of yes is unknown. With sudo's version not known, the text is read
// once as each side of 1.9.10 prints it, and split only where every valid reading splits it alike.

/** A reader's states: an item's start, an unquoted value, a quoted value, after an item, an entry's
 *  start (the Runas and Command-specific section); a run-as member's start, and its start after `!`. */
const ITEM = 0;
const PLAIN = 1;
const QUOTE = 2;
const AFTER = 3;
const ENTRY = 4;
const NEGATED = 4;

/** One step of a reading: to `to` in state `mode`; `tag` says what the step read. */
interface Edge {
  to: number;
  mode: number;
  tag?: 'sep' | 'open' | 'escaped' | 'raw' | 'close' | 'entry' | 'groups';
  header?: { kind: '!' | '>'; targets: string[]; at: number };
}
type Next = 'accept' | 'reject' | Edge[];

/** A printed text read as a machine: every step moves forward, so the readings are counted right to
 *  left, each state's count capped at 2. */
interface Machine {
  text: string;
  modes: number;
  next(p: number, mode: number): Next;
}

/** How many valid readings run from each state: 0, 1, or 2 for "two or more". Every step moves
 *  forward, so the states are counted right to left. */
function counts(m: Machine): Uint8Array {
  const len = m.text.length;
  const count = new Uint8Array((len + 1) * m.modes);
  for (let p = len; p >= 0; p--) {
    for (let mode = 0; mode < m.modes; mode++) {
      const s = m.next(p, mode);
      let n = s === 'accept' ? 1 : 0;
      if (Array.isArray(s)) for (const e of s) n += count[e.to * m.modes + e.mode]!;
      count[p * m.modes + mode] = Math.min(n, 2);
    }
  }
  return count;
}

/** The states a reading from `start` reaches (only they are asked their next steps). */
function reached(m: Machine, start: number): Uint8Array {
  const len = m.text.length;
  const reach = new Uint8Array((len + 1) * m.modes);
  reach[start] = 1;
  for (let p = 0; p <= len; p++) {
    for (let mode = 0; mode < m.modes; mode++) {
      if (reach[p * m.modes + mode] !== 1) continue;
      const s = m.next(p, mode);
      if (Array.isArray(s)) for (const e of s) reach[e.to * m.modes + e.mode] = 1;
    }
  }
  return reach;
}

/** One valid reading from `start`: the steps it takes. At its `turn`-th choice between two live
 *  steps it takes the second (`turn` −1: always the first; 0 gives a second reading wherever there
 *  are two, since two readings part at a choice on the first one's way). */
function walk(
  m: Machine,
  count: Uint8Array,
  start: number,
  turn = -1,
): { steps: { p: number; mode: number; edge?: Edge }[]; choices: number } {
  const steps: { p: number; mode: number; edge?: Edge }[] = [];
  let state = start;
  let choices = 0;
  for (;;) {
    const p = Math.floor(state / m.modes);
    const mode = state % m.modes;
    const s = m.next(p, mode);
    if (s === 'accept' || s === 'reject') {
      steps.push({ p, mode });
      return { steps, choices };
    }
    const live = s.filter((e) => count[e.to * m.modes + e.mode]! > 0);
    let edge = live[0]!;
    if (live.length > 1) {
      if (choices === turn) edge = live[1]!;
      choices++;
    }
    steps.push({ p, mode, edge });
    state = edge.to * m.modes + edge.mode;
  }
}

/** Whether a backslash outside quotes at `p` pairs with the next character, as a sudo of that side
 *  of 1.9.10 prints it (`old`: ≤ 1.9.9) — never before ", " or the end, where it ends the value. */
function pairAt(text: string, p: number, old: boolean): boolean {
  const next = text[p + 1];
  return (
    next !== undefined && !text.startsWith(', ', p + 1) && (old || PRINTED_ESCAPES.includes(next))
  );
}

/** A Defaults list's machine: the global list (`candidates` undefined), or the whole Runas and
 *  Command-specific section, whose entries start at the candidate boundaries outside quotes. `old`:
 *  read as sudo ≤ 1.9.9 prints a backslash (C1). */
function defaultsMachine(
  text: string,
  candidates: ReadonlySet<number> | undefined,
  version: SudoVersion | undefined,
  old: boolean,
  cannot: Map<number, string>,
): Machine {
  const len = text.length;
  const KEY = /!?[A-Za-z_][A-Za-z0-9_]*/y;
  const entry = (q: number): Next => {
    const h = entryHeader(text, q, candidates!, version);
    if (h === undefined) return 'reject';
    if ('cannot' in h) {
      cannot.set(q, h.cannot);
      return 'reject';
    }
    return [
      { to: h.next, mode: ITEM, tag: 'entry', header: { kind: h.kind, targets: h.targets, at: q } },
    ];
  };
  /** A candidate boundary after the spaces at `p`, or none. */
  const boundary = (p: number): number | undefined => {
    if (candidates === undefined) return undefined;
    let q = p;
    while (text[q] === ' ') q++;
    return q > p && candidates.has(q) ? q : undefined;
  };
  const after = (p: number): Next => {
    if (p === len) return 'accept';
    if (text.startsWith(', ', p)) return [{ to: p + 2, mode: ITEM, tag: 'sep' }];
    const q = boundary(p);
    return q === undefined ? 'reject' : entry(q);
  };
  return {
    text,
    modes: 5,
    next(p, mode) {
      if (mode === ENTRY) return candidates?.has(p) === true ? entry(p) : 'reject';
      if (mode === AFTER) return after(p);
      if (mode === QUOTE) {
        if (p === len) return 'reject';
        if (text[p] === '\\' && text[p + 1] === '"')
          return [
            { to: p + 2, mode: QUOTE, tag: 'escaped' },
            { to: p + 2, mode: AFTER, tag: 'raw' },
          ];
        return text[p] === '"'
          ? [{ to: p + 1, mode: AFTER, tag: 'close' }]
          : [{ to: p + 1, mode: QUOTE }];
      }
      if (mode === PLAIN) {
        if (p === len || text.startsWith(', ', p)) return after(p);
        const ch = text[p];
        if (ch === '\\') return [{ to: pairAt(text, p, old) ? p + 2 : p + 1, mode: PLAIN }];
        if (ch === '"') return 'reject';
        if (ch === ' ' || ch === '\t') return after(p);
        return [{ to: p + 1, mode: PLAIN }];
      }
      KEY.lastIndex = p;
      const key = KEY.exec(text);
      if (key === null) return 'reject';
      let k = p + key[0].length;
      if (text.startsWith('+=', k) || text.startsWith('-=', k)) k += 2;
      else if (text[k] === '=') k += 1;
      else return [{ to: k, mode: AFTER }];
      return text[k] === '"' ? [{ to: k + 1, mode: QUOTE, tag: 'open' }] : [{ to: k, mode: PLAIN }];
    },
  };
}

/** `Defaults!`/`Defaults>` at `q`: its targets, each a run-as member (`>`, unquoted and unescaped) or
 *  a command (`!`, as printed), and where its items start — or why its targets cannot be split
 *  (W-UA-L1-15: ", " from 1.9.8, " ," before; a digest holds a space; a `^…$` regex is printed raw). */
function entryHeader(
  text: string,
  q: number,
  candidates: ReadonlySet<number>,
  version: SudoVersion | undefined,
): { kind: '!' | '>'; targets: string[]; next: number } | { cannot: string } | undefined {
  if (!/^Defaults[!>]/.test(text.slice(q, q + 9))) return undefined;
  const kind = text[q + 8] as '!' | '>';
  const read = (comma: boolean): { raw: string[]; next: number } | undefined => {
    const raw: string[] = [];
    let p = q + 9;
    for (;;) {
      const s = p;
      while (p < text.length && text[p] !== ' ' && !(comma && text.startsWith(', ', p))) p++;
      if (p === s) return undefined;
      raw.push(text.slice(s, p));
      if (comma && text.startsWith(', ', p)) p += 2;
      else if (!comma && text.startsWith(' ,', p)) p += 2;
      else return { raw, next: p < text.length ? p + 1 : p };
    }
  };
  // the Unit A correction (C6): each cause says what to do, by why the target cannot be split
  const cannot = (why: string): { cannot: string } => {
    const end = [...candidates].filter((c) => c > q).sort((a, b) => a - b)[0];
    const line = text.slice(q, end).trim();
    return {
      cannot: `sudo listed a Defaults line's target this check cannot split: ${line} (${why})`,
    };
  };
  const comma = version === undefined ? undefined : atLeast(version, TARGET_COMMA_FROM);
  const tried = comma === undefined ? [read(true), read(false)] : [read(comma)];
  const odd = tried
    .flatMap((t) => t?.raw ?? [])
    .find((r) => /^(?:sha(?:224|256|384|512):|\^|!?")/.test(r));
  if (odd !== undefined)
    return cannot(
      odd.startsWith('sha')
        ? 'sudo prints a digest with a space; name the command without a digest'
        : odd.startsWith('^')
          ? 'name the command by its path'
          : 'write the target without a space or a backslash',
    );
  const ok = tried.filter((t) => t !== undefined);
  if (ok.length === 0) return undefined;
  if (ok.some((t) => t.raw.join('\0') !== ok[0]!.raw.join('\0') || t.next !== ok[0]!.next))
    return cannot(
      "sudo's version could not be read, and sudo separates targets differently before and after 1.9.8",
    );
  const targets: string[] = [];
  for (const r of ok[0]!.raw) {
    const t = kind === '>' ? unescapePrinted(r, version) : r;
    if (t === undefined) return { cannot: cannotUnescape(r) };
    targets.push(t);
  }
  return { kind, targets, next: ok[0]!.next };
}

/** One Defaults list, read: its entries (the global list is one, with no header), each with its items;
 *  or why it cannot be split. */
type DefaultsRead =
  | { entries: { header?: { kind: '!' | '>'; targets: string[] }; items: DefaultsItem[] }[] }
  | { unsplit: string };

/** The sides of 1.9.10 a text is read as (`old`: ≤ 1.9.9): the one its sudo is on, or both when
 *  sudo's version could not be read (the Unit A correction, C1). */
const sidesOf = (version: SudoVersion | undefined): boolean[] =>
  version === undefined ? [true, false] : [!atLeast(version, BACKSLASH_PLAIN_FROM)];

/** C1: why a text read as each side of 1.9.10 splits two ways — the first item where they part. */
const splitsByVersion = (span: string): string =>
  `sudo's version could not be read, and this line splits differently before and after 1.9.10: ${span}`;

/** The first item where two readings' spans differ, spanning both. */
function partedAt(text: string, a: [number, number][], b: [number, number][]): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i]![0] === b[i]![0] && a[i]![1] === b[i]![1]) i++;
  const from = Math.min(a[i]?.[0] ?? text.length, b[i]?.[0] ?? text.length);
  const to = Math.max(a[i]?.[1] ?? from, b[i]?.[1] ?? from);
  return text.slice(from, to);
}

/** Whether two readings' spans are the same. */
const sameSpans = (a: [number, number][], b: [number, number][]): boolean =>
  a.length === b.length && a.every((s, i) => s[0] === b[i]![0] && s[1] === b[i]![1]);

function readDefaults(
  text: string,
  candidates: ReadonlySet<number> | undefined,
  version: SudoVersion | undefined,
): DefaultsRead {
  if (text.trim() === '') return { entries: [] };
  const start = candidates === undefined ? ITEM : ENTRY;
  // C1: read as the side of 1.9.10 that printed it — or as each, where the version is not known
  const reads = sidesOf(version).map((old) => {
    const cannot = new Map<number, string>();
    const m = defaultsMachine(text, candidates, version, old, cannot);
    const count = counts(m);
    // a target that cannot be split, where a reading reaches it, makes the section unsplit
    cannot.clear();
    const reach = reached(m, start);
    return { m, count, reach, n: count[start]!, target: [...cannot.values()][0] };
  });
  const target = reads.find((r) => r.target !== undefined)?.target;
  if (target !== undefined) return { unsplit: target };
  const valid = reads.filter((r) => r.n > 0);
  const cannotSplit = 'sudo listed a Defaults setting this check cannot split';
  if (valid.length === 0) {
    // the furthest item a reading reached, up to the next ", "
    let at = 0;
    for (const { m, reach } of reads)
      for (let p = text.length; p > at; p--)
        if (reach[p * m.modes + ITEM] === 1) {
          at = p;
          break;
        }
    const end = text.indexOf(', ', at);
    const cut = text.slice(at, end === -1 ? text.length : end);
    const item = cut.trim() === '' ? text.trim() : cut;
    // the audit's S3 words hold where a quotation mark is in it; any other text no printer of sudo's
    // gives is a line this check does not read
    return {
      unsplit: item.includes('"')
        ? `${cannotSplit}: ${item} (its quotation marks do not pair as sudo prints them)`
        : `sudo listed a line this check does not read: ${item}`,
    };
  }
  const two = valid.find((r) => r.n > 1);
  if (two !== undefined) {
    // two or more: the first item where two readings differ, spanning both
    const a = spansOf(walk(two.m, two.count, start).steps);
    const b = spansOf(walk(two.m, two.count, start, 0).steps);
    return {
      unsplit: `${cannotSplit}: ${partedAt(text, a, b)} (a value with a space that ends in a backslash, or holds a backslash before a quotation mark, prints the same as another setting; write it without one)`,
    };
  }
  const [one, other] = valid as [(typeof valid)[0], ...typeof valid];
  const steps = walk(one.m, one.count, start).steps;
  if (other !== undefined) {
    // C1: each side of 1.9.10 has one reading — taken where they split the text alike
    const a = spansOf(steps);
    const b = spansOf(walk(other.m, other.count, start).steps);
    if (!sameSpans(a, b)) return { unsplit: splitsByVersion(partedAt(text, a, b)) };
  }
  return { entries: itemsOf(one.m, steps) };
}

/** Each item's span along a reading (start, end), in order. */
function spansOf(steps: { p: number; mode: number; edge?: Edge }[]): [number, number][] {
  const out: [number, number][] = [];
  let start: number | undefined;
  for (const s of steps) {
    if (s.mode === ITEM && start === undefined) start = s.p;
    const ends = s.edge === undefined || s.edge.tag === 'sep' || s.edge.tag === 'entry';
    if ((s.mode === PLAIN || s.mode === AFTER) && ends && start !== undefined) {
      out.push([start, s.p]);
      start = undefined;
    }
  }
  return out;
}

/** A reading's entries and items, read off its steps. */
function itemsOf(
  m: Machine,
  steps: { p: number; mode: number; edge?: Edge }[],
): { header?: { kind: '!' | '>'; targets: string[] }; items: DefaultsItem[] }[] {
  const text = m.text;
  const entries: { header?: { kind: '!' | '>'; targets: string[] }; items: DefaultsItem[] }[] = [];
  let cur: { header?: { kind: '!' | '>'; targets: string[] }; items: DefaultsItem[] } | undefined;
  let item:
    | {
        start: number;
        key: string;
        op?: '=' | '+=' | '-=';
        valueAt?: number;
        quoted: boolean;
        value: string;
      }
    | undefined;
  const KEY = /!?[A-Za-z_][A-Za-z0-9_]*/y;
  for (const s of steps) {
    if (s.mode === ITEM && item === undefined) {
      if (cur === undefined) entries.push((cur = { items: [] }));
      KEY.lastIndex = s.p;
      const key = KEY.exec(text)![0];
      const k = s.p + key.length;
      const op = text.startsWith('+=', k)
        ? '+='
        : text.startsWith('-=', k)
          ? '-='
          : text[k] === '='
            ? '='
            : undefined;
      item = { start: s.p, key, quoted: false, value: '' };
      if (op !== undefined) {
        item.op = op;
        item.valueAt = k + op.length;
      }
    }
    const e = s.edge;
    if (s.mode === QUOTE && item !== undefined && e !== undefined) {
      if (e.tag === 'escaped') item.value += '"';
      else if (e.tag === 'raw') item.value += '\\';
      else if (e.tag !== 'close') item.value += text[s.p];
    }
    if (e?.tag === 'open' && item !== undefined) item.quoted = true;
    const ends = e === undefined || e.tag === 'sep' || e.tag === 'entry';
    if ((s.mode === PLAIN || s.mode === AFTER) && ends && item !== undefined) {
      const out: DefaultsItem = {
        text: text.slice(item.start, s.p),
        key: item.key,
        quoted: item.quoted,
      };
      if (item.op !== undefined) {
        out.op = item.op;
        out.value = item.quoted ? item.value : text.slice(item.valueAt, s.p);
      }
      cur!.items.push(out);
      item = undefined;
    }
    if (e?.tag === 'entry' && e.header !== undefined)
      entries.push((cur = { header: e.header, items: [] }));
  }
  return entries;
}

/** A run-as list's machine (W-UA-L1-16): members separated by ", " outside quotes; a member is
 *  `#uid`, a name, `%group`, `+netgroup`, `ALL`, or `"…"` (a space inside, `%` inside the quotes), each
 *  maybe after `!`; quotes read as in a Defaults value. `short`: the short format's `(users : groups)`,
 *  read up to its `)`. A state of the groups half is its mode plus 5. `old`: read as sudo ≤ 1.9.9
 *  prints a backslash (C1). */
function membersMachine(text: string, short: boolean, old: boolean): Machine {
  const len = text.length;
  return {
    text,
    modes: 10,
    next(p, at) {
      const groups = at >= 5;
      const mode = at % 5;
      const g = groups ? 5 : 0;
      const end = (q: number): Next => {
        if (q === len) return short ? 'reject' : 'accept';
        if (text.startsWith(', ', q)) return [{ to: q + 2, mode: ITEM + g, tag: 'sep' }];
        if (short && text[q] === ')') return 'accept';
        if (short && !groups && text.startsWith(' : ', q))
          return [{ to: q + 3, mode: ITEM + 5, tag: 'groups' }];
        return 'reject';
      };
      if (mode === ITEM && text[p] === '!') return [{ to: p + 1, mode: NEGATED + g }];
      if (mode === ITEM || mode === NEGATED) {
        if (text[p] === '"') return [{ to: p + 1, mode: QUOTE + g, tag: 'open' }];
        if (
          p === len ||
          text.startsWith(', ', p) ||
          ' \t"'.includes(text[p]!) ||
          (short && text[p] === ')')
        )
          return 'reject';
        return text[p] === '\\' && pairAt(text, p, old)
          ? [{ to: p + 2, mode: PLAIN + g }]
          : [{ to: p + 1, mode: PLAIN + g }];
      }
      if (mode === QUOTE) {
        if (p === len) return 'reject';
        if (text[p] === '\\' && text[p + 1] === '"')
          return [
            { to: p + 2, mode: QUOTE + g, tag: 'escaped' },
            { to: p + 2, mode: AFTER + g, tag: 'raw' },
          ];
        return text[p] === '"'
          ? [{ to: p + 1, mode: AFTER + g, tag: 'close' }]
          : [{ to: p + 1, mode: QUOTE + g }];
      }
      if (mode === AFTER) return end(p);
      // an unquoted member
      const e = end(p);
      if (e !== 'reject' || p === len) return e;
      const ch = text[p]!;
      if (ch === '\\') return [{ to: pairAt(text, p, old) ? p + 2 : p + 1, mode: PLAIN + g }];
      if (ch === '"' || ch === ' ' || ch === '\t') return 'reject';
      return [{ to: p + 1, mode: PLAIN + g }];
    },
  };
}

/** A run-as list, read: its users and groups, each member unquoted and unescaped, and (short format)
 *  where its `)` stands — or why it cannot be read. */
function readMembers(
  text: string,
  short: boolean,
  version: SudoVersion | undefined,
): { users: string[]; groups: string[]; close: number } | { unknown: string } {
  // C1: read as the side of 1.9.10 that printed it — or as each, where the version is not known
  const reads = sidesOf(version).map((old) => {
    const m = membersMachine(text, short, old);
    const count = counts(m);
    return { m, count, n: count[ITEM]! };
  });
  const valid = reads.filter((r) => r.n > 0);
  if (valid.length === 0 || valid.some((r) => r.n > 1))
    return {
      unknown: `sudo listed a run-as list this check cannot split: ${text} (write the name without a space or a backslash)`,
    };
  const [one, other] = valid as [(typeof valid)[0], ...typeof valid];
  const { steps } = walk(one.m, one.count, ITEM);
  if (other !== undefined) {
    const a = memberSpans(steps);
    const b = memberSpans(walk(other.m, other.count, ITEM).steps);
    if (!sameSpans(a, b)) return { unknown: splitsByVersion(partedAt(text, a, b)) };
  }
  const users: string[] = [];
  const groups: string[] = [];
  let cur: { start: number; neg: boolean; quoted: boolean; value: string } | undefined;
  let into = users;
  for (const s of steps) {
    const mode = s.mode % 5;
    if (mode === ITEM && cur === undefined)
      cur = { start: s.p, neg: false, quoted: false, value: '' };
    if (mode === NEGATED && cur !== undefined) cur.neg = true;
    const e = s.edge;
    if (e?.tag === 'open' && cur !== undefined) cur.quoted = true;
    if (mode === QUOTE && cur !== undefined && e !== undefined) {
      if (e.tag === 'escaped') cur.value += '"';
      else if (e.tag === 'raw') cur.value += '\\';
      else if (e.tag !== 'close') cur.value += text[s.p];
    }
    const ends = e === undefined || e.tag === 'sep' || e.tag === 'groups';
    if ((mode === PLAIN || mode === AFTER) && ends && cur !== undefined) {
      const raw = cur.quoted ? cur.value : text.slice(cur.start + (cur.neg ? 1 : 0), s.p);
      const value = cur.quoted ? raw : unescapePrinted(raw, version);
      if (value === undefined) return { unknown: cannotUnescape(text.slice(cur.start, s.p)) };
      into.push((cur.neg ? '!' : '') + value);
      cur = undefined;
      if (e?.tag === 'groups') into = groups;
    }
  }
  return { users, groups, close: steps[steps.length - 1]!.p };
}

/** Each run-as member's span along a reading (start, end), in order. */
function memberSpans(steps: { p: number; mode: number; edge?: Edge }[]): [number, number][] {
  const out: [number, number][] = [];
  let start: number | undefined;
  for (const s of steps) {
    const mode = s.mode % 5;
    if (mode === ITEM && start === undefined) start = s.p;
    const e = s.edge;
    const ends = e === undefined || e.tag === 'sep' || e.tag === 'groups';
    if ((mode === PLAIN || mode === AFTER) && ends && start !== undefined) {
      out.push([start, s.p]);
      start = undefined;
    }
  }
  return out;
}

/** Reads one listing (either format): its sections, every line recognised — or unknown. #819 Unit A
 *  (A1): first the logical lines — a privileges-section line of 8 spaces then a non-space continues
 *  the line before, joined with one space (sudo drops the blanks at a break, W-UA-L3-12); a wrapped
 *  Defaults section header takes its 4-space lines (the Unit A correction, C3); every other 4-space
 *  line of a Defaults section continues that section's one text — then each text read by its
 *  grammar. `version`: the sudo that printed it (`sudo -V`), which decides how a backslash and a
 *  target list print. Exported for its cells. */
export function parseListing(stdout: string, version?: SudoVersion): Listing | { unknown: string } {
  const listing: Listing = {
    defaults: [],
    items: [],
    specific: [],
    entries: [],
    options: [],
    unsplit: [],
    version,
  };
  let mode: 'none' | 'defaults' | 'specific' | 'entries' = 'none';
  let header = false;
  const defaultsText: string[] = [];
  /** The Runas and Command-specific section's one text, and its candidate boundaries: each
   *  `Defaults[!>]` at a line's start, or after the 4 spaces that join two entries on one line. */
  let specificText = '';
  const candidates = new Set<number>();
  let entry: (Entry & { long: boolean; inCommands: boolean }) | undefined;
  const close = (): void => {
    if (entry !== undefined) listing.entries.push(entry);
    entry = undefined;
  };
  const unread = (line: string) => ({
    unknown: `sudo listed a line this check does not read: ${line.trim()}`,
  });
  // The logical lines: a column-0 line, a 4-space line, a tab line — each, in the privileges section
  // (from the column-0 `User ` line on), with its 8-space lines (the Unit A correction, C5).
  const logical: { kind: 'col0' | 'four' | 'tab'; text: string }[] = [];
  let privileges = false;
  // C3: a Defaults section's header that wraps (a long host name, a narrow terminal) — a column-0
  // `Matching …` or `Runas …` line not ending with `:` takes each 4-space line after it until it does
  // (a header ends with its only `:`), joined with one space as the line it was cut from
  let wrapped: { text: string } | undefined;
  for (const raw of stdout.split('\n')) {
    if (raw.trim() === '') continue; // a blank line, or a section's 3-space first line (W-UA-DR-03)
    const last = logical[logical.length - 1];
    if (wrapped !== undefined && /^ {4}\S/.test(raw)) {
      wrapped.text = `${wrapped.text.replace(/ +$/, '')} ${raw.slice(4)}`;
      if (wrapped.text.endsWith(':')) wrapped = undefined;
      continue;
    }
    wrapped = undefined;
    if (privileges && /^ {8}\S/.test(raw) && last !== undefined) last.text += ` ${raw.slice(8)}`;
    else if (/^ {4}\S/.test(raw)) logical.push({ kind: 'four', text: raw.slice(4) });
    else if (raw.startsWith('\t')) logical.push({ kind: 'tab', text: raw.slice(1) });
    else if (/^\S/.test(raw)) {
      const line = { kind: 'col0' as const, text: raw };
      logical.push(line);
      if (raw.startsWith('User ')) privileges = true;
      if (/^(?:Matching|Runas)/.test(raw) && !raw.endsWith(':')) wrapped = line;
    } else return unread(raw);
  }
  for (const { kind, text } of logical) {
    if (kind === 'col0') {
      if (/^Matching Defaults entries for \S+ on \S+:$/.test(text)) mode = 'defaults';
      else if (/^Runas and Command-specific defaults for \S+:$/.test(text)) mode = 'specific';
      else if (/^User \S+ may run the following commands on \S+:$/.test(text)) {
        mode = 'entries';
        header = true;
      } else if (mode === 'entries' && /^Sudoers entry:/.test(text)) {
        close();
        entry = {
          users: [],
          groups: [],
          nopasswd: false,
          commands: [],
          long: true,
          inCommands: false,
        };
      } else return unread(text);
    } else if (kind === 'four' && mode === 'defaults') {
      defaultsText.push(text);
    } else if (kind === 'four' && mode === 'specific') {
      const at = specificText === '' ? 0 : specificText.length + 1;
      if (/^Defaults[!>]/.test(text)) candidates.add(at);
      for (const m of text.matchAll(/ {4}(?=Defaults[!>])/g)) candidates.add(at + m.index + 4);
      specificText = specificText === '' ? text : `${specificText} ${text}`;
    } else if (kind === 'tab' && mode === 'entries' && entry?.long === true) {
      if (!entry.inCommands) return unread(text);
      entry.commands.push(text.trim());
    } else if (
      kind === 'four' &&
      mode === 'entries' &&
      entry?.long === true &&
      text === 'Commands:'
    ) {
      entry.inCommands = true;
    } else if (
      kind === 'four' &&
      mode === 'entries' &&
      entry?.long === true &&
      /^\w+: /.test(text)
    ) {
      const [, field, value] = /^(\w+): (.*)$/.exec(text)!;
      if (!LONG_FIELDS.has(field!)) return unread(text);
      if (field === 'RunAsUsers' || field === 'RunAsGroups') {
        const members = readMembers(value!, false, version);
        if ('unknown' in members) return members;
        if (field === 'RunAsUsers') entry.users = members.users;
        else entry.groups = members.users;
      }
      if (field === 'Options') {
        // Unit A (A4): an Options list that cannot be split lets a yes win
        const read = readDefaults(value!, undefined, version);
        if ('unsplit' in read) listing.unsplit.push(read.unsplit);
        else {
          const opts = (read.entries[0]?.items ?? []).map((i) => i.text);
          listing.options.push(...opts);
          if (opts.includes('!authenticate')) entry.nopasswd = true;
          if (opts.includes('authenticate')) entry.nopasswd = false;
        }
      }
    } else if (kind === 'four' && mode === 'entries' && text.startsWith('(')) {
      close();
      const members = readMembers(text.slice(1), true, version);
      if ('unknown' in members) return members;
      const rest = text.slice(1 + members.close + 1);
      if (!/^\s/.test(rest)) return unread(text);
      const state = { users: members.users, groups: members.groups, nopasswd: false };
      const items = shortItems(rest.trim(), state);
      if ('unknown' in items) return items;
      listing.entries.push(...items.entries);
    } else {
      return unread(text);
    }
  }
  close();
  const global = readDefaults(defaultsText.join(' '), undefined, version);
  if ('unsplit' in global) listing.unsplit.push(global.unsplit);
  else listing.items = global.entries[0]?.items ?? [];
  listing.defaults = listing.items.map((i) => i.text);
  const specific = readDefaults(specificText, candidates, version);
  if ('unsplit' in specific) listing.unsplit.push(specific.unsplit);
  else {
    for (const e of specific.entries) {
      if (e.header === undefined) continue;
      listing.specific.push({
        kind: e.header.kind,
        targets: e.header.targets,
        options: e.items.map((i) => i.text),
        items: e.items,
      });
    }
  }
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

/** Who a runas covers, of Realm's service user and root. `listed`: the token does not cover ⟨svc⟩,
 *  and that rested on a group's listed members (clause (g), #819 correction 1). `unknown`: what could
 *  not be read — carried beside the covers read (the Unit A correction, C2: only a yes outranks it).
 *  #819 Unit A, the capped correction (Part 1): `unknownOf` keeps each target's cause apart, so a cover
 *  read for one target never drops the other's (`unknown` is the first of them, for `kept`); `byUsers`
 *  and `byGroups`: ⟨svc⟩ is covered through the user list, or through the run-as group list (the
 *  groups after the `:`); `idFails`: why `id -G` could not be read, where a fallback found no cover. */
type Covers = {
  svc: boolean;
  root: boolean;
  byUsers: boolean;
  byGroups: boolean;
  listed?: true;
  unknown?: string;
  unknownOf?: { svc?: string; root?: string };
  /** Rev 5.1 (IA 2's finding, W-860-MA3-19): the first unknown a run-as GROUP token recorded (about
   *  ⟨svc⟩, through the group list) — kept apart, since the way it hides asks this login's password, or
   *  a listed user's, never ⟨svc⟩'s or root's. */
  unknownFromGroups?: string;
  idFails?: string;
};

/** (e): how sudo matches run-as names — case-insensitively unless `!case_insensitive_user` /
 *  `!case_insensitive_group` is listed (sudo's default, defaults.c; AUD-16). #819 follow-up 2
 *  (member 3, A S2): `group` is false under `match_group_by_gid`, where sudo looks the group up by
 *  name (`getgrnam`, exact) and compares gids (pwutil.c:1172-1193). */
interface NameMatch {
  user: boolean;
  group: boolean;
  /** #819 Unit A (A3): `case_insensitive_group` in force (sudo's default), and `match_group_by_gid`
   *  listed — the two flags the exact group read is keyed on. */
  anyCaseGroup: boolean;
  byGid: boolean;
}

/** strcasecmp's fold: ASCII letters only. */
const fold = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * #819 Unit A (A3): whether a run-as group covers a user whose gids `id -G` gave, as sudo's
 * `user_in_group` reads it (pwutil.c, W-UA-L1-09/-10): `#gid` as a number; under `match_group_by_gid`,
 * the gid of the group named exactly (`getent group <name>`; absent is not covering, as sudo's
 * `getgrnam` NULL denies; an all-digit name `getent` would read as a gid reads unknown); otherwise each
 * gid named (`getent group <gid>`; a gid with no name skipped, as sudo skips it) and compared with the
 * token — in any case under `case_insensitive_group`, exactly under `!case_insensitive_group`. A
 * lookup that errs or is refused reads unknown.
 */
async function exactGroup(
  lk: Lookups,
  group: string,
  gids: readonly number[],
  ci: NameMatch,
): Promise<boolean | { unknown: string }> {
  const id = numericId(group);
  if (id === 'negative') return true;
  if (id !== undefined) return gids.includes(id);
  if (ci.byGid) {
    if (/^\d+$/.test(group))
      return {
        unknown: `getent group ${group} reads ${group} as a gid, and sudo looks it up as a group name (match_group_by_gid)`,
      };
    const g = await lk.group(group);
    if ('found' in g) return gids.includes(g.found.gid);
    return 'absent' in g ? false : { unknown: g.unknown };
  }
  for (const gid of gids) {
    const g = await lk.group(String(gid));
    if ('absent' in g) continue;
    if ('unknown' in g) return { unknown: g.unknown };
    if (ci.anyCaseGroup ? fold(g.found.name) === fold(group) : g.found.name === group) return true;
  }
  return false;
}

/** A sudoers alias's shape: upper case (sudo-rs lists runas aliases unexpanded). */
const ALIAS = /^[A-Z][A-Z0-9_]*$/;

/** The capped correction (the walk's wording item): the `id -G` reasons a root-owned `id` in a system
 *  folder would remove — where an `id` is already there, no remedy is given. */
const ID_REMEDY = new Set([
  'no id was found in the system folders',
  'id is not a root-owned system copy',
]);

/** D3: whether one runas token covers ⟨svc⟩ or root. Negations count as covering (the safe
 *  direction); so does an alias this check cannot expand. */
async function tokenCovers(
  lk: Lookups,
  token: string,
  svc: Found<PasswdEntry>,
  root: Found<PasswdEntry>,
  asGroup: boolean,
  ci: NameMatch,
  idRead?: Set<string>,
): Promise<Covers> {
  if (token === 'ALL' || token.startsWith('!') || (ALIAS.test(token) && token !== lk.svc)) {
    return { svc: true, root: true, byUsers: !asGroup, byGroups: asGroup };
  }
  // #819 Unit A, the capped correction (Part 8 (a)): a group after the `:` of a run-as list is matched
  // by its name alone, as sudo's `group_matches` matches it — in any case unless
  // `!case_insensitive_group` is listed, whatever `match_group_by_gid` says (W-860-PA-01); the flag
  // governs only a `%group` of a user list
  const m: NameMatch = asGroup ? { ...ci, byGid: false, group: ci.anyCaseGroup } : ci;
  const users = { svc, root };
  const out = { svc: false, root: false };
  /** The targets this token reads, in order: a runas GROUP never makes the command run as root
   *  (`entryCovers`), so root is not judged for one. */
  const targets = asGroup ? (['svc'] as const) : (['svc', 'root'] as const);
  // #819 (08, A Outside 2): a group whose members may be hidden reads unknown. The capped correction
  // (Part 1): each cause is recorded against the target it is about — what could not be read, and
  // the case gap — so a cover read for one target never drops the other's
  const unread: { svc?: string; root?: string } = {};
  const gap: { svc?: string; root?: string } = {};
  let idFails: string | undefined;
  let listed = false;
  const result = (): Covers => {
    // ⟨svc⟩'s unknown is reported unless the token covers ⟨svc⟩; root's unless it covers root, or is
    // a run-as group; the covers the token read stay beside it
    const unknownOf: { svc?: string; root?: string } = {};
    const forSvc = unread.svc ?? gap.svc;
    if (forSvc !== undefined && !out.svc) unknownOf.svc = forSvc;
    const forRoot = unread.root ?? gap.root;
    if (forRoot !== undefined && !out.root && !asGroup) unknownOf.root = forRoot;
    const covers: Covers = { ...out, byUsers: out.svc && !asGroup, byGroups: out.svc && asGroup };
    const unknown = unknownOf.svc ?? unknownOf.root;
    if (unknown !== undefined)
      return {
        ...covers,
        unknown,
        unknownOf,
        ...(asGroup && unknownOf.svc !== undefined ? { unknownFromGroups: unknownOf.svc } : {}),
      };
    if (out.svc) return covers;
    return {
      ...covers,
      ...(listed ? { listed: true as const } : {}),
      ...(idFails !== undefined ? { idFails } : {}),
    };
  };
  // W-860CR-05: a lookup that errs keeps the covers this token already read; its cause is recorded
  // for this target and for every target the token has not reached
  const none = (cause: string, who: 'svc' | 'root'): Covers => {
    for (const t of targets.slice(targets.findIndex((x) => x === who))) unread[t] ??= cause;
    return result();
  };
  const same = (a: string, b: string): boolean =>
    m.user ? a.toLowerCase() === b.toLowerCase() : a === b;
  for (const who of targets) {
    const entry = users[who];
    const name = who === 'svc' ? lk.svc : 'root';
    if (asGroup || token.startsWith('%')) {
      // a group: `%name`, `%#gid`; a bare group in the runas group list
      const group = token.startsWith('%') ? token.slice(1) : token;
      if (!('found' in entry)) {
        // #819 follow-up 2 (member 5): `%#0` as sudo reads it, a number (`%#00` too)
        if (who === 'root' && (group === 'root' || numericId(group) === 0)) out.root = true;
        else if ('unknown' in entry) return none(entry.unknown, who);
        continue;
      }
      // #819 Unit A (A3): `%:name` is matched only through sudo's group plugin
      if (group.startsWith(':')) {
        unread[who] ??=
          `sudo matches ${token} only through its group plugin, which this check does not read`;
        continue;
      }
      // #819 Unit A (A3): the user's groups as sudo reads them, where `id -G` gives them — that
      // compare replaces the reading below, which stays the fallback (and its clause (g) with it)
      const read = lk.darwin ? undefined : await lk.groupsOf(entry.found);
      if (read !== undefined && 'gids' in read) {
        idRead?.add(entry.found.name);
        const c = await exactGroup(lk, group, read.gids, m);
        if (c === true) out[who] = true;
        else if (c !== false) unread[who] ??= c.unknown;
        continue;
      }
      // #819 correction 1 (e): sudo matches a group name in any case unless told otherwise, and
      // getent only exactly — a name it finds no group for may name one of another case
      const anyCase = m.group && !lk.darwin && !group.startsWith('#');
      if (anyCase && who === 'svc') {
        // #819 follow-up 2 (member 3, the audit's S2): svc's primary group, named by its gid
        // (`getent group <gid>`, rail 1's call), matched in any case as sudo matches it
        const primary = await lk.group(String(entry.found.gid));
        if ('found' in primary && primary.found.name.toLowerCase() === group.toLowerCase()) {
          out[who] = true;
          continue;
        }
        if ('unknown' in primary) unread[who] ??= primary.unknown;
      }
      const exact = anyCase ? await lk.group(group) : undefined;
      if (exact !== undefined && 'absent' in exact) {
        unread[who] ??=
          `getent group ${group} finds no group of that name, and sudo matches group names in any case (case_insensitive_group, on by default)`;
        continue;
      }
      const inGroup = await lk.userIn(entry.found, group);
      if ('unknown' in inGroup) unread[who] ??= inGroup.unknown;
      else if ('found' in inGroup && inGroup.found) out[who] = true;
      // #819 follow-up 2 (member 3, A B3): a name of another case than its lower one may name, for
      // sudo, a group of another case that getent's exact answer is not — unknown unless it covers
      else if (anyCase && group !== group.toLowerCase())
        unread[who] ??=
          `getent group ${group} reads only the group of that exact case, and sudo matches group names in any case (case_insensitive_group, on by default)`;
      // the Unit A correction (C2, W-UA-MA3-02): where `id -G` cannot be read and sudo matches group
      // names in any case, a secondary group named only in another case is not seen — a group that
      // holds neither user by its list or primary group reads unknown, not "no". The capped
      // correction (the walk's wording item): the cause names the user, the group and, where one
      // helps, what to do
      else if (anyCase && read !== undefined)
        gap[who] ??=
          `sudo matches group names in any case, so ${entry.found.name} may be in ${group} under another case, and ${read.fails}${ID_REMEDY.has(read.fails) ? ' (a root-owned id in a system folder lets this check read the groups)' : ''}`;
      else {
        if (who === 'svc' && 'listed' in inGroup) listed = true;
        // the capped correction (the walk's wording item): a fallback that reads no cover says why
        // `id -G` could not be read
        if (who === 'svc' && read !== undefined) idFails ??= read.fails;
      }
    } else if (token.startsWith('+')) {
      const net = await lk.netgroupUsers(token.slice(1));
      if ('unknown' in net) return none(net.unknown, who);
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
      if ('unknown' in other) return none(other.unknown, who);
      const uid = who === 'root' ? 0 : uidOf(lk, entry);
      if ('found' in other && (uid === undefined || other.found.uid === uid)) out[who] = true;
    }
  }
  return result();
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
  exact?: Set<string>,
): Promise<Covers> {
  const out: Covers = { svc: false, root: false, byUsers: false, byGroups: false };
  // the Unit A correction (C2, the audit's S1): a token that reads unknown no longer ends the entry —
  // its first cause is kept beside what the other tokens cover. The capped correction (Part 1): each
  // target's first cause too, across the entry's tokens
  let unknown: string | undefined;
  const unknownOf: { svc?: string; root?: string } = {};
  let unknownFromGroups: string | undefined;
  let listed = false;
  let idFails: string | undefined;
  for (const [tokens, asGroup] of [
    [e.users, false],
    [e.groups, true],
  ] as const) {
    for (const t of tokens) {
      const c = await tokenCovers(lk, t, svc, root, asGroup, ci, exact);
      unknown ??= c.unknown;
      if (c.unknownOf?.svc !== undefined) unknownOf.svc ??= c.unknownOf.svc;
      if (c.unknownOf?.root !== undefined) unknownOf.root ??= c.unknownOf.root;
      unknownFromGroups ??= c.unknownFromGroups;
      out.svc ||= c.svc;
      // a runas group onto root's group does not make the command run as root
      if (!asGroup) out.root ||= c.root;
      out.byUsers ||= c.byUsers;
      out.byGroups ||= c.byGroups;
      if (c.listed === true) listed = true;
      idFails ??= c.idFails;
    }
  }
  // as before: what the tokens listed stays beside an unknown, unless the entry covers ⟨svc⟩
  const covers: Covers = out.svc
    ? out
    : {
        ...out,
        ...(listed ? { listed: true as const } : {}),
        ...(idFails !== undefined ? { idFails } : {}),
      };
  return unknown !== undefined
    ? {
        ...covers,
        unknown,
        unknownOf,
        ...(unknownFromGroups !== undefined ? { unknownFromGroups } : {}),
      }
    : covers;
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
  // #819 Unit A (A7, W-UB-AUD-11): the person reading carries the how of the base reading it
  // accompanies, so the renderer says it once ("as above")
  return [
    ...readings,
    {
      path: 'sudo',
      tool,
      outcome: 'needs_credential',
      whose: 'person',
      how: readings[readings.length - 1]?.how ?? read,
    },
  ];
}

/** A §F4: where sudo shows no Defaults, the credential may be this login's, root's or ⟨svc⟩'s; the
 *  cause says why each may be needed (#819, 08 A F1: printed as "may need"). #819 Unit A (A7, L2-18):
 *  `runaspw` asks too, and each names whose password it asks for. */
const UNSEEN_WHOSE =
  "rootpw, targetpw or runaspw cannot be ruled out: rootpw asks for root's password, targetpw for the target user's, runaspw for its runas_default user's";
const UNSEEN_LISTED = `sudo does not list its Defaults, so ${UNSEEN_WHOSE}`;
/** #819 (08, A F1): the original sudo's refusal hides its Defaults and whether a rule exists. */
const UNSEEN_REFUSED = `sudo does not show its Defaults or whether a rule exists, so ${UNSEEN_WHOSE}`;
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
  // #819 Unit A (A1): the printout read with the version that printed it (sudo-rs prints none)
  const listing = parseListing(text, flavour === 'classic' ? sudoVersion(first) : undefined);
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
  const seen: { listed: boolean; exact?: Set<string> } = { listed: false };
  const rs = await judgeListing(lk, path, how, listing, svc, root, flavour, seen);
  if (rs.some((r) => r.outcome === 'yes' || r.outcome === 'unknown')) return rs;
  if (unread !== undefined)
    return [{ path: 'sudo', tool: path, outcome: 'unknown', how, cause: unread }];
  return seen.listed ? rs.map((r) => ({ ...r, member_list: true as const })) : rs;
}

/**
 * #819 Unit A (A6): under `runaspw`, whose password sudo asks for a `runas_default` that is not root —
 * or why that is unknown. `#…` is looked up as a name and found nowhere (rail 1's NAME refuses `#`, so
 * it is not asked); an all-digit name `getent` would read as a uid (`getpwnam` is what sudo calls), and
 * a name the rail refuses, cannot be looked up exactly. The capped correction (Part 7): a user `getent`
 * finds is the one whose password sudo asks — the service user's, this login's, or that user's.
 */
async function runaspwUser(
  lk: Lookups,
  name: string,
): Promise<{ cause: string } | { whose: 'svc' | 'this_login' } | { user: string }> {
  // the Unit A correction (C6): why a way sudo shuts reads unknown, said where it is; the capped
  // correction (the walk's wording item): in plain words
  const shut = '; this check reads that as unknown, not as proof that no way works';
  if (name.startsWith('#'))
    return {
      cause: `sudo looks ${name} up as a user name, finds none and refuses every command (Defaults runaspw)${shut}`,
    };
  if (/^\d+$/.test(name) || !RAIL_NAME.test(name))
    return {
      cause: `sudo looks ${name} up as a user name, which this check cannot look up exactly (Defaults runaspw)`,
    };
  const found = await lk.passwd(name);
  if ('unknown' in found) return { cause: found.unknown };
  if ('absent' in found)
    return {
      cause: `sudo finds no user ${name} and refuses every command (Defaults runaspw)${shut}`,
    };
  if (name === lk.svc) return { whose: 'svc' };
  if (name === lk.login) return { whose: 'this_login' };
  return { user: found.found.name };
}

/** A §F2: whether a listed command and a `Defaults!` target differ — only two plain paths that differ
 *  as strings and by their real files; a command, an alias, a folder or a glob counts. */
function commandDiffers(lk: Lookups, cmd: string, target: string): boolean {
  const plain = (p: string): boolean => /^\/[^\s*?[\]]*[^\s*?[\]/]$/.test(p);
  const rp = (p: string): string | undefined => lk.probes.realPath(p);
  return (
    plain(cmd) &&
    plain(target) &&
    cmd !== target &&
    rp(cmd) !== undefined &&
    rp(target) !== undefined &&
    rp(cmd) !== rp(target)
  );
}

/** One covering entry, as `judgeListing` reads it (Part 1's fields). */
interface Cover {
  entry: Entry;
  svc: boolean;
  root: boolean;
  byUsers: boolean;
  byGroups: boolean;
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
  seen: { listed: boolean; exact?: Set<string> },
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
    anyCaseGroup: !opts.has('!case_insensitive_group'),
    byGid: opts.has('match_group_by_gid'),
  };
  // Unit A (A1): a value the check acts on, as sudo stores it
  const value = (key: string): string | undefined => valueOf(listing.items, key, listing.version);
  // The capped correction (Part 5): a global `!authenticate` turns the password off for every rule,
  // so every covering entry is read as NOPASSWD below — a yes needs a rule that runs as ⟨svc⟩ or
  // root, or with a group ⟨svc⟩ is in (W-860-GPROBE-01's `noauth` rows); with none, not allowed
  const noAuth = opts.has('!authenticate');
  const open = (e: Entry): boolean => noAuth || e.nopasswd;
  const covering: Cover[] = [];
  // the Unit A correction (C2, the audit's S1): an entry that reads unknown no longer ends the
  // reading — every entry is read, and its cause kept (`kept`, the first, which the not-allowed branch
  // reads). The capped correction (Part 2): each kept unknown with the entry it came from, so that only
  // one that could change the reading is returned below
  let kept: string | undefined;
  const unknowns: { entry: Entry; of: { svc?: string; root?: string }; fromGroups: boolean }[] = [];
  let idFails: string | undefined;
  // the Unit A correction (C6): where the exact read was made, the reading names it
  const idRead = (seen.exact ??= new Set<string>());
  const named = (): string =>
    idRead.size === 0
      ? how
      : `${how} and ${[...idRead].map((u) => `id -G ${u}`).join(' and ')} read`;
  for (const entry of listing.entries) {
    const c = await entryCovers(lk, entry, svc, root, ci, seen.exact);
    kept ??= c.unknown;
    if (c.unknown !== undefined)
      unknowns.push({
        entry,
        of: c.unknownOf ?? {},
        fromGroups: c.unknownFromGroups !== undefined,
      });
    idFails ??= c.idFails;
    if (c.listed === true) seen.listed = true;
    if (c.svc || c.root)
      covering.push({ entry, svc: c.svc, root: c.root, byUsers: c.byUsers, byGroups: c.byGroups });
  }
  // #819 correction 1 (A MINOR 4): with Realm's service user root, it is named once. The capped
  // correction (Part 8 (c)): an entry that reaches ⟨svc⟩ only through its run-as groups runs "with a
  // group that ⟨svc⟩ is in", never "as ⟨svc⟩" (real sudo refuses `-u ⟨svc⟩` for it); the whole phrase
  const runsAs = (items: readonly Cover[]): string => {
    const bySvc = items.some((c) => c.svc && c.byUsers);
    const byRoot = items.some((c) => c.root);
    const users =
      bySvc && byRoot
        ? lk.svc === 'root'
          ? 'as root'
          : `as ${lk.svc} or root`
        : bySvc
          ? `as ${lk.svc}`
          : byRoot
            ? 'as root'
            : undefined;
    const group = items.some((c) => c.byGroups && !c.byUsers)
      ? `with a group that ${lk.svc} is in`
      : undefined;
    return users !== undefined && group !== undefined ? `${users} or ${group}` : (users ?? group)!;
  };
  const opened = covering.find((c) => open(c.entry));
  if (opened !== undefined) {
    return [
      reading({
        outcome: 'yes',
        how: noAuth
          ? `${named()}: its Defaults turn the password off (!authenticate), and a rule runs ${runsAs(covering)}`
          : `${named()}: a NOPASSWD rule runs ${runsAs([opened])}`,
      }),
    ];
  }
  // Part 2: a `Defaults>` `!authenticate` target opens the kept unknowns about the users it covers —
  // both, where the target itself reads unknown (the guard); a target's own unknown is kept open
  const userOpened = { svc: false, root: false };
  let targetUnknown: string | undefined;
  for (const s of listing.specific) {
    if (!s.options.includes('!authenticate')) continue;
    for (const target of s.targets) {
      let hit: boolean;
      if (s.kind === '>') {
        const c = await tokenCovers(lk, target, svc, root, false, ci, seen.exact);
        kept ??= c.unknown;
        targetUnknown ??= c.unknown;
        if (c.listed === true) seen.listed = true;
        userOpened.svc ||= c.svc || c.unknown !== undefined;
        userOpened.root ||= c.root || c.unknown !== undefined;
        // the capped correction (Part 6): it counts only for a user a rule runs as — a rule that
        // reaches ⟨svc⟩ only through its run-as groups never counts: real sudo applies no `Defaults>`
        // line to a group-only way (W-860-GPROBE-08, -09)
        hit =
          (c.svc && covering.some((x) => x.svc && x.byUsers)) ||
          (c.root && covering.some((x) => x.root));
      } else {
        // a command-bound line applies to a group-only way too (W-860-GPROBE-10)
        hit = covering.some((c) =>
          c.entry.commands.some((cmd) => !commandDiffers(lk, cmd, target)),
        );
      }
      if (hit) {
        return [
          reading({
            outcome: 'yes',
            how: `${named()}: Defaults${s.kind}${target} !authenticate covers a rule`,
          }),
        ];
      }
    }
  }
  // D3 reads the entries that run as ⟨svc⟩ or root: with none, the listing names no way, whatever
  // let it be shown — unless an entry read unknown (the Unit A correction, C2: its kept cause). The
  // capped correction (the walk's wording item): a fallback that read no cover says why
  if (covering.length === 0) {
    if (kept !== undefined) return [reading({ outcome: 'unknown', how: named(), cause: kept })];
    const id = idFails !== undefined ? `; id -G ${lk.svc} could not be read: ${idFails}` : '';
    return [
      reading({
        outcome: 'not_allowed',
        how: `${named()}: no rule runs as ${lk.svc} or root${id}`,
      }),
    ];
  }
  const exempt = listing.defaults.find((o) => o.startsWith('exempt_group='));
  const exemptGroup = value('exempt_group');
  if (exempt !== undefined && exemptGroup !== undefined) {
    const m = await exemptIn(lk, exemptGroup, ci);
    if (!('found' in m) || m.found)
      return [
        reading({
          outcome: 'yes',
          how: `${named()}: Defaults ${exempt}, and this login may be in it`,
        }),
      ];
  }
  if (value('listpw') === 'all' && listing.entries.some((e) => !e.nopasswd)) {
    // A §F8: listpw=all asks a password unless every rule is NOPASSWD — it was waived somehow
    return [
      reading({
        outcome: 'yes',
        how: `${named()}: listed under listpw=all although a rule needs a password`,
      }),
    ];
  }
  if (listing.entries.every((e) => !e.nopasswd)) {
    // D3 (review 19): listed although no rule waives the password — a cache, exempt_group,
    // listpw=never: the cause is unknown, and a cached credential lets the agent through
    return [
      reading({
        outcome: 'yes',
        how: `${named()}: the rules were listed without a password (the cause is unknown)`,
      }),
    ];
  }
  // The capped correction (Part 2): every yes above outranks a kept unknown (yes > unknown, 01b #6);
  // the credential readings below return it only where it could change the reading — an open one
  // (from a NOPASSWD entry, an entry a `Defaults!` `!authenticate` line names, or a user a `Defaults>`
  // `!authenticate` target covers); or one from an entry that needs a password, under targetpw in
  // force, where the covers lack ⟨svc⟩ by its users or lack root — and, rev 5.1 (IA 2's finding,
  // W-860-MA3-19), always where it came from a run-as group token: the way it hides is `sudo -g` alone
  // (this login's password) or `-u ⟨listed user⟩ -g` (that user's), which no covering entry names. Under
  // the default policy, rootpw and runaspw, sudo asks the same password whatever the way, so a
  // password rule settles it
  const policy = opts.has('rootpw')
    ? 'rootpw'
    : opts.has('runaspw')
      ? 'runaspw'
      : opts.has('targetpw')
        ? 'targetpw'
        : 'default';
  const bangOpens = (e: Entry): boolean =>
    listing.specific.some(
      (s) =>
        s.kind === '!' &&
        s.options.includes('!authenticate') &&
        s.targets.some((t) => e.commands.some((cmd) => !commandDiffers(lk, cmd, t))),
    );
  const isOpen = (u: (typeof unknowns)[number]): boolean =>
    open(u.entry) ||
    bangOpens(u.entry) ||
    (userOpened.svc && u.of.svc !== undefined) ||
    (userOpened.root && u.of.root !== undefined);
  const openKept = targetUnknown !== undefined || unknowns.some(isOpen);
  const passwordKept = unknowns.some((u) => !isOpen(u));
  const groupKept = unknowns.some((u) => !isOpen(u) && u.fromGroups);
  const settled = covering.some((c) => c.svc && c.byUsers) && covering.some((c) => c.root);
  if (openKept || (policy === 'targetpw' && (groupKept || (passwordKept && !settled))))
    return [reading({ outcome: 'unknown', how: named(), cause: kept! })];
  const runasDefault = value('runas_default');
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
  const why = `${named()}: a rule runs ${runsAs(covering)} with a password`;
  const needs = (whose: SwitchWhose, how: string, user?: string): SwitchPathReading =>
    reading({
      outcome: 'needs_credential',
      whose,
      ...(user !== undefined ? { user } : {}),
      ...cache,
      how,
    });
  let base: SwitchPathReading[];
  if (policy === 'rootpw') {
    base = [needs('root', `${why} (Defaults rootpw)`)];
  } else if (policy === 'runaspw') {
    // #819 (08, A Outside 1): sudo's own order — rootpw, then runaspw, then targetpw (check.c:60-75)
    // #819 follow-up 3 (A S1; the audit's S3): sudo reads runas_default as a user NAME — `#0` (it
    // prints `\#0`) is looked up as a name, found nowhere, and every command is refused ("unknown
    // user #0"), so it is never root's or the service user's password
    // #819 Unit A (A6): runas_default, unescaped (A1), looked up as sudo looks it up — by name
    // (`getpwnam`, exact; W-UA-L1-12): unset or `root` is root's password. The capped correction
    // (Part 7): a user `getent` finds is the one whose password sudo asks (W-UAC2R4-AUD-09)
    const how = `${why} (Defaults runaspw)`;
    if (runasDefault === undefined || runasDefault === 'root') base = [needs('root', how)];
    else {
      const asked = await runaspwUser(lk, runasDefault);
      if ('cause' in asked)
        return [reading({ outcome: 'unknown', how: named(), cause: asked.cause })];
      base = ['user' in asked ? needs('named_user', how, asked.user) : needs(asked.whose, how)];
    }
  } else if (policy === 'targetpw') {
    // The capped correction (Part 8 (b), Part 9): sudo asks the password of the user a way runs as —
    // ⟨svc⟩'s for a rule whose users cover ⟨svc⟩, root's for one that covers root; a way through a
    // run-as group runs as this login (`sudo -g` alone: sudo 1.8.31 and 1.9.9 for any rule with that
    // group, newer sudo when the login is in the rule's user list) or as a user its list names
    // (`-u ⟨T⟩ -g`): this login's password, and each plain user name's (W-860-GPROBE-04, -13, -17)
    const how = `${why} (Defaults targetpw)`;
    base = [];
    if (covering.some((c) => c.svc && c.byUsers)) base.push(needs('svc', how));
    if (covering.some((c) => c.root)) base.push(needs('root', how));
    const grouped = covering.filter((c) => c.byGroups);
    if (grouped.length > 0) base.push(needs('this_login', how));
    const others: string[] = [];
    const isLogin = (t: string): boolean =>
      numericId(t) !== undefined
        ? numericId(t) === lk.probes.uid()
        : ci.user
          ? t.toLowerCase() === lk.login.toLowerCase()
          : t === lk.login;
    for (const c of grouped) {
      for (const t of c.entry.users) {
        const tc = await tokenCovers(lk, t, svc, root, false, ci);
        if (tc.svc || tc.root || isLogin(t)) continue;
        if (/^[%+#]/.test(t)) {
          // Part 8 (b): a group-reached entry's `%group`, `+netgroup` or `#uid` of another user — one
          // user this check cannot name
          if (c.byUsers) continue;
          return [
            reading({
              outcome: 'unknown',
              how: named(),
              cause: `under targetpw sudo asks the password of the user a way runs as, and this rule's user list holds ${t}, whose password this check does not name`,
            }),
          ];
        }
        // Part 9: a plain user name, as `getent passwd` finds it
        if (/^\d+$/.test(t))
          return [
            reading({
              outcome: 'unknown',
              how: named(),
              cause: `sudo looks ${t} up as a user name, which this check cannot look up exactly (Defaults targetpw)`,
            }),
          ];
        const p = await lk.passwd(t);
        if ('unknown' in p)
          return [reading({ outcome: 'unknown', how: named(), cause: p.unknown })];
        if ('absent' in p) {
          if (!ci.user) continue;
          return [
            reading({
              outcome: 'unknown',
              how: named(),
              cause: `getent passwd ${t} finds no user of that exact case, and sudo matches user names in any case`,
            }),
          ];
        }
        if (!others.includes(p.found.name)) others.push(p.found.name);
      }
    }
    for (const user of others) base.push(needs('named_user', how, user));
  } else {
    const r = needs('this_login', why);
    base = flavour === 'rs' ? unseenDefaults(r) : [r];
  }
  const askpass = value('pam_askpass_service');
  const services = {
    main: value('pam_service') ?? 'sudo',
    login: value('pam_login_service'),
    ...(askpass !== undefined ? { askpass } : {}),
  };
  return withPam(lk, base, named(), path, 'listing', services);
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
