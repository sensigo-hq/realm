// output/writer.ts — #729 PR-3 (RECORD 01 #11–#14; D3/01, D3/02; prompt 03 L-1, L-2): the ONE
// writer of a realm CLI process. Every byte the process writes to stdout or stderr passes the
// disclosure law for its stream's audience (I12), except `realm mcp`'s JSON-RPC channel, which the
// MCP door's serializer masks instead.
//
// - Audiences, per stream: `broadcast` for `realm listen`, and for `realm agent` under listen or
//   with `--log-mode` (value fields as shapes); `private` for a TTY (the declared tier, Q3); `log`
//   for any other stream (every tier); `off` for `realm mcp`'s channel.
// - Spans (I9, I13): a command a reader is meant to copy is printed whole. A composer marks it with
//   `ctx.cmd(text)`: private-use marks around the text, tagged with an HMAC over its kind and text
//   under a per-process key. The writer shows a verified span as built (a question span at the
//   declared tier), strips every other mark, and masks the rest. A value can never mint a span: it
//   cannot know the key, and `ctx.value` strips marks.
// - The set: the environment part is built at install through core's one filter; when a manifest
//   loads, its declared values are unioned in and the environment part is rebuilt with the
//   manifests' not-secret lists (their intersection).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { writeSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { Writable } from 'node:stream';
import util from 'node:util';
import type { Command } from 'commander';
import {
  buildDisclosureSet,
  disclose,
  discloseByTable,
  type ClassTable,
  notSecretIntersection,
  notSecretNames,
  shapeOf,
  tierFor,
  weakestDeclared,
  withDeclaredStanding,
  WITHHELD_WORDS,
  type WithheldCause,
  type DeclaredStanding,
  type DisclosureAudience,
  type DisclosureSet,
  type DisclosureTally,
  type RunPhase,
  type RunRecord,
  WorkflowError,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { readRunManifest, type RunManifest } from '../lib/read-run-manifest.js';

// ─── Spans ──────────────────────────────────────────────────────────────────────────────────────

const SPAN_START = '\uE000';
const SPAN_MID = '\uE001';
const SPAN_END = '\uE002';
const MARKS = /[\uE000-\uE002]/g;
const SPAN = /\uE000([cqd])([A-Za-z0-9_-]{22})\uE001([^\uE000-\uE002]*)\uE002/g;

/** A span's kind: a command (`c`), question text (`q`), or data built by a class table (`d`). */
type SpanKind = 'c' | 'q' | 'd';

/** The per-process key. Never part of any string the process writes. */
const KEY = randomBytes(32);

function tagOf(kind: SpanKind, text: string): string {
  return createHmac('sha256', KEY)
    .update(kind)
    .update('\0')
    .update(text)
    .digest('base64url')
    .slice(0, 22);
}

function verified(kind: SpanKind, tag: string, text: string): boolean {
  const a = Buffer.from(tag);
  const b = Buffer.from(tagOf(kind, text));
  return a.length === b.length && timingSafeEqual(a, b);
}

function span(kind: SpanKind, text: string): string {
  const clean = stripMarks(text);
  return clean === ''
    ? ''
    : `${SPAN_START}${kind}${tagOf(kind, clean)}${SPAN_MID}${clean}${SPAN_END}`;
}

/** Removes every span mark (U+E000–E002): the edges that leave the process (Slack, a provider) and
 *  any value printed beside a span. */
export function stripMarks(text: string): string {
  return text.replace(MARKS, '');
}

/**
 * F26 (#729 PR-3 correction 1; RECORD 01 #13): a JSON value with every span mark removed from every
 * string in it, keys included — taken BEFORE the value is masked, so a mark planted in run data can
 * never part a credential's name from its value. JSON never escapes U+E000–E002, so the marks are
 * removed from the serialised text and the value read back.
 */
export function withoutMarks<T>(value: T): T {
  const json = JSON.stringify(value);
  return json === undefined ? value : (JSON.parse(stripMarks(json)) as T);
}

// ─── The render context ─────────────────────────────────────────────────────────────────────────

/**
 * What a composer marks with (D3/01): `cmd` a command a reader copies, `value` a value printed
 * beside it. Passed by the caller: print sites pass {@link writerCtx}; every non-print consumer (the
 * MCP person block, a stored string) passes {@link PLAIN}.
 */
export interface RenderCtx {
  cmd(text: string): string;
  /** #729 PR-3 correction 2 (E-11''): a value that stands alone and equals a word of realm's fixed
   *  `vocabulary` (a phase, a gate-answers value, a fixed sentence) prints whole, as a verified span;
   *  any other value is printed as text the writer masks. Never for text mixing words and values. */
  word(value: string, vocabulary: readonly string[]): string;
  value(value: unknown): string;
  /** A value the run holds escaped and bounded (E1 (b); a precondition's value): as written, or on
   *  `broadcast` the shape of the value it escapes (F27) — never the shape of its escaped text. */
  escaped(text: string): string;
}

function plainValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? String(value);
}

/** F27: the value an escaped text spells (the shapes describe it), or the text itself when it spells
 *  none (a `not kept` marker, `undefined`). */
function unescaped(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** The plain context: commands and values as they are. */
export const PLAIN: RenderCtx = {
  cmd: (text) => text,
  word: (value) => value,
  value: plainValue,
  escaped: (text) => text,
};

/** E-11'': the run phases, every one (a phase added to `RunPhase` fails the compile here). */
const RUN_PHASE_SET: Record<RunPhase, true> = {
  running: true,
  gate_waiting: true,
  completed: true,
  failed: true,
  abandoned: true,
  aborted: true,
};
export const RUN_PHASE_WORDS: readonly string[] = Object.keys(RUN_PHASE_SET);

/** The writer's context: commands as verified spans; values as their shapes on `broadcast`, else
 *  their text with every mark stripped (the writer masks it). {@link PLAIN} when no writer runs. */
export function writerCtx(): RenderCtx {
  if (state === undefined) return PLAIN;
  // #729 PR-3 correction 3 (H-7''): a read command under a failed or changed manifest withholds
  // values as a broadcast shows them.
  const shaped = (): boolean => state?.mode === 'broadcast' || valuesWithheldFor() !== undefined;
  return {
    cmd: (text) => span('c', text),
    word: (value, vocabulary) =>
      vocabulary.includes(value) ? span('c', value) : stripMarks(value),
    value: (value) => {
      if (!shaped()) return stripMarks(plainValue(value));
      state!.tally.shaped += 1;
      return plainValue(shapeOf(value));
    },
    escaped: (text) => {
      if (!shaped()) return stripMarks(text);
      state!.tally.shaped += 1;
      return plainValue(shapeOf(unescaped(text)));
    },
  };
}

/**
 * #729 PR-3 correction 3 (H-7''): a read command that prints a run's stored values (`inspect`,
 * `attempts`) turns the withholding rule on, `accepted` when `--accept-partial-disclosure` was given.
 */
export function withholdUnlessAccepted(accepted: boolean): void {
  if (state !== undefined) state.readRule = { accepted };
}

/** H-7'': the cause this read command withholds values for — the rule is on, the flag was not given,
 *  and the process's declared cause is a failed or changed manifest (never `no_manifest`). */
export function valuesWithheldFor(): WithheldCause | undefined {
  if (state?.readRule === undefined || state.readRule.accepted) return undefined;
  const cause = processStanding(state).declaredCause;
  return cause === 'load_failed' || cause === 'manifest_changed' ? cause : undefined;
}

/** H-7'': the line a read command prints first while it withholds, naming the cause and the flag.
 *  Correction 4 (I-11): a command that takes no flag passes `flagCommand`, the command that does
 *  (`realm run inspect <id> --accept-partial-disclosure`) as a command span (`ctx.cmd`). */
export function valuesWithheldLine(cause: WithheldCause, flagCommand?: string): string {
  return (
    `Values withheld (${WITHHELD_WORDS[cause]}): Realm does not know every declared secret of this run, ` +
    'so each stored value prints as its type and size, and a question is not shown. ' +
    (flagCommand === undefined
      ? 'Pass --accept-partial-disclosure to print them masked with what is known.'
      : `Run ${flagCommand} to print them masked with what is known.`)
  );
}

/**
 * #729 PR-3 correction 4 (I-9b, R43'): a digest printed beside the record, the law asked the walk's
 * question — did it hide anything inside the content the digest derives from (`source`), for this
 * process's stdout at its tier? Then the digest is shown as its type and size; otherwise it is a
 * value (I-9: its shape on a broadcast or under withholding, else its text). Plain when no writer
 * runs.
 */
export function digestSpan(hash: string, source: unknown): string {
  if (state === undefined) return hash;
  const stream = audienceOf('stdout');
  const audience: DisclosureAudience = stream === 'off' ? 'log' : stream;
  let text: string;
  try {
    text = JSON.stringify(source) ?? '';
  } catch {
    text = '';
  }
  const { hidden } = disclose(text, setFor(audience), tierFor(audience));
  if (hidden.declared + hidden.environment + hidden.pattern === 0) return writerCtx().value(hash);
  state.tally.shaped += 1;
  return plainValue(shapeOf(hash));
}

/** Correction 4 (I-6): the cause this read command SHOWS values for on the operator's acceptance —
 *  the rule is on, the flag was given, and without it the values would have been withheld. */
export function valuesShownFor(): WithheldCause | undefined {
  if (state?.readRule === undefined || !state.readRule.accepted) return undefined;
  const cause = processStanding(state).declaredCause;
  return cause === 'load_failed' || cause === 'manifest_changed' ? cause : undefined;
}

/** I-6: the line a read command prints first when the flag shows values it would have withheld. */
export function valuesShownLine(cause: WithheldCause): string {
  return (
    `Values shown on --accept-partial-disclosure (${WITHHELD_WORDS[cause]}): ` +
    'Realm does not know every declared secret of this run; they print masked with what is known.'
  );
}

/**
 * Correction 4 (I-4, I-9, I-11): the read-command rule's manifest half, in one place — the run's
 * manifest read without the loader, its declared values and not-secret list joined, its standing
 * noted (by its path, or by `key` when one process reads several runs that may name one path).
 */
export async function noteRunManifest(
  definition: WorkflowDefinition | undefined,
  run: RunRecord,
  key?: string,
): Promise<RunManifest> {
  const manifest = await readRunManifest(definition, run);
  warnManifestNotSecretUnset(manifest.path, manifest.notSecret);
  addDeclaredValues(
    manifest.declared,
    manifest.document !== undefined ? (manifest.notSecret ?? []) : undefined,
  );
  noteDeclaredStanding(key ?? manifest.path ?? `run ${run.id}`, {
    declared: manifest.declaredState,
    ...(manifest.declaredCause !== undefined ? { declaredCause: manifest.declaredCause } : {}),
  });
  return manifest;
}

/**
 * #729 PR-3 correction 2 (G7, C1): `text` with `command` (a repair act's shell command, core's
 * `RepairAct.command`) printed whole as a command span where it appears; the rest stays text the
 * writer masks. The text as it is when no command is given or it does not appear.
 */
export function withCommand(text: string, command: string | undefined, ctx: RenderCtx): string {
  if (command === undefined || command === '') return text;
  const at = text.indexOf(command);
  return at === -1 ? text : text.slice(0, at) + ctx.cmd(command) + text.slice(at + command.length);
}

/** G7: an error's text, its repair command (`details.repair_command`) printed whole. */
export function errorWithCommand(err: unknown, ctx: RenderCtx): string {
  if (!(err instanceof Error)) return String(err);
  const command =
    err instanceof WorkflowError
      ? (err.details as Record<string, unknown>)['repair_command']
      : undefined;
  return withCommand(err.message, typeof command === 'string' ? command : undefined, ctx);
}

/** Question text, shown at the declared tier on every stream (P-9). Plain when no writer runs. */
export function questionSpan(text: string): string {
  // H-7'': withheld, the question is not shown; the words say why and name the flag.
  const withheld = valuesWithheldFor();
  if (withheld !== undefined)
    return `withheld (${WITHHELD_WORDS[withheld]} — pass --accept-partial-disclosure)`;
  return state === undefined ? text : span('q', text);
}

/** Output built by a class table (`--json`): shown as built. Plain when no writer runs. */
export function dataSpan(text: string): string {
  return state === undefined ? text : span('d', text);
}

/**
 * #729 PR-3 (L-5; RECORD 01 #14): a `--json` output — walked by its class table for stdout's
 * audience (ids and other facts raw, values disclosed), printed as ONE `data` span the writer shows
 * as built. With no writer, the object as given.
 */
export function printJsonByTable(value: object, table: ClassTable): void {
  const audience = stdoutAudience();
  const withhold = valuesWithheldFor();
  const shown =
    audience === undefined
      ? value
      : discloseByTable(withoutMarks(value), table, setFor(audience), audience, {
          ...(withhold !== undefined ? { withhold } : {}),
        }).value;
  console.log(dataSpan(JSON.stringify(shown, null, 2)));
}

// ─── The writer's state ─────────────────────────────────────────────────────────────────────────

/** How this process writes: an ordinary command, a broadcast (listen; agent in log mode), or
 *  `realm mcp` (stdout is the JSON-RPC channel). */
export type WriterMode = 'default' | 'broadcast' | 'mcp';

type StreamAudience = DisclosureAudience | 'off';

interface WriterState {
  mode: WriterMode;
  /** Declared secret values by name, unioned over every manifest this process loaded. */
  declared: Map<string, string>;
  /** Each loaded manifest's `disclosure.not_secret` list (undefined: none). */
  notSecretLists: (readonly string[] | undefined)[];
  /** One set per audience, rebuilt when the declared part changes. */
  sets: Map<DisclosureAudience, DisclosureSet>;
  original: { stdout: Writable['write']; stderr: Writable['write'] };
  /** What this process's writes and walks hid, by kind, and how many values were shown as their
   *  shapes (F10: the walks' counts are added by {@link recordWalk}). */
  tally: WriterTally;
  /** The manifests whose declared values and not-secret list this process has unioned in (F11). */
  unioned: Set<string>;
  /** #729 PR-3 correction 3 (H-10): each manifest read's own standing, by its path — the last read
   *  of a path replaces its earlier one. */
  standings: Map<string, DeclaredStanding>;
  /** H-7'': set by a read command that prints a run's stored values. */
  readRule?: { accepted: boolean };
}

/** What this process's output hid and shaped, its sources on a private terminal, and whether it
 *  showed a question (masked at the declared tier only, P-9). */
export interface WriterTally {
  declared: number;
  environment: number;
  pattern: number;
  unchecked: number;
  shaped: number;
  tooDeep: number;
  question: boolean;
  members: Set<string>;
}

function newWriterTally(): WriterTally {
  return {
    declared: 0,
    environment: 0,
    pattern: 0,
    unchecked: 0,
    shaped: 0,
    tooDeep: 0,
    question: false,
    members: new Set(),
  };
}

let state: WriterState | undefined;

/** The process's declared standing (H-10): the weakest of the manifest reads it noted; with none
 *  noted, `resolved` once a manifest's values or list joined, else `unknown` / `no_manifest`. */
function processStanding(s: WriterState): DeclaredStanding {
  if (s.standings.size > 0) return weakestDeclared([...s.standings.values()]);
  return s.notSecretLists.length > 0 || s.declared.size > 0
    ? { declared: 'resolved' }
    : { declared: 'unknown', declaredCause: 'no_manifest' };
}

function setFor(audience: DisclosureAudience): DisclosureSet {
  const s = state!;
  let set = s.sets.get(audience);
  if (set === undefined) {
    const standing = processStanding(s);
    set = buildDisclosureSet({
      env: process.env,
      declared: Object.fromEntries(s.declared),
      declaredState: standing.declared,
      ...(standing.declaredCause !== undefined ? { declaredCause: standing.declaredCause } : {}),
      audience,
      notSecret: notSecretIntersection(s.notSecretLists),
    }).set;
    s.sets.set(audience, set);
  }
  return set;
}

function audienceOf(stream: 'stdout' | 'stderr'): StreamAudience {
  const s = state!;
  if (s.mode === 'broadcast') return 'broadcast';
  if (s.mode === 'mcp' && stream === 'stdout') return 'off';
  return process[stream].isTTY === true ? 'private' : 'log';
}

/** The constant written when a line cannot be checked: never the line. */
export const PASS_FAILED_LINE =
  'realm: a line could not be checked for secrets, so it was not written.\n';

/** A verified span of a line: its kind and body, and (the echo's correction 1) the count of line
 *  breaks (`\n`, `\r`) at the body's start (`lead`) and at its end (`trail`); a body that is empty or
 *  only breaks has no core: `lead` is its length and `trail` 0. */
interface LineSpan {
  kind: SpanKind;
  body: string;
  lead: number;
  trail: number;
}

/** A body's line breaks at its start and end (`\n`, `\r` only); a body that is empty or only breaks
 *  has no core: all of it is `lead`. */
function bodyEdges(body: string): { lead: number; trail: number } {
  const isBreak = (c: string | undefined): boolean => c === '\n' || c === '\r';
  let lead = 0;
  while (lead < body.length && isBreak(body[lead])) lead++;
  if (lead === body.length) return { lead, trail: 0 };
  let trail = 0;
  while (isBreak(body[body.length - 1 - trail])) trail++;
  return { lead, trail };
}

/**
 * The abandon echo (#729 PR-3): the text a line's mask reads — every verified span (its whole
 * envelope) replaced by one placeholder character per code point of its body, the body's line breaks
 * (`\n`, `\r`) kept at their places; every other character as it is, marks stripped. The two
 * placeholder characters are the first two of the Private Use Area from U+E003 that `cleaned` does not
 * hold (none of the law's classes matches them, and a character chosen for its absence cannot be
 * planted), alternating span by span so adjacent spans never merge. Each span is recorded with its
 * body's shape — the breaks at its start and end — which `pass` matches the masked text against
 * (correction 1). `undefined` when no two are free.
 */
function maskInput(
  cleaned: string,
): { input: string; spans: LineSpan[]; placeholders: [string, string] } | undefined {
  const present = new Set<number>();
  for (let i = 0; i < cleaned.length; i++) {
    const code = cleaned.charCodeAt(i);
    if (code >= 0xe003 && code <= 0xf8ff) present.add(code);
  }
  const free: string[] = [];
  for (let code = 0xe003; code <= 0xf8ff && free.length < 2; code++)
    if (!present.has(code)) free.push(String.fromCharCode(code));
  if (free.length < 2) return undefined;
  const placeholders: [string, string] = [free[0]!, free[1]!];
  const spans: LineSpan[] = [];
  let input = '';
  let from = 0;
  for (const m of cleaned.matchAll(SPAN)) {
    const [whole, kind, , body] = m as unknown as [string, SpanKind, string, string];
    const mark = placeholders[spans.length % 2]!;
    input += stripMarks(cleaned.slice(from, m.index));
    for (const c of body) input += c === '\n' || c === '\r' ? c : mark;
    spans.push({ kind, body, ...bodyEdges(body) });
    from = m.index + whole.length;
  }
  input += stripMarks(cleaned.slice(from));
  return { input, spans, placeholders };
}

/**
 * Text as `audience` is shown it: each verified span as built (a question span at the declared
 * tier); everything else with its marks stripped FIRST, then masked with the audience's tier — as ONE
 * text, in the order it stands, with every span's body held fixed (the abandon echo, #729 PR-3: a
 * piece masked alone read the closing quote of the span before it as a quote left open). A line whose
 * spans cannot be placed back — a span's run not matching its body's shape (a run inside a value's run
 * or glued to a closing quote, a body with no character but line breaks), or no free placeholder — is
 * masked whole with every body inline, so a credential is never shown (owner: "Hiding values when
 * Realm can't tell which ones are secret: yes"); a realm word on such a line may be masked. On such a
 * line a question span is masked at the line's tier, not the declared one, and the tally's question
 * flag stays unset (hide-first).
 */
export function pass(text: string, audience: StreamAudience): string {
  if (audience === 'off' || state === undefined) return text;
  const set = setFor(audience);
  const tier = tierFor(audience);
  const tally = state.tally;
  const count = (d: ReturnType<typeof disclose>): string => {
    tally.declared += d.hidden.declared;
    tally.environment += d.hidden.environment;
    tally.pattern += d.hidden.pattern;
    tally.unchecked += d.unchecked;
    for (const member of d.members ?? []) tally.members.add(member);
    return d.text;
  };
  // F26: an envelope that does not verify — a forgery, or text changed after it was marked — loses
  // its whole envelope (kind and tag too) BEFORE the text is read, so its body is read with what is
  // around it: a forged envelope can never part a credential's name from its value.
  const cleaned = text.replace(SPAN, (whole: string, kind: SpanKind, tag: string, body: string) =>
    verified(kind, tag, body) ? whole : body,
  );
  const whole = (): string =>
    count(
      disclose(
        stripMarks(
          cleaned.replace(
            SPAN,
            (_whole: string, _kind: string, _tag: string, body: string) => body,
          ),
        ),
        set,
        tier,
      ),
    );
  const mask = maskInput(cleaned);
  if (mask === undefined) return whole();
  const { input, spans, placeholders } = mask;
  if (spans.length === 0) return count(disclose(input, set, tier));
  const d = disclose(input, set, tier);
  // Correction 1: each span is MATCHED against its body's shape, in order — never found by scanning
  // for placeholder runs. At a placeholder, the next unmatched span's leading breaks must close the
  // plain text before it (taken back out of it), its core must follow code point by code point (its
  // placeholder for every character but a `\n` or `\r`, which must stand as itself), and its trailing
  // breaks must follow it (consumed). Any mismatch, a placeholder of the other span's parity, the text
  // ending early, a span never reached, or a placeholder after the last span → the whole line
  // hide-first.
  const isBreak = (c: string): boolean => c === '\n' || c === '\r';
  const pieces: Array<string | number> = [];
  let matched = 0;
  let i = 0;
  let plain = '';
  const masked = d.text;
  while (i < masked.length) {
    const c = masked.charAt(i);
    if (c !== placeholders[0] && c !== placeholders[1]) {
      plain += c;
      i++;
      continue;
    }
    if (matched === spans.length) return whole();
    const { body, lead, trail } = spans[matched]!;
    const mark = placeholders[matched % 2]!;
    if (lead === body.length || c !== mark) return whole();
    // (i) the body's leading breaks, at the end of the plain text before it
    if (plain.length < lead || plain.slice(plain.length - lead) !== body.slice(0, lead))
      return whole();
    plain = plain.slice(0, plain.length - lead);
    // (ii) the core, code point by code point: one code unit of the text per code point
    let k = i;
    for (const cp of body.slice(lead, body.length - trail)) {
      if (k >= masked.length || masked.charAt(k) !== (isBreak(cp) ? cp : mark)) return whole();
      k++;
    }
    // (iii) the body's trailing breaks, after it
    if (masked.slice(k, k + trail) !== body.slice(body.length - trail)) return whole();
    k += trail;
    pieces.push(plain, matched);
    plain = '';
    matched++;
    i = k;
  }
  if (matched !== spans.length) return whole();
  count(d);
  let out = '';
  for (const piece of pieces) {
    if (typeof piece === 'string') {
      out += piece;
      continue;
    }
    const { kind, body } = spans[piece]!;
    // A verified span is shown as built; a question at the declared tier (P-9), and said so (D-10).
    if (kind === 'q') {
      if (body !== '') tally.question = true;
      out += count(disclose(body, set, 'declared'));
    } else {
      out += body;
    }
  }
  return out + plain;
}

/** F10: adds a walk's counts (a log-mode drive's shaped gate and Result) to this process's tally. */
export function recordWalk(walk: DisclosureTally): void {
  if (state === undefined) return;
  const t = state.tally;
  t.declared += walk.hidden.declared;
  t.environment += walk.hidden.environment;
  t.pattern += walk.hidden.pattern;
  t.unchecked += walk.unchecked;
  t.shaped += walk.shapedCount;
  t.tooDeep += walk.tooDeep;
  if (walk.question) t.question = true;
  for (const member of walk.members) t.members.add(member);
}

/** F13: a copy of this process's tally (a surface's own counts are a later copy minus this one). */
export function writerTally(): WriterTally | undefined {
  if (state === undefined) return undefined;
  return { ...state.tally, members: new Set(state.tally.members) };
}

/** The words a receipt line uses for a set's declared standing. */
export function declaredWords(set: Pick<DisclosureSet, 'declared' | 'declaredCause'>): string {
  return set.declared === 'resolved'
    ? `declared values ${set.declaredCause === 'no_manifest' ? 'resolved (no manifest)' : 'resolved'}`
    : `declared values ${set.declared}${set.declaredCause !== undefined ? ` (${set.declaredCause.replace('_', ' ')})` : ''}`;
}

/** D-10 (F16): the clause a receipt line ends with when a question was shown. */
export const QUESTION_DECLARED_ONLY_WORDS = 'question: declared tier only';

/** Correction 4 (I-6): the receipt's question clause — under `--accept-partial-disclosure`, where
 *  the values would have been withheld, a shown question was masked with what is known. */
export function questionReceiptWords(): string {
  return valuesShownFor() !== undefined
    ? 'question: shown with what is known (--accept-partial-disclosure)'
    : QUESTION_DECLARED_ONLY_WORDS;
}

/**
 * The one receipt line `realm agent` prints per run in log mode (RECORD 05 "shaped sites"): kinds
 * and counts, never a name. `undefined` when no writer runs.
 */
export function writerReceiptLine(): string | undefined {
  if (state === undefined) return undefined;
  const set = setFor(
    audienceOf('stderr') === 'off' ? 'log' : (audienceOf('stderr') as DisclosureAudience),
  );
  const t = state.tally;
  return (
    `Disclosure: ${declaredWords(set)}; environment ${set.environment === 'swept' ? 'swept' : 'not swept'}; ` +
    `hidden ${t.declared} declared, ${t.environment} environment, ${t.pattern} by pattern; ` +
    `${t.unchecked} not checked; ${set.unmaskable} too short to hide; ${t.shaped === 1 ? '1 value shown as its type and size' : `${t.shaped} values shown as their type and size`}` +
    `${t.question ? `; ${questionReceiptWords()}` : ''}.`
  );
}

/** Text as this process's stdout shows it: the pass for its audience, or the text when no writer
 *  runs. A CLI cut calls it BEFORE cutting (I4: no start of a value is emitted unpassed). */
export function passForStdout(text: string): string {
  if (state === undefined) return text;
  const audience = audienceOf('stdout');
  return pass(text, audience === 'off' ? 'log' : audience);
}

/** The C1 controls and the Unicode line separators as `\uXXXX` (JSON leaves them as they are). */
export function escapeC1(text: string): string {
  return text.replace(
    /[\u0080-\u009f\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/**
 * D3/08 S2: a CLI cut of a stored value — JSON text (every C0 control its escape), the C1 controls
 * and line separators escaped too, passed for stdout's audience, THEN cut at `cap` with
 * `ellipsis`. A long ordinary value shows its first `cap` characters; a secret across the cut
 * point leaves no fragment.
 */
export function escapePassCut(json: string, cap: number, ellipsis = '…'): string {
  const passed = passForStdout(escapeC1(json));
  return passed.length > cap ? `${passed.slice(0, cap)}${ellipsis}` : passed;
}

/** Text as this process's stderr shows it (a fatal handler, a masked log line). */
export function passForStderr(text: string): string {
  return state === undefined ? text : pass(text, audienceOf('stderr'));
}

type WriteArgs = [chunk: unknown, encoding?: unknown, callback?: unknown];

function patch(stream: 'stdout' | 'stderr'): void {
  const target = process[stream];
  const original = state!.original[stream];
  const decoder = new StringDecoder('utf8');
  target.write = function write(...args: WriteArgs): boolean {
    const [chunk, encoding, callback] = args;
    const cb = (typeof encoding === 'function' ? encoding : callback) as
      ((err?: Error | null) => void) | undefined;
    let text: string;
    if (typeof chunk === 'string') {
      text =
        typeof encoding === 'string' && encoding !== 'utf8' && encoding !== 'utf-8'
          ? Buffer.from(chunk, encoding as BufferEncoding).toString('utf8')
          : chunk;
    } else {
      text = decoder.write(Buffer.from(chunk as Uint8Array));
    }
    const audience = audienceOf(stream);
    if (audience === 'off') {
      // `realm mcp`: stdout is the channel, written only through `channelStdout()`; any other write
      // goes to the masked stderr.
      return process.stderr.write(text, cb);
    }
    let shown: string;
    try {
      shown = pass(text, audience);
    } catch {
      shown = PASS_FAILED_LINE;
    }
    return original.call(target, shown, cb as never);
  } as typeof target.write;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  return String(err);
}

/** The constant a fatal handler writes when the pass fails: never the error's text. */
export const FATAL_CONSTANT =
  'realm: a fatal error occurred; its text could not be checked for secrets.\n';

function fatal(err: unknown): void {
  let text: string;
  try {
    text = passForStderr(errorText(err));
    if (!text.endsWith('\n')) text += '\n';
  } catch {
    text = FATAL_CONSTANT;
  }
  try {
    writeSync(2, text);
  } catch {
    // Nothing more can be written.
  }
  process.exit(1);
}

/**
 * Installs the writer once per process, and sets its mode (a later call — the command's own hook
 * after an early default — only changes the mode). Synchronous.
 */
export function installWriter(mode: WriterMode = 'default'): void {
  if (state !== undefined) {
    if (state.mode !== mode && mode !== 'default') {
      state.mode = mode;
      state.sets.clear();
    }
    return;
  }
  state = {
    mode,
    declared: new Map(),
    notSecretLists: [],
    sets: new Map(),
    tally: newWriterTally(),
    unioned: new Set(),
    standings: new Map(),
    original: {
      stdout: process.stdout.write.bind(process.stdout) as Writable['write'],
      stderr: process.stderr.write.bind(process.stderr) as Writable['write'],
    },
  };
  // A value printed through `util.inspect` (console.log of an object) is never cut (I4).
  util.inspect.defaultOptions.maxStringLength = Infinity;
  patch('stdout');
  patch('stderr');
  process.on('uncaughtException', fatal);
  process.on('unhandledRejection', fatal);
  // F32: a name REALM_NOT_SECRET lists that is not set has no effect — said once per process.
  const unset = notSecretNames(process.env).filter((name) => process.env[name] === undefined);
  if (unset.length > 0) process.stderr.write(`${notSecretUnsetWarning(unset)}\n`);
}

/**
 * F32: the warning for names `REALM_NOT_SECRET` lists that are not set — the four clauses of the
 * inert-config policy: validity, consequence, remedy, re-admission. It names variables, never values.
 */
export function notSecretUnsetWarning(names: readonly string[]): string {
  const listed = names.map((name) => `'${name}'`).join(', ');
  return (
    `Warning: REALM_NOT_SECRET lists ${listed}, which ${names.length === 1 ? 'is' : 'are'} not set in this environment, ` +
    `so listing ${names.length === 1 ? 'it' : 'them'} has no effect. ` +
    'Fix the name, or remove it from REALM_NOT_SECRET. ' +
    'Nothing else needs to change; a listed name takes effect once it is set.'
  );
}

/**
 * #729 PR-3 correction 2 (C5): the warning for names a manifest's `disclosure.not_secret` lists that
 * are not set — F32's four clauses (validity, consequence, remedy, re-admission), naming the manifest.
 * It names variables, never values.
 */
export function manifestNotSecretUnsetWarning(
  manifest: string,
  names: readonly string[],
  ctx: RenderCtx = PLAIN,
): string {
  const listed = names.map((name) => `'${name}'`).join(', ');
  const one = names.length === 1;
  // #729 PR-3 correction 3 (H-10, R31's logic): the manifest's path is a fact the reader acts on, so
  // it prints whole, a path under HOME included.
  const path = ctx.cmd(manifest);
  return (
    `Warning: the manifest ${path} lists ${listed} under disclosure.not_secret, which ${one ? 'is' : 'are'} not set in this environment, ` +
    `so listing ${one ? 'it' : 'them'} has no effect. ` +
    `Fix the name, or remove it from disclosure.not_secret in ${path}. ` +
    'Nothing else needs to change; a listed name takes effect once it is set.'
  );
}

/** C5: (manifest, name) pairs already warned about in this process. */
const warnedManifestNotSecret = new Set<string>();

/** C5: warns, once per manifest and name in this process, for listed names that are not set. */
export function warnManifestNotSecretUnset(
  manifest: string | undefined,
  listed: readonly string[] | undefined,
): void {
  if (manifest === undefined || listed === undefined) return;
  const unset = listed.filter(
    (name) =>
      process.env[name] === undefined && !warnedManifestNotSecret.has(`${manifest}\u0000${name}`),
  );
  if (unset.length === 0) return;
  for (const name of unset) warnedManifestNotSecret.add(`${manifest}\u0000${name}`);
  process.stderr.write(`${manifestNotSecretUnsetWarning(manifest, unset, writerCtx())}\n`);
}

/** Whether this process's writer is installed. */
export function writerInstalled(): boolean {
  return state !== undefined;
}

/** The writer's mode, or `undefined` when none is installed. */
export function writerMode(): WriterMode | undefined {
  return state?.mode;
}

/**
 * A manifest loaded: its declared values are unioned in (a known secret stays masked), its
 * not-secret list joins the intersection, and the sets are rebuilt from the environment.
 */
/**
 * #729 PR-3 correction 3 (H-10): what a read of the manifest at `path` found — `resolved`, or
 * `unknown` with `load_failed` when it could not be read, parsed or resolved. The writer's receipt
 * and sets carry the weakest standing noted, so a manifest that exists is never `no_manifest`.
 */
export function noteDeclaredStanding(path: string, standing: DeclaredStanding): void {
  if (state === undefined) return;
  state.standings.set(path, standing);
  state.sets.clear();
}

export function addDeclaredDisclosure(
  declared: Readonly<Record<string, string>>,
  notSecret: readonly string[] | undefined,
): void {
  if (state === undefined) return;
  for (const [name, value] of Object.entries(declared)) state.declared.set(name, value);
  state.notSecretLists.push(notSecret);
  state.sets.clear();
}

/**
 * The CLI's disclosure provider for the MCP server it launches (`realm mcp`, `realm serve`; M-3): the
 * writer's set for the agent. D-11 (F11): its declared MEMBERS are the process-wide union (every
 * manifest this process has read); its declared STATE and CAUSE are the project's own — the run's
 * recorded manifest, else its workflow's — read without running project code
 * (`readRunManifest`), when first asked for. With nothing to read, the process's own standing.
 */
export async function cliDisclosureProvider(
  definition?: WorkflowDefinition,
  run?: RunRecord,
): Promise<DisclosureSet> {
  if (state === undefined) throw new Error('the CLI writer is not installed');
  if (definition === undefined && run === undefined) return setFor('agent');
  const manifest = await readRunManifest(definition, run);
  warnManifestNotSecretUnset(manifest.path, manifest.notSecret);
  // Union this manifest's declared values (a Map: idempotent) and, once per manifest, its list.
  addDeclaredValues(
    manifest.declared,
    manifest.document !== undefined &&
      manifest.path !== undefined &&
      !state.unioned.has(manifest.path)
      ? (manifest.notSecret ?? [])
      : undefined,
  );
  if (manifest.path !== undefined && manifest.document !== undefined) {
    state.unioned.add(manifest.path);
  }
  return withDeclaredStanding(setFor('agent'), {
    declared: manifest.declaredState,
    ...(manifest.declaredCause !== undefined ? { declaredCause: manifest.declaredCause } : {}),
  });
}

/**
 * Declared values a read command or a listener learned (a run's manifest read without the loader;
 * a webhook's secret): unioned into the declared part. `manifestNotSecret` is given only when a
 * manifest was read (its list, or `[]`), and joins the intersection then.
 */
export function addDeclaredValues(
  declared: Readonly<Record<string, string>>,
  manifestNotSecret?: readonly string[],
): void {
  if (state === undefined) return;
  let changed = false;
  for (const [name, value] of Object.entries(declared)) {
    if (state.declared.get(name) !== value) {
      state.declared.set(name, value);
      changed = true;
    }
  }
  if (manifestNotSecret !== undefined) {
    state.notSecretLists.push(manifestNotSecret);
    changed = true;
  }
  // The sets are rebuilt only when the declared part changed (a provider asks once per reply).
  if (changed) state.sets.clear();
}

/** The audience this process's stdout is shown to (`log` for `realm mcp`'s diverted writes), or
 *  `undefined` when no writer runs. */
export function stdoutAudience(): DisclosureAudience | undefined {
  if (state === undefined) return undefined;
  const audience = audienceOf('stdout');
  return audience === 'off' ? 'log' : audience;
}

/** The set the writer uses for `audience` (a read command's receipt, the agent's provider feed). */
export function writerSetFor(audience: DisclosureAudience): DisclosureSet | undefined {
  return state === undefined ? undefined : setFor(audience);
}

/**
 * `realm mcp`'s channel: a stream that writes through the ORIGINAL stdout write, so the JSON-RPC
 * messages leave as the MCP door's serializer built them. `process.stdout` when no writer runs.
 */
export function channelStdout(): Writable {
  if (state === undefined) return process.stdout;
  const write = state.original.stdout;
  return new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      write.call(process.stdout, chunk, callback as never);
    },
  });
}

// ─── The hook ───────────────────────────────────────────────────────────────────────────────────

/** The mode a command runs in, from its name and options. */
export function writerModeOf(command: Command): WriterMode {
  const name = command.name();
  if (name === 'listen') return 'broadcast';
  // `realm mcp --check` starts no server: its stdout is an ordinary stream, not the channel (#627 W).
  if (name === 'mcp')
    return (command.opts() as { check?: unknown }).check === true ? 'default' : 'mcp';
  if (name === 'agent') {
    const opts = command.opts() as { spawnedByListen?: unknown; logMode?: unknown };
    if (opts.spawnedByListen === true || opts.logMode === true) return 'broadcast';
  }
  return 'default';
}

/** The `preAction` hook every exported command carries (L-1): installs the writer for the command
 *  that runs. */
export function writerHook(_thisCommand: Command, actionCommand: Command): void {
  installWriter(writerModeOf(actionCommand));
}

/** Attaches {@link writerHook} to every command object in `lists`, nested ones included (m-c). */
export function attachWriterHook(lists: readonly (readonly Command[])[]): void {
  const seen = new Set<Command>();
  const visit = (command: Command): void => {
    if (seen.has(command)) return;
    seen.add(command);
    command.hook('preAction', writerHook);
    for (const sub of command.commands) visit(sub);
  };
  for (const list of lists) for (const command of list) visit(command);
}

// ─── Test seams ─────────────────────────────────────────────────────────────────────────────────

/** For tests in this package: the span a command would carry, and the writer's own pass. */
export const writerTestSeams = {
  span,
  /** The text a line's mask reads (the abandon echo, #729 PR-3): the spans as placeholder runs. */
  maskInput(text: string): string | undefined {
    return maskInput(text)?.input;
  },
  /** What the writer would show of `text` on stdout (identity when no writer runs): in-process
   *  tests that spy on `console.*` read composed text, spans included. */
  visible(text: string): string {
    return passForStdout(text);
  },
  reset(): void {
    if (state === undefined) return;
    process.stdout.write = state.original.stdout as typeof process.stdout.write;
    process.stderr.write = state.original.stderr as typeof process.stderr.write;
    process.off('uncaughtException', fatal);
    process.off('unhandledRejection', fatal);
    state = undefined;
  },
};
