// Test support for the disclosure differential cell (E-1''): a seeded generator of texts with
// planted canaries, and the check that tells whether a law hid a canary. Not part of the package.
//
// A canary is `FAKE` + 8–16 characters from consonants and digits (at least one consonant), so it
// never holds a quote, a separator, `@`, `/` or a space, is always token-shaped (D-4 never applies to
// it), is never a `${secret:IDENT}` identifier (E-4 never applies to it), and never spells a
// credential name or an anchor word. Canaries go ONLY in a credential's value position or into the
// set as members; non-value text holds none.
//
// Whether a law hid a canary is read without its internals: the text is disclosed twice, once as
// generated and once with that canary replaced by a different string of the same character classes
// (and the member set changed the same way). Every rule of both laws reads character classes or fixed
// words the alphabet cannot spell, so the marks are the same in both runs; the two outputs are equal
// exactly when no character of the canary is shown.

export type DisclosureEntryLike = {
  value: string;
  source: `env:${string}` | `declared:${string}`;
};

/** A law under test: discloses `text` with a set compiled from `entries`, on a log audience. */
export type Law = (text: string, entries: readonly DisclosureEntryLike[]) => string;

/** The two functions of a law module the differential needs (the current law, or a frozen one). */
export interface LawModule<S> {
  compileDisclosure(
    entries: readonly DisclosureEntryLike[],
    options: { declared: 'resolved'; audience: 'log'; environment: 'swept' },
  ): { set: S };
  disclose(text: string, set: S, tier: 'all'): { text: string };
}

/** Wraps a law module: sets are compiled once per entry list. */
export function lawOf<S>(m: LawModule<S>): Law {
  const sets = new Map<string, S>();
  return (text, entries) => {
    const key = entries.map((e) => `${e.source}\u0000${e.value}`).join('\u0001');
    let set = sets.get(key);
    if (set === undefined) {
      set = m.compileDisclosure(entries, {
        declared: 'resolved',
        audience: 'log',
        environment: 'swept',
      }).set;
      if (sets.size > 2000) sets.clear();
      sets.set(key, set);
    }
    return m.disclose(text, set, 'all').text;
  };
}

/**
 * The rule a canary was planted under (the generator's own construction, never a re-parse):
 * - `name`: the value after a credential name (`=`, `:`, quoted, escaped, `${NAME:default}`, `==`);
 * - `flag`: the word after a credential-named `--flag`;
 * - `scheme`: the run after `Bearer ` / `Basic `;
 * - `token-run`: the run after `token=`;
 * - `url`: a URL's password (or colon-less token) before `@`;
 * - `pem`: a PEM block's body;
 * - `member`: a declared or environment value, anywhere;
 * - `tail`: glued after a quote inside an unquoted value (R2-L1-09's first shapes, R3-L1-12's `\'`,
 *   the second of two glued escaped-quoted values) — hidden whole: a quote glued to more text does
 *   not end the value, whatever was open before the name (correction 7);
 * - `quoted-tail`: glued after a quoted value's own quote (R2-L1-09's last shape);
 * - `r30-url-quote` (allowed): in a URL userinfo that holds a raw `"` (R30);
 * - `r29-level3` (allowed): the value of a quoted JSON key written as a JSON string twice or more
 *   (`\\\"key\\\":`, R29: the name rule reads keys raw and at one escape level). Set where the
 *   generator encodes, never by reading the text.
 * - `l0-bound` (allowed; correction 5, J-1): a canary on a later line after an unclosed level-0
 *   quote whose next line holds no same-token closer — every earlier law hid it (the unbounded
 *   scan), correction 5 shows it, on the owner's word. Set by the template that writes it.
 */
export type PlantRule =
  | 'name'
  | 'flag'
  | 'scheme'
  | 'token-run'
  | 'url'
  | 'pem'
  | 'member'
  | 'tail'
  | 'quoted-tail'
  | 'r30-url-quote'
  | 'r29-level3'
  | 'l0-bound';

/**
 * The allowed differences (E-1''): where the current law deliberately shows what round 1 hid. D-4 (a
 * non-token word after a scheme word) and E-4 (`${secret:IDENT}`) never arise from the canary
 * alphabet; their cells live beside the differential. These three arise, by construction only
 * (`l0-bound`: correction 5, J-1). E-2's tail left at correction 7: an unquoted value ends at an
 * open quote only where the quote closes — past any closing brackets or quotes, before a blank, `&`,
 * `;`, `,` or the text's end, where round 1 ended it too — so no planted canary is a tail the current
 * law may show.
 */
export const ALLOWED_DIFFERENCES: ReadonlySet<PlantRule> = new Set([
  'r30-url-quote',
  'r29-level3',
  'l0-bound',
]);

export interface Planted {
  canary: string;
  rule: PlantRule;
  /** The canary is the value of a double-quoted key (`"key": value`). */
  jsonKey?: boolean;
  /** How many times the text holding it was written as a JSON string. */
  encoded?: number;
}

/** `planted`, written as a JSON string `by` more times. */
function encodedMore(planted: readonly Planted[], by: number): Planted[] {
  return planted.map((p) => ({ ...p, encoded: (p.encoded ?? 0) + by }));
}

export interface GeneratedText {
  text: string;
  planted: Planted[];
  entries: DisclosureEntryLike[];
  /** A named shape from a review row (`R2-L1-07`, …), or undefined for a generated text. */
  shape?: string;
}

/** A different string with the same character class at every position. */
export function substitute(canary: string): string {
  let out = '';
  for (const ch of canary) {
    if (/[a-z]/.test(ch)) out += ch === 'q' ? 'z' : 'q';
    else if (/[A-Z]/.test(ch)) out += ch === 'Q' ? 'Z' : 'Q';
    else if (/[0-9]/.test(ch)) out += ch === '7' ? '3' : '7';
    else out += ch;
  }
  return out;
}

function replaceIn(
  t: GeneratedText,
  which: readonly string[],
): { text: string; entries: DisclosureEntryLike[] } {
  let text = t.text;
  let entries = t.entries;
  for (const c of which) {
    const s = substitute(c);
    text = text.split(c).join(s);
    entries = entries.map((e) =>
      e.value.includes(c) ? { ...e, value: e.value.split(c).join(s) } : e,
    );
  }
  return { text, entries };
}

/** For each planted canary of `t`, whether `law` showed none of its characters. */
export function hiddenBy(law: Law, t: GeneratedText): boolean[] {
  const base = law(t.text, t.entries);
  const all = replaceIn(
    t,
    t.planted.map((p) => p.canary),
  );
  if (law(all.text, all.entries) === base) return t.planted.map(() => true);
  return t.planted.map((p) => {
    const one = replaceIn(t, [p.canary]);
    return law(one.text, one.entries) === base;
  });
}

// ── the generator ─────────────────────────────────────────────────────────────────────────────

/** mulberry32: a small seeded generator. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const CONSONANTS = 'bcdfghjklmnpqrstvwxz';
const DIGITS = '0123456789';

const CREDENTIAL_KEYS = [
  'password',
  'token',
  'secret',
  'api_key',
  'apiKey',
  'client_secret',
  'DB_PASSWORD',
  'passwd',
  'access_token',
  'private_key',
  'x-api-key',
  'db.password',
  'refreshToken',
  'credentials',
  'Password',
  'TOKEN',
  'passphrase',
  'Pwd',
  'db_pwd',
] as const;
const PLAIN_KEYS = [
  'user',
  'host',
  'name',
  'note',
  'id',
  'max_tokens',
  'level',
  'msg',
  'x',
] as const;
const PLAIN_WORDS = ['ok', 'bob', 'db', 'ready', '42', 'true', 'main', 'eu-west-1', 'hello world'];
const FLAG_NAMES = ['password', 'api-key', 'token', 'secret', 'client-secret'] as const;
const URL_SCHEMES = ['postgres', 'https', 'redis', 'mysql', 'amqp'] as const;
const GLUE = [' ', '\n', ', ', '; ', ' & ', '\t', ' | ', '  '] as const;

/** One fragment: its text (canaries in place) and what it planted. */
interface Fragment {
  text: string;
  planted: Planted[];
  entries: DisclosureEntryLike[];
}

/** `\` repeated `level` times. */
const bs = (level: number): string => '\\'.repeat(level);

// The reader's quote soup (round 3, `L1-probes/soup.mjs`). Its canaries end in a digit, so a quote
// right after one is never an apostrophe.
/** What goes before a name (the name follows at once). */
const SOUP_PRE: readonly string[] = [
  '',
  'x ',
  "it's ",
  "users' ",
  'say "hi" ',
  "echo 'a' ",
  '"open ',
  "'open ",
  'C:\\app\\',
  '\\',
  'a\\n',
  'a\\t',
  '\\\\',
  "don\\'t ",
  '{"k":"',
  '\\"q\\" ',
  '\\\\\\"',
  "Bob's ",
  '"',
  "'",
  '`',
  '(',
  '[',
  'a"b ',
  "a'b ",
  'x=y ',
  '--v ',
  'note="z" ',
];
const SOUP_NAMES = [
  'password',
  'token',
  'secret',
  'api_key',
  'passwd',
  'client_secret',
  'Password',
  'refreshToken',
  'passphrase',
  'TOKEN',
  'db.password',
] as const;
const SOUP_SEPS = ['=', ': ', ':', ' = ', '=='] as const;
/** A value around a canary. */
const SOUP_WRAP: ReadonlyArray<(c: string) => string> = [
  (c) => c,
  (c) => `"${c}"`,
  (c) => `'${c}'`,
  (c) => `\\"${c}\\"`,
  (c) => `${c}'x`,
  (c) => `${c}"y`,
  (c) => `ab'${c}`,
  (c) => `ab"${c}`,
  (c) => `=${c}`,
  (c) => `${c}\\'z`,
  (c) => `"${c}'`,
  (c) => `'${c}"`,
  (c) => `${c}\\n`,
  (c) => `\\\\${c}`,
];
/** A value with no canary. */
const SOUP_PLAIN_VALUES: readonly string[] = ['v', 'abc', "a'b", 'a"b', '1', 'zz'];
/** What follows the value. */
const SOUP_POST: readonly string[] = [
  '',
  ' ',
  ' x',
  '"',
  "'",
  '" y',
  "' y",
  ' password=zz',
  ' token: q',
  '\\n',
  '\\" z',
  ', y="v"',
  '}',
  ')',
  ']',
  " it's",
  '\\',
  "'s",
];

/** A node of a JSON text the generator writes itself. */
type JsonNode =
  { kind: 'obj'; entries: Array<readonly [string, JsonNode]> } | { kind: 'str'; text: string };

/** Writes `node` as `JSON.stringify` would (two spaces when `pretty`). */
function writeJson(node: JsonNode, pretty: boolean, indent = ''): string {
  if (node.kind === 'str') return JSON.stringify(node.text);
  if (node.entries.length === 0) return '{}';
  const inner = `${indent}  `;
  let text = '{';
  node.entries.forEach(([key, value], i) => {
    if (pretty) text += `\n${inner}`;
    const v = writeJson(value, pretty, inner);
    text += `${JSON.stringify(key)}${pretty ? ': ' : ':'}${v}${i < node.entries.length - 1 ? ',' : ''}`;
  });
  if (pretty) text += `\n${indent}`;
  return `${text}}`;
}

class Gen {
  private used = new Set<string>();
  constructor(private readonly rnd: () => number) {}

  int(lo: number, hi: number): number {
    return lo + Math.floor(this.rnd() * (hi - lo + 1));
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.rnd() * xs.length)]!;
  }
  chance(p: number): boolean {
    return this.rnd() < p;
  }

  /** `FAKE` + 8–16 consonants and digits; with `digitLast`, the last one a digit. */
  canary(digitLast = false): string {
    for (;;) {
      const len = this.int(8, 16);
      let body = '';
      for (let i = 0; i < len; i++)
        body += this.chance(0.7) ? this.pick([...CONSONANTS]) : this.pick([...DIGITS]);
      if (!/[a-z]/.test(body)) body = this.pick([...CONSONANTS]) + body.slice(1);
      if (digitLast) body = body.slice(0, -1) + this.pick([...DIGITS]);
      if (!/[a-z]/.test(body)) continue;
      const c = `FAKE${body}`;
      if (!this.used.has(c)) {
        this.used.add(c);
        return c;
      }
    }
  }

  /** A credential name's value, in one of the separator and quoting forms. */
  nameValue(): Fragment {
    const c = this.canary();
    const k = this.pick(CREDENTIAL_KEYS);
    const K = k.toUpperCase().replace(/[.-]/g, '_');
    const text = this.pick([
      `${k}=${c}`,
      `${k}: ${c}`,
      `${k}:${c}`,
      `"${k}": "${c}"`,
      `"${k}":"${c}"`,
      `'${k}': '${c}'`,
      `${k}="${c}"`,
      `${k}='${c}'`,
      `${k} = ${c}`,
      `${k}=${c}&`,
      `?user=bob&${k}=${c}&x=1`,
      `${K}=${c}`,
      `${k}==${c}`,
      `\${${K}:${c}}`,
      `it's set: ${k}=${c}`,
      `Bob's ${k}: ${c}`,
    ] as const);
    const jsonKey = text.startsWith(`"${k}":`);
    return {
      text,
      planted: [{ canary: c, rule: 'name', ...(jsonKey ? { jsonKey } : {}) }],
      entries: [],
    };
  }

  flag(): Fragment {
    const c = this.canary();
    const f = this.pick(FLAG_NAMES);
    const text = this.pick([
      `mysql --${f} ${c} -h db`,
      `curl --${f} ${c} -d secret=x`,
      `tool --${f}=${c} --verbose`,
      `run --${f} ${c}`,
    ]);
    return { text, planted: [{ canary: c, rule: 'flag' }], entries: [] };
  }

  scheme(): Fragment {
    const c = this.canary();
    const text = this.pick([
      `Authorization: Bearer ${c}`,
      `-H "Authorization: Bearer ${c}" https://x.test`,
      `Bearer ${c}`,
      `Authorization: Basic ${c}==`,
      `authorization=Bearer ${c}`,
      // Correction 7 (C7-2b): a quote left open before the name, closed after the scheme word — the
      // credential after the blank (round 1 hid it; corrections 2–6 showed it). The doubled quote's
      // closing run (`''`) too: round 1's run was `Bearer''`, a scheme word.
      `'x Authorization: Bearer' ${c}`,
      `'x Authorization: Bearer'' ${c}`,
    ] as const);
    return { text, planted: [{ canary: c, rule: 'scheme' }], entries: [] };
  }

  tokenRun(): Fragment {
    const c = this.canary();
    const text = this.pick([`token=${c}`, `?a=1&token=${c}&b=2`, `x token=${c}.y`]);
    return { text, planted: [{ canary: c, rule: 'token-run' }], entries: [] };
  }

  url(): Fragment {
    const c = this.canary();
    const s = this.pick(URL_SCHEMES);
    const text = this.pick([
      `${s}://user:${c}@db.example/app`,
      `${s}://:${c}@host:6379`,
      `see ${s}://u:${c}@host now`,
      `${s}://admin:${c}@h.example`,
      `${s}://u:p@ss${c}@host/db`,
    ]);
    return { text, planted: [{ canary: c, rule: 'url' }], entries: [] };
  }

  /** R30: a raw quote in a URL userinfo. It leaves that quote open. */
  r30(): Fragment {
    const c = this.canary();
    const s = this.pick(URL_SCHEMES);
    const text = this.pick([
      `${s}://us"er:${c}@host/db`,
      `${s}://u:pa"${c}@host/db`,
      `${s}://u:${c}"x@host/db`,
      `${s}://u:pa\\"${c}@host/db`,
    ] as const);
    return { text, planted: [{ canary: c, rule: 'r30-url-quote' }], entries: [] };
  }

  pem(): Fragment {
    const c = this.canary();
    const text = `-----BEGIN PRIVATE KEY-----\nMII${c}\nAAAA\n-----END PRIVATE KEY-----`;
    return { text, planted: [{ canary: c, rule: 'pem' }], entries: [] };
  }

  member(): Fragment {
    const c = this.canary();
    const declared = this.chance(0.5);
    const text = this.pick([
      `the value ${c} here`,
      `https://example.test/${c}/x`,
      `{"note":"${c}"}`,
      `id=${c}`,
      `${c}`,
      `x${c}password: v`,
    ] as const);
    return {
      text,
      planted: [{ canary: c, rule: 'member' }],
      entries: [{ value: c, source: declared ? 'declared:M' : 'env:M' }],
    };
  }

  /** A member that spells part of a credential name, then that name's value (R2-L1-08). */
  namePartMember(): Fragment {
    const c = this.canary();
    const [part, text, declared] = this.pick([
      ['secret', `client_secret: ${c}`, true],
      ['password', `{"password": "${c}"}`, true],
      ['db_password', `db_password=${c}`, false],
      ['client_secret', `client_secret=${c}`, false],
      ['token', `access_token: ${c}`, true],
    ] as const);
    return {
      text,
      planted: [{ canary: c, rule: 'name', ...(text.startsWith('{"') ? { jsonKey: true } : {}) }],
      entries: [{ value: part, source: declared ? 'declared:P' : 'env:P' }],
    };
  }

  /** R2-L1-09: a tail glued after a quote inside a value; hidden whole (correction 7: a quote glued
   *  to more text does not end the value; before it, E-2's allowed tail when an opening quote stood
   *  before the name, as in the last three). */
  tail(): Fragment {
    const c = this.canary();
    const k = this.pick(CREDENTIAL_KEYS);
    const [text, rule] = this.pick([
      [`${k}=Xk9'}q${c}`, 'tail'],
      [`${k}=Xk9")q${c} next`, 'tail'],
      [`${k}=ab']${c}`, 'tail'],
      [`${k}='abc'${c}`, 'quoted-tail'],
      [`${k}="abc"${c}`, 'quoted-tail'],
      [`echo 'run ${k}=Xk9'}q${c}`, 'tail'],
      [`"note ${k}=abc"${c}`, 'tail'],
      [`'x ${k}=abc'${c}`, 'tail'],
    ] as const);
    return { text, planted: [{ canary: c, rule }], entries: [] };
  }

  /** A quote left open, of either character at levels 0–3; or a contraction (an apostrophe, H-4). */
  opener(): Fragment {
    const level = this.int(0, 3);
    const q = this.pick(['"', "'"] as const);
    const text = this.chance(0.75)
      ? `note ${bs(level)}${q}x`
      : this.pick([`echo can${bs(level)}'t connect`, `don${bs(level)}'t`, `users' list`, `{"k":"`]);
    return { text, planted: [], entries: [] };
  }

  /**
   * H-1: a value opened by an escaped quote (levels 1–3, either character), maybe after an opener
   * of the same quote earlier on the line (a non-apostrophe one, or a contraction of `'`): alone, as
   * a flag's value, with a tail glued after its own quote, two glued (the second a tail), or (I-1)
   * with a blank or tab after the opening quote and no closer on its line.
   */
  escapedValue(): Fragment {
    const level = this.int(1, 3);
    const q = this.pick(['"', "'"] as const);
    const o = `${bs(level)}${q}`;
    const k = this.pick(CREDENTIAL_KEYS);
    const openers: readonly string[] =
      q === "'" ? ['', `note ${o}x `, `echo can${o}t connect; export `] : ['', `say ${o}hi `];
    const before = this.pick(openers);
    const c = this.canary();
    const form = this.int(0, 4);
    if (form === 4)
      return {
        // Correction 4 (I-1): a blank or a tab right after the opening quote, and no closing quote
        // on the line — read as an unquoted value, past the blank.
        text: `${before}${k}=${o}${this.pick([' ', '\t', '  '])}${c}`,
        planted: [{ canary: c, rule: 'name' }],
        entries: [],
      };
    if (form === 0)
      return {
        text: `${before}${k}=${o}${c}${o}${this.pick(['', ' && go', ' x'])}`,
        planted: [{ canary: c, rule: 'name' }],
        entries: [],
      };
    if (form === 1)
      return {
        text: `${before}mysql --${this.pick(FLAG_NAMES)} ${o}${c}${o} -h db`,
        planted: [{ canary: c, rule: 'flag' }],
        entries: [],
      };
    if (form === 2)
      return {
        // `c\'F`: a letter before the closing quote's run and after it, an apostrophe (H-4).
        text: `${before}${k}=${o}abc${o}${c}`,
        planted: [{ canary: c, rule: 'quoted-tail' }],
        entries: [],
      };
    const second = this.canary();
    return {
      text: `${before}${k}=${o}${c}${o}${o}${second}${o}`,
      planted: [
        { canary: c, rule: 'name' },
        { canary: second, rule: 'tail' },
      ],
      entries: [],
    };
  }

  /** H-2: a backslash run (1–3), a path or an escape's letter right before a credential name. */
  backslashName(): Fragment {
    const c = this.canary();
    const k = this.chance(0.5) ? 'token' : this.pick(CREDENTIAL_KEYS);
    const pre = this.pick(['C:\\app\\', '\\', '\\\\', '\\\\\\', 'a\\n', 'a\\t', 'x\\r']);
    const sep = this.pick(['=', ': ', ':', '==']);
    return {
      text: `${pre}${k}${sep}${c}`,
      planted: [{ canary: c, rule: 'name' }],
      entries: [],
    };
  }

  /** H-4: the shell-escaped apostrophe inside a value, maybe after a non-apostrophe opener of the
   *  same quote or a contraction (not an opener); hidden whole (correction 7: a quote glued to more
   *  text does not end the value; before it, E-2's allowed tail after such an opener). */
  apostropheTail(): Fragment {
    const level = this.int(1, 2);
    const c = this.canary();
    const k = this.pick(CREDENTIAL_KEYS);
    const before = this.pick(['', `note ${bs(level)}'x `, `it${bs(level)}'s set `]);
    return {
      text: `${before}${k}=ab${bs(level)}'cd${c}`,
      planted: [{ canary: c, rule: 'tail' }],
      entries: [],
    };
  }

  /** The reader's quote soup: what goes before a name, the name, a separator, a value, what follows. */
  soup(): Fragment {
    const pre = this.pick(SOUP_PRE);
    const name = this.pick(SOUP_NAMES);
    const sep = this.pick(SOUP_SEPS);
    const post = this.pick(SOUP_POST);
    if (this.chance(0.35)) {
      const value = this.pick(SOUP_PLAIN_VALUES);
      return { text: `${pre}${name}${sep}${value}${post}`, planted: [], entries: [] };
    }
    const c = this.canary(true);
    const wrap = this.pick(SOUP_WRAP);
    return {
      text: `${pre}${name}${sep}${wrap(c)}${post}`,
      planted: [{ canary: c, rule: 'name' }],
      entries: [],
    };
  }

  /** A JSON object mixing credential keys (canaries) and plain keys, maybe nested and re-encoded. */
  jsonNode(depth: number): { node: JsonNode; planted: Planted[]; entries: DisclosureEntryLike[] } {
    const planted: Planted[] = [];
    const entries: DisclosureEntryLike[] = [];
    const nodes: Array<readonly [string, JsonNode]> = [];
    const n = this.int(1, 4);
    for (let i = 0; i < n; i++) {
      const roll = this.rnd();
      if (roll < 0.35) {
        const c = this.canary();
        nodes.push([this.pick(CREDENTIAL_KEYS), { kind: 'str', text: c }]);
        planted.push({ canary: c, rule: 'name', jsonKey: true });
      } else if (roll < 0.5 && depth < 2) {
        const inner = this.jsonNode(depth + 1);
        const asString = this.chance(0.5);
        planted.push(...encodedMore(inner.planted, asString ? 1 : 0));
        entries.push(...inner.entries);
        if (asString) {
          const w = writeJson(inner.node, this.chance(0.2));
          nodes.push([this.pick(PLAIN_KEYS), { kind: 'str', text: w }]);
        } else nodes.push([this.pick(PLAIN_KEYS), inner.node]);
      } else if (roll < 0.62) {
        const f = this.pick([
          this.url(),
          this.scheme(),
          this.nameValue(),
          this.tokenRun(),
          this.backslashName(),
        ]);
        planted.push(...encodedMore(f.planted, 1));
        nodes.push([this.pick(PLAIN_KEYS), { kind: 'str', text: f.text }]);
      } else {
        nodes.push([this.pick(PLAIN_KEYS), { kind: 'str', text: this.pick(PLAIN_WORDS) }]);
      }
    }
    return { node: { kind: 'obj', entries: nodes }, planted, entries };
  }

  json(): Fragment {
    const { node, planted, entries } = this.jsonNode(0);
    return { text: writeJson(node, this.chance(0.2)), planted, entries };
  }

  pyRepr(): Fragment {
    const c = this.canary();
    const k = this.pick(CREDENTIAL_KEYS);
    return {
      text: `{'user': 'bob', '${k}': '${c}', 'n': 1}`,
      planted: [{ canary: c, rule: 'name' }],
      entries: [],
    };
  }

  plain(): Fragment {
    const text = this.pick([
      'ok',
      `level=info user=bob`,
      `it's fine`,
      'x.token == true && y.secret != null',
      '${secret:DB_PASS}',
      'max_tokens=4096',
      'note="hello there"',
      // Neither law reads these as a name and a value (an element, prose): no canary goes there.
      '<token>abc</token>',
      'the password is set',
    ] as const);
    return { text, planted: [], entries: [] };
  }

  /**
   * Correction 5 (J-1): a quoted value whose same-token closer is not on its line. Either its closer
   * stands on the next line (both paths: a level-0 quote, or a backslash run and a quote; either
   * quote character) — the value runs through the line break; or (level 0) it has no closer at all
   * and more lines follow — the value ends on its own line, and the later lines' canaries are
   * `l0-bound` (every earlier law hid them).
   */
  nextLine(): Fragment {
    const q = this.pick(['"', "'"] as const);
    const k = this.pick(CREDENTIAL_KEYS);
    const c = this.canary();
    if (this.rnd() < 0.6) {
      const level = this.pick([0, 1, 1, 2] as const);
      const o = `${bs(level)}${q}`;
      const second = this.canary();
      return {
        text: `${k}=${o}${c}\n${second}${o}${this.pick(['', ' rest', ' && go'])}`,
        planted: [
          { canary: c, rule: 'name' },
          { canary: second, rule: 'name' },
        ],
        entries: [],
      };
    }
    const later = [this.canary(), this.canary()];
    return {
      text: `${k}=${q}${c}\n${this.pick(['Completed:', 'middle', 'next'])} ${later[0]}\n${this.pick(['Created:', 'more', 'end'])} ${later[1]}`,
      planted: [
        { canary: c, rule: 'name' },
        ...later.map((x): Planted => ({ canary: x, rule: 'l0-bound' })),
      ],
      entries: [],
    };
  }

  /**
   * Correction 6 (C6-3): a level-0 quoted value whose first line ends with a backslash before a raw
   * line break, LF or CRLF — one logical line: the value runs on to its closer on the third physical
   * line, every part hidden (round 1 hid the later parts after `"` and showed them after `'`, LF and
   * CRLF alike; corrections 2–4 hid them; correction 5 showed the CRLF form's later parts).
   * Ordinary canaries (`name`), expected hidden.
   */
  continuation(): Fragment {
    const q = this.pick(['"', "'"] as const);
    const k = this.pick(CREDENTIAL_KEYS);
    const eol = this.pick(['\n', '\r\n'] as const);
    const parts = [this.canary(), this.canary(), this.canary()];
    return {
      text: `${k}=${q}${parts[0]}\\${eol}${parts[1]}${eol}${parts[2]}${q}${this.pick(['', ' rest', ' && go'])}`,
      planted: parts.map((c): Planted => ({ canary: c, rule: 'name' })),
      entries: [],
    };
  }

  fragment(): Fragment {
    const r = this.rnd();
    if (r < 0.14) return this.nameValue();
    if (r < 0.21) return this.json();
    if (r < 0.25) return this.flag();
    if (r < 0.29) return this.scheme();
    if (r < 0.32) return this.tokenRun();
    if (r < 0.37) return this.url();
    if (r < 0.39) return this.r30();
    if (r < 0.41) return this.pem();
    if (r < 0.45) return this.member();
    if (r < 0.48) return this.namePartMember();
    if (r < 0.55) return this.tail();
    if (r < 0.58) return this.pyRepr();
    if (r < 0.64) return this.plain();
    if (r < 0.72) return this.opener();
    if (r < 0.8) return this.escapedValue();
    if (r < 0.86) return this.backslashName();
    if (r < 0.9) return this.apostropheTail();
    if (r < 0.94) return this.nextLine();
    if (r < 0.96) return this.continuation();
    return this.soup();
  }

  text(): GeneratedText {
    // Fragments in any order: one that leaves a quote open changes which quote is open where every
    // later one on its line starts.
    const n = this.int(1, 4);
    const parts: Fragment[] = [];
    for (let i = 0; i < n; i++) parts.push(this.fragment());
    let text = parts[0]!.text;
    for (let i = 1; i < parts.length; i++) {
      const glue = this.pick(GLUE);
      text += glue + parts[i]!.text;
    }
    let planted = parts.flatMap((p) => p.planted);
    const entries = parts.flatMap((p) => p.entries);
    // An encoding around the whole text, or a raw quote around a one-line text; either opens a
    // quote before every name.
    const oneLine = !text.includes('\n');
    let times = 0;
    const wrap = this.rnd();
    if (wrap < 0.15) {
      text = JSON.stringify(text);
      times = 1;
    } else if (wrap < 0.25) {
      text = JSON.stringify({ log: text, n: 1 });
      times = 1;
    } else if (wrap < 0.3) {
      text = JSON.stringify(JSON.stringify({ out: text }));
      times = 2;
    } else if (wrap < 0.4 && oneLine) {
      const q = wrap < 0.35 ? '"' : "'";
      text = `${q}${text}${q}`;
    }
    planted = encodedMore(planted, times);
    // R29 (allowed): a quoted key written as a JSON string twice or more is not read by the name
    // rule; the canary under it is classified here, where it was encoded.
    planted = planted.map((p) =>
      p.jsonKey === true && (p.encoded ?? 0) >= 2 ? { ...p, rule: 'r29-level3' } : p,
    );
    return { text, planted, entries };
  }
}

/** `count` generated texts from `seed`. */
export function generateTexts(seed: number, count: number): GeneratedText[] {
  const g = new Gen(seeded(seed));
  const out: GeneratedText[] = [];
  for (let i = 0; i < count; i++) out.push(g.text());
  return out;
}

/** The named shapes of the round-2 rows (the rows this correction makes hide again, and I11's). */
export const NAMED_SHAPES: readonly GeneratedText[] = [
  {
    shape: 'R2-L1-07',
    text: 'url=${DB_PASSWORD:FAKEdefault9}',
    planted: [{ canary: 'FAKEdefault9', rule: 'name' }],
    entries: [],
  },
  {
    shape: 'R2-L1-08 declared',
    text: 'client_secret: FAKEcsvalue9',
    planted: [{ canary: 'FAKEcsvalue9', rule: 'name' }],
    entries: [{ value: 'secret', source: 'declared:S' }],
  },
  {
    shape: 'R2-L1-08 environment',
    text: 'db_password=FAKEhunter9',
    planted: [{ canary: 'FAKEhunter9', rule: 'name' }],
    entries: [{ value: 'db_password', source: 'env:E' }],
  },
  {
    shape: "R2-L1-09 '}",
    text: "password=Xk9'}qFAKEtail7",
    planted: [{ canary: 'FAKEtail7', rule: 'tail' }],
    entries: [],
  },
  {
    shape: 'R2-L1-09 ")',
    text: 'password=Xk9")qFAKEtail7 next',
    planted: [{ canary: 'FAKEtail7', rule: 'tail' }],
    entries: [],
  },
  {
    shape: "R2-L1-09 ']",
    text: "api_key=ab']FAKEtail77",
    planted: [{ canary: 'FAKEtail77', rule: 'tail' }],
    entries: [],
  },
  {
    shape: 'R2-L1-09 quoted',
    text: "password='abc'FAKEtail88",
    planted: [{ canary: 'FAKEtail88', rule: 'quoted-tail' }],
    entries: [],
  },
  {
    shape: 'R2-L1-10 ==',
    text: 'password==FAKEeqStart9',
    planted: [{ canary: 'FAKEeqStart9', rule: 'name' }],
    entries: [],
  },
  // Round 3 (R3-L1-08, -10, -12; the reader's `L1-probes/leak.mjs`; the audit's PR3-C3AUD2-05).
  {
    shape: "R3-L1-08 \\' after can\\'t",
    text: "echo can\\'t connect; export PASSWORD=\\'FAKEsh0729bcd\\' && go",
    planted: [{ canary: 'FAKEsh0729bcd', rule: 'name' }],
    entries: [],
  },
  {
    shape: "R3-L1-08 \\' after a non-apostrophe \\'",
    text: "note \\'x export PASSWORD=\\'FAKEsh0729bcf\\' && go",
    planted: [{ canary: 'FAKEsh0729bcf', rule: 'name' }],
    entries: [],
  },
  {
    shape: "R3-L1-08 \\' alone",
    text: "export PASSWORD=\\'FAKEsh0729bcg\\' && go",
    planted: [{ canary: 'FAKEsh0729bcg', rule: 'name' }],
    entries: [],
  },
  {
    shape: "R3-L1-08 a flag after don\\'t",
    text: "echo don\\'t; mysql --password \\'FAKEsh0729bch\\' -h db",
    planted: [{ canary: 'FAKEsh0729bch', rule: 'flag' }],
    entries: [],
  },
  {
    shape: 'R3-L1-08 a stray \\" then a JSON value',
    text: '{"detail":"expected \\" near here","password":"FAKEdj0729bcd","ok":1}',
    planted: [{ canary: 'FAKEdj0729bcd', rule: 'name', jsonKey: true }],
    entries: [],
  },
  {
    shape: 'R3-L1-08 the same, once more encoded',
    text: JSON.stringify({
      error: '{"detail":"expected \\" near here","password":"FAKEdj0729bcf","ok":1}',
    }),
    planted: [{ canary: 'FAKEdj0729bcf', rule: 'name', jsonKey: true, encoded: 1 }],
    entries: [],
  },
  {
    shape: 'R3-L1-08 \\"hi then a \\"-quoted value',
    text: '{"msg":"say \\"hi password=\\"FAKEdk0729bcd\\" x"}',
    planted: [{ canary: 'FAKEdk0729bcd', rule: 'name' }],
    entries: [],
  },
  {
    shape: 'R3-L1-08 the same, once more encoded (level 3)',
    text: JSON.stringify({ out: '{"msg":"say \\"hi password=\\"FAKEdk0729bcf\\" x"}' }),
    planted: [{ canary: 'FAKEdk0729bcf', rule: 'name', encoded: 1 }],
    entries: [],
  },
  {
    shape: 'R3-L1-08 level 2, raw',
    text: 'x \\\\"q password=\\\\"FAKEl2q0729bc\\\\" y',
    planted: [{ canary: 'FAKEl2q0729bc', rule: 'name' }],
    entries: [],
  },
  {
    shape: 'R3-L1-10 \\\\token==',
    text: '\\\\token==FAKEev0729bcd x',
    planted: [{ canary: 'FAKEev0729bcd', rule: 'name' }],
    entries: [],
  },
  {
    shape: 'R3-L1-10 C:\\app\\token: raw',
    text: 'C:\\app\\token: FAKEev0729bcf',
    planted: [{ canary: 'FAKEev0729bcf', rule: 'name' }],
    entries: [],
  },
  {
    shape: 'R3-L1-10 C:\\app\\token: in a JSON string',
    text: JSON.stringify({ p: 'C:\\app\\token: FAKEev0729bcg' }),
    planted: [{ canary: 'FAKEev0729bcg', rule: 'name', encoded: 1 }],
    entries: [],
  },
  {
    shape: "R3-L1-12 it\\'s, then ab\\'cd in a value",
    text: "it\\'s set DB_PASSWORD=ab\\'cdFAKEap0729bcd",
    planted: [{ canary: 'FAKEap0729bcd', rule: 'tail' }],
    entries: [],
  },
  {
    shape: 'PR3-C3AUD2-05 two \\"-quoted values glued',
    text: 'password=\\"FAKEgp0729bcd\\"\\"FAKEgp0729bcf\\" next',
    planted: [
      { canary: 'FAKEgp0729bcd', rule: 'name' },
      { canary: 'FAKEgp0729bcf', rule: 'tail' },
    ],
    entries: [],
  },
  {
    shape: "PR3-C3AUD2-05 two \\'-quoted values glued",
    text: "password=\\'FAKEgp0729bcg\\'\\'FAKEgp0729bch\\' next",
    planted: [
      { canary: 'FAKEgp0729bcg', rule: 'name' },
      { canary: 'FAKEgp0729bch', rule: 'tail' },
    ],
    entries: [],
  },
  {
    shape: 'PR3-C3AUD2-05 two \\"-quoted values glued, in a JSON log',
    text: JSON.stringify({ log: 'password="FAKEgp0729bcj""FAKEgp0729bck"', n: 1 }),
    planted: [
      { canary: 'FAKEgp0729bcj', rule: 'name', encoded: 1 },
      { canary: 'FAKEgp0729bck', rule: 'tail', encoded: 1 },
    ],
    entries: [],
  },
  {
    shape: "PR3-C3AUD2-05 two \\\\'-quoted values glued, in a JSON log",
    text: JSON.stringify({ log: "password=\\'FAKEgp0729bcl\\'\\'FAKEgp0729bcm\\'", n: 1 }),
    planted: [
      { canary: 'FAKEgp0729bcl', rule: 'name', encoded: 1 },
      { canary: 'FAKEgp0729bcm', rule: 'tail', encoded: 1 },
    ],
    entries: [],
  },
  // Correction 4 (round 4): I-1, an escaped-quote-opened value with a leading blank or tab and no
  // closer on its line (PR3-R4-R-01); I-2, two level-0 quoted values glued by the same quote
  // character (PR3-R4-R-03).
  {
    shape: 'R4-I1 \\" and a blank, then a line break',
    text: 'password=\\" FAKEhbl0729bcd\nnext line',
    planted: [{ canary: 'FAKEhbl0729bcd', rule: 'name' }],
    entries: [],
  },
  {
    shape: 'R4-I1 \\" and a blank, in a JSON log',
    text: '{"log":"password=\\" FAKEhbl0729bcf","next":"field"}',
    planted: [{ canary: 'FAKEhbl0729bcf', rule: 'name' }],
    entries: [],
  },
  {
    shape: 'R4-I1 \\" and a tab, then a line break',
    text: 'password=\\"\tFAKEhbl0729bcg\nnext line',
    planted: [{ canary: 'FAKEhbl0729bcg', rule: 'name' }],
    entries: [],
  },
  {
    shape: "R4-I2 two '-quoted values glued",
    text: "password='FAKEisq0729bcd''FAKEisq0729bcf' rest",
    planted: [
      { canary: 'FAKEisq0729bcd', rule: 'name' },
      { canary: 'FAKEisq0729bcf', rule: 'tail' },
    ],
    entries: [],
  },
  {
    shape: 'R4-I2 two "-quoted values glued',
    text: 'password="FAKEidq0729bcd""FAKEidq0729bcf" rest',
    planted: [
      { canary: 'FAKEidq0729bcd', rule: 'name' },
      { canary: 'FAKEidq0729bcf', rule: 'tail' },
    ],
    entries: [],
  },
  {
    shape: "R4-I2 two '-quoted values glued, in a JSON log",
    text: JSON.stringify({ log: "password='FAKEisq0729bcg''FAKEisq0729bch' rest", n: 1 }),
    planted: [
      { canary: 'FAKEisq0729bcg', rule: 'name', encoded: 1 },
      { canary: 'FAKEisq0729bch', rule: 'tail', encoded: 1 },
    ],
    entries: [],
  },
  {
    shape: 'R4-I2 two "-quoted values glued, in a \'-quoted log',
    text: "{'log': 'password=\"FAKEidq0729bcg\"\"FAKEidq0729bch\" rest', 'n': 1}",
    planted: [
      { canary: 'FAKEidq0729bcg', rule: 'name' },
      { canary: 'FAKEidq0729bch', rule: 'tail' },
    ],
    entries: [],
  },
  // R2-L1-04: I11 only (its canaries are hidden by both laws).
  {
    shape: 'R2-L1-04 a',
    text: `secret='a "token":"b" c', next="visible"`,
    planted: [],
    entries: [],
  },
  {
    shape: 'R2-L1-04 b',
    text: `password="p1 token:'s2' x", y="visible"`,
    planted: [],
    entries: [],
  },
  {
    shape: 'R2-L1-04 c',
    text: `{"password":"abc token:\\"zz\\" q","y":"visible"}`,
    planted: [],
    entries: [],
  },
  { shape: 'R2-L1-04 d', text: `auth="x secret=yy z" other="visible"`, planted: [], entries: [] },
  // Correction 5 (J-1): a quoted value whose closer stands on the next line, on the backslash
  // path (`\\"`: red against correction 2 only before the fix; `\\'`: red against none); and the
  // level-0 bound (two breaks; no closer at all), red against none before the fix.
  {
    shape: 'C5-J1 \\" closer on the next line',
    text: 'password=\\"FAKEjc50729bcd\nFAKEjc50729bcf\\" rest',
    planted: [
      { canary: 'FAKEjc50729bcd', rule: 'name' },
      { canary: 'FAKEjc50729bcf', rule: 'name' },
    ],
    entries: [],
  },
  {
    shape: "C5-J1 \\' closer on the next line",
    text: "password=\\'FAKEjc50729bcg\nFAKEjc50729bch\\' rest",
    planted: [
      { canary: 'FAKEjc50729bcg', rule: 'name' },
      { canary: 'FAKEjc50729bch', rule: 'name' },
    ],
    entries: [],
  },
  {
    shape: 'C5-J1 level 0, two breaks',
    text: 'password="FAKEjc50729bcj\nmiddle FAKEjc50729bck\nFAKEjc50729bcl" rest',
    planted: [
      { canary: 'FAKEjc50729bcj', rule: 'name' },
      { canary: 'FAKEjc50729bck', rule: 'l0-bound' },
      { canary: 'FAKEjc50729bcl', rule: 'l0-bound' },
    ],
    entries: [],
  },
  {
    shape: 'C5-J1 level 0, no closer',
    text: 'password="FAKEjc50729bcm\nCompleted: FAKEjc50729bcn\nCreated: FAKEjc50729bcp',
    planted: [
      { canary: 'FAKEjc50729bcm', rule: 'name' },
      { canary: 'FAKEjc50729bcn', rule: 'l0-bound' },
      { canary: 'FAKEjc50729bcp', rule: 'l0-bound' },
    ],
    entries: [],
  },
  // Correction 6 (C6-3): a backslash before a raw line break continues the level-0 value (a logical
  // line), the closer on the third physical line. Before the fix the CRLF form was red against
  // round 1, correction 2, correction 3 and correction 4 (correction 5 showed its later parts); the
  // LF form red against none.
  {
    shape: 'C6-3 backslash continuation, CRLF',
    text: 'password="FAKEjd60729bca\\\r\nFAKEjd60729bcb\r\nFAKEjd60729bcc" rest',
    planted: [
      { canary: 'FAKEjd60729bca', rule: 'name' },
      { canary: 'FAKEjd60729bcb', rule: 'name' },
      { canary: 'FAKEjd60729bcc', rule: 'name' },
    ],
    entries: [],
  },
  {
    shape: 'C6-3 backslash continuation, LF',
    text: 'password="FAKEjd60729bcd\\\nFAKEjd60729bce\nFAKEjd60729bcf" rest',
    planted: [
      { canary: 'FAKEjd60729bcd', rule: 'name' },
      { canary: 'FAKEjd60729bce', rule: 'name' },
      { canary: 'FAKEjd60729bcf', rule: 'name' },
    ],
    entries: [],
  },
  // Correction 7 (C7-1, C7-2, C7-2b): the shapes of the law's cells, so every reference holds them.
  // Before the fix each glued tail and each credential after a cut scheme word was shown by
  // corrections 2–6 (round 1 hid it); `db_pwd`, `passphrase` and `Pwd` no reference reads.
  ...(['\n', '\r\n'] as const).map((e) => ({
    shape: `C7-1 + C7-2 the lane's shape, ${e === '\n' ? 'LF' : 'CRLF'}`,
    text: `token='FAKEc7a1\\${e}FAKEc7a2${e}FAKEc7a3' rest  refreshToken=Xk9'}qFAKEc7a4`,
    planted: [
      { canary: 'FAKEc7a1', rule: 'name' as const },
      { canary: 'FAKEc7a2', rule: 'name' as const },
      { canary: 'FAKEc7a3', rule: 'name' as const },
      { canary: 'FAKEc7a4', rule: 'tail' as const },
    ],
    entries: [],
  })),
  ...[
    "echo 'run password=Xk9'}qFAKEc7c1",
    '"note password=Xk9"FAKEc7c2',
    "'x password=Xk9'FAKEc7c3",
    "echo 'run password=Xk9')FAKEc7c4",
    "echo 'run password=ab']FAKEc7c5",
    "note \\'x password=ab\\'cdFAKEc7c6",
  ].map((text, i) => ({
    shape: `C7-2 a glued quote ${i + 1}`,
    text,
    planted: [{ canary: `FAKEc7c${i + 1}`, rule: 'tail' as const }],
    entries: [],
  })),
  ...(
    [
      ['{"a":"Authorization: Bearer FAKEc7j1"}', 'scheme'],
      ['{"log":"connect failed\\npassphrase=FAKEc7j2"}', 'name'],
      ['{"p":"C:\\\\app\\\\token: FAKEc7j3"}', 'name'],
      [JSON.stringify('{"p":"password=FAKEc7j4"}'), 'name'],
      ['["password=FAKEc7j5"]', 'name'],
    ] as const
  ).map(([text, rule], i) => ({
    shape: `C7-2 the JSON closer run ${i + 1}`,
    text,
    planted: [{ canary: `FAKEc7j${i + 1}`, rule }],
    entries: [],
  })),
  {
    shape: 'C7-1 + C7-2 C1 soup, LF',
    text: 'refreshToken="FAKEc7d1\\\nFAKEc7d2\nFAKEc7d3"  [passwd: ab"FAKEc7d4\' y',
    planted: [
      { canary: 'FAKEc7d1', rule: 'name' },
      { canary: 'FAKEc7d2', rule: 'name' },
      { canary: 'FAKEc7d3', rule: 'name' },
      { canary: 'FAKEc7d4', rule: 'tail' },
    ],
    entries: [],
  },
  ...['db_pwd', 'passphrase', 'Pwd'].map((name) => ({
    shape: `C7-1 + C7-2 C1b ${name}, LF`,
    text: `Password='FAKEc7e1\\\nFAKEc7e2\nFAKEc7e3' rest & ${name}=Xk9'}qFAKEc7e4`,
    planted: [
      { canary: 'FAKEc7e1', rule: 'name' as const },
      { canary: 'FAKEc7e2', rule: 'name' as const },
      { canary: 'FAKEc7e3', rule: 'name' as const },
      { canary: 'FAKEc7e4', rule: 'tail' as const },
    ],
    entries: [],
  })),
  {
    shape: 'C7-1 + C7-2 C1c, LF',
    text: 'TOKEN=\'FAKEc7f1\nmiddle FAKEc7f2\nend FAKEc7f3\taccess_token=FAKEc7f4&  credentials="FAKEc7f5\\\nFAKEc7f6\nFAKEc7f7" rest  db.password=Xk9")qFAKEc7f8 next',
    planted: [
      { canary: 'FAKEc7f1', rule: 'name' },
      { canary: 'FAKEc7f2', rule: 'l0-bound' },
      { canary: 'FAKEc7f3', rule: 'l0-bound' },
      { canary: 'FAKEc7f4', rule: 'name' },
      { canary: 'FAKEc7f5', rule: 'name' },
      { canary: 'FAKEc7f6', rule: 'name' },
      { canary: 'FAKEc7f7', rule: 'name' },
      { canary: 'FAKEc7f8', rule: 'tail' },
    ],
    entries: [],
  },
  {
    shape: 'C7-2 the encoded one-line form',
    text: JSON.stringify(
      "it x' passwd='FAKEc7g1\\\nFAKEc7g2\nFAKEc7g3' go  refreshToken=Xk9'}qFAKEc7g4",
    ),
    planted: [
      { canary: 'FAKEc7g1', rule: 'name' },
      { canary: 'FAKEc7g2', rule: 'name' },
      { canary: 'FAKEc7g3', rule: 'name' },
      { canary: 'FAKEc7g4', rule: 'tail' },
    ],
    entries: [],
  },
  ...(
    [
      ["echo 'run \\\nAuthorization: Bearer' FAKEc7i1", 'A'],
      ["token='FAKEc7i2\\\nFAKEc7i3\nFAKEc7i4' rest 'x Authorization: Bearer' FAKEc7i5", 'B'],
      ["-H 'Authorization: Bearer' FAKEc7i6", 'C'],
      ["'x Authorization: Bearer'' FAKEc7k1", 'E'],
      ["'x Authorization: Bearer''' FAKEc7k2", 'F'],
      ["-H 'Authorization: Bearer'' FAKEc7k4", 'G'],
    ] as const
  ).map(([text, id]) => ({
    shape: `C7-2b the scheme word past a cut quote (${id})`,
    text,
    planted: [
      ...(id === 'B'
        ? (['FAKEc7i2', 'FAKEc7i3', 'FAKEc7i4'] as const).map((canary) => ({
            canary,
            rule: 'name' as const,
          }))
        : []),
      { canary: /FAKEc7[ik]\d+$/.exec(text)![0], rule: 'scheme' as const },
    ],
    entries: [],
  })),
  // Correction 7, correction 1 (G-1): a quote before a written `\n` glues; the value runs to its
  // terminator, as round 1 read it (corrections 2–6, and correction 7 as first delivered, showed
  // what follows).
  ...(
    [
      ["'x password=Xk9'\\nFAKEc7n1", 'FAKEc7n1', 'name'],
      ["'x Authorization: Bearer'\\nFAKEc7n2", 'FAKEc7n2', 'scheme'],
      ["note \\'x password=ab\\'\\ncdFAKEh5", 'FAKEh5', 'name'],
    ] as const
  ).map(([text, canary, rule], i) => ({
    shape: `C7-2 correction 1, a quote before a written line break ${i + 1}`,
    text,
    planted: [{ canary, rule }],
    entries: [],
  })),
  // Correction 7, correction 1 (C1-5): a value's own closing quote glued to more text; round 1 hid
  // every tail, corrections 2–7 showed them.
  ...(
    [
      ["token=''}FAKEc7p1", ['FAKEc7p1']],
      ["token='FAKEc7p2'}FAKEc7p3", ['FAKEc7p2', 'FAKEc7p3']],
      [`token=''"FAKEc7q1`, ['FAKEc7q1']],
      ["token='']FAKEc7q2", ['FAKEc7q2']],
      ["token='')FAKEc7q3", ['FAKEc7q3']],
      [`token='"'}FAKEc7q4`, ['FAKEc7q4']],
    ] as const
  ).map(([text, canaries], i) => ({
    shape: `C7-2 correction 1, the own closer glued ${i + 1}`,
    text,
    planted: canaries.map((canary, j) => ({
      canary,
      rule: canaries.length === 2 && j === 0 ? ('name' as const) : ('tail' as const),
    })),
    entries: [],
  })),
];

/** One comparison's finding: a canary a reference hid and the current law showed, or an I11 break. */
export interface DifferentialFinding {
  kind: 'shown' | 'i11';
  text: string;
  canary?: string;
  rule?: PlantRule;
  shape?: string;
}

/** Runs the comparison over `texts`: every planted canary (outside the allowed list) a reference
 *  hides is hidden by `current`; and `current` changes nothing on a second pass (I11). */
export function compareLaws(
  current: Law,
  references: readonly Law[],
  texts: readonly GeneratedText[],
): DifferentialFinding[] {
  const findings: DifferentialFinding[] = [];
  for (const t of texts) {
    const once = current(t.text, t.entries);
    if (current(once, t.entries) !== once)
      findings.push({
        kind: 'i11',
        text: t.text,
        ...(t.shape !== undefined ? { shape: t.shape } : {}),
      });
    if (t.planted.length === 0) continue;
    const cur = hiddenBy(current, t);
    for (const ref of references) {
      const r = hiddenBy(ref, t);
      t.planted.forEach((p, i) => {
        if (ALLOWED_DIFFERENCES.has(p.rule)) return;
        if (r[i] === true && cur[i] !== true)
          findings.push({
            kind: 'shown',
            text: t.text,
            canary: p.canary,
            rule: p.rule,
            ...(t.shape !== undefined ? { shape: t.shape } : {}),
          });
      });
    }
  }
  return findings;
}
