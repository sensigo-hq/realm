// pam.ts — #790 (D7): the PAM scanner, an allowlist that fails closed. It reads a service's auth
// lines (01b #7: `account`, `password` and `session` lines are skipped; `include`, `substack` and
// `@include` are followed to depth 4), and recognises only the lines D7 lists. Anything else — a line
// it does not recognise, a missing or unreadable file, an include that does not resolve — makes the
// whole stack unknown, with that line. D5 (sudo's stack) and D6 (su's stacks) call it.
import { basename, dirname, isAbsolute, join } from 'node:path';
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

/** One auth line, split: its control (a word, or a bracket's token set), module name and args.
 *  #819 (08, B F8): `frame`, the substacks it sits in — `[]` at the top, one id per `substack`
 *  entered (an `include` or `@include` adds none: Linux-PAM inlines it). */
interface AuthLine {
  text: string;
  control: string | Set<string>;
  module: string;
  args: string[];
  frame: number[];
}

/** A service's file: `/etc/pam.d` first, then the vendor folder (D7); an absolute path as given. */
function serviceFile(lk: Lookups, name: string): string | undefined {
  if (isAbsolute(name)) return lk.probes.exists(name) ? name : undefined;
  return PAM_DIRS.map((d) => join(d, name)).find((p) => lk.probes.exists(p));
}

/** A module's name without its folder and suffix: `pam_unix`, from `pam_unix.so` or `pam_tid.so.2`. */
const moduleName = (path: string): string | undefined =>
  (
    isAbsolute(path)
      ? (MODULE_DIRS as readonly string[]).includes(dirname(path))
      : !path.includes('/')
  )
    ? /^(pam_[A-Za-z0-9_]+)\.so(?:\.\d+)*$/.exec(basename(path))?.[1]
    : undefined;

/** B §3: each module's arguments, seeded from every captured stack (F790-IA-16/17); any other
 *  argument reads unknown — `pam_wheel trust deny` (it grants NON-members) and `pam_u2f nouserok`
 *  (it lets a user with no key through) among them. A module not named takes none. */
const ARGS: Record<string, RegExp> = {
  pam_unix: /^nullok$/,
  pam_sss: /^forward_pass$/,
  pam_faildelay: /^delay=\d+$/,
  pam_faillock: /^(?:preauth|silent|authfail)$/,
  pam_usertype: /^isregular$/,
  pam_wheel: /^(?:trust|use_uid|group=[\w.-]+)$/,
  pam_u2f: /^cue$/,
  pam_ssh_agent_auth: /^file=\S+$/,
};

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

/** One file's auth lines, its includes followed: the lines in order, or unknown. `frame` is the
 *  substacks the file is read inside; `frames` counts them, so each substack has its own id. */
function authLines(
  lk: Lookups,
  service: string,
  depth: number,
  files: string[],
  frame: number[] = [],
  frames: { next: number } = { next: 1 },
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
        return {
          unknown: `${file} has a line this check does not read: ${line.replace(/\s+/g, ' ')}`,
        };
      const inner = authLines(lk, target, depth + 1, files, frame, frames);
      if (!Array.isArray(inner)) return inner;
      lines.push(...inner);
      continue;
    }
    const { type, control, rest } = splitLine(line);
    const dashed = type.startsWith('-');
    const bare = dashed ? type.slice(1) : type;
    if (!TYPES.has(bare))
      return {
        unknown: `${file} has a line this check does not read: ${line.replace(/\s+/g, ' ')}`,
      };
    if (bare !== 'auth') continue;
    const target = rest[0];
    if (target === undefined)
      return {
        unknown: `${file} has a line this check does not read: ${line.replace(/\s+/g, ' ')}`,
      };
    if (control === 'include' || control === 'substack') {
      // #819 (08, B F8): a substack's `done` ends only the substack (Linux-PAM 1.5.3,
      // pam_dispatch.c:301-305); its lines carry their own frame
      const inner = authLines(
        lk,
        target,
        depth + 1,
        files,
        control === 'substack' ? [...frame, frames.next++] : frame,
        frames,
      );
      if (!Array.isArray(inner)) return inner;
      lines.push(...inner);
      continue;
    }
    if (dashed && !moduleExists(lk, target)) continue;
    const module = moduleName(target);
    if (module === undefined)
      return {
        unknown: `${file} has a line this check does not read: ${line.replace(/\s+/g, ' ')}`,
      };
    lines.push({ text: line.replace(/\s+/g, ' '), control, module, args: rest.slice(1), frame });
  }
  return lines;
}

/**
 * D7: scans `service`'s auth lines. `pam_wheel`'s `trust` grant asks whether this login is in the
 * group (`group=`, else `wheel`, else the group of gid 0); without `use_uid` it is a grant whatever
 * the membership (review 16).
 */
export async function scanPam(lk: Lookups, service: string): Promise<PamScan> {
  if (!lk.probes.exists('/etc/pam.d') && lk.probes.exists('/etc/pam.conf'))
    return { unknown: 'PAM is configured in /etc/pam.conf, which this check does not read' };
  const files: string[] = [];
  const lines = authLines(lk, service, 0, files);
  if (!Array.isArray(lines)) return lines;
  let password = false;
  let person = false;
  let sshAgent = false;
  let grant: string | undefined;
  let grantFrame: number[] = [];
  let denied = false;
  // 01b #6 within one stack (B §11): a `sufficient` grant already read ends the stack when it
  // succeeds, so it outranks anything after it this check does not read. #819 (08, B F8): a grant
  // read inside a substack ends only that substack — it outranks only the lines in its frame or
  // nested in it; a line after its substack ends still runs, and reads unknown.
  const within = (l: AuthLine): boolean =>
    grantFrame.every((id, i) => l.frame[i] === id) && l.frame.length >= grantFrame.length;
  const fail = (cause: string, l: AuthLine): PamScan =>
    grant !== undefined && within(l)
      ? { password, person, sshAgent, files, grant }
      : { unknown: cause };
  const unread = (l: AuthLine): PamScan =>
    fail(`${service}'s PAM stack has a line this check does not read: ${l.text}`, l);
  const granted = (l: AuthLine): void => {
    if (grant !== undefined) return;
    grant = l.text;
    grantFrame = l.frame;
  };
  for (const [i, l] of lines.entries()) {
    const word = typeof l.control === 'string' ? l.control : undefined;
    const set = typeof l.control === 'string' ? undefined : l.control;
    const allowed = ARGS[l.module];
    if (l.args.some((a) => allowed === undefined || !allowed.test(a))) return unread(l);
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
      // B §3: recognised only under controls that cannot let a user through
      const die = set !== undefined && set.size === 1 && set.has('default=die');
      const ok = word === 'required' || word === 'requisite' || word === 'optional';
      if (!ok && !(die && l.module === 'pam_faillock' && l.args.includes('authfail')))
        return unread(l);
    } else if (OPTIONAL_MODULES.has(l.module)) {
      if (word !== 'optional') return unread(l);
    } else if (l.module === 'pam_usertype' || l.module === 'pam_localuser') {
      if (set === undefined || !fedoraGuard(set)) return unread(l);
      // B §6: a guard whose jump lands past a deny line can skip it
      const jump = Number([...set].find((t) => t.startsWith('default='))!.slice('default='.length));
      if (lines.slice(i + 1, i + 1 + jump).some((x) => x.module === 'pam_deny'))
        return fail(`${service}'s PAM stack can jump past its deny line: ${l.text}`, l);
    } else if (l.module === 'pam_wheel') {
      if (!l.args.includes('trust')) continue; // a restriction, recognised
      if (word !== 'sufficient') return unread(l);
      if (!l.args.includes('use_uid')) {
        granted(l);
        continue;
      }
      const named = l.args.find((a) => a.startsWith('group='))?.slice('group='.length);
      const member = await wheelMember(lk, named);
      if ('unknown' in member) return fail(`${l.text}: ${member.unknown}`, l);
      if (member.found) granted(l);
    } else if (PERSON_MODULES.has(l.module) || SSH_AGENT_MODULES.has(l.module)) {
      // #819 (08, B Outside 1): recognised only under a control that cannot jump past the stack's
      // deny line — any other (`[default=2]` …) reads unknown
      const ok =
        word === 'required' ||
        word === 'requisite' ||
        word === 'sufficient' ||
        word === 'optional' ||
        (set !== undefined && successSkip(set));
      if (!ok) return unread(l);
      if (PERSON_MODULES.has(l.module)) person = true;
      else sshAgent = true;
    } else {
      return unread(l);
    }
  }
  // CAUD-12 (Linux-PAM's dispatch, F790-IA-C1): a password module whose failure is ignored, with no
  // deny line after it, lets a later success through on a wrong password
  for (const [i, l] of lines.entries()) {
    const ignoresFailure = l.control === 'sufficient' || typeof l.control !== 'string';
    const denyAfter = lines
      .slice(i + 1)
      .some(
        (x) => x.module === 'pam_deny' && (x.control === 'requisite' || x.control === 'required'),
      );
    if (PASSWORD_MODULES.has(l.module) && ignoresFailure && !denyAfter) {
      return fail(
        `${service}'s PAM stack lets a failed password through: no deny line follows ${l.text}`,
        l,
      );
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
