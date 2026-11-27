// input-map-paths.ts — fix 1, unit 1: every `input_map` path a step consumes, judged when the file
// is loaded (`path-resolver.ts`), and the words the author reads.
//
// Two loader warning codes carry the findings, in the #169 channel:
//   INPUT_MAP_PATH_UNRESOLVABLE (policy 'error') — a path that can never be found. validate,
//     register and watch refuse the file (the #170 boundary); every running surface prints it and
//     goes on, as for an unknown key;
//   INPUT_MAP_PATH_UNCERTAIN (policy 'warn') — a path that may be absent when the step runs.
// A path into data the workflow declares no shape for is not a warning: it is returned as
// `notChecked`, and `validate` lists it.
//
// Only a map the step consumes is judged (`consumesInputMap`: an auto step with a `handler` or a
// `uses_service`); a bare step's map is inert there (AA-AUU1-01).
//
// The check is advisory and never stops a load (correction 1, N3). The workflow's shared answers
// (`PathIndex`) are built once for every leaf. A throw while judging one leaf lists that leaf as
// not checked, `why: check_failed`, and every other leaf is judged as usual; a throw while building
// the shared answers lists every leaf so. That is a named exception to the #123 rule (an internal
// bug is thrown, never relabelled): a bug in this check is shown by `validate`, never thrown.
//
// Piece 2a: the `when` leaves the loader's existing checks accepted are judged here too
// (`when-paths.ts`), over the same index and under the same catch.
import { consumesInputMap, type InputMapStep } from '../engine/input-map.js';
import { holdsFailureMessages } from '../engine/render-template.js';
import { capText } from '../utils/redaction.js';
import { resolveSeverity, type LoaderWarning, type WarningCode } from './diagnostics.js';
import { absentWhy, neverWords } from './path-reasons.js';
import { judgeWhenLeaf, whenLeafPath, type WhenLeaf } from './when-paths.js';
import { judgeTemplateLeaf, type TemplateLeaf } from './template-paths.js';
import {
  judgeRememberLeaf,
  rememberLeafKey,
  type RememberBlockAt,
  type RememberLeaf,
} from './remember-paths.js';
import {
  INPUT_MAP_SURFACE,
  PathIndex,
  resolveReference,
  type AbsentCause,
  type NotCheckedWhy,
  type PathWorkflow,
} from './path-resolver.js';
import type { SourcePosition } from './source-positions.js';

/**
 * An `input_map` path, a `when` condition, a template placeholder or a `remember` path that reads
 * data the workflow declares no shape for (`validate --json`'s `not_checked`).
 * @public
 */
export interface NotCheckedPath {
  /**
   * Where the path is read: an `input_map` leaf, a `when` condition (piece 2a), a template
   * placeholder in `gate.message`, `display`, a prompt or instructions (pieces 3a-ii-a and 3a-ii-b),
   * or a `remember` key or value path (gap 3).
   */
  surface: 'input_map' | 'when' | 'template' | 'remember';
  /** The step whose `input_map`, `when`, template or `remember` holds the path. */
  step: string;
  /**
   * The map's dotted key chain; `when` for a condition; the field's name for a template;
   * `key.<name>` or `value.<key>` for `remember`.
   */
  key: string;
  /** The path as written, trimmed: for a condition, its left-hand path. */
  path: string;
  /**
   * The shape reasons (and `added_from_file`, a context entry only the file loader adds), or
   * `check_failed` when the check itself failed on this path.
   */
  why: NotCheckedWhy | 'check_failed';
}

/**
 * A placeholder or an `input_map` leaf that puts a step's failure message
 * (`$settlement.<step>.message`, or a path that holds it) into a `prompt`, a gated step's
 * `instructions` or a step's `input_map`. Information for the author, never a warning: it moves no
 * exit code and never counts toward `--strict` (`validate --json`'s `notes`).
 * @public
 */
export interface LoaderNote {
  /** The step whose `prompt`, `instructions` or `input_map` holds it. */
  step: string;
  placement: 'prompt' | 'instructions' | 'input_map';
  /** The path as written, trimmed: the field, or a shorter path that holds it. */
  reads: string;
  /** The note's sentence; `realm workflow validate` prints it after `ℹ `. */
  message: string;
}

/**
 * The input_map leaves' findings: warnings for the loader's channel, the paths not checked, and
 * (gap 2, unit (iv-a1)) the notes.
 */
export interface InputMapPathFindings {
  warnings: LoaderWarning[];
  notChecked: NotCheckedPath[];
  notes: LoaderNote[];
}

/** Maximum nesting depth the loader admits (deeper maps are refused there, and not walked here). */
const MAX_DEPTH = 10;

/**
 * Judges every leaf of every consumed `input_map` in `workflow`, in the steps' order and each map's
 * key order, then each `when` leaf in `when.leaves` (piece 2a) — every finding in one pass, never
 * stopping at the first, over one shared index.
 *
 * `positionOf` resolves a key's place in the source (the loader's `SourcePositionMap.posOf`); a
 * finding cites the key's own line, else the step's (`(step at line N)`), else nothing.
 * `when.choicesOf` gives a step's gate choices (the loader's `gateChoicesOf`).
 */
export function checkInputMapPaths(
  workflow: PathWorkflow,
  positionOf: (segments: readonly string[]) => SourcePosition | undefined,
  when?: {
    leaves: readonly WhenLeaf[];
    choicesOf: (stepName: string) => readonly string[];
  },
  /** Piece 3a-ii-a: the `gate.message` and `display` placeholders to judge (`templateLeaves`). */
  templates: readonly TemplateLeaf[] = [],
  /** Gap 3, unit 1b-i: the `remember:` blocks of the steps `remember` goes on, to judge. */
  remember: readonly RememberBlockAt[] = [],
): InputMapPathFindings {
  const findings: InputMapPathFindings = { warnings: [], notChecked: [], notes: [] };
  const leaves: Leaf[] = [];
  const steps = typeof workflow.steps === 'object' && workflow.steps !== null ? workflow.steps : {};
  for (const [stepName, raw] of Object.entries(steps)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const step = raw as InputMapStep;
    if (!consumesInputMap(step)) continue;
    const map = step.input_map as unknown;
    if (typeof map !== 'object' || map === null || Array.isArray(map)) continue;
    walkMap(map as Record<string, unknown>, [], 0, (keys, rawPath) =>
      leaves.push({ stepName, keys, rawPath }),
    );
  }
  const whenLeaves = when?.leaves ?? [];
  const rememberLeaves = remember.flatMap(rememberLeavesOf);
  if (
    leaves.length === 0 &&
    whenLeaves.length === 0 &&
    templates.length === 0 &&
    rememberLeaves.length === 0
  ) {
    return findings;
  }

  let index: PathIndex | undefined;
  try {
    index = new PathIndex(workflow);
  } catch {
    index = undefined;
  }
  for (const leaf of leaves) {
    let judged: LeafFindings | undefined;
    if (index !== undefined) {
      try {
        judged = judgeLeaf(index, leaf, positionOf);
      } catch {
        judged = undefined;
      }
    }
    if (judged === undefined) {
      findings.notChecked.push({
        surface: 'input_map',
        step: leaf.stepName,
        key: leaf.keys.join('.'),
        path: leaf.rawPath.trim(),
        why: 'check_failed',
      });
      continue;
    }
    if (judged.notChecked !== undefined) findings.notChecked.push(judged.notChecked);
    if (judged.warning !== undefined) findings.warnings.push(judged.warning);
    // Gap 2, unit (iv-a3): pushed here, so every step's input_map notes come before the templates'.
    if (judged.note !== undefined) findings.notes.push(judged.note);
  }
  for (const leaf of whenLeaves) {
    let judged: LeafFindings | undefined;
    if (index !== undefined && when !== undefined) {
      try {
        judged = judgeWhenLeaf(index, leaf, when.choicesOf, positionOf);
      } catch {
        judged = undefined;
      }
    }
    if (judged === undefined) {
      let path: string;
      try {
        path = whenLeafPath(leaf.leaf);
      } catch {
        path = leaf.leaf.trim();
      }
      findings.notChecked.push({
        surface: 'when',
        step: leaf.step,
        key: 'when',
        path,
        why: 'check_failed',
      });
      continue;
    }
    if (judged.notChecked !== undefined) findings.notChecked.push(judged.notChecked);
    if (judged.warning !== undefined) findings.warnings.push(judged.warning);
  }
  // Piece 3a-ii-a: the template placeholders, over the same index and under the same catch.
  for (const leaf of templates) {
    let judged: LeafFindings | undefined;
    if (index !== undefined) {
      try {
        judged = judgeTemplateLeaf(index, leaf, positionOf);
      } catch {
        judged = undefined;
      }
    }
    if (judged === undefined) {
      findings.notChecked.push({
        surface: 'template',
        step: leaf.step,
        key: leaf.field,
        path: leaf.path,
        why: 'check_failed',
      });
      continue;
    }
    if (judged.notChecked !== undefined) findings.notChecked.push(judged.notChecked);
    if (judged.warning !== undefined) findings.warnings.push(judged.warning);
    if (judged.note !== undefined) findings.notes.push(judged.note);
  }
  // Gap 3, unit 1b-i: every `remember:` path, over the same index and under the same catch.
  for (const leaf of rememberLeaves) {
    let judged: LeafFindings | undefined;
    if (index !== undefined) {
      try {
        judged = judgeRememberLeaf(index, leaf, positionOf);
      } catch {
        judged = undefined;
      }
    }
    if (judged === undefined) {
      findings.notChecked.push({
        surface: 'remember',
        step: leaf.step,
        key: rememberLeafKey(leaf),
        path: leaf.rawPath.trim(),
        why: 'check_failed',
      });
      continue;
    }
    if (judged.notChecked !== undefined) findings.notChecked.push(judged.notChecked);
    if (judged.warning !== undefined) findings.warnings.push(judged.warning);
  }
  return findings;
}

/**
 * Gap 3, unit 1b-i: a `remember:` block's paths in the order written: each `key` part that is text,
 * then each `value` leaf, walked as an `input_map` is (`walkMap`). A part that is not a map gives no
 * leaf: the loader's own check refuses it.
 */
function rememberLeavesOf({ step, block }: RememberBlockAt): RememberLeaf[] {
  const out: RememberLeaf[] = [];
  if (typeof block !== 'object' || block === null || Array.isArray(block)) return out;
  const { as, key, value } = block as Record<string, unknown>;
  if (typeof key === 'object' && key !== null && !Array.isArray(key)) {
    for (const [name, rawPath] of Object.entries(key)) {
      if (typeof rawPath === 'string' && rawPath.trim() !== '') {
        out.push({ step, as, part: 'key', keys: [name], rawPath });
      }
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    walkMap(value as Record<string, unknown>, [], 0, (keys, rawPath) =>
      out.push({ step, as, part: 'value', keys, rawPath }),
    );
  }
  return out;
}

/** One `input_map` leaf: the step that holds it, its key chain, and the path as written. */
interface Leaf {
  stepName: string;
  keys: readonly string[];
  rawPath: string;
}

/** One leaf's findings, pushed only once all of them are built. */
export interface LeafFindings {
  warning?: LoaderWarning;
  notChecked?: NotCheckedPath;
  /** Gap 2, units (iv-a1) and (iv-a3): a template placeholder's or an `input_map` leaf's note. */
  note?: LoaderNote;
}

/** Walks a map as `resolveInputMap` does: string leaves are paths, `$literal` nodes are not. */
function walkMap(
  node: Record<string, unknown>,
  keys: readonly string[],
  depth: number,
  onLeaf: (keys: readonly string[], path: string) => void,
): void {
  if (depth > MAX_DEPTH) return;
  for (const [key, child] of Object.entries(node)) {
    const chain = [...keys, key];
    if (typeof child === 'string') {
      // An empty leaf is refused by the loader's own form check.
      if (child.trim() !== '') onLeaf(chain, child);
      continue;
    }
    if (typeof child !== 'object' || child === null || Array.isArray(child)) continue;
    // Row 11: a `$literal` leaf is not a path. Any other `$` key is refused by the directive gate.
    if (Object.keys(child).some((k) => k.startsWith('$'))) continue;
    walkMap(child as Record<string, unknown>, chain, depth + 1, onLeaf);
  }
}

function judgeLeaf(
  index: PathIndex,
  { stepName, keys, rawPath }: Leaf,
  positionOf: (segments: readonly string[]) => SourcePosition | undefined,
): LeafFindings {
  const judgement = resolveReference(rawPath, INPUT_MAP_SURFACE, stepName, index);
  const key = keys.join('.');
  const path = rawPath.trim();
  const findings: LeafFindings = {};

  let cause: { code: WarningCode; text: string; didYouMean?: string } | undefined;
  if (judgement.verdict === 'never') {
    cause = {
      code: 'INPUT_MAP_PATH_UNRESOLVABLE',
      ...neverWords(head(stepName, key), path, judgement.cause, 'input_map'),
    };
  } else if (judgement.verdict === 'may_be_absent') {
    cause = {
      code: 'INPUT_MAP_PATH_UNCERTAIN',
      text: absentWords(stepName, key, path, judgement.cause),
    };
  } else if (judgement.verdict === 'not_checked') {
    findings.notChecked = { surface: 'input_map', step: stepName, key, path, why: judgement.why };
    if (judgement.stepCause !== undefined) {
      cause = {
        code: 'INPUT_MAP_PATH_UNCERTAIN',
        text: absentWords(stepName, key, path, judgement.stepCause),
      };
    }
  }
  // Gap 2, unit (iv-a3), Words 1: a failure message handed to the step, unless the loader refuses
  // the leaf — the prompt note's rule (`holdsFailureMessages`).
  if (
    holdsFailureMessages(path) &&
    (cause === undefined || resolveSeverity(cause.code) !== 'error')
  ) {
    findings.note = {
      step: stepName,
      placement: 'input_map',
      reads: path,
      message:
        `Step '${capText(stepName)}' is handed a failure message (\`${capText(path)}\`) in its ` +
        `input_map at '${capText(key)}': the text is the failure's own, and whatever the step ` +
        `copies of it into its output is shown to assistants even under --failure-text hidden.`,
    };
  }
  if (cause === undefined) return findings;

  // The key's own line (`(line N)`), else the step's (`(step at line N)`), else no cite — the
  // loader's two-rung vocabulary (issue #420). The structured position is the key's, or absent.
  const keyPos = positionOf(['steps', stepName, 'input_map', ...keys]);
  const stepLine = positionOf(['steps', stepName])?.line;
  const at =
    keyPos !== undefined
      ? ` (line ${keyPos.line})`
      : stepLine !== undefined
        ? ` (step at line ${stepLine})`
        : '';
  const warning: LoaderWarning = {
    code: cause.code,
    severity: resolveSeverity(cause.code),
    message: cause.text + at,
    scope: 'step',
    step: stepName,
    key: capText(key),
  };
  if (cause.didYouMean !== undefined) warning.did_you_mean = cause.didYouMean;
  if (keyPos !== undefined) {
    warning.line = keyPos.line;
    warning.column = keyPos.column;
    warning.endLine = keyPos.endLine;
    warning.endColumn = keyPos.endColumn;
  }
  findings.warning = warning;
  return findings;
}

/** The opening every finding shares, bounded as unknown keys are (#872 b1). */
function head(stepName: string, key: string): string {
  return `Step '${stepName}': input_map '${capText(key)}'`;
}

function absentWords(stepName: string, key: string, path: string, cause: AbsentCause): string {
  const opening = head(stepName, key);
  const p = capText(path);
  const k = capText(key);
  switch (cause.rule) {
    case 'undeclared_field':
      return (
        `${opening} reads '${p}', which step '${cause.step}' does not declare; the step receives ` +
        `no value for '${k}' unless the output happens to carry it.`
      );
    case 'undeclared_param':
      return (
        `${opening} reads '${p}', which params_schema does not declare; the step receives no ` +
        `value for '${k}' unless the run's params carry it.`
      );
    case 'not_a_dependency':
      return (
        `${opening} reads step '${cause.step}', which this step does not depend on, so it may ` +
        `not have run yet; add '${cause.step}' to depends_on if this step needs it.`
      );
    case 'runs_after':
      return (
        `${opening} reads step '${cause.step}', which runs after this step, so it has no output ` +
        `when this step's input is built.`
      );
    case 'trigger_rule':
    case 'optional':
    case 'default_only':
    case 'list_position':
    case 'model_failure_only':
    case 'failure_only':
      return (
        `${opening} reads '${p}', which may be absent when this step runs (${absentWhy(cause)}); the ` +
        `step then receives no value for '${k}'.`
      );
  }
}
