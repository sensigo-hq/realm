// master-key-k1.test.ts — callback K1 (R1.3): the master key's text form and the read-only resolver
// over its three sources (`REALM_ENCRYPTION_KEY`, the file `REALM_ENCRYPTION_KEY_FILE` names, and
// `<home>/encryption.key`), on real files in a scratch folder. The home file is absent exactly when it
// has no directory entry (pre-authorized by MA 3 after a stop: a read through a dangling link answers
// ENOENT too).
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MASTER_KEY_FILE, parseMasterKey, resolveMasterKey } from './master-key.js';

const A = 'a1'.repeat(32);
const B = 'b2'.repeat(32);
/** First 8 hex of SHA-256 of each key's 32 bytes (`printf <hex> | xxd -r -p | sha256sum`). */
const FP_A = '52fe6094';
const FP_B = 'f14dfc87';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A scratch home folder, and a folder beside it for named files. */
function scratch(): { home: string; side: string } {
  const root = mkdtempSync(join(tmpdir(), 'realm-k1-master-'));
  dirs.push(root);
  const home = join(root, '.realm');
  const side = join(root, 'side');
  mkdirSync(home);
  mkdirSync(side);
  return { home, side };
}

/** The result as a log would print it, the key's bytes shown as hex when present. */
const shown = (r: ReturnType<typeof resolveMasterKey>) =>
  r.state === 'found' ? { ...r, key: Buffer.from(r.key).toString('hex') } : r;
/** The source a result names, or its state when it names none. */
const sourceOf = (r: ReturnType<typeof shown>): string => ('source' in r ? r.source : r.state);

describe('callback K1 — the master key’s text form', () => {
  it('64 hex characters of either case, after one trailing newline; nothing else', () => {
    // (1) red when two newlines, a space, 63 or 65 characters or a non-hex character are taken, or one
    //     newline or upper case is refused; (2) prints each answer.
    const parsed = (t: string) => {
      const k = parseMasterKey(t);
      return k === undefined ? 'undefined' : Buffer.from(k).toString('hex');
    };
    expect({
      plain: parsed(A),
      upper: parsed(A.toUpperCase()),
      lf: parsed(`${A}\n`),
      crlf: parsed(`${A}\r\n`),
      twoLf: parsed(`${A}\n\n`),
      space: parsed(` ${A}`),
      short: parsed(A.slice(1)),
      long: parsed(`${A}0`),
      nonHex: parsed(`${A.slice(1)}g`),
    }).toEqual({
      plain: A,
      upper: A,
      lf: A,
      crlf: A,
      twoLf: 'undefined',
      space: 'undefined',
      short: 'undefined',
      long: 'undefined',
      nonHex: 'undefined',
    });
  });
});

describe('callback K1 — the resolver', () => {
  it('each source alone; with several set, the environment wins over the named file, which wins over the home file', () => {
    const { home, side } = scratch();
    const named = join(side, 'master.key');
    writeFileSync(named, `${B}\n`, { mode: 0o600 });
    const homeOnly = scratch();
    writeFileSync(join(homeOnly.home, MASTER_KEY_FILE), A, { mode: 0o600 });
    writeFileSync(join(home, MASTER_KEY_FILE), A, { mode: 0o600 });
    const at = (env: Record<string, string>, dir = home) =>
      shown(resolveMasterKey({ env, homeDir: dir }));
    // (1) red when a source is read out of order or one is ignored; (2) prints each result.
    expect({
      env: at({ REALM_ENCRYPTION_KEY: A }, scratch().home),
      file: at({ REALM_ENCRYPTION_KEY_FILE: named }, scratch().home),
      homeFile: at({}, homeOnly.home),
      nothing: at({}, scratch().home),
      envOverFile: sourceOf(at({ REALM_ENCRYPTION_KEY: A, REALM_ENCRYPTION_KEY_FILE: named })),
      fileOverHome: sourceOf(at({ REALM_ENCRYPTION_KEY_FILE: named })),
    }).toEqual({
      env: { state: 'found', source: 'env', fp: FP_A, key: A },
      file: { state: 'found', source: 'env_file', fp: FP_B, key: B },
      homeFile: { state: 'found', source: 'home_file', fp: FP_A, key: A },
      nothing: { state: 'none' },
      envOverFile: 'env',
      fileOverHome: 'env_file',
    });
  });

  it('a set source that is invalid stops there, and an empty or all-whitespace environment value counts as unset', () => {
    const { home } = scratch();
    writeFileSync(join(home, MASTER_KEY_FILE), A, { mode: 0o600 });
    const at = (env: Record<string, string>) => shown(resolveMasterKey({ env, homeDir: home }));
    // (1) red when an invalid source falls through to the next (the valid home file is then found),
    //     or an empty value is read as malformed; (2) prints each result.
    expect({
      envMalformed: at({ REALM_ENCRYPTION_KEY: 'not hex' }),
      fileRelative: at({ REALM_ENCRYPTION_KEY_FILE: 'relative/master.key' }),
      fileMissing: at({ REALM_ENCRYPTION_KEY_FILE: '/nonexistent/realm-k1/master.key' }),
      emptyEnv: sourceOf(at({ REALM_ENCRYPTION_KEY: '' })),
      blankEnv: sourceOf(at({ REALM_ENCRYPTION_KEY: '  \t' })),
      blankFile: sourceOf(at({ REALM_ENCRYPTION_KEY_FILE: ' ' })),
    }).toEqual({
      envMalformed: { state: 'invalid', source: 'env', reason: 'malformed' },
      fileRelative: { state: 'invalid', source: 'env_file', reason: 'malformed' },
      fileMissing: { state: 'invalid', source: 'env_file', reason: 'unreadable_file' },
      emptyEnv: 'home_file',
      blankEnv: 'home_file',
      blankFile: 'home_file',
    });
  });

  it('a zero-byte file and a file of one newline are empty; two newlines are malformed', () => {
    const cases = Object.fromEntries(
      ['', '\n', '\r\n', `${A}\n\n`].map((text, i) => {
        const { home } = scratch();
        writeFileSync(join(home, MASTER_KEY_FILE), text, { mode: 0o600 });
        return [String(i), shown(resolveMasterKey({ env: {}, homeDir: home }))];
      }),
    );
    // (1) red when an empty file is read as malformed or as no file; (2) prints each result.
    expect(cases).toEqual({
      0: { state: 'invalid', source: 'home_file', reason: 'empty' },
      1: { state: 'invalid', source: 'home_file', reason: 'empty' },
      2: { state: 'invalid', source: 'home_file', reason: 'empty' },
      3: { state: 'invalid', source: 'home_file', reason: 'malformed' },
    });
  });

  it('the home file: absent only when it has no entry; a dangling link is unreadable_file; a link to a key file is found', () => {
    const dangling = scratch();
    symlinkSync(join(dangling.side, 'missing.key'), join(dangling.home, MASTER_KEY_FILE));
    const linked = scratch();
    writeFileSync(join(linked.side, 'real.key'), A, { mode: 0o600 });
    symlinkSync(join(linked.side, 'real.key'), join(linked.home, MASTER_KEY_FILE));
    // (1) red when a read's ENOENT is taken for absent (the dangling link reads `none`, and K2 would
    //     make a key over it), or a link is not followed; (2) prints each result.
    expect({
      dangling: shown(resolveMasterKey({ env: {}, homeDir: dangling.home })),
      linked: shown(resolveMasterKey({ env: {}, homeDir: linked.home })),
      absent: shown(resolveMasterKey({ env: {}, homeDir: scratch().home })),
    }).toEqual({
      dangling: { state: 'invalid', source: 'home_file', reason: 'unreadable_file' },
      linked: { state: 'found', source: 'home_file', fp: FP_A, key: A },
      absent: { state: 'none' },
    });
  });

  it('differs_from_home_file only when the home file holds a key of another fingerprint', () => {
    const at = (homeText: string | undefined) => {
      const { home } = scratch();
      if (homeText !== undefined)
        writeFileSync(join(home, MASTER_KEY_FILE), homeText, { mode: 0o600 });
      return resolveMasterKey({ env: { REALM_ENCRYPTION_KEY: A }, homeDir: home });
    };
    const flag = (r: ReturnType<typeof resolveMasterKey>) =>
      r.state === 'found' ? (r.differs_from_home_file ?? 'unset') : r.state;
    // (1) red when the flag is set for the same key, or for a home file with no key in it; (2) prints
    //     each flag.
    expect({
      other: flag(at(B)),
      same: flag(at(A)),
      malformed: flag(at('not a key')),
      none: flag(at(undefined)),
    }).toEqual({ other: true, same: 'unset', malformed: 'unset', none: 'unset' });
  });

  it('the key is not enumerable: neither a JSON form nor a spread of the result carries it', () => {
    const r = resolveMasterKey({ env: { REALM_ENCRYPTION_KEY: A }, homeDir: scratch().home });
    const json = JSON.stringify(r);
    const spread = JSON.stringify({ ...r });
    // (1) red when `key` is an ordinary property (a `logger.info(result)` would print it); (2) prints
    //     both forms and whether the key is still there.
    expect({
      json,
      spread,
      inJson: json.includes(A),
      reachable: r.state === 'found' && Buffer.from(r.key).toString('hex') === A,
    }).toEqual({
      json: `{"state":"found","source":"env","fp":"${FP_A}"}`,
      spread: `{"state":"found","source":"env","fp":"${FP_A}"}`,
      inJson: false,
      reachable: true,
    });
  });

  it('a key file readable by others is marked wider than owner (POSIX)', () => {
    const at = (mode: number) => {
      const { home } = scratch();
      const path = join(home, MASTER_KEY_FILE);
      writeFileSync(path, A);
      chmodSync(path, mode);
      const r = resolveMasterKey({ env: {}, homeDir: home });
      return r.state === 'found' ? (r.mode_wider_than_owner ?? 'unset') : r.state;
    };
    // (1) red when the mode is not examined, or a 0600 file is flagged; (2) prints both.
    expect({ wide: at(0o644), owner: at(0o600) }).toEqual({ wide: true, owner: 'unset' });
  });

  it('the resolver writes nothing and creates nothing in a writable home, and no reason carries a value', () => {
    const { home, side } = scratch();
    const before = readdirSync(home);
    const results = [
      resolveMasterKey({ env: {}, homeDir: home }),
      resolveMasterKey({ env: { REALM_ENCRYPTION_KEY: `${A.slice(1)}z` }, homeDir: home }),
      resolveMasterKey({
        env: { REALM_ENCRYPTION_KEY_FILE: join(side, 'none.key') },
        homeDir: home,
      }),
    ];
    const text = JSON.stringify(results);
    // (1) red when the resolver makes the home file (or anything) when there is none, or a result
    //     repeats the value it was given; (2) prints the listings and the results.
    expect({
      before,
      after: readdirSync(home),
      sideAfter: readdirSync(side),
      carriesValue: text.includes(A.slice(1)),
      states: results.map((r) => r.state),
    }).toEqual({
      before: [],
      after: [],
      sideAfter: [],
      carriesValue: false,
      states: ['none', 'invalid', 'invalid'],
    });
  });
});
