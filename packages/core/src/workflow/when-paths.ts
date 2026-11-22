// when-paths.ts — fix 1, piece 2a: a `when` condition judged against what the workflow declares
// when the file loads (`path-resolver.ts`, `WHEN_SURFACE`), and the words the author reads.
//
// Three loader warning codes carry the findings, in the #169 channel:
//   WHEN_PATH_UNRESOLVABLE (policy 'error') — the condition reads a path that can never be found;
//   WHEN_CHOICE_NOT_OFFERED (policy 'error') — it compares a gate's answer with a choice that gate
//     does not offer;
//   WHEN_PATH_UNCERTAIN (policy 'warn') — the value it reads may be absent.
// validate, register and watch refuse the two error codes (the #170 boundary); every running surface
// prints all three and goes on. A condition on data the workflow declares no shape for is listed as
// not checked (`surface: 'when'`).
//
// Only a leaf the existing `when` checks accepted reaches here (the loader collects them), on a step
// whose kind reads `when`, so a leaf gets at most one finding. What an absent value does is the
// engine's rule (`evaluateWhenCondition`): `== null` is then true, every other form false. The
// right-hand side is parsed by the engine's own `parseWhenRhs`.
import { splitComparison } from '../engine/comparison-expr.js';
import { parseWhenRhs } from '../engine/eligibility.js';
import { capText } from '../utils/redaction.js';
import {
  closestKey,
  resolveSeverity,
  type LoaderWarning,
  type WarningCode,
} from './diagnostics.js';
import type { LeafFindings } from './input-map-paths.js';
import { absentWhy } from './path-reasons.js';
import {
  WHEN_SURFACE,
  resolveReference,
  type AbsentCause,
  type NeverCause,
  type PathIndex,
} from './path-resolver.js';
import type { SourcePosition } from './source-positions.js';

/** One `when` leaf an existing check accepted: the step that holds it and the leaf as written. */
export interface WhenLeaf {
  step: string;
  leaf: string;
}

/** The left-hand path of a `when` leaf: the bare path, or a comparison's left-hand side. */
export function whenLeafPath(leaf: string): string {
  const split = splitComparison(leaf);
  if (split.kind === 'comparison') return split.lhsPath;
  if (split.kind === 'path') return split.path;
  return leaf.trim();
}

const NEVER_TRUE = 'This condition is never true, so the step is always skipped.';
const ALWAYS_TRUE = 'This condition is always true, so it never skips the step.';
const NOT_A_CHOICE_TEST =
  'This condition is true whenever the gate has been answered, so it does not test the choice.';

/**
 * Judges one `when` leaf over the workflow's shared index. `choicesOf` gives a step's gate choices
 * (the loader's `gateChoicesOf`); `positionOf` resolves a key's place in the source.
 */
export function judgeWhenLeaf(
  index: PathIndex,
  { step, leaf }: WhenLeaf,
  choicesOf: (stepName: string) => readonly string[],
  positionOf: (segments: readonly string[]) => SourcePosition | undefined,
): LeafFindings {
  const split = splitComparison(leaf);
  const path = whenLeafPath(leaf);
  const rhs = split.kind === 'comparison' ? parseWhenRhs(split.rhsRaw) : undefined;
  const op = split.kind === 'comparison' ? split.op : undefined;
  // `== null` / `!= null` test presence on purpose (the engine's 1c rule).
  const presence = (op === '==' || op === '!=') && rhs?.isBareNull === true;
  const segments = path.split('.');
  const settlement = segments[0] === '$settlement';
  // The step read: `<t>` of `<t>.<f>`, or of `$settlement.<t>.<f>`.
  const read = (settlement ? segments[1] : segments[0]) ?? '';
  // The step reading itself: its `depends_on` entry is already refused (item 2).
  if (read === step) return {};
  const choiceRead = !settlement && segments[1] === 'choice' && index.isStep(read);
  const noGate = choiceRead && !index.opensGate(read);

  const judgement = resolveReference(path, WHEN_SURFACE, step, index);
  const findings: LeafFindings = {};
  let warning: { code: WarningCode; text: string; didYouMean?: string } | undefined;

  if (judgement.verdict === 'never') {
    const reason = neverReason(judgement.cause, noGate);
    // A step the workflow lacks: its `depends_on` entry is already refused.
    if (reason === undefined) return findings;
    warning = {
      code: 'WHEN_PATH_UNRESOLVABLE',
      text:
        `${opening(step, leaf)} reads '${capText(path)}', which can never be found: ` +
        `${reason.text}. ${op === '==' && presence ? ALWAYS_TRUE : NEVER_TRUE}`,
      ...(reason.didYouMean !== undefined ? { didYouMean: reason.didYouMean } : {}),
    };
  } else {
    // A gate's answer compared with a choice the gate does not offer (item 4).
    const offered =
      choiceRead && !noGate && segments.length === 2 && (op === '==' || op === '!=')
        ? choicesOf(read)
        : undefined;
    if (offered !== undefined && typeof rhs?.value === 'string' && !offered.includes(rhs.value)) {
      const didYouMean = closestKey(rhs.value, offered);
      warning = {
        code: 'WHEN_CHOICE_NOT_OFFERED',
        text:
          `${opening(step, leaf)} compares '${capText(path)}' with '${capText(rhs.value)}', which ` +
          `is not one of the choices step '${capText(read)}' offers ` +
          `(${offered.map((c) => capText(c)).join(', ')}). ` +
          (op === '==' ? NEVER_TRUE : NOT_A_CHOICE_TEST),
        ...(didYouMean !== undefined ? { didYouMean } : {}),
      };
    } else if (judgement.verdict === 'may_be_absent') {
      const why = absentReason(judgement.cause, noGate, presence, settlement);
      if (why !== undefined)
        warning = { code: 'WHEN_PATH_UNCERTAIN', text: absentText(step, leaf, path, why) };
    } else if (judgement.verdict === 'not_checked') {
      if (noGate && !presence) {
        // `choice` from a step that opens no gate: the warning replaces the listing (item 5).
        warning = {
          code: 'WHEN_PATH_UNCERTAIN',
          text: absentText(step, leaf, path, choiceWhy(read)),
        };
      } else {
        findings.notChecked = { surface: 'when', step, key: 'when', path, why: judgement.why };
        const why =
          judgement.stepCause !== undefined
            ? absentReason(judgement.stepCause, false, presence, settlement)
            : undefined;
        if (why !== undefined)
          warning = { code: 'WHEN_PATH_UNCERTAIN', text: absentText(step, leaf, path, why) };
      }
    }
  }
  if (warning === undefined) return findings;

  // The `when` key's line, else the step's: the loader's two-rung cite (#420). A list item has no
  // position of its own (AA-AU2A-10), so every leaf of a list cites the key's line.
  const keyPos = positionOf(['steps', step, 'when']);
  const stepLine = positionOf(['steps', step])?.line;
  const at =
    keyPos !== undefined
      ? ` (line ${keyPos.line})`
      : stepLine !== undefined
        ? ` (step at line ${stepLine})`
        : '';
  const didYouMean = warning.didYouMean;
  const out: LoaderWarning = {
    code: warning.code,
    severity: resolveSeverity(warning.code),
    message:
      warning.text +
      (didYouMean !== undefined ? ` Did you mean '${capText(didYouMean)}'?` : '') +
      at,
    scope: 'step',
    step,
    key: 'when',
  };
  if (didYouMean !== undefined) out.did_you_mean = didYouMean;
  if (keyPos !== undefined) {
    out.line = keyPos.line;
    out.column = keyPos.column;
    out.endLine = keyPos.endLine;
    out.endColumn = keyPos.endColumn;
  }
  findings.warning = out;
  return findings;
}

/** The finding's opening, bounded as unit 1's is. */
function opening(step: string, leaf: string): string {
  return `Step '${step}': when '${capText(leaf.trim())}'`;
}

/** Item 2's reasons, by the resolver rows that can reach a `when` leaf; `undefined`: no finding. */
function neverReason(
  cause: NeverCause,
  noGate: boolean,
): { text: string; didYouMean?: string } | undefined {
  const dym =
    'didYouMean' in cause && cause.didYouMean !== undefined ? { didYouMean: cause.didYouMean } : {};
  switch (cause.rule) {
    case 'no_field':
      return noGate && cause.field === 'choice'
        ? {
            text:
              `only a gate's answer carries 'choice', step '${capText(cause.step)}' opens no gate, ` +
              `and its schema allows no other fields`,
            ...dym,
          }
        : {
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
    // A step the workflow lacks (its depends_on entry is refused), and the start, root and braces
    // rows, which the existing checks refuse first (AA-AU2A-07, -08).
    case 'no_step':
    case 'bad_start':
    case 'bad_root':
    case 'template':
      return undefined;
  }
}

/**
 * Items 5–6: the `<why>` of a may-be-absent warning, or `undefined` for a leaf that gets none: a
 * presence test, a `$settlement` leaf under the reader's trigger rule (a skipped step has no entry by
 * design), `$settlement.<s>.failure_kind` (gap 2, unit (ii-a): absent reads null, as a skipped step's
 * entry does), and the step causes whose `depends_on` entry is already refused (the step itself, a
 * step outside the reader's dependencies).
 */
function absentReason(
  cause: AbsentCause,
  noGate: boolean,
  presence: boolean,
  settlement: boolean,
): string | undefined {
  if (presence) return undefined;
  switch (cause.rule) {
    case 'runs_after':
    case 'not_a_dependency':
      return undefined;
    case 'trigger_rule':
      return settlement ? undefined : absentWhy(cause);
    case 'model_failure_only':
      return undefined;
    case 'undeclared_field':
      return noGate ? choiceWhy(cause.step) : `step '${capText(cause.step)}' does not declare it`;
    case 'undeclared_param':
      return 'params_schema does not declare it';
    case 'optional':
    case 'default_only':
    case 'list_position':
      return absentWhy(cause);
  }
}

function choiceWhy(step: string): string {
  return `only a gate's answer carries 'choice', and step '${capText(step)}' opens no gate`;
}

function absentText(step: string, leaf: string, path: string, why: string): string {
  return (
    `${opening(step, leaf)} reads '${capText(path)}', which may be absent when this condition is ` +
    `read (${why}); the condition is then false, and the step is skipped.`
  );
}
