// remember-paths.ts — gap 3, unit 1b-i: every path a step's `remember:` block reads (each `key`
// part and each `value` leaf), judged when the file is loaded through the shared resolver
// (`path-resolver.ts`, `REMEMBER_SURFACE`) as an `input_map` path is, and the words the author reads.
//
// Two loader warning codes carry the findings, in the #169 channel:
//   REMEMBER_PATH_UNRESOLVABLE (policy 'error') — a path that can never be found: validate, register
//     and watch refuse the file, as for INPUT_MAP_PATH_UNRESOLVABLE; every running surface prints it
//     and goes on;
//   REMEMBER_PATH_UNCERTAIN (policy 'warn') — a path that may be absent when the step remembers.
// A path into data the workflow declares no shape for is listed as not checked (`surface:
// 'remember'`). `checkInputMapPaths` walks the blocks the loader passes (the steps `remember` goes
// on, a block its own checks refuse included) and judges each leaf here, over the workflow's one
// index and under its one catch.
import { capText } from '../utils/redaction.js';
import { resolveSeverity, type LoaderWarning, type WarningCode } from './diagnostics.js';
import type { LeafFindings } from './input-map-paths.js';
import { absentWhy, neverWords } from './path-reasons.js';
import {
  REMEMBER_SURFACE,
  resolveReference,
  type AbsentCause,
  type NeverCause,
  type PathIndex,
} from './path-resolver.js';
import type { SourcePosition } from './source-positions.js';

/** One step's `remember:` block, as written, for the path check. */
export interface RememberBlockAt {
  step: string;
  block: unknown;
}

/** One path a `remember:` block reads: a `key` part, or a `value` leaf with its key chain. */
export interface RememberLeaf {
  step: string;
  /** The block's `as`, as written: a block the loader refuses is judged too. */
  as: unknown;
  part: 'key' | 'value';
  /** The key part's name, or the value leaf's key chain. */
  keys: readonly string[];
  rawPath: string;
}

/** A leaf's `key` in `not_checked` and in its finding: `key.<name>` or `value.<chain>`. */
export function rememberLeafKey(leaf: RememberLeaf): string {
  return `${leaf.part}.${leaf.keys.join('.')}`;
}

/**
 * Judges one `remember:` path over the workflow's shared index; `positionOf` resolves a key's place
 * in the source.
 */
export function judgeRememberLeaf(
  index: PathIndex,
  leaf: RememberLeaf,
  positionOf: (segments: readonly string[]) => SourcePosition | undefined,
): LeafFindings {
  const judgement = resolveReference(leaf.rawPath, REMEMBER_SURFACE, leaf.step, index);
  const path = leaf.rawPath.trim();
  const key = rememberLeafKey(leaf);
  const findings: LeafFindings = {};

  let cause: { code: WarningCode; text: string; didYouMean?: string } | undefined;
  if (judgement.verdict === 'never') {
    cause = { code: 'REMEMBER_PATH_UNRESOLVABLE', ...neverText(leaf, path, judgement.cause) };
  } else if (judgement.verdict === 'may_be_absent') {
    cause = { code: 'REMEMBER_PATH_UNCERTAIN', text: absentText(leaf, path, judgement.cause) };
  } else if (judgement.verdict === 'not_checked') {
    findings.notChecked = { surface: 'remember', step: leaf.step, key, path, why: judgement.why };
    // The step read may not have run: its words, beside the entry (as `input_map` does).
    if (judgement.stepCause !== undefined) {
      cause = {
        code: 'REMEMBER_PATH_UNCERTAIN',
        text: absentText(leaf, path, judgement.stepCause),
      };
    }
  }
  if (cause === undefined) return findings;

  // The key's own line, else the step's: the loader's two-rung cite (#420).
  const keyPos = positionOf(['steps', leaf.step, 'remember', leaf.part, ...leaf.keys]);
  const stepLine = positionOf(['steps', leaf.step])?.line;
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
    step: leaf.step,
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

/** Words 1: `Step '<s>': remember '<as>' key '<name>'`, or `… value '<key>'` for a value leaf. */
function opening(leaf: RememberLeaf): string {
  const as = typeof leaf.as === 'string' ? ` '${capText(leaf.as)}'` : '';
  return `Step '${leaf.step}': remember${as} ${leaf.part} '${capText(leaf.keys.join('.'))}'`;
}

/** Words 2: `input_map`'s sentence, with this opening; the two own-output causes have their own. */
function neverText(
  leaf: RememberLeaf,
  path: string,
  cause: NeverCause,
): { text: string; didYouMean?: string } {
  const p = capText(path);
  switch (cause.rule) {
    case 'own_settlement':
      return {
        text:
          `${opening(leaf)} reads '${p}', but a step's own '$settlement' is written after it ` +
          `remembers, so it is never there.`,
      };
    case 'own_choice':
      return {
        text:
          `${opening(leaf)} reads '${p}', but step '${cause.step}' opens no gate and its answer ` +
          `declares no 'choice'.`,
      };
    default:
      return neverWords(opening(leaf), path, cause, 'remember');
  }
}

/** Words 3: why the path may be absent, and what the step then remembers. */
function absentText(leaf: RememberLeaf, path: string, cause: AbsentCause): string {
  const o = opening(leaf);
  const p = capText(path);
  const then =
    leaf.part === 'key'
      ? 'the step remembers nothing'
      : `the remembered value has no '${capText(leaf.keys.join('.'))}'`;
  switch (cause.rule) {
    case 'undeclared_field':
      return `${o} reads '${p}', which step '${cause.step}' does not declare; when it is absent, ${then}.`;
    case 'undeclared_param':
      return `${o} reads '${p}', which params_schema does not declare; when it is absent, ${then}.`;
    case 'not_a_dependency':
      return (
        `${o} reads step '${cause.step}', which this step does not depend on, so it may not have ` +
        `run yet; add '${cause.step}' to depends_on if this step needs it. When it is absent, ` +
        `${then}.`
      );
    case 'runs_after':
      return (
        `${o} reads step '${cause.step}', which runs after this step, so it may have no output ` +
        `when this step remembers: ${then}.`
      );
    case 'trigger_rule':
    case 'optional':
    case 'default_only':
    case 'list_position':
    case 'model_failure_only':
    case 'failure_only':
      return (
        `${o} reads '${p}', which may be absent when this step remembers (${absentWhy(cause)}); ` +
        `when it is absent, ${then}.`
      );
  }
}
