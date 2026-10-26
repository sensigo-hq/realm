// disclosure-walk.ts — #729 PR-3 (RECORD 01 #6, #7; 05 "door API"): the class-table walk and the
// receipt. Pure: the set is passed in, the audience is a parameter (framework §0 rule 9: an engine API
// takes the transport's constraint IN), and nothing here reads the environment (R19).
//
// One table per serialized object, keyed on the object the walk runs on. Each table is written
// `satisfies Record<keyof T, DisclosureClass>`, so a new field fails the compile until it is
// classified. At run time an unclassified key is walked as `value` (the safe side), and a test passes
// `onUnclassified` to turn it into a failure.
import {
  disclose,
  isCredentialName,
  tierFor,
  REDACTED_MARKER,
  type DeclaredCause,
  type DeclaredState,
  type DisclosureAudience,
  type DisclosureSet,
  type DisclosureTier,
  type EnvironmentCause,
  type EnvironmentState,
  type HiddenCounts,
} from './redaction.js';

/**
 * How a field is shown:
 * - `fact`: ids, verbs, choices, `call_with`, codes, counts, times — shown as they are;
 * - `value`: a run's data (params, outputs, previews) — every tier of the audience; on `broadcast`,
 *   its leaves are shown as their shapes;
 * - `question`: what a person is asked (`resolved_message`, `display`) — the declared tier only, on
 *   every audience (P-9);
 * - `bounded`: a diagnostic copy (an error message, a terminal reason) — every tier, never shaped,
 *   because a shape would erase its meaning;
 * - `frozen`: reserved for V-1's frozen view — shown as it is;
 * - `{ nested }`: an object with its own table (or a function choosing the table per discriminant);
 *   an array under it is walked element by element;
 * - `{ map }`: a map keyed by facts (step names, gate ids), each entry walked by the table.
 */
export type DisclosureClass =
  'fact' | 'value' | 'question' | 'bounded' | 'frozen' | NestedClass | MapClass | ChosenClass;

/** A field with its own table. */
export interface NestedClass {
  readonly nested: ClassTable | ((value: unknown) => ClassTable);
}

/** #729 PR-3 correction 2 (E-11''): a row whose class is chosen by its value — a value equal to one of
 *  realm's fixed sentences is a `fact`, anything else (text a template rendered with run values)
 *  is `bounded`. */
export interface ChosenClass {
  readonly choose: (value: unknown) => 'fact' | 'bounded';
}

/** A map keyed by facts whose every entry has the same table. */
export interface MapClass {
  readonly map: ClassTable | ((value: unknown) => ClassTable);
}

/** A class table: one row per key. Concrete tables are written `satisfies Record<keyof T, DisclosureClass>`. */
export type ClassTable = Readonly<Record<string, DisclosureClass>>;

/**
 * #729 PR-3 correction 4 (I-9b, R43'): which row each digest row of a table derives from — a digest
 * of content the law hid anything inside is shown as its shape on every audience (a short value's
 * digest would confirm a guess). Declared beside its table with {@link deriveOf}; read by the walk.
 */
export type DerivedOf<Table extends ClassTable> = {
  readonly [K in keyof Table & string]?: Exclude<keyof Table & string, K>;
};

const DERIVED_OF = new WeakMap<ClassTable, Readonly<Record<string, string>>>();

/** Declares `table`'s digest rows and the rows they digest; returns the map as given. */
export function deriveOf<Table extends ClassTable, const D extends DerivedOf<Table>>(
  table: Table,
  derived: D,
): D {
  DERIVED_OF.set(table, derived as Readonly<Record<string, string>>);
  return derived;
}

/**
 * F5: what produces a `fact` row's text. A `fact` row is shown as it is, so its text must come from
 * one of these: an id realm mints, a word from a closed set, a count, a time, a hash, a path realm
 * resolved, the author's own literal (a step name, an expression, a choice), or a command span. A row
 * whose text comes from a template render, a runtime message, an external reply or a load error is
 * never `fact`.
 */
export type FactProducer =
  'id' | 'enum' | 'count' | 'time' | 'hash' | 'path_fact' | 'author_literal' | 'command_span';

/** Whether a field's type can hold a string, at any depth up to five levels. `unknown` (or `any`)
 *  can hold anything, so it counts (fail closed). */
type HoldsString<V, D extends unknown[] = []> = D['length'] extends 5
  ? true
  : [V] extends [never]
    ? false
    : unknown extends V
      ? true
      : V extends string
        ? true
        : V extends readonly (infer E)[]
          ? HoldsString<Present<E>, [...D, 1]>
          : V extends object
            ? true extends { [K in keyof V]-?: HoldsString<Present<V[K]>, [...D, 1]> }[keyof V]
              ? true
              : false
            : false;

/** A field's type without `null` and `undefined` (`unknown` stays `unknown`, unlike `NonNullable`). */
type Present<V> = Exclude<V, null | undefined>;

/** The rows of `Table` classed `'fact'` whose field in `T` can hold a string. */
type StringFactKeys<Table, T> = {
  [K in keyof Table & keyof T]-?: Table[K] extends 'fact'
    ? true extends HoldsString<Present<T[K]>>
      ? K
      : never
    : never;
}[keyof Table & keyof T];

/**
 * F5: a table's producer registry. Written `satisfies FactProducers<typeof TABLE, T>`, beside the
 * table: a `fact` row that can hold a string and names no producer fails the compile, and so does a
 * producer for a row that is not such a row.
 */
export type FactProducers<Table, T> = { readonly [K in StringFactKeys<Table, T>]: FactProducer };

/** What a walk hid and shaped, summed over every `disclose` it ran. */
export interface DisclosureTally {
  /** The audience the walk ran for. */
  audience: DisclosureAudience;
  hidden: HiddenCounts;
  unchecked: number;
  /** Sources named (private audience only). */
  members: Set<string>;
  /** The fields shown as shapes, as dotted paths, each once (on a broadcast, under withholding, and
   *  a digest of content the law hid inside, I-9b). */
  shaped: string[];
  /** How many values were shown as their shapes (each leaf, and each cut subtree). */
  shapedCount: number;
  /** Subtrees shown as their shape past {@link DISCLOSURE_MAX_DEPTH}, on every audience (D-10). */
  tooDeep: number;
  /** Whether the walk showed a non-empty question (masked at the declared tier only, P-9; D-10). */
  question: boolean;
  /** H-11': whether the walk withheld the values, and a non-empty question. */
  withheld: boolean;
  questionWithheld: boolean;
}

/** Options of a walk. */
export interface WalkOptions {
  /** Called with the dotted path of every key no table row classifies. Tests throw from it. */
  onUnclassified?: (path: string) => void;
  /**
   * #729 PR-3 correction 3 (H-7'', H-11'): the declared values could not be read, or changed, so
   * the walk withholds what could hold one — `value` and `bounded` leaves as their shapes, a
   * question as {@link withheldQuestion} — and its receipt says so. P-9's one exception, bounded to a
   * failed or changed manifest (never `no_manifest` or `embedder_none`).
   */
  withhold?: WithheldCause;
}

/** The causes the declared values are withheld for (H-7''): a manifest Realm was told about that
 *  cannot be read, or has changed. */
export type WithheldCause = 'load_failed' | 'manifest_changed';

/** The cause a set's values are withheld for, when its declared cause is one of them. */
export function withheldCauseOf(set: DisclosureSet): WithheldCause | undefined {
  return set.declaredCause === 'load_failed' || set.declaredCause === 'manifest_changed'
    ? set.declaredCause
    : undefined;
}

/** H-7'': why a question or a value is withheld, in words. */
export const WITHHELD_WORDS: Readonly<Record<WithheldCause, string>> = {
  load_failed: 'declared values could not be read',
  manifest_changed: 'declared values changed',
};

/** H-11': the sentence a withheld question is replaced by (a string, as the question was). */
export function withheldQuestion(cause: WithheldCause): string {
  return `withheld (${WITHHELD_WORDS[cause]})`;
}

/** How deep a walk goes before a value is shown as its shape. */
export const DISCLOSURE_MAX_DEPTH = 64;

/**
 * A value's shape: its type and size, never any of its content. Used on `broadcast` for value
 * fields, and for a cycle or a value nested deeper than {@link DISCLOSURE_MAX_DEPTH}. `disclose`
 * never matches inside one (I11).
 */
export function shapeOf(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
  if (typeof value === 'string')
    return `‹string, ${count(value.length, 'character', 'characters')}›`;
  if (typeof value === 'number' || typeof value === 'bigint') return '‹number›';
  if (typeof value === 'boolean') return '‹boolean›';
  if (Array.isArray(value)) return `‹array, ${count(value.length, 'item', 'items')}›`;
  if (typeof value === 'object') {
    return `‹object, ${count(Object.keys(value).length, 'key', 'keys')}›`;
  }
  return `‹${typeof value}›`;
}

/** The shape shown for an object met again inside itself. */
export const CYCLE_SHAPE = '‹cycle›';

interface WalkContext {
  readonly set: DisclosureSet;
  readonly audience: DisclosureAudience;
  readonly tier: DisclosureTier;
  readonly tally: DisclosureTally;
  readonly onUnclassified: ((path: string) => void) | undefined;
  readonly stack: Set<object>;
  /** H-11': the cause the values are withheld for, when they are. */
  readonly withhold: WithheldCause | undefined;
}

/** How a value subtree is shown. */
interface ValueMode {
  readonly tier: DisclosureTier;
  /** Shape the leaves (a `value` row on `broadcast`); `shapedAt` is the row's path. */
  readonly shape: boolean;
  readonly shapedAt: string;
}

function newTally(audience: DisclosureAudience): DisclosureTally {
  return {
    audience,
    hidden: { declared: 0, environment: 0, pattern: 0 },
    unchecked: 0,
    members: new Set(),
    shaped: [],
    shapedCount: 0,
    tooDeep: 0,
    question: false,
    withheld: false,
    questionWithheld: false,
  };
}

/** Every hide the walk has counted so far, of every kind (I-9b reads it before and after a row). */
function hiddenTotal(tally: DisclosureTally): number {
  return tally.hidden.declared + tally.hidden.environment + tally.hidden.pattern;
}

/** Counts one hide by its kind (F15: a hide counts by the highest kind it hid). */
function countHide(ctx: WalkContext, kind: 'declared' | 'environment' | 'pattern'): void {
  ctx.tally.hidden[kind] += 1;
}

/** The highest member kind in `text` at `tier`, or `undefined` (patterns are not members). */
function memberKindIn(
  text: string,
  tier: DisclosureTier,
  ctx: WalkContext,
): 'declared' | 'environment' | undefined {
  const found = disclose(text, ctx.set, tier).hidden;
  return found.declared > 0 ? 'declared' : found.environment > 0 ? 'environment' : undefined;
}

/** A subtree past {@link DISCLOSURE_MAX_DEPTH}, or a cycle: its shape, counted. */
function cutShape(node: object, path: string, depth: number, ctx: WalkContext): unknown {
  noteShaped(ctx, path);
  ctx.tally.shapedCount += 1;
  if (ctx.stack.has(node)) return CYCLE_SHAPE;
  if (depth > DISCLOSURE_MAX_DEPTH) ctx.tally.tooDeep += 1;
  return shapeOf(node);
}

function join(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

function discloseText(text: string, tier: DisclosureTier, ctx: WalkContext): string {
  const out = disclose(text, ctx.set, tier);
  ctx.tally.hidden.declared += out.hidden.declared;
  ctx.tally.hidden.environment += out.hidden.environment;
  ctx.tally.hidden.pattern += out.hidden.pattern;
  ctx.tally.unchecked += out.unchecked;
  for (const member of out.members ?? []) ctx.tally.members.add(member);
  return out.text;
}

/**
 * F7: a string's JSON-escaped spelling, taken AFTER it was masked at its own tier. A member that only
 * the escaped spelling holds (a value an encoder writes whole) hides the string whole. Never a flat
 * all-tier pass: a question keeps the declared tier (P-9). E-8: a key gets the same check. The member
 * it hid is listed on a private audience, for a key and a leaf alike (E-8, H-5).
 */
function escapedSpellingHides(shown: string, tier: DisclosureTier, ctx: WalkContext): string {
  const escaped = JSON.stringify(shown).slice(1, -1);
  if (escaped === shown) return shown;
  const out = disclose(escaped, ctx.set, tier);
  const kind =
    out.hidden.declared > 0 ? 'declared' : out.hidden.environment > 0 ? 'environment' : undefined;
  if (kind === undefined) return shown;
  countHide(ctx, kind);
  for (const member of out.members ?? []) ctx.tally.members.add(member);
  return REDACTED_MARKER;
}

function noteShaped(ctx: WalkContext, path: string): void {
  if (!ctx.tally.shaped.includes(path)) ctx.tally.shaped.push(path);
}

/** Walks a value subtree: every string and key through `disclose`, a credential name's value hidden
 *  whole (the name rule's value reader), and on `broadcast` every leaf shown as its shape. */
function walkValue(
  node: unknown,
  path: string,
  depth: number,
  mode: ValueMode,
  ctx: WalkContext,
): unknown {
  if (node === null || node === undefined) return node;
  if (typeof node === 'string') {
    if (mode.shape) {
      noteShaped(ctx, mode.shapedAt);
      ctx.tally.shapedCount += 1;
      return shapeOf(node);
    }
    return escapedSpellingHides(discloseText(node, mode.tier, ctx), mode.tier, ctx);
  }
  if (typeof node !== 'object') {
    if (mode.shape) {
      noteShaped(ctx, mode.shapedAt);
      ctx.tally.shapedCount += 1;
      return shapeOf(node);
    }
    // A number or boolean whose JSON text holds a member is hidden whole; the reply still parses.
    const text = JSON.stringify(node) as string | undefined;
    if (text === undefined) return node;
    return discloseText(text, mode.tier, ctx) !== text ? REDACTED_MARKER : node;
  }
  if (ctx.stack.has(node) || depth > DISCLOSURE_MAX_DEPTH) return cutShape(node, path, depth, ctx);
  ctx.stack.add(node);
  try {
    if (Array.isArray(node)) {
      return node.map((child, i) => walkValue(child, `${path}[${i}]`, depth + 1, mode, ctx));
    }
    // `Object.fromEntries` keeps a `"__proto__"` key and its subtree (an assignment copy drops both).
    const used = new Set<string>();
    return Object.fromEntries(
      Object.entries(node).map(([key, child]) => {
        // E-8: a key is masked as a string leaf is, its JSON-escaped spelling included.
        const shownKey = uniqueKey(
          escapedSpellingHides(discloseText(key, mode.tier, ctx), mode.tier, ctx),
          used,
        );
        const childPath = join(path, key);
        if (
          mode.tier === 'all' &&
          isCredentialName(key, typeof child === 'string' ? child : '') &&
          hidesWhole(child)
        ) {
          // F15: counted by the highest kind it hid (a declared value under a credential name is
          // declared), else as a pattern. E-9: a value with no JSON text (a cycle, a bigint) is
          // hidden all the same and counted as a pattern, never thrown. E-6': under a key named
          // `pwd` alone, only a path is the working folder (anything else is hidden).
          let text: string;
          try {
            text = typeof child === 'string' ? child : (JSON.stringify(child) ?? '');
          } catch {
            countHide(ctx, 'pattern');
            return [shownKey, REDACTED_MARKER];
          }
          countHide(ctx, memberKindIn(text, 'all', ctx) ?? 'pattern');
          return [shownKey, REDACTED_MARKER];
        }
        return [shownKey, walkValue(child, childPath, depth + 1, mode, ctx)];
      }),
    );
  } finally {
    ctx.stack.delete(node);
  }
}

/** F25: a shown key already used in this object gets `#2`, `#3`, …, so two keys that are wholly
 *  members do not collapse into one. */
function uniqueKey(shown: string, used: Set<string>): string {
  let key = shown;
  for (let k = 2; used.has(key); k++) key = `${shown}#${k}`;
  used.add(key);
  return key;
}

/** Whether a value under a credential name is hidden whole: anything but nothing (null, undefined,
 *  the empty string) and an existing marker. */
function hidesWhole(value: unknown): boolean {
  // F25: a boolean under a credential name stays a boolean (`{ password: true }` says one is set).
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
    return false;
  }
  return value !== REDACTED_MARKER;
}

function walkRow(
  child: unknown,
  row: DisclosureClass,
  path: string,
  depth: number,
  ctx: WalkContext,
): unknown {
  if (row === 'fact' || row === 'frozen') return child;
  if (row === 'value') {
    return walkValue(
      child,
      path,
      depth,
      {
        tier: ctx.tier,
        shape: ctx.audience === 'broadcast' || ctx.withhold !== undefined,
        shapedAt: path,
      },
      ctx,
    );
  }
  if (row === 'bounded') {
    // H-11': withheld, a diagnostic copy is shown as its shape too (it may hold a declared value).
    return walkValue(
      child,
      path,
      depth,
      { tier: ctx.tier, shape: ctx.withhold !== undefined, shapedAt: path },
      ctx,
    );
  }
  if (row === 'question' && ctx.withhold !== undefined) {
    // H-11': the question is not shown; the sentence says why. Nothing there, nothing withheld.
    if (child === undefined || child === null || child === '') return child;
    ctx.tally.questionWithheld = true;
    return withheldQuestion(ctx.withhold);
  }
  if (row === 'question') {
    // D-10: the receipt says a question was shown, masked at the declared tier only (P-9).
    if (child !== undefined && child !== null && child !== '') ctx.tally.question = true;
    return walkValue(child, path, depth, { tier: 'declared', shape: false, shapedAt: path }, ctx);
  }
  if ('choose' in row) return walkRow(child, row.choose(child), path, depth, ctx);
  if ('map' in row) return walkMap(child, row, path, depth, ctx);
  const table = typeof row.nested === 'function' ? row.nested(child) : row.nested;
  return walkTable(child, table, path, depth, ctx);
}

function walkMap(
  node: unknown,
  row: MapClass,
  path: string,
  depth: number,
  ctx: WalkContext,
): unknown {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    return walkRow(node, 'value', path, depth, ctx);
  }
  return Object.fromEntries(
    Object.entries(node).map(([key, child]) => {
      const table = typeof row.map === 'function' ? row.map(child) : row.map;
      return [key, walkTable(child, table, join(path, key), depth + 1, ctx)];
    }),
  );
}

function walkTable(
  node: unknown,
  table: ClassTable,
  path: string,
  depth: number,
  ctx: WalkContext,
): unknown {
  if (node === null || typeof node !== 'object') {
    // Not the object the table describes (an open or absent field): walked as a value.
    return walkRow(node, 'value', path, depth, ctx);
  }
  if (ctx.stack.has(node) || depth > DISCLOSURE_MAX_DEPTH) return cutShape(node, path, depth, ctx);
  ctx.stack.add(node);
  try {
    if (Array.isArray(node)) {
      return node.map((child, i) => walkTable(child, table, `${path}[${i}]`, depth + 1, ctx));
    }
    const rowOf = (key: string, childPath: string): DisclosureClass => {
      const row = Object.hasOwn(table, key) ? table[key] : undefined;
      if (row !== undefined) return row;
      ctx.onUnclassified?.(childPath);
      return 'value';
    };
    const derived = DERIVED_OF.get(table);
    const entries = Object.entries(node);
    if (derived === undefined) {
      return Object.fromEntries(
        entries.map(([key, child]) => {
          const childPath = join(path, key);
          return [key, walkRow(child, rowOf(key, childPath), childPath, depth + 1, ctx)];
        }),
      );
    }
    // I-9b: the rows a digest derives from are walked first, keeping whether the law hid anything
    // inside each; a digest of content it hid inside is then shown as its shape, on every audience.
    const shown = new Map<string, unknown>();
    const hid = new Set<string>();
    for (const [key, child] of entries) {
      if (Object.hasOwn(derived, key)) continue;
      const childPath = join(path, key);
      const before = hiddenTotal(ctx.tally);
      shown.set(key, walkRow(child, rowOf(key, childPath), childPath, depth + 1, ctx));
      if (hiddenTotal(ctx.tally) > before) hid.add(key);
    }
    for (const [key, child] of entries) {
      if (!Object.hasOwn(derived, key)) continue;
      const childPath = join(path, key);
      const source = derived[key]!;
      if (hid.has(source) && child !== undefined && child !== null) {
        noteShaped(ctx, childPath);
        ctx.tally.shapedCount += 1;
        shown.set(key, shapeOf(child));
      } else {
        shown.set(key, walkRow(child, rowOf(key, childPath), childPath, depth + 1, ctx));
      }
    }
    return Object.fromEntries(entries.map(([key]) => [key, shown.get(key)]));
  } finally {
    ctx.stack.delete(node);
  }
}

/**
 * Walks `value` by `table` for `audience`, returning the shown copy and what was hidden. The input
 * is never changed (the store keeps execution inputs raw, I1/D9).
 */
export function discloseByTable(
  value: unknown,
  table: ClassTable,
  set: DisclosureSet,
  audience: DisclosureAudience,
  options: WalkOptions = {},
): { value: unknown; tally: DisclosureTally } {
  const tally = newTally(audience);
  const ctx: WalkContext = {
    set,
    audience,
    tier: tierFor(audience),
    tally,
    onUnclassified: options.onUnclassified,
    stack: new Set(),
    withhold: options.withhold,
  };
  if (options.withhold !== undefined) tally.withheld = true;
  return { value: walkTable(value, table, '', 0, ctx), tally };
}

const VALUE_ONLY: ClassTable = { value: 'value' };

/**
 * The value walk alone: a value as `audience` sees it (shapes on `broadcast`, every tier elsewhere,
 * the declared tier on `private`). realm agent's `Result (<step>):` line, its gate-print preview and
 * Slack's message-less preview render through it.
 */
export function discloseValue(
  value: unknown,
  set: DisclosureSet,
  audience: DisclosureAudience,
): { value: unknown; tally: DisclosureTally } {
  const walked = discloseByTable({ value }, VALUE_ONLY, set, audience);
  return { value: (walked.value as { value: unknown }).value, tally: walked.tally };
}

// ── The receipt (RECORD 01 #7; D1 §3.7) ───────────────────────────────────────────────────────

/**
 * A reply's or record view's `disclosure` field: whether the declared values were known and why
 * not, whether the environment was swept, what was hidden by kind, what PR-M1 could not check, how
 * many declared values were too short to hide, and on `broadcast` which fields were shown as shapes.
 * Names appear only on a private terminal. Derived at read, from the walk's counts: no record
 * stores it, so none predates it.
 */
export interface DisclosureReceipt {
  declared: DeclaredState;
  declared_cause?: DeclaredCause;
  environment: EnvironmentState;
  environment_cause?: EnvironmentCause;
  hidden: HiddenCounts;
  unchecked: number;
  unmaskable: number;
  /** Subtrees shown as their shape past the walk's depth (D-10). */
  too_deep: number;
  /** `declared_only` when the reply showed a question: it is masked at the declared tier (P-9);
   *  `withheld` when it was withheld (H-11'). */
  question?: 'declared_only' | 'withheld';
  /** H-11': `withheld` when the values were shown as their shapes because the declared values
   *  could not be read or changed (beside `declared` and `declared_cause`). */
  values?: 'withheld';
  shaped?: string[];
  /** The sources of what was hidden — `private` only. */
  members?: string[];
}

/** Builds the receipt for a walk's tally over `set`. */
export function disclosureReceipt(set: DisclosureSet, tally: DisclosureTally): DisclosureReceipt {
  return {
    declared: set.declared,
    ...(set.declaredCause !== undefined ? { declared_cause: set.declaredCause } : {}),
    environment: set.environment,
    ...(set.environmentCause !== undefined ? { environment_cause: set.environmentCause } : {}),
    hidden: { ...tally.hidden },
    unchecked: tally.unchecked,
    unmaskable: set.unmaskable,
    too_deep: tally.tooDeep,
    ...(tally.questionWithheld
      ? { question: 'withheld' as const }
      : tally.question
        ? { question: 'declared_only' as const }
        : {}),
    ...(tally.withheld ? { values: 'withheld' as const } : {}),
    // I-9b: the shaped paths on every audience that shaped anything (a broadcast always says them).
    ...(tally.audience === 'broadcast' || tally.shapedCount > 0
      ? { shaped: [...tally.shaped] }
      : {}),
    ...(tally.audience === 'private' ? { members: [...tally.members].sort() } : {}),
  };
}
