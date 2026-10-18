// doas.ts — #790 (D8): doas's rules, read from its files and checked against doas's own config-check
// mode (`doas -C <file> -u <target> <cmd>`), which evaluates one command and runs nothing. A file this
// login cannot read, a line this reader does not parse, or a check that disagrees with the parse
// reads `unknown` (stock Alpine: doas.conf 0640, doas.d 0750 — 04 item 3).
import type { SwitchPathReading, SwitchOutcome } from '@sensigo/realm';
import { mostPermissive } from '@sensigo/realm';
import { join } from 'node:path';
import { findTool, toolLine, type Lookups } from './lookup.js';

const CONF = '/etc/doas.conf';
const CONF_DIR = '/etc/doas.d';
/** A command no rule names: what a rule with no `cmd` permits. */
const ANY_COMMAND = '/bin/sh';

interface Rule {
  permit: boolean;
  nopass: boolean;
  persist: boolean;
  identity: string;
  target?: string;
  cmd?: string;
  args?: string[];
}

/** One line's words: quotes group, `\` escapes, `#` starts a comment. */
function words(line: string): string[] | undefined {
  const out: string[] = [];
  let cur: string | undefined;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '\\' && i + 1 < line.length) {
      cur = (cur ?? '') + line[++i]!;
    } else if (ch === '"') {
      quoted = !quoted;
      cur ??= '';
    } else if (!quoted && ch === '#') {
      break;
    } else if (!quoted && /\s/.test(ch)) {
      if (cur !== undefined) out.push(cur);
      cur = undefined;
    } else if (!quoted && (ch === '{' || ch === '}')) {
      if (cur !== undefined) out.push(cur);
      out.push(ch);
      cur = undefined;
    } else {
      cur = (cur ?? '') + ch;
    }
  }
  if (quoted) return undefined;
  if (cur !== undefined) out.push(cur);
  return out;
}

/** doas.conf(5): `permit|deny [options] identity [as target] [cmd command [args …]]`. */
function parseRule(w: string[]): Rule | undefined {
  let i = 0;
  const action = w[i++];
  if (action !== 'permit' && action !== 'deny') return undefined;
  const rule: Rule = { permit: action === 'permit', nopass: false, persist: false, identity: '' };
  for (;;) {
    const opt = w[i];
    if (opt === 'nopass') rule.nopass = true;
    else if (opt === 'persist') rule.persist = true;
    else if (opt === 'nolog' || opt === 'keepenv') {
      // recognised: neither opens a way
    } else if (opt === 'setenv') {
      if (w[i + 1] !== '{') return undefined;
      const close = w.indexOf('}', i + 2);
      if (close === -1) return undefined;
      i = close;
    } else break;
    i++;
  }
  const identity = w[i++];
  if (identity === undefined) return undefined;
  rule.identity = identity;
  if (w[i] === 'as') {
    const target = w[i + 1];
    if (target === undefined) return undefined;
    rule.target = target;
    i += 2;
  }
  if (w[i] === 'cmd') {
    const cmd = w[i + 1];
    if (cmd === undefined) return undefined;
    rule.cmd = cmd;
    i += 2;
    if (w[i] === 'args') {
      rule.args = w.slice(i + 1);
      i = w.length;
    }
  }
  return i === w.length ? rule : undefined;
}

/** A file's rules, or the line this reader does not parse. */
function parseFile(text: string): Rule[] | { unknown: string } {
  const rules: Rule[] = [];
  for (const line of text.replace(/\\\n/g, ' ').split('\n')) {
    const w = words(line);
    if (w === undefined) return { unknown: `a doas line this check does not read: ${line.trim()}` };
    if (w.length === 0) continue;
    const rule = parseRule(w);
    if (rule === undefined)
      return { unknown: `a doas line this check does not read: ${line.trim()}` };
    rules.push(rule);
  }
  return rules;
}

/** The doas files this host has, read — or why they cannot be. */
function readFiles(lk: Lookups): { file: string; text: string }[] | { unknown: string } {
  const files: string[] = [];
  if (lk.probes.exists(CONF)) files.push(CONF);
  if (lk.probes.exists(CONF_DIR)) {
    const names = lk.probes.list(CONF_DIR);
    if (names === undefined) return { unknown: `doas's rules cannot be read here (${CONF_DIR})` };
    files.push(
      ...names
        .filter((n) => n.endsWith('.conf'))
        .sort()
        .map((n) => join(CONF_DIR, n)),
    );
  }
  const out: { file: string; text: string }[] = [];
  for (const file of files) {
    const text = lk.probes.readText(file);
    if (text === undefined) return { unknown: `doas's rules cannot be read here (${file})` };
    out.push({ file, text });
  }
  return out;
}

/** D8: the doas path — none when no doas is on this host. */
export async function readDoas(lk: Lookups): Promise<SwitchPathReading[]> {
  const doas = findTool(lk.probes, 'doas');
  if (doas === undefined) return [];
  if ('unknown' in doas) {
    return [
      {
        path: 'doas',
        tool: 'doas',
        outcome: 'unknown',
        how: 'doas looked for in the system folders',
        cause: doas.unknown,
      },
    ];
  }
  const unknown = (how: string, cause: string): SwitchPathReading[] => [
    { path: 'doas', tool: doas.path, outcome: 'unknown', how, cause },
  ];
  const files = readFiles(lk);
  if ('unknown' in files) return unknown(`${CONF} and ${CONF_DIR} read`, files.unknown);
  if (files.length === 0) {
    return [
      {
        path: 'doas',
        tool: doas.path,
        outcome: 'not_allowed',
        how: `no ${CONF} or ${CONF_DIR} file exists`,
      },
    ];
  }
  const me = lk.probes.uid();
  const identityMatches = async (identity: string): Promise<boolean | { unknown: string }> => {
    if (identity.startsWith(':')) {
      const m = await lk.loginIn(identity.slice(1));
      return 'found' in m ? m.found : 'unknown' in m ? m : false;
    }
    return identity === lk.login || (me !== undefined && identity === String(me));
  };
  const outcomes: SwitchOutcome[] = [];
  let persist = false;
  const asked: string[] = [];
  for (const { file, text } of files) {
    const rules = parseFile(text);
    if ('unknown' in rules) return unknown(`${file} read`, rules.unknown);
    const mine: Rule[] = [];
    for (const r of rules) {
      const m = await identityMatches(r.identity);
      if (typeof m === 'object') return unknown(`${file} read`, m.unknown);
      if (m) mine.push(r);
    }
    const commands = [
      ...mine.flatMap((r) => (r.cmd !== undefined ? [[r.cmd, ...(r.args ?? [])]] : [])),
      [ANY_COMMAND],
    ];
    for (const target of [lk.svc, 'root']) {
      for (const [cmd, ...args] of commands) {
        // the parse's answer: the last rule that matches wins
        const last = mine
          .filter(
            (r) =>
              (r.target === undefined || r.target === target) &&
              (r.cmd === undefined ||
                (r.cmd === cmd && (r.args === undefined || r.args.join('\0') === args.join('\0')))),
          )
          .at(-1);
        const parsed =
          last === undefined || !last.permit ? 'deny' : last.nopass ? 'permit nopass' : 'permit';
        const argv = [doas.path, '-C', file, '-u', target, cmd!, ...args];
        asked.push(argv.join(' '));
        const r = await lk.run(argv);
        const said = 'exit' in r ? r.stdout.trim() : undefined;
        const ok =
          'exit' in r && r.stderr === '' && (said === 'deny' ? r.exit === 1 : r.exit === 0);
        if (!ok || said !== parsed) {
          return unknown(
            argv.join(' '),
            ok
              ? `doas -C says "${said}" where this check reads "${parsed}"`
              : `${argv.join(' ')}: ${toolLine(r)}`,
          );
        }
        outcomes.push(
          parsed === 'permit nopass'
            ? 'yes'
            : parsed === 'permit'
              ? 'needs_credential'
              : 'not_allowed',
        );
        if (parsed === 'permit' && last?.persist === true) persist = true;
      }
    }
  }
  const outcome =
    mostPermissive(outcomes.map((o) => ({ path: 'doas', outcome: o, how: '' }))) ?? 'not_allowed';
  const how = `${files.map((f) => f.file).join(' and ')} read, and ${doas.path} -C asked ${asked.length} times`;
  if (outcome === 'needs_credential') {
    return [
      {
        path: 'doas',
        tool: doas.path,
        outcome,
        whose: 'this_login',
        ...(persist ? { cache: 'doas_persist' as const } : {}),
        how,
      },
    ];
  }
  return [{ path: 'doas', tool: doas.path, outcome, how }];
}
