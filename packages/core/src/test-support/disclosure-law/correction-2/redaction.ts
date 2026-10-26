// FROZEN REFERENCE (test support; not part of the package). This file is
// packages/core/src/utils/redaction.ts exactly as it stood at commit 6ec70b57 (PR-3 correction 2,
// the working-branch commit its delivery is cut from), below this header. The disclosure
// differential cell compares the current law against it. Never edit it: a change here
// changes what the cell guards.

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
  return `‹${length} ${length === 1 ? 'character' : 'characters'}, not kept›`;
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
 *  characters›`, `‹string, 1 character›`, `‹object, 3 keys›`, `‹cycle›`, …): a member such as
 *  `characters` must not match inside them; and a walked key's `[REDACTED]#2` (F25). */
const NAMED_MARKER =
  /\[REDACTED(?:_EMAIL|: not checked)?\](?:#\d+)?|\[redacted-live-claim\]|‹\d+ characters?, not kept›|‹(?:string, \d+ characters?|array, \d+ items?|object, \d+ keys?|number|boolean|bigint|symbol|function|cycle)›/g;

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
    /** Required (D-8): a set built without the environment never claims it was swept. */
    environment: EnvironmentState;
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
    environment: options.environment,
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
 * inert-config policy: validity, consequence, remedy, re-admission). It names the secret, and (F37)
 * the manifest and the `config` keys that refer to it — never its value.
 */
export function unmaskableWarning(
  source: string,
  where?: { manifest: string; keys: readonly string[] },
): string {
  const name = source.startsWith('declared:') ? source.slice('declared:'.length) : source;
  const referredBy =
    where === undefined
      ? ''
      : ` (in ${where.manifest}${where.keys.length > 0 ? `, at ${where.keys.join(', ')}` : ''})`;
  return (
    `Secret '${name}'${referredBy} is shorter than ${DISCLOSURE_FLOORS.declared} characters, so realm cannot recognise it in printed text without hiding ordinary words. ` +
    `It shows wherever it appears outside a credential's name: in replies, logs, exports and Slack posts (after a name such as password=, a surface that hides every kind still hides it). ` +
    `Fix: give it a value of at least ${DISCLOSURE_FLOORS.declared} characters. ` +
    `It is hidden again from the next load at which it is that long.`
  );
}

/** The declared part of a set: its state, and why when it is not `resolved`. */
export interface DeclaredStanding {
  declared: DeclaredState;
  declaredCause?: DeclaredCause;
}

const DECLARED_RANK: Readonly<Record<DeclaredState, number>> = {
  unknown: 0,
  partial: 1,
  resolved: 2,
};

/**
 * D-11 (F11): the standing of a reply that covers several projects (`list_workflows`): the weakest
 * state of theirs (unknown < partial < resolved) and the first cause that is not `resolved`. No
 * standing given is `unknown`, cause `embedder_none`.
 */
export function weakestDeclared(standings: readonly DeclaredStanding[]): DeclaredStanding {
  if (standings.length === 0) return { declared: 'unknown', declaredCause: 'embedder_none' };
  let declared: DeclaredState = 'resolved';
  for (const s of standings)
    if (DECLARED_RANK[s.declared] < DECLARED_RANK[declared]) declared = s.declared;
  const cause = standings.find(
    (s) => s.declared !== 'resolved' && s.declaredCause !== undefined,
  )?.declaredCause;
  return {
    declared,
    ...(declared !== 'resolved' && cause !== undefined ? { declaredCause: cause } : {}),
  };
}

/** `set` with another declared standing (its members unchanged: D-11 keeps them the union). */
export function withDeclaredStanding(
  set: DisclosureSet,
  standing: DeclaredStanding,
): DisclosureSet {
  const { declaredCause: _old, ...rest } = set;
  return {
    ...rest,
    declared: standing.declared,
    ...(standing.declaredCause !== undefined ? { declaredCause: standing.declaredCause } : {}),
  };
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

/** Launcher keys whose values are public by name (issue #407; exact, case-sensitive), and the
 *  shell's own path metadata (D-6): the shell sets `PWD`, `OLDPWD` and `_` to paths, and a secret is
 *  never only such a path. A value another variable also holds stays a member (the shadow rule). */
const EXCLUDED_LAUNCHER_METADATA = new Set([
  'npm_package_name',
  'npm_package_version',
  'npm_lifecycle_event',
  'PWD',
  'OLDPWD',
  '_',
]);
/**
 * D-14: realm's own settings, excluded by name — every `REALM_*` variable realm's code reads from
 * the environment that holds a setting (an enum, a number, a flag or a name), never a credential.
 * Derived from the source (`git grep -ohE "REALM_[A-Z0-9_]+" -- 'packages/**\/src/**'`, then each
 * read classified); a cell re-derives it, so a new setting must be classified here or in
 * {@link REALM_CREDENTIAL_VARIABLES}. A value another, non-exempt variable also holds stays hidden.
 */
export const REALM_SETTING_VARIABLES: ReadonlySet<string> = new Set([
  'REALM_DEV', // a flag ('1')
  'REALM_MCP_FORM_WAIT_SECONDS', // a number of seconds
  'REALM_MCP_GATE_ANSWERS', // an enum: asked, offered, withheld
  'REALM_NO_NUDGE', // a flag ('1')
  'REALM_OPERATOR', // a name (attribution, axis 1)
  'REALM_REQUIRE_WRITER_NONCE', // a flag
]);
/** D-14: realm's own variables that hold a credential: never excluded. */
export const REALM_CREDENTIAL_VARIABLES: ReadonlySet<string> = new Set(['REALM_SERVE_TOKEN']);
/** Values public by shape: 2- or 3-segment dotted versions (issue #407). (Booleans are under the
 *  environment floor, so they never reach this test.) */
const PUBLIC_VALUE_SHAPE = /^\d+\.\d+(\.\d+)?$/;
/** D-7: the names whose values are personal (shown on `private` and `file`), beside values at or
 *  under HOME. Never "any value equal to USER's": a password equal to the user name stays hidden. */
const PERSONAL_NAMES = new Set(['HOME', 'USER', 'LOGNAME', 'USERNAME']);
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
 * exempt variable holds is still hidden when another, non-exempt variable holds it too. HOME, USER,
 * LOGNAME and USERNAME, and values at or under HOME, are members on agent, broadcast and log
 * audiences, and exempt on private and file audiences (the operator's own terminal and record; D-7).
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
    if (
      value === undefined ||
      exempt.has(name) ||
      EXCLUDED_LAUNCHER_METADATA.has(name) ||
      REALM_SETTING_VARIABLES.has(name)
    )
      continue;
    if (value.length < DISCLOSURE_FLOORS.environment || PUBLIC_VALUE_SHAPE.test(value)) continue;
    const personal =
      PERSONAL_NAMES.has(name) ||
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
      : { environment: 'swept' as const }),
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
  // D-5 (F9): `secrets` (never `tokens`: `max_tokens` is a count), and the store and framework keys.
  'passphrase',
  'pwd',
  'secretkeybase',
  'encryptionkey',
  'masterkey',
  'secrets',
]);

/** A key's segments: split at camelCase, at an acronym before a capitalised word, and at `-`, `_`,
 *  `.` (D-5: `db.password`) and spaces; lower-cased. */
function keySegments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[-_.\s]+/)
    .filter((s) => s !== '')
    .map((s) => s.toLowerCase());
}

/** Whether a key names a credential (the value at it is hidden whatever its length). A key whose
 *  ONLY segment is `pwd` is the shell's working folder when its value is a path (E-6': it starts
 *  with `/` or `~`), and a password otherwise; without a value it is read as the folder (D-5). */
export function isCredentialName(key: string, value?: string): boolean {
  const segments = keySegments(key);
  if (segments.length === 1 && segments[0] === 'pwd') return value !== undefined && !isPath(value);
  for (let k = 1; k <= segments.length; k++) {
    if (CREDENTIAL_NAMES.has(segments.slice(segments.length - k).join(''))) return true;
  }
  return false;
}

/** E-6': a value that starts with `/` or `~` is a path. */
function isPath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('~');
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

/** The characters a `token=` run takes, beside positions already marked (moved unchanged from the
 *  CLI's composer). */
const TOKEN_RUN_CHAR = /[A-Za-z0-9._-]/;
/** The body characters of a `Basic` or `Bearer` credential (RFC 7235's token68; `=` padding follows). */
const TOKEN68_CHAR = /[A-Za-z0-9._~+/-]/;
/** D-4: a scheme anchor marks only a token-shaped run: at least {@link TOKEN_MIN} characters holding a
 *  digit, an uppercase letter, `+`, `/` or `=`. An ordinary word after `Basic` or `Bearer` is shown. */
const TOKEN_SHAPED = /[0-9A-Z+/=]/;
const TOKEN_MIN = 8;
/** The scheme anchors (token-shaped runs only, D-4). */
const SCHEME_ANCHORS: readonly string[] = ['Bearer ', 'Basic '];
/** The longest key-like name read back from a `=` or `:` — quoted, or bare. A bare name has no `.`,
 *  so the name read in `db.password=` is `password`. */
const NAME_MAX = 200;
/** A bare name's characters. */
const NAME_CHAR = /[A-Za-z0-9_-]/;
/** An `Authorization` value's scheme word (`Bearer`, `Basic`, `Digest`, …). */
const AUTH_SCHEME = /^[A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]*$/;
/** Where a value outside quotes ends (RECORD 05 "name rule"). */
const VALUE_END = /[\s&;,]/;
/** D-1: what may follow a quote that closes a value (a PEM body's string, a quoted value). */
const AFTER_CLOSING_QUOTE = /[\s,})\]]/;
/** E-2: what may follow a quoted value's own quote for it to close the value: D-1's set, the
 *  characters that end an unquoted value, and a quote (the end of a string holding it). Any other
 *  character glues a tail to the value. */
const AFTER_OWN_QUOTE = /[\s,;&})\]"']/;
/** E-3': the letters of an escaped line break or tab (`\n`, `\t`, `\r`). */
const ESCAPE_LETTER = /[ntr]/;
/** E-2': a letter on both sides of `'` makes it an apostrophe ("it's"): it never opens a quote
 *  (it may close one). */
const LETTER = /[A-Za-z]/;
/** A URL scheme's characters (`scheme://user:<SECRET>@host`). */
const SCHEME_CHAR = /[A-Za-z0-9+.-]/;
/** D-5: where a URL's userinfo region stops (a `"` too: a URL holds none unencoded, and a JSON
 *  string's end must not reach a later field's `@`). */
const URL_STOP = /[\s/"]/;
/** E-4: `${secret:IDENT}` is a reference only with the manifest's grammar (IDENT = `[A-Z0-9_]+`,
 *  `manifest/secret-refs.ts`), then `}`. */
const SECRET_REFERENCE = /^[A-Z0-9_]+\}/;
/** D-5: a PEM block's armour lines. */
const PEM_BEGIN = '-----BEGIN ';
const PEM_END = '-----END ';
const PEM_DASHES = '-----';

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

/** Marks the patterns of {@link disclose}'s `all` tier. Every scan is linear in the text: each
 *  starts at a fixed anchor or separator and reads a bounded name back from it, never a pattern
 *  tried at every position (a 200,000-character value made the regex form quadratic). */
function markPatterns(
  text: string,
  marks: Uint8Array,
  blocked: Uint8Array,
  mark: (from: number, to: number) => void,
): void {
  const n = text.length;
  // E-3: a name is read twice — stopped at a position marked BEFORE this pass (a member: so
  // `x<member>password: v` reads `password`), and through it (so a member that spells part of the
  // name, `client_<secret>`, still lets the name read whole). Never through a named marker (I11).
  const preMarked = marks.slice();

  // The scheme anchors: a token-shaped token68 run (D-4), through positions a member marked.
  for (const anchor of SCHEME_ANCHORS) {
    for (let i = text.indexOf(anchor); i !== -1; i = text.indexOf(anchor, i + 1)) {
      const start = i + anchor.length;
      let end = start;
      while (
        end < n &&
        blocked[end] !== 1 &&
        (marks[end] !== 0 || TOKEN68_CHAR.test(text.charAt(end)))
      )
        end++;
      while (end < n && blocked[end] !== 1 && text.charAt(end) === '=') end++;
      const run = text.slice(start, end);
      if (run.length >= TOKEN_MIN && TOKEN_SHAPED.test(run)) mark(start, end);
    }
  }
  // `token=`: the run after it, whatever its shape.
  for (let i = text.indexOf('token='); i !== -1; i = text.indexOf('token=', i + 1)) {
    const start = i + 'token='.length;
    let end = start;
    while (
      end < n &&
      blocked[end] !== 1 &&
      (marks[end] !== 0 || TOKEN_RUN_CHAR.test(text.charAt(end)))
    )
      end++;
    if (end > start) mark(start, end);
  }

  // A URL's userinfo (D-5): `scheme://user:<SECRET>@host` (the user may be empty; the password runs
  // to the last `@` before the region's end), or a colon-less `scheme://<TOKEN>@host` of 8+. E-7: one
  // forward pass finds the region's end, its last `@` and its first `:`; a `://` inside the region
  // just read shares that region, and the `:` pointer only moves forward, so the rule is linear.
  let regionStop = -1;
  let regionLastAt = -1;
  let colonAt = 0;
  for (let i = text.indexOf('://'); i !== -1; i = text.indexOf('://', i + 3)) {
    let s = i;
    while (s > 0 && SCHEME_CHAR.test(text.charAt(s - 1))) s--;
    while (s < i && !/[A-Za-z]/.test(text.charAt(s))) s++;
    if (s === i) continue;
    const from = i + 3;
    if (from >= regionStop) {
      regionStop = from;
      regionLastAt = -1;
      while (regionStop < n && !URL_STOP.test(text.charAt(regionStop))) {
        if (text.charAt(regionStop) === '@') regionLastAt = regionStop;
        regionStop++;
      }
    }
    const at = regionLastAt;
    if (at < from) continue;
    if (colonAt < from) colonAt = from;
    while (colonAt < at && text.charAt(colonAt) !== ':') colonAt++;
    if (colonAt < at) {
      if (at > colonAt + 1) mark(colonAt + 1, at);
    } else if (at - from >= TOKEN_MIN) {
      mark(from, at);
    }
  }

  // A quote that closes a value (D-1): followed by the end, white space, `,`, `}`, `]` or `)`.
  const closesValue = (k: number): boolean => {
    const ch = text.charAt(k);
    return (
      (ch === '"' || ch === "'") && (k + 1 >= n || AFTER_CLOSING_QUOTE.test(text.charAt(k + 1)))
    );
  };
  // A value that ends at a closing quote leaves that quote's escape (`\"` in JSON held inside a
  // JSON string) outside the value, so the text around it stays what it was (C2).
  const beforeEscape = (from: number, end: number): number => {
    let e = end;
    if (e < n && closesValue(e)) while (e > from && text.charAt(e - 1) === '\\') e--;
    return e;
  };

  // A PEM block's body (D-5): from its BEGIN armour line to the first of its END armour line, the
  // quote that closes the string holding it, or the end of the text — never past that quote, so a
  // JSON text stays JSON. The blank space at the body's edges (and an encoded text's escaped line
  // breaks `\n`, `\r`) is kept, so the armour lines still read as lines. Linear: each body is read
  // once, the next BEGIN is looked for after it, and the END is searched for again only once the
  // last one found lies behind.
  // A blank at k — white space, or a line break escaped at any encoding level (a run of
  // backslashes, then `n` or `r`) — and its length; 0 when there is none.
  const blankAt = (k: number): number => {
    if (/[ \t\r\n]/.test(text.charAt(k))) return 1;
    let e = k;
    while (text.charAt(e) === '\\') e++;
    return e > k && /[nr]/.test(text.charAt(e)) ? e - k + 1 : 0;
  };
  let endArmourAt = -2;
  for (let i = text.indexOf(PEM_BEGIN); i !== -1;) {
    const close = text.indexOf(PEM_DASHES, i + PEM_BEGIN.length);
    if (close === -1) break;
    let from = close + PEM_DASHES.length;
    if (endArmourAt !== -1 && endArmourAt < from) endArmourAt = text.indexOf(PEM_END, from);
    const limit = endArmourAt === -1 ? n : endArmourAt;
    let to = from;
    while (to < limit && !closesValue(to)) to++;
    const resume = to;
    to = beforeEscape(from, to);
    for (let w = blankAt(from); w > 0 && from < to; w = blankAt(from)) from += w;
    // The body's end never splits an escape: a trailing blank, escaped line break or backslash run
    // stays outside it.
    while (to > from) {
      if (/[ \t\r\n]/.test(text.charAt(to - 1))) {
        to -= 1;
        continue;
      }
      const run = /[nr]/.test(text.charAt(to - 1)) ? to - 2 : to - 1;
      let e = run;
      while (e >= from && text.charAt(e) === '\\') e--;
      if (e === run) break;
      to = e + 1;
    }
    if (to > from) mark(from, to);
    i = text.indexOf(PEM_BEGIN, Math.max(i + 1, resume));
  }

  // E-2: the quotes open where each position starts, on its line. A quote is `"` or `'` after a run
  // of L backslashes — one token per character and L, so a JSON string held inside a JSON string
  // has its own `\"` — and toggles its token; a line break closes them all; a `'` with a letter on
  // both sides is an apostrophe, which never opens a quote but closes an open one (E-2'). One
  // forward pass.
  // The letter before it is a letter of the text, not an escape's (`\n'x` is a line break, then a
  // quote).
  const apostrophe = (k: number): boolean =>
    k > 0 &&
    LETTER.test(text.charAt(k - 1)) &&
    text.charAt(k - 2) !== '\\' &&
    LETTER.test(text.charAt(k + 1));
  const quoteToken = (k: number): number => {
    const ch = text.charAt(k);
    if (ch !== '"' && ch !== "'") return -1;
    let level = 0;
    while (k - level > 0 && text.charAt(k - level - 1) === '\\') level++;
    // Sixteen levels of each quote (four encodings deep); a quote under more backslashes is no
    // token, so it never ends a value (it hides more, never less).
    if (level > 15) return -1;
    return (ch === '"' ? 0 : 1) + 2 * level;
  };
  const openAt = new Uint32Array(n + 1);
  let openNow = 0;
  for (let k = 0; k < n; k++) {
    openAt[k] = openNow;
    if (text.charAt(k) === '\n') openNow = 0;
    else {
      const token = quoteToken(k);
      const bit = token === -1 ? 0 : (1 << token) >>> 0;
      if (bit !== 0 && ((openNow & bit) !== 0 || !(text.charAt(k) === "'" && apostrophe(k))))
        openNow = (openNow ^ bit) >>> 0;
    }
  }
  openAt[n] = openNow;

  // Where an unquoted value ends: whitespace, `&`, `;`, `,`, or (E-2) a quote whose token was open
  // before the value's name on its line, with that quote's escape left outside the value.
  const unquotedEnd = (from: number, open: number): number => {
    let end = from;
    while (end < n) {
      const ch = text.charAt(end);
      if (VALUE_END.test(ch)) break;
      if (open !== 0) {
        const token = quoteToken(end);
        if (token !== -1 && (open & (1 << token)) !== 0) {
          let e = end;
          while (e > from && text.charAt(e - 1) === '\\') e--;
          return e;
        }
      }
      end++;
    }
    return end;
  };
  // F21 / E-7: the high-water mark of the unquoted scans. An unquoted value (or a quoted value's
  // glued tail) starting inside the last unquoted run resumes at that run's end: a quote open before
  // the earlier name is still open before the later one, so the run's end ends the later value too.
  // Only the part past the old end is marked, so repeated separators stay linear. A quoted value is
  // read from its own start (E-7), never from the mark.
  let highWater = -1;
  const unquotedRun = (from: number, open: number, extend?: (end: number) => number): void => {
    const start = Math.max(from, highWater);
    let end = unquotedEnd(start, open);
    if (extend !== undefined) end = extend(end);
    highWater = Math.max(highWater, end);
    if (end > start) mark(start, end);
  };
  // The first character of a value (past blanks and an opening quote), for the `pwd` rule (E-6').
  const valueHead = (valueStart: number): string => {
    let k = valueStart;
    while (k < n && (text.charAt(k) === ' ' || text.charAt(k) === '\t')) k++;
    if (text.charAt(k) === '\\' && text.charAt(k + 1) === '"') k += 2;
    else if (text.charAt(k) === '"' || text.charAt(k) === "'") k += 1;
    return text.charAt(k);
  };
  const markValue = (name: string, valueStart: number, open: number): void => {
    let start = valueStart;
    while (start < n && (text.charAt(start) === ' ' || text.charAt(start) === '\t')) start++;
    if (start >= n) return;
    // I11: a value that is already a marker (an earlier pass hid it) is left as it is: its end was
    // decided when it was hidden.
    const opening = text.charAt(start);
    const first =
      opening === '"' || opening === "'"
        ? start + 1
        : opening === '\\' && text.charAt(start + 1) === '"'
          ? start + 2
          : start;
    if (blocked[first] === 1) return;
    const q = text.charAt(start);
    if (q === '"' || q === "'") {
      // E-2: a quoted value runs from its own start to its own quote (unescaped; an apostrophe
      // closes it too, E-2'). That quote closes the value when what follows may follow a value; otherwise a tail
      // is glued to it (`'abc'x`, R2-L1-09) and the value goes on as an unquoted value would.
      const from = start + 1;
      let k = from;
      while (k < n) {
        const ch = text.charAt(k);
        if (ch === '\\') {
          k += 2;
          continue;
        }
        if (ch === q) break;
        k++;
      }
      if (k >= n) {
        mark(from, n);
        return;
      }
      if (k > from) mark(from, k);
      // The quote stays, so a later pass reads the same quoted value (I11).
      if (k + 1 < n && !AFTER_OWN_QUOTE.test(text.charAt(k + 1))) unquotedRun(k + 1, open);
      return;
    }
    if (q === '\\' && text.charAt(start + 1) === '"') {
      // An escaped JSON value (`\"v\"`, D-5): to its own `\"`, which closes it under the same rule
      // (an escape after it — `\n`, `\"` — counts as what may follow).
      const from = start + 2;
      const k = text.indexOf('\\"', from);
      if (k === -1) {
        mark(from, n);
        return;
      }
      if (k > from) mark(from, k);
      const after = text.charAt(k + 2);
      if (k + 2 < n && !AFTER_OWN_QUOTE.test(after) && after !== '\\') unquotedRun(k + 2, open);
      return;
    }
    unquotedRun(start, open, (end) => {
      // `authorization`: the scheme word and the credential after it. Only when the first run is a
      // scheme word (RFC 9110 auth-scheme), so a marker already there extends nothing (I11).
      if (
        keySegments(name).at(-1) === 'authorization' &&
        text.charAt(end) === ' ' &&
        AUTH_SCHEME.test(text.slice(start, end))
      ) {
        const next = unquotedEnd(end + 1, open);
        if (next > end + 1) return next;
      }
      return end;
    });
  };

  // A name read back from `e`: quoted (`"name"`, `'name'`, an escaped JSON key `\"name\"`, D-5), back
  // to its opening quote, at most NAME_MAX characters, no newline; or bare. `through`: read through
  // positions a member marked (E-3).
  const readName = (e: number, through: boolean): { name: string; start: number } | undefined => {
    const free = (k: number): boolean => blocked[k] !== 1 && (through || preMarked[k] === 0);
    const q = text.charAt(e - 1);
    if (e > 1 && (q === '"' || q === "'") && free(e - 1)) {
      const escaped = q === '"' && text.charAt(e - 2) === '\\';
      const last = escaped ? e - 3 : e - 2;
      let b = last;
      while (b >= 0 && last - b < NAME_MAX) {
        const ch = text.charAt(b);
        if (ch === q || ch === '\n' || !free(b)) break;
        if (!escaped && ch === '\\') break;
        b--;
      }
      const opened = escaped
        ? b >= 1 && text.charAt(b) === '"' && text.charAt(b - 1) === '\\'
        : b >= 0 && text.charAt(b) === q;
      if (opened && b < last)
        return { name: text.slice(b + 1, last + 1), start: escaped ? b - 1 : b };
    }
    // E-3': a bare name stops before an escape's letter (`n`, `t` or `r` after a backslash), so a
    // name right after an encoded line break or tab (`\npassword=`) is read whole, never `npassword`.
    let b = e;
    while (
      b > 0 &&
      e - b < NAME_MAX &&
      NAME_CHAR.test(text.charAt(b - 1)) &&
      free(b - 1) &&
      !(ESCAPE_LETTER.test(text.charAt(b - 1)) && text.charAt(b - 2) === '\\')
    )
      b--;
    return b < e ? { name: text.slice(b, e), start: b } : undefined;
  };

  // A credential name before `=`, `:` or `":"`: the name is read back from each separator.
  for (let c = 0; c < n; c++) {
    const sep = text.charAt(c);
    if (sep !== '=' && sep !== ':') continue;
    // E-5: `==`, `!=`, `<=` and `>=` compare only with white space on both sides
    // (`x.token == true`); `password==v` is a value that starts with `=`.
    if (sep === '=') {
      const op =
        text.charAt(c + 1) === '='
          ? ([c, c + 2] as const)
          : /[=!<>]/.test(text.charAt(c - 1))
            ? ([c - 1, c + 1] as const)
            : undefined;
      if (op !== undefined && /\s/.test(text.charAt(op[0] - 1)) && /\s/.test(text.charAt(op[1])))
        continue;
    }
    let e = c;
    while (e > 0 && (text.charAt(e - 1) === ' ' || text.charAt(e - 1) === '\t')) e--;
    const head = valueHead(c + 1);
    let found = readName(e, false);
    if (found === undefined || !isCredentialName(found.name, head)) {
      const whole = readName(e, true);
      if (whole === undefined || !isCredentialName(whole.name, head)) continue;
      found = whole;
    }
    // E-4: `${secret:IDENT}` names a secret; it holds none.
    if (
      sep === ':' &&
      found.name === 'secret' &&
      text.slice(found.start - 2, found.start) === '${' &&
      SECRET_REFERENCE.test(text.slice(c + 1, c + 2 + NAME_MAX))
    )
      continue;
    markValue(found.name, c + 1, openAt[found.start]!);
  }

  // `--name value` flags (D-5): a credential-named flag hides the next word; `--name=value` is the
  // separator rule above. E-7: the flags are read in a pass of their own, so the mark starts again.
  highWater = -1;
  for (let i = text.indexOf('--'); i !== -1; i = text.indexOf('--', i + 2)) {
    if (i > 0 && !/\s/.test(text.charAt(i - 1))) continue;
    let e = i + 2;
    while (e < n && e - i - 2 < NAME_MAX && NAME_CHAR.test(text.charAt(e))) e++;
    if (e === i + 2 || text.charAt(e) !== ' ') continue;
    const next = text.charAt(e + 1);
    if (next === '' || next === '-' || /\s/.test(next)) continue;
    const name = text.slice(i + 2, e);
    if (isCredentialName(name, valueHead(e + 1))) markValue(name, e + 1, openAt[i]!);
  }
}
