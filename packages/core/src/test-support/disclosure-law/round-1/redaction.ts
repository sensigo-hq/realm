// FROZEN REFERENCE (test support; not part of the package). This file is
// packages/core/src/utils/redaction.ts exactly as it stood at commit a3bf69b1 (round 1),
// below this header. The disclosure differential cell compares the current law
// against it. Never edit it: a change here changes what the cell guards.

// Shared redaction/bounding primitives (issue #111 extraction — were inline in
// adapters/adapter-utils.ts's redactErrorBody). Neutral module: no imports from engine/ or
// adapters/, so both can depend on it without creating an import cycle between them.

import { variantsOf } from './redaction-variants.js';

/** The realistic PII an API error body or a resolved evidence value echoes back: an email address. */
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

/** Scrubs email addresses from `s`, replacing each with `[REDACTED_EMAIL]`. */
export function scrubEmail(s: string): string {
  return s.replace(EMAIL_PATTERN, '[REDACTED_EMAIL]');
}

/** Shared length cap for a bounded string, in characters. */
export const REDACTION_CHAR_CAP = 500;

/** B0: what a bounded value too long to keep whole becomes — never a cut start of it (RECORD 01 #2). */
export function notKeptMarker(length: number): string {
  return `‹${length} characters, not kept›`;
}

/**
 * B0 (#729 PR-3; RECORD 01 #2): a value is kept whole when it fits the cap, else replaced by
 * {@link notKeptMarker}. No proper prefix of a value is ever stored or printed (I4): a cut start of
 * a value can be the start of a secret, which no later mask can recognise.
 */
export function boundWhole(text: string, cap: number): string {
  return text.length <= cap ? text : notKeptMarker(text.length);
}

/** Bounds `text` at {@link REDACTION_CHAR_CAP} characters by {@link boundWhole}. */
export function capText(text: string): string {
  return boundWhole(text, REDACTION_CHAR_CAP);
}

/**
 * Bounds an arbitrary resolved value (issue #111) for durable storage in a `SkipDetail`'s
 * `resolved_value` — type-faithful for scalars (`null`/`undefined`/`boolean`/`number` pass
 * through verbatim, so the typo case's "absent" vs. "present but falsy" distinction survives),
 * bounded whole ({@link boundWhole}) and email-scrubbed for strings/objects (the same bounding
 * discipline as `redactErrorBody`, applied to an evidence value instead of an error body).
 */
export function boundResolvedValue(v: unknown): unknown {
  if (v === null || v === undefined || typeof v === 'boolean' || typeof v === 'number') {
    return v;
  }
  if (typeof v === 'string') return scrubEmail(boundWhole(v, REDACTION_CHAR_CAP));
  let s: string;
  try {
    s = JSON.stringify(v) ?? String(v);
  } catch {
    s = '<unserializable>';
  }
  return scrubEmail(boundWhole(s, REDACTION_CHAR_CAP));
}

/**
 * The escaped, bounded value renderer (issue #625 PR-2a, F2; F5 renders the precondition refusal's
 * value through it): a free-text or step-output value as one line a surface can print — written as
 * JSON, so a newline, an escape character or any other control character is its escape sequence and
 * can neither start a line nor drive a terminal (the C1 controls and the Unicode line separators,
 * which JSON leaves as they are, are escaped too); THEN bounded whole and email-scrubbed by
 * {@link boundResolvedValue}. Escaping comes first because it can grow a value up to six times
 * (`\u001b` for one character), and the cap must hold on what is printed. `undefined` reads
 * `undefined`.
 */
export function escapedBoundedValue(v: unknown): string {
  let json: string;
  if (v === undefined) {
    json = 'undefined';
  } else {
    try {
      json = JSON.stringify(v) ?? String(v);
    } catch {
      json = '<unserializable>';
    }
  }
  const escaped = json.replace(
    // eslint-disable-next-line no-control-regex -- the control characters are what is escaped
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return boundResolvedValue(escaped) as string;
}

// ── #729 PR-3: the disclosure law ───────────────────────────────────────────────────────────────
// ONE law for every exit (RECORD 01 #1–#5): the store keeps execution values raw, and each surface
// masks what it shows for its audience. Pure: the caller passes the environment and the declared
// values in (core stays I/O-free). PR-M1 later swaps the matcher inside `disclose` with no caller
// change; it keeps `tier`, the kind codes, `unchecked` and the anchors.

/** The marker a hidden run becomes. */
export const REDACTED_MARKER = '[REDACTED]';
/** PR-M1's marker for a region it could not check. Named here so `disclose` never matches inside it. */
export const NOT_CHECKED_MARKER = '[REDACTED: not checked]';
/** Export's marker for a live claim token. */
export const LIVE_CLAIM_MARKER = '[redacted-live-claim]';
/** {@link scrubEmail}'s marker. */
export const REDACTED_EMAIL_MARKER = '[REDACTED_EMAIL]';

/** Every named marker (I11): `disclose` never matches inside one, so disclosing twice changes
 *  nothing. With D6's five, the shapes `disclosure-walk.ts`'s `shapeOf` writes (`‹string, 12
 *  characters›`, `‹object, 3 keys›`, `‹cycle›`, …): a member such as `characters` must not match
 *  inside them. */
const NAMED_MARKER =
  /\[REDACTED(?:_EMAIL|: not checked)?\]|\[redacted-live-claim\]|‹\d+ characters, not kept›|‹(?:string, \d+ characters|array, \d+ items|object, \d+ keys|number|boolean|bigint|symbol|function|cycle)›/g;

/**
 * #729 PR-3 (D1 D5): the named markers an INBOUND value carries — an answer, a model's output, a
 * run's params — in its strings and keys. An agent shown `[REDACTED]` may send it back; Realm records
 * what was sent, so the sender is told.
 */
export function markersIn(value: unknown): string[] {
  const found = new Set<string>();
  const seen = new Set<object>();
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      for (const m of node.matchAll(NAMED_MARKER)) found.add(m[0]);
      return;
    }
    if (node === null || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    for (const [key, child] of Object.entries(node)) {
      visit(key);
      visit(child);
    }
  };
  visit(value);
  return [...found];
}

/** The warning for an inbound value that carries a named marker (four clauses; no value). */
export function inboundMarkerWarning(markers: readonly string[]): string {
  return (
    `This answer holds ${markers.map((m) => `'${m}'`).join(', ')}: a value Realm hid when it showed it, sent back. ` +
    'Realm records what was sent, the marker included, so the run now holds the marker, not the value. ' +
    'Send the value itself, or leave the field out. ' +
    'An answer with no marker is recorded as sent.'
  );
}

/** The floors, in one place (RECORD 01 #5): an environment value shorter than 8 characters is not
 *  swept (the owner's Q2); a declared value shorter than 4 cannot be masked without hiding ordinary
 *  text, so it is reported in `unmaskable` (I8), never dropped silently. */
export const DISCLOSURE_FLOORS = { environment: 8, declared: 4 } as const;

/** Who reads a surface (RECORD 01 #12; 05 "audiences"). */
export type DisclosureAudience = 'agent' | 'broadcast' | 'log' | 'private' | 'file';
/** `declared` hides declared members only (question text, private terminals); `all` adds the
 *  environment members and the patterns. */
export type DisclosureTier = 'declared' | 'all';
/** Whether the declared values are known. */
export type DeclaredState = 'resolved' | 'partial' | 'unknown';
/** Why they are not (or `resolved` with zero members because there is no manifest). */
export type DeclaredCause = 'no_manifest' | 'load_failed' | 'embedder_none' | 'manifest_changed';
/** Whether the environment was swept. */
export type EnvironmentState = 'swept' | 'not_swept';
/** Why not (D1 §3.7): the host set the members itself and passed no environment. */
export type EnvironmentCause = 'host_set';

/** One value to hide, with where it came from (a name, never shown on a shared surface). */
export interface DisclosureEntry {
  value: string;
  source: `env:${string}` | `declared:${string}`;
}

/** Kind codes: the higher wins where marks overlap (RECORD 01 #3). */
const KIND = { pattern: 1, environment: 2, declared: 3 } as const;
type MemberKind = typeof KIND.environment | typeof KIND.declared;

/** A compiled set: opaque to callers; built once per (entries, options). */
export interface DisclosureSet {
  readonly audience: DisclosureAudience;
  readonly declared: DeclaredState;
  readonly declaredCause?: DeclaredCause;
  readonly environment: EnvironmentState;
  readonly environmentCause?: EnvironmentCause;
  /** Every form of every member, longest first. */
  readonly forms: readonly {
    readonly form: string;
    readonly kind: MemberKind;
    readonly member: number;
  }[];
  /** Each member's source, by member index (named only on a private surface). */
  readonly sources: readonly string[];
  /** How many declared values are under the declared floor (I8). */
  readonly unmaskable: number;
}

/** The tier a surface applies (RECORD 01 #12): a private terminal hides declared values only (Q3). */
export function tierFor(audience: DisclosureAudience): DisclosureTier {
  return audience === 'private' ? 'declared' : 'all';
}

/**
 * Compiles the entries into a set. A value both declared and in the environment is ONE member,
 * declared. A declared value under {@link DISCLOSURE_FLOORS}.declared is not a member: its source is
 * returned in `unmaskable` for the caller's four-clause load warning (I8). An environment value under
 * the environment floor is not a member (the filter drops it first; this is its second guard).
 */
export function compileDisclosure(
  entries: readonly DisclosureEntry[],
  options: {
    declared: DeclaredState;
    cause?: DeclaredCause;
    audience: DisclosureAudience;
    environment?: EnvironmentState;
    environmentCause?: EnvironmentCause;
  },
): { set: DisclosureSet; unmaskable: string[] } {
  const unmaskable: string[] = [];
  const byValue = new Map<string, { kind: MemberKind; source: string }>();
  for (const entry of entries) {
    const declared = entry.source.startsWith('declared:');
    if (declared && entry.value.length < DISCLOSURE_FLOORS.declared) {
      unmaskable.push(entry.source);
      continue;
    }
    if (!declared && entry.value.length < DISCLOSURE_FLOORS.environment) continue;
    const kind: MemberKind = declared ? KIND.declared : KIND.environment;
    const seen = byValue.get(entry.value);
    if (seen === undefined || seen.kind < kind)
      byValue.set(entry.value, { kind, source: entry.source });
  }
  const sources: string[] = [];
  const formKind = new Map<string, { kind: MemberKind; member: number }>();
  for (const [value, { kind, source }] of byValue) {
    const member = sources.push(source) - 1;
    for (const form of variantsOf(value, { parts: kind === KIND.declared })) {
      if (form === '') continue;
      const prior = formKind.get(form);
      if (prior === undefined || prior.kind < kind) formKind.set(form, { kind, member });
    }
  }
  const forms = [...formKind]
    .map(([form, { kind, member }]) => ({ form, kind, member }))
    .sort((a, b) => b.form.length - a.form.length);
  const set: DisclosureSet = {
    audience: options.audience,
    declared: options.declared,
    ...(options.cause !== undefined ? { declaredCause: options.cause } : {}),
    environment: options.environment ?? 'swept',
    ...(options.environmentCause !== undefined
      ? { environmentCause: options.environmentCause }
      : {}),
    forms,
    sources,
    unmaskable: unmaskable.length,
  };
  return { set, unmaskable };
}

/**
 * The load warning for one declared value under the declared floor (I8; the four clauses of the
 * inert-config policy: validity, consequence, remedy, re-admission). It names the secret, never its
 * value.
 */
export function unmaskableWarning(source: string): string {
  const name = source.startsWith('declared:') ? source.slice('declared:'.length) : source;
  return (
    `Secret '${name}' is shorter than ${DISCLOSURE_FLOORS.declared} characters, so realm cannot hide it in printed text without hiding ordinary words. ` +
    `It will show wherever it appears: in replies, logs, exports and Slack posts. ` +
    `Fix: give it a value of at least ${DISCLOSURE_FLOORS.declared} characters. ` +
    `It is hidden again from the next load at which it is that long.`
  );
}

/** An empty set (a surface with nothing declared and no environment swept). */
export function emptyDisclosureSet(
  audience: DisclosureAudience,
  declared: DeclaredState = 'unknown',
  cause?: DeclaredCause,
): DisclosureSet {
  return compileDisclosure([], {
    declared,
    ...(cause !== undefined ? { cause } : {}),
    audience,
    environment: 'not_swept',
  }).set;
}

// ── The environment filter (RECORD 01 #5; ONE filter, every set builder calls it) ──────────────

/** Launcher keys whose values are public by name (issue #407; exact, case-sensitive). */
const EXCLUDED_LAUNCHER_METADATA = new Set([
  'npm_package_name',
  'npm_package_version',
  'npm_lifecycle_event',
]);
/** Values public by shape: booleans and 2- or 3-segment dotted versions (issue #407). */
const PUBLIC_VALUE_SHAPE = /^(true|false|\d+\.\d+(\.\d+)?)$/;
/** The environment variable that names other variables as not secret (a comma list of NAMES). */
export const NOT_SECRET_ENV = 'REALM_NOT_SECRET';

/** The names `REALM_NOT_SECRET` lists. */
export function notSecretNames(env: Readonly<Record<string, string | undefined>>): string[] {
  const raw = env[NOT_SECRET_ENV];
  return raw === undefined
    ? []
    : raw
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name !== '');
}

/**
 * The environment's members for an audience. A variable is swept when its value is at least
 * {@link DISCLOSURE_FLOORS}.environment characters, is not public by shape, and its name is neither
 * launcher metadata nor exempt. Exempt names = `REALM_NOT_SECRET` ∪ `notSecret` (the caller's
 * intersection of the loaded manifests' `disclosure.not_secret` lists, or a host's list); a value an
 * exempt variable holds is still hidden when another, non-exempt variable holds it too. HOME and USER,
 * and values under HOME, are members on agent, broadcast and log audiences, and exempt on private and
 * file audiences (the operator's own terminal and record).
 */
export function environmentEntries(
  env: Readonly<Record<string, string | undefined>>,
  options: { audience: DisclosureAudience; notSecret?: readonly string[] },
): DisclosureEntry[] {
  const exempt = new Set([NOT_SECRET_ENV, ...notSecretNames(env), ...(options.notSecret ?? [])]);
  const ownSurface = options.audience === 'private' || options.audience === 'file';
  const home = env['HOME'];
  const homePrefix = home !== undefined && home !== '' ? `${home}/` : undefined;
  const out: DisclosureEntry[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || exempt.has(name) || EXCLUDED_LAUNCHER_METADATA.has(name)) continue;
    if (value.length < DISCLOSURE_FLOORS.environment || PUBLIC_VALUE_SHAPE.test(value)) continue;
    const personal =
      name === 'HOME' ||
      name === 'USER' ||
      value === home ||
      (homePrefix !== undefined && value.startsWith(homePrefix));
    if (personal && ownSurface) continue;
    out.push({ value, source: `env:${name}` });
  }
  return out;
}

/**
 * The not-secret names the loaded manifests agree on (RECORD 01 #5; D3/07 R3-7): the INTERSECTION
 * of their `disclosure.not_secret` lists. A manifest with no list contributes none, so one manifest
 * that does not list a name keeps it hidden. No manifest loaded → no names.
 */
export function notSecretIntersection(lists: readonly (readonly string[] | undefined)[]): string[] {
  if (lists.length === 0) return [];
  const [first, ...rest] = lists.map((list) => new Set(list ?? []));
  return [...first!].filter((name) => rest.every((set) => set.has(name)));
}

/**
 * THE set builder (RECORD 05 "the matcher moves into core": the set builder exists once). Every
 * surface builds its set here: the environment's members through {@link environmentEntries} (or
 * none, with `environment: 'not_swept'` and cause `host_set`, when the caller passes no
 * environment), the declared values by name, then {@link compileDisclosure}.
 */
export function buildDisclosureSet(input: {
  env: Readonly<Record<string, string | undefined>> | undefined;
  declared: Readonly<Record<string, string>>;
  declaredState: DeclaredState;
  declaredCause?: DeclaredCause;
  audience: DisclosureAudience;
  notSecret?: readonly string[];
}): { set: DisclosureSet; unmaskable: string[] } {
  const envEntries =
    input.env === undefined
      ? []
      : environmentEntries(input.env, {
          audience: input.audience,
          ...(input.notSecret !== undefined ? { notSecret: input.notSecret } : {}),
        });
  const declaredEntries: DisclosureEntry[] = Object.entries(input.declared).map(
    ([name, value]) => ({ value, source: `declared:${name}` }),
  );
  return compileDisclosure([...envEntries, ...declaredEntries], {
    declared: input.declaredState,
    ...(input.declaredCause !== undefined ? { cause: input.declaredCause } : {}),
    audience: input.audience,
    ...(input.env === undefined
      ? { environment: 'not_swept' as const, environmentCause: 'host_set' as const }
      : {}),
  });
}

// ── The credential-name rule (RECORD 01 #4; 05 "name rule") ───────────────────────────────────

/** ONE joined list: a key matches when the join of its last k segments is in it, for any k. */
const CREDENTIAL_NAMES = new Set([
  'token',
  'secret',
  'password',
  'passwd',
  'apikey',
  'credential',
  'credentials',
  'cookie',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'clientsecret',
  'authorization',
  'secretaccesskey',
  'sessiontoken',
  'privatekey',
  'authtoken',
  'signingsecret',
  'webhooksecret',
  'tokensecret',
  'apitoken',
  'secretkey',
]);

/** A key's segments: split at camelCase, at an acronym before a capitalised word, and at `-`,
 *  `_` and spaces; lower-cased. */
function keySegments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[-_\s]+/)
    .filter((s) => s !== '')
    .map((s) => s.toLowerCase());
}

/** Whether a key names a credential (the value at it is hidden whatever its length). */
export function isCredentialName(key: string): boolean {
  const segments = keySegments(key);
  for (let k = 1; k <= segments.length; k++) {
    if (CREDENTIAL_NAMES.has(segments.slice(segments.length - k).join(''))) return true;
  }
  return false;
}

// ── disclose ──────────────────────────────────────────────────────────────────────────────────

/** What `disclose` found, by kind (counts of hidden runs). */
export interface HiddenCounts {
  declared: number;
  environment: number;
  pattern: number;
}

/** `disclose`'s result. `members` (sources) is filled on a private audience only. */
export interface Disclosed {
  text: string;
  hidden: HiddenCounts;
  unchecked: number;
  members?: string[];
}

/** The characters a `Bearer` or `token=` run takes, beside positions already marked (moved
 *  unchanged from the CLI's composer). */
const TOKEN_RUN_CHAR = /[A-Za-z0-9._-]/;
/** The characters a `Basic` credential takes (RFC 7617's token68: base64 with its padding). */
const TOKEN68_CHAR = /[A-Za-z0-9._~+/=-]/;
/** The anchors whose following run is hidden whatever its value, with the run's characters. */
const TOKEN_ANCHORS: readonly (readonly [string, RegExp])[] = [
  ['Bearer ', TOKEN_RUN_CHAR],
  ['Basic ', TOKEN68_CHAR],
  ['token=', TOKEN_RUN_CHAR],
];
/** The longest key-like name read back from a `=` or `:` — quoted, or bare. A bare name has no `.`,
 *  so the name read in `db.password=` is `password`. */
const NAME_MAX = 200;
/** A bare name's characters. */
const NAME_CHAR = /[A-Za-z0-9_-]/;
/** An `Authorization` value's scheme word (`Bearer`, `Basic`, `Digest`, …). */
const AUTH_SCHEME = /^[A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]*$/;
/** Where a value outside JSON ends (RECORD 05 "name rule"). */
const VALUE_END = /[\s&;,]/;
/** A URL scheme's characters (`scheme://user:<SECRET>@host`). */
const SCHEME_CHAR = /[A-Za-z0-9+.-]/;

/**
 * Hides every member of `set` and, with `tier: 'all'`, every pattern, in `text`. Everything is
 * marked on the ORIGINAL text, then each maximal marked run is written as ONE {@link REDACTED_MARKER}:
 * a short member inside a longer one leaves no fragment, and two side by side become one marker. It
 * never matches inside a named marker (I11), so disclosing twice changes nothing.
 *
 * - members: every form of every member; with `tier: 'declared'` only the declared ones (question
 *   text, a private terminal);
 * - patterns (`tier: 'all'`): `Bearer `, `Basic ` and `token=` runs; a URL's user part; and the
 *   value after any credential name (`<name>=`, `<name>:`, `"<name>": "…"`) — inside JSON to the first
 *   unescaped quote, otherwise to whitespace, `&`, `;` or `,`. For `authorization`, the
 *   scheme word and the credential after it are both hidden.
 *
 * `hidden` counts the runs by the highest kind inside each; `unchecked` is 0 (PR-M1 fills it).
 */
export function disclose(text: string, set: DisclosureSet, tier: DisclosureTier): Disclosed {
  const n = text.length;
  const marks = new Uint8Array(n);
  const blocked = new Uint8Array(n);
  for (const m of text.matchAll(NAMED_MARKER)) blocked.fill(1, m.index, m.index + m[0].length);
  const memberAt = set.audience === 'private' ? new Int32Array(n).fill(-1) : undefined;
  const isBlocked = (from: number, to: number): boolean => {
    for (let k = from; k < to; k++) if (blocked[k] === 1) return true;
    return false;
  };
  const mark = (from: number, to: number, kind: number, member = -1): void => {
    for (let k = from; k < to; k++) {
      if (blocked[k] === 1) continue;
      if (marks[k]! < kind) {
        marks[k] = kind;
        if (memberAt !== undefined) memberAt[k] = member;
      }
    }
  };
  for (const { form, kind, member } of set.forms) {
    if (tier === 'declared' && kind !== KIND.declared) continue;
    for (let i = text.indexOf(form); i !== -1; i = text.indexOf(form, i + 1)) {
      if (!isBlocked(i, i + form.length)) mark(i, i + form.length, kind, member);
    }
  }
  if (tier === 'all')
    markPatterns(text, marks, blocked, (from, to) => mark(from, to, KIND.pattern));
  const hidden: HiddenCounts = { declared: 0, environment: 0, pattern: 0 };
  const members = new Set<number>();
  let out = '';
  let k = 0;
  while (k < n) {
    const from = k;
    if (marks[k] !== 0) {
      let top = 0;
      while (k < n && marks[k] !== 0) {
        top = Math.max(top, marks[k]!);
        if (memberAt !== undefined && memberAt[k]! >= 0) members.add(memberAt[k]!);
        k++;
      }
      if (top === KIND.declared) hidden.declared++;
      else if (top === KIND.environment) hidden.environment++;
      else hidden.pattern++;
      out += REDACTED_MARKER;
    } else {
      while (k < n && marks[k] === 0) k++;
      out += text.slice(from, k);
    }
  }
  return {
    text: out,
    hidden,
    unchecked: 0,
    ...(memberAt !== undefined ? { members: [...members].map((m) => set.sources[m]!) } : {}),
  };
}

/** Marks the patterns of {@link disclose}'s `all` tier. */
function markPatterns(
  text: string,
  marks: Uint8Array,
  blocked: Uint8Array,
  mark: (from: number, to: number) => void,
): void {
  const runFrom = (start: number, chars: RegExp): number => {
    let end = start;
    while (
      end < text.length &&
      blocked[end] !== 1 &&
      (marks[end] !== 0 || chars.test(text.charAt(end)))
    ) {
      end++;
    }
    return end;
  };
  for (const [anchor, chars] of TOKEN_ANCHORS) {
    for (let i = text.indexOf(anchor); i !== -1; i = text.indexOf(anchor, i + 1)) {
      const start = i + anchor.length;
      const end = runFrom(start, chars);
      if (end > start) mark(start, end);
    }
  }
  // Every scan below is linear in the text: each starts at a fixed separator (`://`, `=`, `:`) and
  // reads a bounded name back from it, never a pattern tried at every position (a 200,000-character
  // value made the regex form quadratic).
  const n = text.length;
  // A URL's user part: `scheme://user:<SECRET>@host`.
  for (let i = text.indexOf('://'); i !== -1; i = text.indexOf('://', i + 3)) {
    let s = i;
    while (s > 0 && SCHEME_CHAR.test(text.charAt(s - 1))) s--;
    while (s < i && !/[A-Za-z]/.test(text.charAt(s))) s++;
    if (s === i) continue;
    let u = i + 3;
    while (u < n && !/[\s:@/]/.test(text.charAt(u))) u++;
    if (u === i + 3 || text.charAt(u) !== ':') continue;
    let p = u + 1;
    while (p < n && !/[\s@/]/.test(text.charAt(p))) p++;
    if (p === u + 1 || text.charAt(p) !== '@') continue;
    mark(u + 1, p);
  }
  // A credential name before `=`, `:` or `":"`: the name is read back from each separator.
  for (let c = 0; c < n; c++) {
    const sep = text.charAt(c);
    if (sep !== '=' && sep !== ':') continue;
    let e = c;
    while (e > 0 && (text.charAt(e - 1) === ' ' || text.charAt(e - 1) === '\t')) e--;
    let name: string | undefined;
    if (e > 1 && text.charAt(e - 1) === '"') {
      // A quoted name: back to its opening quote, at most NAME_MAX characters, no `\` or newline.
      let b = e - 2;
      while (b >= 0 && e - 2 - b < NAME_MAX) {
        const ch = text.charAt(b);
        if (ch === '"' || ch === '\\' || ch === '\n') break;
        b--;
      }
      if (b >= 0 && text.charAt(b) === '"' && b < e - 2) name = text.slice(b + 1, e - 1);
    }
    if (name === undefined) {
      let b = e;
      while (b > 0 && e - b < NAME_MAX && NAME_CHAR.test(text.charAt(b - 1))) b--;
      if (b < e) name = text.slice(b, e);
    }
    if (name === undefined || !isCredentialName(name)) continue;
    let start = c + 1;
    while (start < n && (text.charAt(start) === ' ' || text.charAt(start) === '\t')) start++;
    if (start >= n) continue;
    let end: number;
    if (text.charAt(start) === '"') {
      // A JSON string: to the first unescaped quote.
      start += 1;
      end = start;
      while (end < text.length && text.charAt(end) !== '"')
        end += text.charAt(end) === '\\' ? 2 : 1;
      end = Math.min(end, text.length);
    } else {
      end = start;
      while (end < text.length && !VALUE_END.test(text.charAt(end))) end++;
      // `authorization`: the scheme word and the credential after it. Only when the first run is
      // a scheme word (RFC 9110 auth-scheme), so a marker already there extends nothing (I11).
      if (
        keySegments(name).at(-1) === 'authorization' &&
        text.charAt(end) === ' ' &&
        AUTH_SCHEME.test(text.slice(start, end))
      ) {
        let next = end + 1;
        while (next < text.length && !VALUE_END.test(text.charAt(next))) next++;
        if (next > end + 1) end = next;
      }
    }
    if (end > start) mark(start, end);
  }
}
