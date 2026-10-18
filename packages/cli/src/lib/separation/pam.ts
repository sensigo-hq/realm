// pam.ts — #790 (D7): the PAM scanner, an allowlist that fails closed. It reads a service's auth
// lines (01b #7: `account`, `password` and `session` lines are skipped; `include`, `substack` and
// `@include` are followed to depth 4), and recognises only the lines D7 lists. Anything else — a line
// it does not recognise, a missing or unreadable file, an include that does not resolve — makes the
// whole stack unknown, with that line. D5 (sudo's stack) and D6 (su's stacks) call it.
import { basename, isAbsolute, join } from 'node:path';
import type { Lookups } from './lookup.js';

/** What a stack's auth lines say: unknown (with why), or what they hold. */
export type PamScan =
  | { unknown: string }
  | {
      /** A module that asks the target's password (pam_unix, pam_sss, …). */
      password: boolean;
      /** A line that lets the login through with no credential (pam_wheel `trust`), named. */
      grant?: string;
      /** A person's touch or key (pam_tid, pam_u2f, pam_fprintd). */
      person: boolean;
      /** An ssh agent's key (pam_ssh_agent_auth, pam_rssh). */
      sshAgent: boolean;
      /** The files read, in order. */
      files: string[];
    };

const PAM_DIRS = ['/etc/pam.d', '/usr/lib/pam.d'] as const;
const MODULE_DIRS = [
  '/lib/security',
  '/lib64/security',
  '/usr/lib/security',
  '/usr/lib64/security',
  '/lib/x86_64-linux-gnu/security',
  '/usr/lib/x86_64-linux-gnu/security',
  '/lib/aarch64-linux-gnu/security',
  '/usr/lib/aarch64-linux-gnu/security',
  '/usr/lib/pam',
] as const;
const PASSWORD_MODULES = new Set([
  'pam_unix',
  'pam_sss',
  'pam_krb5',
  'pam_ldap',
  'pam_opendirectory',
  'pam_systemd_home',
]);
const PERSON_MODULES = new Set(['pam_tid', 'pam_u2f', 'pam_fprintd']);
const SSH_AGENT_MODULES = new Set(['pam_ssh_agent_auth', 'pam_rssh']);
const NEUTRAL_MODULES = new Set(['pam_env', 'pam_faildelay', 'pam_faillock', 'pam_nologin']);
const OPTIONAL_MODULES = new Set(['pam_cap', 'pam_gnome_keyring']);
const TYPES = new Set(['auth', 'account', 'password', 'session']);
const MAX_DEPTH = 4;

/** One auth line, split: its control (a word, or a bracket's token set), module name and args. */
interface AuthLine {
  text: string;
  control: string | Set<string>;
  module: string;
  args: string[];
}

/** A service's file: `/etc/pam.d` first, then the vendor folder (D7); an absolute path as given. */
function serviceFile(lk: Lookups, name: string): string | undefined {
  if (isAbsolute(name)) return lk.probes.exists(name) ? name : undefined;
  return PAM_DIRS.map((d) => join(d, name)).find((p) => lk.probes.exists(p));
}

/** A module's name without its folder and suffix: `pam_unix`, from `pam_unix.so` or `pam_tid.so.2`. */
const moduleName = (path: string): string | undefined =>
  /^(pam_[A-Za-z0-9_]+)\.so(?:\.\d+)*$/.exec(basename(path))?.[1];

/** D7's `-auth`: read as `auth` when its module exists — and also when no module folder is known,
 *  so a line is never skipped on a guess. */
function moduleExists(lk: Lookups, path: string): boolean {
  if (isAbsolute(path)) return lk.probes.exists(path);
  if (MODULE_DIRS.some((d) => lk.probes.exists(join(d, path)))) return true;
  const known = MODULE_DIRS.some(
    (d) => lk.probes.exists(join(d, 'pam_deny.so')) || lk.probes.exists(join(d, 'pam_deny.so.2')),
  );
  return !known;
}

/** The file's logical lines: `\` continuations joined, `#` and after stripped, blank lines dropped. */
const logicalLines = (text: string): string[] =>
  text
    .replace(/\\\n/g, ' ')
    .split('\n')
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter((l) => l !== '');

/** Splits `type control module args…`, reading a `[…]` control as one token set. */
function splitLine(line: string): { type: string; control: string | Set<string>; rest: string[] } {
  const words = line.split(/\s+/);
  const type = words[0]!;
  if (words[1]?.startsWith('[') === true) {
    const at = words.findIndex((w, i) => i >= 1 && w.endsWith(']'));
    const inside = words
      .slice(1, at + 1)
      .join(' ')
      .slice(1, -1);
    return {
      type,
      control: new Set(inside.split(/\s+/).filter((t) => t !== '')),
      rest: at === -1 ? [] : words.slice(at + 1),
    };
  }
  return { type, control: words[1] ?? '', rest: words.slice(2) };
}

/** Whether a bracket is exactly `[success=N default=ignore]`. */
const successSkip = (c: Set<string>): boolean =>
  c.size === 2 && [...c].some((t) => /^success=\d+$/.test(t)) && c.has('default=ignore');

/** Whether a bracket is Fedora's guard: the set {default=N, ignore=ignore, success=ok} (critic 8). */
const fedoraGuard = (c: Set<string>): boolean =>
  c.size === 3 &&
  [...c].some((t) => /^default=\d+$/.test(t)) &&
  c.has('ignore=ignore') &&
  c.has('success=ok');

/** One file's auth lines, its includes followed: the lines in order, or unknown. */
function authLines(
  lk: Lookups,
  service: string,
  depth: number,
  files: string[],
): AuthLine[] | { unknown: string } {
  if (depth > MAX_DEPTH)
    return { unknown: `the PAM stack nests deeper than ${MAX_DEPTH} includes` };
  const file = serviceFile(lk, service);
  if (file === undefined) return { unknown: `the PAM file for ${service} was not found` };
  const text = lk.probes.readText(file);
  if (text === undefined) return { unknown: `${file} cannot be read` };
  files.push(file);
  const lines: AuthLine[] = [];
  for (const line of logicalLines(text)) {
    if (line.startsWith('@include')) {
      const target = line.split(/\s+/)[1];
      if (target === undefined)
        return { unknown: `${file} has a line this check does not read: ${line}` };
      const inner = authLines(lk, target, depth + 1, files);
      if (!Array.isArray(inner)) return inner;
      lines.push(...inner);
      continue;
    }
    const { type, control, rest } = splitLine(line);
    const dashed = type.startsWith('-');
    const bare = dashed ? type.slice(1) : type;
    if (!TYPES.has(bare))
      return { unknown: `${file} has a line this check does not read: ${line}` };
    if (bare !== 'auth') continue;
    const target = rest[0];
    if (target === undefined)
      return { unknown: `${file} has a line this check does not read: ${line}` };
    if (control === 'include' || control === 'substack') {
      const inner = authLines(lk, target, depth + 1, files);
      if (!Array.isArray(inner)) return inner;
      lines.push(...inner);
      continue;
    }
    if (dashed && !moduleExists(lk, target)) continue;
    const module = moduleName(target);
    if (module === undefined)
      return { unknown: `${file} has a line this check does not read: ${line}` };
    lines.push({ text: line.replace(/\s+/g, ' '), control, module, args: rest.slice(1) });
  }
  return lines;
}

/**
 * D7: scans `service`'s auth lines. `pam_wheel`'s `trust` grant asks whether this login is in the
 * group (`group=`, else `wheel`, else the group of gid 0); without `use_uid` it is a grant whatever
 * the membership (review 16).
 */
export async function scanPam(lk: Lookups, service: string): Promise<PamScan> {
  const files: string[] = [];
  const lines = authLines(lk, service, 0, files);
  if (!Array.isArray(lines)) return lines;
  let password = false;
  let person = false;
  let sshAgent = false;
  let grant: string | undefined;
  let denied = false;
  const unread = (l: AuthLine): PamScan => ({
    unknown: `${service}'s PAM stack has a line this check does not read: ${l.text}`,
  });
  for (const l of lines) {
    const word = typeof l.control === 'string' ? l.control : undefined;
    const set = typeof l.control === 'string' ? undefined : l.control;
    if (l.module === 'pam_rootok') {
      // A grant only for root, which this login is not (the root path reads that first).
      if (word !== 'sufficient') return unread(l);
    } else if (PASSWORD_MODULES.has(l.module)) {
      const ok =
        word === 'sufficient' ||
        word === 'required' ||
        word === 'requisite' ||
        (set !== undefined && successSkip(set));
      if (!ok) return unread(l);
      password = true;
    } else if (l.module === 'pam_deny') {
      if (word !== 'requisite' && word !== 'required') return unread(l);
      if (word === 'requisite') denied = true;
    } else if (l.module === 'pam_permit') {
      // Debian's fallthrough only: `required pam_permit` behind a `requisite pam_deny`.
      if (word !== 'required' || !denied) return unread(l);
    } else if (NEUTRAL_MODULES.has(l.module)) {
      // recognised: these lines add no way and remove none
    } else if (OPTIONAL_MODULES.has(l.module)) {
      if (word !== 'optional') return unread(l);
    } else if (l.module === 'pam_usertype' || l.module === 'pam_localuser') {
      if (set === undefined || !fedoraGuard(set)) return unread(l);
    } else if (l.module === 'pam_wheel') {
      if (!l.args.includes('trust')) continue; // a restriction, recognised
      if (word !== 'sufficient') return unread(l);
      if (!l.args.includes('use_uid')) {
        grant ??= l.text;
        continue;
      }
      const named = l.args.find((a) => a.startsWith('group='))?.slice('group='.length);
      const member = await wheelMember(lk, named);
      if ('unknown' in member) return { unknown: `${l.text}: ${member.unknown}` };
      if (member.found) grant ??= l.text;
    } else if (PERSON_MODULES.has(l.module)) {
      person = true;
    } else if (SSH_AGENT_MODULES.has(l.module)) {
      sshAgent = true;
    } else {
      return unread(l);
    }
  }
  return { password, person, sshAgent, files, ...(grant !== undefined ? { grant } : {}) };
}

/** Whether this login is in pam_wheel's group: `group=`, else `wheel`, else the group of gid 0. */
async function wheelMember(
  lk: Lookups,
  named: string | undefined,
): Promise<{ found: boolean } | { unknown: string }> {
  if (lk.darwin) return { unknown: "macOS has no getent, so pam_wheel's group is not read" };
  if (named !== undefined) {
    const m = await lk.loginIn(named);
    return 'absent' in m ? { found: false } : m;
  }
  const wheel = await lk.group('wheel');
  if ('unknown' in wheel) return wheel;
  const m = await lk.loginIn('found' in wheel ? 'wheel' : '0');
  return 'absent' in m ? { found: false } : m;
}
