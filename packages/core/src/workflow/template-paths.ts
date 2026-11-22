// template-paths.ts — fix 1, piece 3a-ii-a: every `{{ … }}` path in an approval question
// (`gate.message`) and in a step's `display`, judged against what the workflow declares through the
// shared resolver (`path-resolver.ts`), and the words the author reads. Piece 3a-ii-b: and in a
// step's `prompt` and its `instructions`.
//
// Three loader warning codes carry the findings, in the #169 channel:
//   TEMPLATE_PATH_UNRESOLVABLE (policy 'error') — a path that can never be found, in any field;
//   TEMPLATE_PATH_NO_DEFAULT (policy 'error') — a path in an approval question that may be missing,
//     which `| default` does not fill (#648 C1);
//   TEMPLATE_PATH_UNCERTAIN (policy 'warn') — a path in `display`, a prompt or step instructions
//     that may be missing (prompts stay lenient, #648 D3-3).
// validate, register and watch refuse the two error codes; every running surface prints all three
// and goes on. A path into data the workflow declares no shape for, or a context entry only a file
// adds, is listed as not checked (`surface: 'template'`).
//
// The fields judged are `gate.message` on a step whose trust opens a gate, and `display` on the
// kinds that render it (a gated auto step, an agent step); `prompt` on an auto or agent step, and
// `instructions` on a step whose trust opens a gate (a gateless step's are passed on raw). In a
// prompt or instructions a placeholder is judged only when it starts with Realm's own roots
// (`context`, `run`, `workflow`) or with a wrong start naming a step of the workflow
// (`startsWithStepName`); any other is text for the model. A placeholder piece 3a-i reports (an
// unknown filter, an argument no value accepts) gets nothing here, nor does a field that is not
// text. Whether `| default` fills a missing value is the renderer's own filter code's answer: the
// placeholder's filters run in order on a missing value (`applyFilter`, `'stored'`), as
// `renderTemplate` and `display` run them, never a rule about filter names.
import { TEMPLATE_PLACEHOLDER, applyFilter, placeholderParts } from '../engine/render-template.js';
import { isGateTrust } from '../types/workflow-definition.js';
import { capText } from '../utils/redaction.js';
import { resolveSeverity, type LoaderWarning, type WarningCode } from './diagnostics.js';
import type { LeafFindings } from './input-map-paths.js';
import { absentWhy } from './path-reasons.js';
import {
  DISPLAY_SURFACE,
  GATE_MESSAGE_SURFACE,
  PROMPT_SURFACE,
  resolveReference,
  startsWithStepName,
  type AbsentCause,
  type NeverCause,
  type PathIndex,
} from './path-resolver.js';
import type { SourcePosition } from './source-positions.js';
import { hasFilterFinding } from './template-check.js';

/** A field whose paths this piece judges. */
export type TemplateField = 'gate.message' | 'prompt' | 'instructions' | 'display';

/** Realm's own roots: a placeholder in a prompt or instructions starting with one is judged. */
const ENGINE_ROOTS: readonly string[] = ['context', 'run', 'workflow'];

/** One placeholder of one judged field. */
export interface TemplateLeaf {
  step: string;
  field: TemplateField;
  /** The placeholder's inside, trimmed. */
  expr: string;
  /** Its path, before the first filter. */
  path: string;
  filters: ReadonlyArray<{ name: string; args: string[]; quoted: boolean[] }>;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Every placeholder this piece judges, in the steps' file order, each step's fields in 3a-i's order
 * (`gate.message`, `prompt`, `instructions`, `display`). A placeholder piece 3a-i reports, a field
 * that is not text, and text for the model in a prompt or instructions, are left out.
 */
export function templateLeaves(stepsRaw: unknown): TemplateLeaf[] {
  const leaves: TemplateLeaf[] = [];
  if (!isObj(stepsRaw)) return leaves;
  for (const [step, raw] of Object.entries(stepsRaw)) {
    if (!isObj(raw)) continue;
    const kind = raw['execution'];
    if (kind !== 'auto' && kind !== 'agent') continue;
    const gated = isGateTrust(raw['trust']);
    const fields: Array<[TemplateField, unknown]> = [];
    const gate = raw['gate'];
    if (gated && isObj(gate)) fields.push(['gate.message', gate['message']]);
    fields.push(['prompt', raw['prompt']]);
    if (gated) fields.push(['instructions', raw['instructions']]);
    if (kind === 'agent' || gated) fields.push(['display', raw['display']]);
    for (const [field, value] of fields) {
      if (typeof value !== 'string') continue;
      for (const match of value.matchAll(TEMPLATE_PLACEHOLDER)) {
        const expr = match[1]!.trim();
        if (hasFilterFinding(expr)) continue;
        const parts = placeholderParts(expr);
        if (modelText(field, parts.path, stepsRaw)) continue;
        leaves.push({ step, field, expr, path: parts.path, filters: parts.filters });
      }
    }
  }
  return leaves;
}

/**
 * Piece 3a-ii-b: whether a placeholder in a prompt or instructions is text for the model. Realm has
 * no `\{{` escape and leaves an unknown placeholder as written, so one that starts with none of
 * Realm's own roots, nor a wrong start naming a step of the workflow, is not judged.
 */
function modelText(field: TemplateField, path: string, stepsRaw: Obj): boolean {
  if (field !== 'prompt' && field !== 'instructions') return false;
  const first = path.trim().split('.')[0]!;
  return !ENGINE_ROOTS.includes(first) && !startsWithStepName(path, stepsRaw);
}

/**
 * Whether the placeholder's filters, run in order on a missing value, give a value: every filter
 * succeeds and the result is not `undefined` or `null`. Only `default` accepts a missing value, and
 * the filters after it must take its value: a bare number or true/false keeps its type (the one
 * parse's quote flags, as the renderer reads them).
 */
function filledByDefault(filters: TemplateLeaf['filters']): boolean {
  if (filters.length === 0) return false;
  let value: unknown = undefined;
  for (const filter of filters) {
    let result: ReturnType<typeof applyFilter>;
    try {
      result = applyFilter(value, filter.name, filter.args, 'stored', filter.quoted);
    } catch {
      return false;
    }
    if (!result.ok) return false;
    value = result.value;
  }
  return value !== undefined && value !== null;
}

/** What a run does with a placeholder that finds nothing, by the placeholder's form. */
const CONSEQUENCE: Record<TemplateField, Record<'none' | 'default' | 'other', string>> = {
  'gate.message': {
    none: 'the gate does not open, and the run stays open with the step not done',
    default: "the question always shows what '| default' gives",
    other: 'the question shows the placeholder as written',
  },
  prompt: {
    none: 'the model is sent the placeholder as written',
    default: "the prompt always shows what '| default' gives",
    other: 'the model is sent the placeholder as written',
  },
  instructions: {
    none: 'the instructions show the placeholder as written',
    default: "the instructions always show what '| default' gives",
    other: 'the instructions show the placeholder as written',
  },
  display: {
    none: 'the placeholder is shown as nothing',
    default: "the placeholder always shows what '| default' gives",
    other: 'the placeholder is shown as nothing',
  },
};

const READS = "'context.resources.<step>.', 'run.params.' and 'workflow.context.<name>'";
const ROOT_REASON: Record<TemplateField, string> = {
  'gate.message': `an approval question reads only ${READS}`,
  prompt: `a prompt reads only ${READS}`,
  instructions: `step instructions read only ${READS}`,
  display: "display reads only the names of the step's own answer",
};

/** Piece 3a-ii-b: when the field is read, for the reasons and the may-be-missing words. */
const WHEN_READ: Record<TemplateField, string> = {
  'gate.message': ' when the gate opens',
  prompt: ' when the prompt is sent',
  instructions: ' when the gate opens',
  display: '',
};

/** The field's surface: instructions read what an approval question reads (the gate's root). */
const SURFACE = {
  'gate.message': GATE_MESSAGE_SURFACE,
  prompt: PROMPT_SURFACE,
  instructions: GATE_MESSAGE_SURFACE,
  display: DISPLAY_SURFACE,
} as const;

const DEFAULT_FIX =
  "Add '| default: <value>' as its first filter, keeping after it only filters that take that value";
const NOT_FILLED =
  "The filters after '| default' give nothing from its value, so its default is never shown.";

/**
 * Judges one placeholder over the workflow's shared index; `positionOf` resolves a key's place in
 * the source.
 */
export function judgeTemplateLeaf(
  index: PathIndex,
  leaf: TemplateLeaf,
  positionOf: (segments: readonly string[]) => SourcePosition | undefined,
): LeafFindings {
  const judgement = resolveReference(leaf.path, SURFACE[leaf.field], leaf.step, index);
  const filled = filledByDefault(leaf.filters);
  const form = leaf.filters.length === 0 ? 'none' : filled ? 'default' : 'other';
  const findings: LeafFindings = {};

  let finding: { code: WarningCode; text: string; didYouMean?: string } | undefined;
  const never = (reason: Reason): void => {
    finding = {
      code: 'TEMPLATE_PATH_UNRESOLVABLE',
      text:
        `${opening(leaf)}, which can never be found: ${reason.text}, so ` +
        `${CONSEQUENCE[leaf.field][form]}.` +
        (reason.fix !== undefined ? ` Write it as '${capText(reason.fix)}'.` : ''),
      ...(reason.didYouMean !== undefined ? { didYouMean: reason.didYouMean } : {}),
    };
  };
  const mayBeMissing = (cause: AbsentCause): void => {
    if (cause.rule === 'runs_after') {
      // Piece 3a-ii-b: a prompt never finds its own step's output (no evidence entry yet, or a
      // failed attempt's `output: {}`).
      never({
        text:
          leaf.field === 'prompt' && cause.step === leaf.step
            ? "this step's own output is not there when its prompt is sent"
            : runsAfterReason(cause.step, leaf.field),
      });
      return;
    }
    if (filled) return;
    const words = absentWords(cause);
    const fix = leaf.filters[0]?.name === 'default' ? NOT_FILLED : words.fix;
    finding = {
      code: leaf.field === 'gate.message' ? 'TEMPLATE_PATH_NO_DEFAULT' : 'TEMPLATE_PATH_UNCERTAIN',
      text:
        `${opening(leaf)}, which may be missing${WHEN_READ[leaf.field]} (${words.why}), so then ` +
        `${CONSEQUENCE[leaf.field][form]}.` +
        (fix !== undefined ? ` ${fix}` : ''),
      ...(words.didYouMean !== undefined ? { didYouMean: words.didYouMean } : {}),
    };
  };

  if (judgement.verdict === 'never') {
    never(neverReason(judgement.cause, leaf.field));
  } else if (judgement.verdict === 'may_be_absent') {
    mayBeMissing(judgement.cause);
  } else if (judgement.verdict === 'not_checked') {
    findings.notChecked = {
      surface: 'template',
      step: leaf.step,
      key: leaf.field,
      path: leaf.path,
      why: judgement.why,
    };
    if (judgement.stepCause !== undefined) mayBeMissing(judgement.stepCause);
  }
  if (finding === undefined) return findings;

  // The field's key line, else the step's: the loader's two-rung cite (#420).
  const keyPos = positionOf([
    'steps',
    leaf.step,
    ...(leaf.field === 'gate.message' ? ['gate', 'message'] : [leaf.field]),
  ]);
  const stepLine = positionOf(['steps', leaf.step])?.line;
  const at =
    keyPos !== undefined
      ? ` (line ${keyPos.line})`
      : stepLine !== undefined
        ? ` (step at line ${stepLine})`
        : '';
  const f: { code: WarningCode; text: string; didYouMean?: string } = finding;
  const out: LoaderWarning = {
    code: f.code,
    severity: resolveSeverity(f.code),
    message:
      f.text + (f.didYouMean !== undefined ? ` Did you mean '${capText(f.didYouMean)}'?` : '') + at,
    scope: 'step',
    step: leaf.step,
    key: leaf.field,
  };
  if (f.didYouMean !== undefined) out.did_you_mean = f.didYouMean;
  if (keyPos !== undefined) {
    out.line = keyPos.line;
    out.column = keyPos.column;
    out.endLine = keyPos.endLine;
    out.endColumn = keyPos.endColumn;
  }
  findings.warning = out;
  return findings;
}

/** The finding's opening, every part bounded. */
function opening(leaf: TemplateLeaf): string {
  return (
    `Step '${capText(leaf.step)}': ${leaf.field} reads '${capText(leaf.path)}' in ` +
    `'{{ ${capText(leaf.expr)} }}'`
  );
}

interface Reason {
  text: string;
  fix?: string;
  didYouMean?: string;
}

function runsAfterReason(step: string, field: TemplateField): string {
  return (
    `step '${capText(step)}' runs after this one, so its output is not there` +
    (field === 'prompt' ? ' when the prompt is sent' : ' when the gate opens')
  );
}

/** Item 1's reasons, by the resolver's never rows, worded as unit 1 and piece 2a word them. */
function neverReason(cause: NeverCause, field: TemplateField): Reason {
  const dym =
    'didYouMean' in cause && cause.didYouMean !== undefined ? { didYouMean: cause.didYouMean } : {};
  switch (cause.rule) {
    case 'bad_start':
    case 'bad_root':
    case 'template':
      return { text: ROOT_REASON[field], ...(cause.fix !== undefined ? { fix: cause.fix } : {}) };
    case 'no_step':
      return { text: `the workflow has no step '${capText(cause.step)}'`, ...dym };
    case 'no_field':
      return {
        text:
          `step '${capText(cause.step)}' has no field '${capText(cause.field)}' there, and its ` +
          `schema allows no other fields`,
        ...dym,
      };
    case 'no_settlement_field':
      return {
        text:
          `'$settlement.${capText(cause.step)}' holds only 'failed', 'settled_by_default', ` +
          `'validation_rejections' and 'failure_kind'`,
        ...dym,
      };
    case 'no_param':
      return {
        text: `params_schema has no parameter '${capText(cause.param)}' and allows no others`,
        ...dym,
      };
    case 'own_settlement':
      return {
        text:
          `'$settlement.${capText(cause.step)}' is there only once the step is settled, after its ` +
          `gate is answered`,
      };
    case 'own_choice':
      return {
        text: `'choice' is the answer to this question, so it is not there when the gate opens`,
      };
    case 'no_context_entry':
      return cause.name === ''
        ? { text: `'workflow.context' must be followed by the name of a workflow_context entry` }
        : { text: `workflow_context declares no entry '${capText(cause.name)}'`, ...dym };
  }
}

/** Item 3's `<why>`, its fix where it has one, and its did-you-mean. */
function absentWords(cause: Exclude<AbsentCause, { rule: 'runs_after' }>): {
  why: string;
  fix?: string;
  didYouMean?: string;
} {
  switch (cause.rule) {
    case 'optional':
      return {
        why: absentWhy(cause),
        fix: `${DEFAULT_FIX}, or make '${capText(cause.field)}' required.`,
      };
    case 'trigger_rule':
      return { why: absentWhy(cause), fix: `${DEFAULT_FIX}, or change the trigger_rule.` };
    case 'list_position':
    case 'default_only':
    case 'model_failure_only':
      return { why: absentWhy(cause), fix: `${DEFAULT_FIX}.` };
    case 'undeclared_field':
      return {
        why: `step '${capText(cause.step)}' does not declare this path`,
        ...(cause.didYouMean !== undefined ? { didYouMean: cause.didYouMean } : {}),
      };
    case 'undeclared_param':
      return {
        why: 'params_schema does not declare this path',
        ...(cause.didYouMean !== undefined ? { didYouMean: cause.didYouMean } : {}),
      };
    case 'not_a_dependency':
      return {
        why: `this step does not depend on '${capText(cause.step)}'`,
        fix: `Add '${capText(cause.step)}' to depends_on.`,
      };
  }
}
