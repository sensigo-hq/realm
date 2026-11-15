// path-resolver.ts — fix 1, unit 1 (data paths): what a data path in a workflow can find, judged
// when the file is loaded, against what the workflow declares.
//
// ONE resolver for every surface that reads a path: `input_map` (this unit), `when` (unit 2) and
// templates (unit 3) call it with their own surface — the roots a path may start with — so nothing
// here is specific to `input_map`. Pure: no I/O and no loader state; the caller renders the words
// and places the line. It is not meant to throw, and the checker that calls it catches anything
// that does, so a bug here never stops a workflow loading (correction 1, N3).
//
// The answers every path in one workflow shares — the dependency graph, each step's output shape,
// and per step read which steps reach it and which reach it safely — live in a `PathIndex`, built
// once per workflow and reused by every path (correction 1: a 1,000-step chain whose every step
// read the first took 65 s when each path rebuilt them, AA-WU1-15). Every walk is a loop with its
// own visited set, never a call per step, so a long chain or a `depends_on` cycle (refused in the
// same load, #424) cannot overflow the stack or loop.
//
// What it answers, for one path read by one step:
//   found          — nothing to say;
//   never          — the path can never find a value (a wrong start, an unknown step, a field a
//                    closed level does not declare), with the fix when one can be derived;
//   may_be_absent  — it might find nothing when the step runs (an undeclared field of an open level,
//                    an optional property, a list position, a step that may not have run);
//   not_checked    — the data it reads declares no shape (a handler's output, params with no
//                    `params_schema`), so nothing can be said about the field.
//
// The engine rules it follows, each read in the engine and recorded in plans/facts-ai-authoring.md:
// a path is split on `.` and walked object by object, arrays indexed by position (`resolvePath`,
// AA-AUU1-07); an agent step's output is its answer, plus `choice` once its gate is answered
// (AA-C1-03, AA-AUU1-03); a handler or adapter step's output declares no shape (AA-C1-02); a bare
// auto step records its one dependency's output (docs/concepts/step-kinds.md); `$settlement.<s>`
// holds three fields (AA-AUU1-04); a reader with `all_success` runs only after each of its
// dependencies completed (AA-MA4-01), and with exactly one dependency `one_success` is the same
// rule (AA-MA4-07); a step that runs only after `<s>` failed finds `$settlement.<s>`, because a
// failed step has its entry (AA-AUC1U-03); a default settle records `default_output` as written
// (AA-AUU1-02).
import { classifyStepTrust, type ExecutionMode } from '../types/workflow-definition.js';
import { closestKey } from './diagnostics.js';

/** One root a surface's paths may start with. */
export interface PathRoot {
  /** The segments before the data: `['run', 'params']`, `['context', 'resources']`. */
  readonly prefix: readonly string[];
  /** What follows the prefix: the run's params, or a step's output (the next segment names it). */
  readonly data: 'params' | 'step';
}

/** The roots a surface's paths may start with, in the order they are matched. */
export interface PathSurface {
  readonly roots: readonly PathRoot[];
}

/** `input_map`'s surface: the root `resolveInputMap` builds (`{ run: { params }, context: { resources } }`). */
export const INPUT_MAP_SURFACE: PathSurface = {
  roots: [
    { prefix: ['run', 'params'], data: 'params' },
    { prefix: ['context', 'resources'], data: 'step' },
  ],
};

/**
 * The workflow as the resolver reads it: the steps after templates are expanded, and the
 * workflow's `params_schema`. Raw on purpose — the loader calls it before the definition is typed,
 * and a malformed value is read as "declares nothing", never thrown on.
 */
export interface PathWorkflow {
  readonly steps: Readonly<Record<string, unknown>>;
  readonly params_schema?: unknown;
}

/** Why a path can never be found. */
export type NeverCause =
  /** Starts with none of the surface's roots (`steps.propose.output.amount_cents`, `review.verdict`). */
  | { readonly rule: 'bad_start'; readonly fix?: string }
  /** Starts with a root's first word but not the root (`run.param.x`, `context.propose.x`). */
  | { readonly rule: 'bad_root'; readonly fix?: string }
  /** Written with template braces. */
  | { readonly rule: 'template'; readonly fix?: string }
  /** Names a step the workflow does not have. */
  | { readonly rule: 'no_step'; readonly step: string; readonly didYouMean?: string }
  /** A field a closed level of a step's declared answer does not declare. */
  | {
      readonly rule: 'no_field';
      readonly step: string;
      readonly field: string;
      readonly didYouMean?: string;
    }
  /** A field `$settlement.<s>` does not hold. */
  | {
      readonly rule: 'no_settlement_field';
      readonly step: string;
      readonly field: string;
      readonly didYouMean?: string;
    }
  /** A parameter a closed `params_schema` does not declare. */
  | { readonly rule: 'no_param'; readonly param: string; readonly didYouMean?: string };

/** Why a path may find nothing when the step runs. */
export type AbsentCause =
  /** A field an open level does not declare, or one a bare step's inherited shape lacks. */
  | { readonly rule: 'undeclared_field'; readonly step: string }
  /** A parameter an open `params_schema` does not declare. */
  | { readonly rule: 'undeclared_param' }
  /** The step read is not in the reader's `depends_on` ancestry, and does not run after it. */
  | { readonly rule: 'not_a_dependency'; readonly step: string }
  /** The step read is the reader itself, or runs after it. */
  | { readonly rule: 'runs_after'; readonly step: string }
  /**
   * The step read is upstream, but every dependency path down to it passes a step whose
   * `trigger_rule` lets it run without the step read completing. `through` is the nearest such step
   * when it is not the reader itself.
   */
  | { readonly rule: 'trigger_rule'; readonly step: string; readonly through?: string }
  /** A property its schema does not require. */
  | { readonly rule: 'optional'; readonly field: string }
  /** A field only `default_output` carries (both schemas, `validation_exhaustion.mode: default`). */
  | { readonly rule: 'default_only'; readonly field: string }
  /** A position in a list, which may be shorter. */
  | { readonly rule: 'list_position'; readonly position: string };

/** Why a path was not checked. */
export type NotCheckedWhy = 'producer_declares_no_shape' | 'no_params_schema';

/** The resolver's one answer for one path. */
export type PathJudgement =
  | { readonly verdict: 'found' }
  | { readonly verdict: 'never'; readonly cause: NeverCause }
  | { readonly verdict: 'may_be_absent'; readonly cause: AbsentCause }
  | {
      readonly verdict: 'not_checked';
      readonly why: NotCheckedWhy;
      /** The step cause (rows 8–9) still applies to data whose fields cannot be judged. */
      readonly stepCause?: AbsentCause;
    };

/** The three fields `$settlement.<s>` holds (AA-AUU1-04), in the order the words name them. */
const SETTLEMENT_FIELDS: readonly string[] = [
  'failed',
  'settled_by_default',
  'validation_rejections',
];

const SETTLEMENT = '$settlement';
const FOUND: PathJudgement = { verdict: 'found' };
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null']);
/** The keywords that keep a level from being closed: each can let the value carry other fields. */
const OPENING_KEYWORDS = [
  'oneOf',
  'anyOf',
  'allOf',
  '$ref',
  'patternProperties',
  'if',
  'then',
  'dependentSchemas',
] as const;
const WHOLE_NUMBER = /^(0|[1-9]\d*)$/;
/** One `{{ x }}` whose inside is a plain path (no filter, no spaces): the only form a fix is given for. */
const ONE_TEMPLATE = /^\{\{\s*([^\s{}|]+)\s*\}\}$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Judges one path, read by `reader`, on `surface`, against what `workflow` declares. Pass the
 * workflow's `PathIndex` when judging several paths of one workflow, so its answers are built once;
 * a bare `PathWorkflow` builds its own.
 *
 * The order is fixed (the prompt's row order): braces, then the start, then the root, then the step
 * name, then the field; a path that can never be found gets no other finding. The step cause (the
 * step read may not have run) comes before a field cause, and a path into data that declares no
 * shape is `not_checked`, carrying the step cause beside it.
 */
export function resolveReference(
  path: string,
  surface: PathSurface,
  reader: string,
  workflow: PathWorkflow | PathIndex,
): PathJudgement {
  const index = workflow instanceof PathIndex ? workflow : new PathIndex(workflow);
  const ctx = new Context(index, reader);
  const trimmed = path.trim();

  // Row 3: braces. `input_map` (and `when`) take a path; the braces make it one no value has.
  if (trimmed.includes('{{') || trimmed.includes('}}')) {
    const inner = ONE_TEMPLATE.exec(trimmed)?.[1];
    return never(inner !== undefined ? { rule: 'template', fix: inner } : { rule: 'template' });
  }

  const segments = trimmed.split('.');
  const stepRoot = surface.roots.find((r) => r.data === 'step');

  // Row 1: the first word is no root's (`steps.propose.output.amount_cents`, `review.verdict`). The
  // fix moves a step's name under the step root, when the path names a step; nothing else is
  // guessed.
  const byHead = surface.roots.filter((r) => r.prefix.length > 0 && r.prefix[0] === segments[0]);
  if (byHead.length === 0) {
    const bare = surface.roots.find((r) => r.prefix.length === 0);
    if (bare !== undefined) return ctx.dispatch(bare, segments);
    const fix = stepFix(segments, stepRoot, ctx);
    return never(fix !== undefined ? { rule: 'bad_start', fix } : { rule: 'bad_start' });
  }

  // Row 2: the first word is a root's, the rest of the root is not (`run.param.x`,
  // `context.propose.x`); a fix as row 1's, from what follows the first word.
  const root = byHead.find((r) =>
    r.prefix.every((s, i) => i >= segments.length || segments[i] === s),
  );
  if (root === undefined) {
    const fix = stepFix(segments.slice(1), stepRoot, ctx);
    return never(fix !== undefined ? { rule: 'bad_root', fix } : { rule: 'bad_root' });
  }

  // A path that stops inside a root (`run`, `context.resources`) reads the whole object there.
  if (segments.length <= root.prefix.length) return FOUND;
  return ctx.dispatch(root, segments.slice(root.prefix.length));
}

function never(cause: NeverCause): PathJudgement {
  return { verdict: 'never', cause };
}

/** `<s>.<rest>` or `steps.<s>.output(s).<rest>`, for a step `<s>`, written under the step root. */
function stepFix(
  segments: readonly string[],
  stepRoot: PathRoot | undefined,
  ctx: Context,
): string | undefined {
  if (stepRoot === undefined || segments.length === 0) return undefined;
  let rest: readonly string[] | undefined;
  if (ctx.isStep(segments[0]!)) {
    rest = segments;
  } else if (
    segments[0] === 'steps' &&
    segments.length >= 3 &&
    ctx.isStep(segments[1]!) &&
    (segments[2] === 'output' || segments[2] === 'outputs')
  ) {
    rest = [segments[1]!, ...segments.slice(3)];
  }
  return rest === undefined ? undefined : [...stepRoot.prefix, ...rest].join('.');
}

/** What a step's output is, as the resolver knows it at load. */
type Shape =
  /** Declares nothing: a handler's or adapter's output, a guard, a finalizer, an unknown kind. */
  | { readonly kind: 'none'; readonly choice: boolean }
  /** An agent step's answer: every declared schema (the answer fits each), and a default answer. */
  | {
      readonly kind: 'schemas';
      readonly schemas: readonly Obj[];
      readonly defaultOutput: unknown;
      readonly choice: boolean;
    }
  /** A bare auto step: what it records comes from elsewhere, so its fields are at most absent. */
  | { readonly kind: 'inherited'; readonly from: InheritedFrom; readonly choice: boolean };

type InheritedFrom =
  /** No `depends_on`: the run's params. */
  | { readonly kind: 'params' }
  /** Several `depends_on`: `{}`. */
  | { readonly kind: 'empty' }
  /** One `depends_on`: that step's output (followed by a loop, never a call per step). */
  | { readonly kind: 'step'; readonly step: string };

/** The outcome of walking one schema down a path's fields. */
type Walk =
  | { readonly kind: 'declared'; readonly cause?: AbsentCause }
  | {
      readonly kind: 'closed_miss';
      readonly field: string;
      /** The field's position in the path's fields. */
      readonly index: number;
      readonly didYouMean?: string;
    }
  | { readonly kind: 'open_miss'; readonly field: string };

/** The judgement of the field part of a path, before the step cause is added. */
type FieldJudgement =
  | { readonly kind: 'found' }
  | { readonly kind: 'never'; readonly cause: NeverCause }
  | { readonly kind: 'absent'; readonly cause: AbsentCause }
  | { readonly kind: 'not_checked'; readonly why: NotCheckedWhy };

/** A set of step positions, one bit each. */
type Bits = Uint32Array;
const has = (bits: Bits, i: number): boolean => ((bits[i >>> 5] ?? 0) & (1 << (i & 31))) !== 0;
const add = (bits: Bits, i: number): void => {
  bits[i >>> 5] = (bits[i >>> 5] ?? 0) | (1 << (i & 31));
};

/**
 * The answers every path read in one workflow shares (correction 1, N3), built once per workflow:
 * the steps, each step's dependencies, dependents, trigger rule and output shape, and, per step
 * read, the steps that reach it and the steps that reach it safely. Each per-step answer is built
 * by a loop with its own visited set and stored only once complete, so a throw part-way through
 * never leaves half an answer for a later path.
 */
export class PathIndex {
  /** Every step name, in the file's order (the did-you-mean candidates). */
  readonly names: readonly string[];
  readonly paramsSchema: unknown;
  private readonly steps: Readonly<Record<string, unknown>>;
  private readonly position = new Map<string, number>();
  private readonly depsOf: readonly (readonly number[])[];
  private readonly dependentsOf: readonly (readonly number[])[];
  private readonly rules: readonly string[];
  private readonly shapes: readonly Shape[];
  private readonly words: number;
  private readonly reaching = new Map<number, Bits>();
  private readonly reachingSafely = new Map<string, Bits>();

  constructor(workflow: PathWorkflow) {
    this.steps = isObj(workflow.steps) ? workflow.steps : {};
    this.paramsSchema = workflow.params_schema;
    this.names = Object.keys(this.steps);
    this.names.forEach((name, i) => this.position.set(name, i));
    this.words = Math.ceil(this.names.length / 32);
    // The step's `depends_on`, keeping only names of other steps (what the loader admits as edges).
    const depNames = this.names.map((name) => {
      const raw = this.step(name)['depends_on'];
      if (!Array.isArray(raw)) return [];
      return raw.filter((d): d is string => typeof d === 'string' && d !== name && this.isStep(d));
    });
    this.depsOf = depNames.map((deps) => deps.map((d) => this.at(d)));
    const dependents: number[][] = this.names.map(() => []);
    this.depsOf.forEach((deps, x) => {
      for (const d of deps) dependents[d]!.push(x);
    });
    this.dependentsOf = dependents;
    this.rules = this.names.map((name) => {
      const raw = this.step(name)['trigger_rule'];
      return raw === undefined ? 'all_success' : String(raw);
    });
    this.shapes = this.names.map((name, i) => localShape(this.step(name), depNames[i]!));
  }

  isStep(name: string): boolean {
    return name !== SETTLEMENT && Object.prototype.hasOwnProperty.call(this.steps, name);
  }

  /** What step `name` records, one level deep: a bare step's points at the step it inherits from. */
  shapeOf(name: string): Shape {
    return this.shapes[this.at(name)]!;
  }

  /**
   * Rows 8 and 9: can step `s` be without output when `reader`'s input is built? `settlement` is
   * true for a `$settlement.<s>` read, which a step that runs only after `s` failed also finds.
   */
  stepCause(reader: string, s: string, settlement: boolean): AbsentCause | undefined {
    if (s === reader) return { rule: 'runs_after', step: s };
    const r = this.at(reader);
    const t = this.at(s);
    const reach = this.reachTo(t);
    if (!has(reach, r)) {
      return has(this.reachTo(r), t)
        ? { rule: 'runs_after', step: s }
        : { rule: 'not_a_dependency', step: s };
    }
    // Upstream. One dependency path down to `s` with a safe rule at every step on it (the reader
    // included, `s` itself not) means `s` completed before the reader ran (AA-MA4-01).
    if (has(this.safelyTo(t, settlement), r)) return undefined;
    // Every path passes a step that may run without `s`: name the nearest one, by the same test.
    if (!this.safeStep(r, t, settlement)) return { rule: 'trigger_rule', step: s };
    const seen = new Uint32Array(this.words);
    const queue: number[] = [];
    const enqueueDeps = (x: number): void => {
      for (const d of this.depsOf[x]!) {
        if (d === t || !has(reach, d) || has(seen, d)) continue;
        add(seen, d);
        queue.push(d);
      }
    };
    enqueueDeps(r);
    for (let i = 0; i < queue.length; i++) {
      const d = queue[i]!;
      if (!this.safeStep(d, t, settlement)) {
        return { rule: 'trigger_rule', step: s, through: this.names[d]! };
      }
      enqueueDeps(d);
    }
    return { rule: 'trigger_rule', step: s };
  }

  private step(name: string): Obj {
    const s = this.steps[name];
    return isObj(s) ? s : {};
  }

  private at(name: string): number {
    const i = this.position.get(name);
    if (i === undefined) throw new Error(`path-resolver: no step '${name}' in the index`);
    return i;
  }

  /** The steps that reach step `t` through `depends_on` (`t` itself included). */
  private reachTo(t: number): Bits {
    const known = this.reaching.get(t);
    if (known !== undefined) return known;
    const bits = new Uint32Array(this.words);
    add(bits, t);
    const queue = [t];
    for (let i = 0; i < queue.length; i++) {
      for (const x of this.dependentsOf[queue[i]!]!) {
        if (has(bits, x)) continue;
        add(bits, x);
        queue.push(x);
      }
    }
    this.reaching.set(t, bits);
    return bits;
  }

  /**
   * The steps with a dependency path down to step `t` that has a safe rule at every step on it
   * (`t` itself not counted): a walk out from `t` through its dependents, entering only such steps.
   * A cycle never makes a path safe: the walk enters a step at most once, and only from a step
   * already safe.
   */
  private safelyTo(t: number, settlement: boolean): Bits {
    const key = `${String(t)}:${settlement ? 's' : 'f'}`;
    const known = this.reachingSafely.get(key);
    if (known !== undefined) return known;
    const bits = new Uint32Array(this.words);
    const queue: number[] = [];
    for (const x of this.dependentsOf[t]!) {
      if (has(bits, x) || !this.edgeSafe(x, settlement)) continue;
      add(bits, x);
      queue.push(x);
    }
    for (let i = 0; i < queue.length; i++) {
      for (const x of this.dependentsOf[queue[i]!]!) {
        if (x === t || has(bits, x) || !this.ruleSafe(x)) continue;
        add(bits, x);
        queue.push(x);
      }
    }
    this.reachingSafely.set(key, bits);
    return bits;
  }

  /** A rule that lets step `x` run only after each of its dependencies completed. */
  private ruleSafe(x: number): boolean {
    const rule = this.rules[x];
    return rule === 'all_success' || (rule === 'one_success' && this.depsOf[x]!.length === 1);
  }

  /**
   * Step `x`'s rule, for its edge to the step read. A `$settlement` read is also found by a step that
   * runs only after that step failed: `all_failed`, or `one_failed` over that step alone (D1).
   */
  private edgeSafe(x: number, settlement: boolean): boolean {
    if (this.ruleSafe(x)) return true;
    if (!settlement) return false;
    const rule = this.rules[x];
    return rule === 'all_failed' || (rule === 'one_failed' && this.depsOf[x]!.length === 1);
  }

  /** The one test, for the reader's own rule and the step a warning names (F7). */
  private safeStep(x: number, t: number, settlement: boolean): boolean {
    return this.depsOf[x]!.includes(t) ? this.edgeSafe(x, settlement) : this.ruleSafe(x);
  }
}

/** What one step records as its output, as far as its own definition says. */
function localShape(step: Obj, deps: readonly string[]): Shape {
  const kind = step['execution'];
  const gated =
    (kind === 'auto' || kind === 'agent') &&
    classifyStepTrust(kind as ExecutionMode, step['trust']) === 'gates';
  if (kind === 'agent') {
    const schemas = [step['input_schema'], step['output_schema']].filter(isObj);
    if (schemas.length === 0) return { kind: 'none', choice: gated };
    const exhaustion = step['validation_exhaustion'];
    const defaultOutput =
      isObj(exhaustion) && exhaustion['mode'] === 'default'
        ? exhaustion['default_output']
        : undefined;
    return { kind: 'schemas', schemas, defaultOutput, choice: gated };
  }
  if (kind === 'auto') {
    if (step['handler'] !== undefined || step['uses_service'] !== undefined) {
      return { kind: 'none', choice: gated };
    }
    // A bare step records its one dependency's output (run params with none, `{}` with several).
    if (deps.length === 0) return { kind: 'inherited', from: { kind: 'params' }, choice: gated };
    if (deps.length > 1) return { kind: 'inherited', from: { kind: 'empty' }, choice: gated };
    return { kind: 'inherited', from: { kind: 'step', step: deps[0]! }, choice: gated };
  }
  return { kind: 'none', choice: false };
}

/** One path's view: the reader, over the workflow's shared answers. */
class Context {
  constructor(
    private readonly index: PathIndex,
    private readonly reader: string,
  ) {}

  isStep(name: string): boolean {
    return this.index.isStep(name);
  }

  /** Judges what follows a root: params, or a step's output. */
  dispatch(root: PathRoot, rest: readonly string[]): PathJudgement {
    return root.data === 'params' ? this.judgeParams(rest) : this.judgeStepPath(rest);
  }

  judgeParams(rest: readonly string[]): PathJudgement {
    if (rest.length === 0) return FOUND;
    const field = this.judgeParamFields(rest);
    if (field.kind === 'never') return never(field.cause);
    if (field.kind === 'not_checked') return { verdict: 'not_checked', why: field.why };
    if (field.kind === 'absent') return { verdict: 'may_be_absent', cause: field.cause };
    return FOUND;
  }

  private judgeParamFields(rest: readonly string[]): FieldJudgement {
    const schema = this.index.paramsSchema;
    if (!isObj(schema)) return { kind: 'not_checked', why: 'no_params_schema' };
    // The run's params may be a list (CLI `--params`, AA-AUC1U-11): the top level follows the rule
    // for a level that can hold one.
    const walk = walkSchema(schema, rest, true);
    if (walk.kind === 'closed_miss') {
      // The parameter named is the path below `run.params` down to the missing field.
      const param = rest.slice(0, walk.index + 1).join('.');
      return {
        kind: 'never',
        cause: {
          rule: 'no_param',
          param,
          ...(walk.didYouMean !== undefined ? { didYouMean: walk.didYouMean } : {}),
        },
      };
    }
    if (walk.kind === 'open_miss') return { kind: 'absent', cause: { rule: 'undeclared_param' } };
    return walk.cause !== undefined ? { kind: 'absent', cause: walk.cause } : { kind: 'found' };
  }

  /** `<s>.<fields…>` under the step root (`context.resources.` for `input_map`). */
  judgeStepPath(rest: readonly string[]): PathJudgement {
    if (rest.length === 0) return FOUND;
    const s = rest[0]!;

    // `$settlement.<t>.<field>`: `<t>` is judged as a step name, then only three fields exist.
    if (s === SETTLEMENT) {
      if (rest.length === 1) return FOUND;
      const t = rest[1]!;
      if (!this.isStep(t)) return this.noStep(t);
      const fields = rest.slice(2);
      if (fields.length > 0 && !SETTLEMENT_FIELDS.includes(fields[0]!)) {
        const didYouMean = closestKey(fields[0]!, SETTLEMENT_FIELDS);
        return never({
          rule: 'no_settlement_field',
          step: t,
          field: fields[0]!,
          ...(didYouMean !== undefined ? { didYouMean } : {}),
        });
      }
      const stepCause = this.index.stepCause(this.reader, t, true);
      return stepCause !== undefined ? { verdict: 'may_be_absent', cause: stepCause } : FOUND;
    }

    if (!this.isStep(s)) return this.noStep(s);
    const fields = rest.slice(1);
    const field: FieldJudgement =
      fields.length === 0 ? { kind: 'found' } : this.judgeShape(s, fields);
    if (field.kind === 'never') return never(field.cause);
    const stepCause = this.index.stepCause(this.reader, s, false);
    if (field.kind === 'not_checked') {
      return {
        verdict: 'not_checked',
        why: field.why,
        ...(stepCause !== undefined ? { stepCause } : {}),
      };
    }
    if (stepCause !== undefined) return { verdict: 'may_be_absent', cause: stepCause };
    if (field.kind === 'absent') return { verdict: 'may_be_absent', cause: field.cause };
    return FOUND;
  }

  private noStep(name: string): PathJudgement {
    const didYouMean = closestKey(name, this.index.names);
    return never({
      rule: 'no_step',
      step: name,
      ...(didYouMean !== undefined ? { didYouMean } : {}),
    });
  }

  /**
   * Judges `fields` against step `s`'s output. A bare step's output is followed down its chain of
   * single dependencies by a loop, to the step that declares it; a chain that comes back to a step
   * already walked (a cycle, refused at load) declares nothing.
   */
  private judgeShape(s: string, fields: readonly string[]): FieldJudgement {
    const walked = new Set<string>([s]);
    let shape = this.index.shapeOf(s);
    let bare = false;
    let inner: FieldJudgement;
    for (;;) {
      // A gated step's evidence carries `choice` once its gate is answered (AA-AUU1-03).
      if (shape.choice && fields[0] === 'choice') return { kind: 'found' };
      if (shape.kind === 'none') {
        inner = { kind: 'not_checked', why: 'producer_declares_no_shape' };
        break;
      }
      if (shape.kind === 'schemas') {
        inner = judgeAnswer(s, shape, fields);
        break;
      }
      // A bare step: what it records may come from a caller, so nothing is refused, only warned.
      bare = true;
      const from = shape.from;
      if (from.kind === 'empty') {
        inner = { kind: 'absent', cause: { rule: 'undeclared_field', step: s } };
        break;
      }
      if (from.kind === 'params') {
        const params = this.judgeParamFields(fields);
        inner =
          params.kind === 'absent' && params.cause.rule === 'undeclared_param'
            ? { kind: 'absent', cause: { rule: 'undeclared_field', step: s } }
            : params;
        break;
      }
      if (walked.has(from.step)) {
        inner = { kind: 'not_checked', why: 'producer_declares_no_shape' };
        break;
      }
      walked.add(from.step);
      shape = this.index.shapeOf(from.step);
    }
    if (!bare) return inner;
    if (
      inner.kind === 'never' ||
      (inner.kind === 'absent' && inner.cause.rule === 'undeclared_field')
    ) {
      return { kind: 'absent', cause: { rule: 'undeclared_field', step: s } };
    }
    return inner;
  }
}

/** An agent step's answer: it fits every declared schema; a default answer may carry more. */
function judgeAnswer(
  s: string,
  shape: Extract<Shape, { kind: 'schemas' }>,
  fields: readonly string[],
): FieldJudgement {
  // An agent answer is always a record (AA-AUC1U-11): its top level never holds a list.
  const walks = shape.schemas.map((schema) => walkSchema(schema, fields, false));
  const refused = walks.find(
    (w): w is Extract<Walk, { kind: 'closed_miss' }> => w.kind === 'closed_miss',
  );
  if (refused !== undefined) {
    // With `validation_exhaustion.mode: default` the step can record `default_output` as written,
    // which the loader proves against `output_schema` alone (AA-AUU1-02, -21): a path it holds is
    // at most absent, never refused.
    if (resolvesIn(shape.defaultOutput, fields)) {
      return { kind: 'absent', cause: { rule: 'default_only', field: refused.field } };
    }
    return {
      kind: 'never',
      cause: {
        rule: 'no_field',
        step: s,
        field: refused.field,
        ...(refused.didYouMean !== undefined ? { didYouMean: refused.didYouMean } : {}),
      },
    };
  }
  const declared = walks.filter(
    (w): w is Extract<Walk, { kind: 'declared' }> => w.kind === 'declared',
  );
  if (declared.length === 0) {
    return { kind: 'absent', cause: { rule: 'undeclared_field', step: s } };
  }
  // The answer fits every schema: one that declares the field as always there settles it.
  if (declared.some((w) => w.cause === undefined)) return { kind: 'found' };
  return { kind: 'absent', cause: declared[0]!.cause! };
}

/**
 * Walks one JSON Schema down `fields`, level by level. A level is closed only when it says
 * `additionalProperties: false` and uses none of the keywords that can let other fields in; a miss
 * is refused only at a closed level whose every level above declared its segment (each segment
 * walked here was declared, or stepped into an array's `items`). Nothing below a scalar is judged.
 *
 * Correction 1 (N1): a closed level that can also hold a list — no `type`, or `array` beside another
 * type — may find a value at a position or at `length`, so those are at most absent there; any other
 * miss is still refused. `topCanBeList` is false for an agent's answer, whose top is a record.
 */
function walkSchema(root: Obj, fields: readonly string[], topCanBeList: boolean): Walk {
  let level: unknown = root;
  let cause: AbsentCause | undefined;
  for (const [index, field] of fields.entries()) {
    if (!isObj(level)) return { kind: 'open_miss', field };
    if (isScalarLevel(level)) break;
    if (isArrayLevel(level)) {
      if (field === 'length') break;
      if (WHOLE_NUMBER.test(field)) {
        cause ??= { rule: 'list_position', position: field };
        level = level['items'];
        continue;
      }
      return { kind: 'open_miss', field };
    }
    const properties = isObj(level['properties']) ? level['properties'] : undefined;
    if (properties !== undefined && Object.prototype.hasOwnProperty.call(properties, field)) {
      const required = level['required'];
      if (!(Array.isArray(required) && required.includes(field))) {
        cause ??= { rule: 'optional', field };
      }
      level = properties[field];
      continue;
    }
    if (isClosedLevel(level)) {
      if ((index > 0 || topCanBeList) && canHoldList(level)) {
        if (WHOLE_NUMBER.test(field)) {
          cause ??= { rule: 'list_position', position: field };
          level = level['items'];
          continue;
        }
        if (field === 'length') return { kind: 'open_miss', field };
      }
      const didYouMean = closestKey(field, properties !== undefined ? Object.keys(properties) : []);
      return {
        kind: 'closed_miss',
        field,
        index,
        ...(didYouMean !== undefined ? { didYouMean } : {}),
      };
    }
    return { kind: 'open_miss', field };
  }
  return cause !== undefined ? { kind: 'declared', cause } : { kind: 'declared' };
}

function typesOf(level: Obj): string[] | undefined {
  const t = level['type'];
  if (typeof t === 'string') return [t];
  if (Array.isArray(t) && t.every((x) => typeof x === 'string')) return t as string[];
  return undefined;
}

function isScalarLevel(level: Obj): boolean {
  const types = typesOf(level);
  return types !== undefined && types.length > 0 && types.every((t) => SCALAR_TYPES.has(t));
}

function isArrayLevel(level: Obj): boolean {
  const types = typesOf(level)?.filter((t) => t !== 'null');
  return types !== undefined && types.length > 0 && types.every((t) => t === 'array');
}

/** A level that may be a list as well as something else: no `type`, or `array` beside another type. */
function canHoldList(level: Obj): boolean {
  const types = typesOf(level);
  return (
    types === undefined ||
    (types.includes('array') && types.some((t) => t !== 'array' && t !== 'null'))
  );
}

function isClosedLevel(level: Obj): boolean {
  return (
    level['additionalProperties'] === false &&
    OPENING_KEYWORDS.every((k) => !Object.prototype.hasOwnProperty.call(level, k))
  );
}

/** Does `fields` find a value in `value`, walked as the engine walks a path (`resolvePath`)? */
function resolvesIn(value: unknown, fields: readonly string[]): boolean {
  if (value === undefined) return false;
  let current: unknown = value;
  for (const field of fields) {
    if (typeof current !== 'object' || current === null) return false;
    current = (current as Obj)[field];
  }
  return current !== undefined;
}
