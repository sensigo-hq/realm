// path-resolver.ts — fix 1, unit 1 (data paths): what a data path in a workflow can find, judged
// when the file is loaded, against what the workflow declares.
//
// ONE resolver for every surface that reads a path: `input_map` (this unit), `when` (unit 2) and
// templates (unit 3) call it with their own surface — the roots a path may start with — so nothing
// here is specific to `input_map`. Pure: no I/O, no throwing, no loader state; the caller renders
// the words and places the line.
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
// dependencies completed (AA-MA4-01); a default settle records `default_output` as written
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
 * Judges one path, read by `reader`, on `surface`, against what `workflow` declares.
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
  workflow: PathWorkflow,
): PathJudgement {
  const ctx = new Context(workflow, reader);
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
  /** One `depends_on`: that step's output. */
  | { readonly kind: 'step'; readonly shape: Shape };

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

/** One resolution's view of the workflow: step lookups, the dependency graph, memoised. */
class Context {
  private readonly steps: Readonly<Record<string, unknown>>;
  private readonly names: string[];
  private readonly ancestry = new Map<string, Set<string>>();

  constructor(
    private readonly workflow: PathWorkflow,
    private readonly reader: string,
  ) {
    this.steps = isObj(workflow.steps) ? workflow.steps : {};
    this.names = Object.keys(this.steps);
  }

  isStep(name: string): boolean {
    return name !== SETTLEMENT && Object.prototype.hasOwnProperty.call(this.steps, name);
  }

  private step(name: string): Obj {
    const s = this.steps[name];
    return isObj(s) ? s : {};
  }

  /** The step's `depends_on`, keeping only names of other steps (what the loader admits as edges). */
  private deps(name: string): string[] {
    const raw = this.step(name)['depends_on'];
    if (!Array.isArray(raw)) return [];
    return raw.filter((d): d is string => typeof d === 'string' && d !== name && this.isStep(d));
  }

  private rule(name: string): string {
    const raw = this.step(name)['trigger_rule'];
    return raw === undefined ? 'all_success' : String(raw);
  }

  /** Every step `name` depends on, directly or not. A cycle (refused at load) cannot loop here. */
  private ancestorsOf(name: string): Set<string> {
    const known = this.ancestry.get(name);
    if (known !== undefined) return known;
    const seen = new Set<string>();
    const stack = [...this.deps(name)];
    while (stack.length > 0) {
      const d = stack.pop()!;
      if (seen.has(d)) continue;
      seen.add(d);
      stack.push(...this.deps(d));
    }
    this.ancestry.set(name, seen);
    return seen;
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
    const schema = this.workflow.params_schema;
    if (!isObj(schema)) return { kind: 'not_checked', why: 'no_params_schema' };
    const walk = walkSchema(schema, rest);
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
      const stepCause = this.stepCause(t);
      return stepCause !== undefined ? { verdict: 'may_be_absent', cause: stepCause } : FOUND;
    }

    if (!this.isStep(s)) return this.noStep(s);
    const fields = rest.slice(1);
    const field: FieldJudgement =
      fields.length === 0 ? { kind: 'found' } : this.judgeShape(s, this.shapeOf(s), fields);
    if (field.kind === 'never') return never(field.cause);
    const stepCause = this.stepCause(s);
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
    const didYouMean = closestKey(name, this.names);
    return never({
      rule: 'no_step',
      step: name,
      ...(didYouMean !== undefined ? { didYouMean } : {}),
    });
  }

  /** Rows 8 and 9: can the step read be without output when the reader's input is built? */
  private stepCause(s: string): AbsentCause | undefined {
    const reader = this.reader;
    if (s === reader) return { rule: 'runs_after', step: s };
    if (!this.ancestorsOf(reader).has(s)) {
      return this.ancestorsOf(s).has(reader)
        ? { rule: 'runs_after', step: s }
        : { rule: 'not_a_dependency', step: s };
    }
    // Upstream. One dependency path down to `s` with `all_success` at every step on it (the reader
    // included, `s` itself not) means `s` completed before the reader ran (AA-MA4-01, AA-AUU1-19).
    const reaches = (d: string): boolean => d === s || this.ancestorsOf(d).has(s);
    const safe = new Map<string, boolean>();
    const isSafe = (x: string): boolean => {
      const known = safe.get(x);
      if (known !== undefined) return known;
      safe.set(x, false); // a cycle (refused at load) cannot make a path safe
      const result =
        this.rule(x) === 'all_success' &&
        this.deps(x).some((d) => d === s || (reaches(d) && isSafe(d)));
      safe.set(x, result);
      return result;
    };
    if (isSafe(reader)) return undefined;
    // Every path passes a step that may run without `s`: name the nearest one.
    if (this.rule(reader) !== 'all_success') return { rule: 'trigger_rule', step: s };
    const seen = new Set<string>();
    const queue = this.deps(reader).filter((d) => d !== s && reaches(d));
    while (queue.length > 0) {
      const d = queue.shift()!;
      if (seen.has(d)) continue;
      seen.add(d);
      if (this.rule(d) !== 'all_success') return { rule: 'trigger_rule', step: s, through: d };
      queue.push(...this.deps(d).filter((e) => e !== s && reaches(e)));
    }
    return { rule: 'trigger_rule', step: s };
  }

  /** What step `name` records as its output, as far as the workflow declares it. */
  private shapeOf(name: string, visiting: ReadonlySet<string> = new Set()): Shape {
    const step = this.step(name);
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
      const deps = this.deps(name);
      if (deps.length === 0) return { kind: 'inherited', from: { kind: 'params' }, choice: gated };
      if (deps.length > 1) return { kind: 'inherited', from: { kind: 'empty' }, choice: gated };
      const dep = deps[0]!;
      if (visiting.has(dep)) return { kind: 'none', choice: gated };
      const inner = this.shapeOf(dep, new Set([...visiting, name]));
      return { kind: 'inherited', from: { kind: 'step', shape: inner }, choice: gated };
    }
    return { kind: 'none', choice: false };
  }

  /** Judges `fields` against step `s`'s output shape. */
  private judgeShape(s: string, shape: Shape, fields: readonly string[]): FieldJudgement {
    // A gated step's evidence carries `choice` once its gate is answered (AA-AUU1-03).
    if (shape.choice && fields[0] === 'choice') return { kind: 'found' };
    if (shape.kind === 'none') return { kind: 'not_checked', why: 'producer_declares_no_shape' };
    if (shape.kind === 'schemas') return judgeAnswer(s, shape, fields);

    // A bare step: what it records may come from a caller, so nothing is refused, only warned.
    let inner: FieldJudgement;
    if (shape.from.kind === 'empty') {
      inner = { kind: 'absent', cause: { rule: 'undeclared_field', step: s } };
    } else if (shape.from.kind === 'params') {
      const params = this.judgeParamFields(fields);
      inner =
        params.kind === 'absent' && params.cause.rule === 'undeclared_param'
          ? { kind: 'absent', cause: { rule: 'undeclared_field', step: s } }
          : params;
    } else {
      inner = this.judgeShape(s, shape.from.shape, fields);
    }
    if (inner.kind === 'never') {
      return { kind: 'absent', cause: { rule: 'undeclared_field', step: s } };
    }
    if (inner.kind === 'absent' && inner.cause.rule === 'undeclared_field') {
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
  const walks = shape.schemas.map((schema) => walkSchema(schema, fields));
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
 */
function walkSchema(root: Obj, fields: readonly string[]): Walk {
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
