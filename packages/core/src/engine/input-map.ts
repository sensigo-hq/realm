// input-map.ts — what an `auto` step's `input_map` builds, and who reads it (issue #688).
//
// One leaf module: the dispatch (`execution-loop.ts`) and the check before a claim (`pending.ts`) both
// read it, and it imports neither. A step with a `handler` or a `uses_service` receives exactly what
// its map builds, so its `input_schema` is checked against that, by the one rule `consumesInputMap`.
import type { InputMapNode, LiteralNode, StepDefinition } from '../types/workflow-definition.js';
import type { RunRecord } from '../types/run-record.js';
import { WorkflowError } from '../types/workflow-error.js';
import { validateInputSchema } from '../validation/input-schema.js';
import { buildEvidenceByStep } from './eligibility.js';
import { resolvePath } from './render-template.js';

/** Maximum nesting depth allowed in an input_map tree. */
const MAX_INPUT_MAP_DEPTH = 10;

/**
 * The step fields this module reads — a narrow, all-optional view of a `StepDefinition`, so a full
 * definition satisfies it, and so does a way out's lighter view of a workflow (`WayOutSteps`, whose
 * existing callers pass steps with only some of these fields, `execution` as plain text).
 */
export type InputMapStep = {
  readonly execution?: string;
  readonly handler?: StepDefinition['handler'];
  readonly uses_service?: StepDefinition['uses_service'];
  readonly input_map?: StepDefinition['input_map'];
  readonly input_schema?: StepDefinition['input_schema'];
  readonly depends_on?: readonly string[];
};

/**
 * Resolves an input_map declaration into a concrete params object, against the run's params and the
 * outputs its steps recorded. Falls back to `fallbackInput` when input_map is absent. Throws the
 * map's own defect (`INPUT_MAP_DEPTH_EXCEEDED`, `INPUT_MAP_UNKNOWN_DIRECTIVE`).
 */
export function resolveInputMap(
  inputMap: Record<string, InputMapNode> | undefined,
  fallbackInput: Record<string, unknown>,
  run: RunRecord,
): Record<string, unknown> {
  if (inputMap === undefined) return fallbackInput;
  const evidenceByStep = buildEvidenceByStep(run);
  const root: Record<string, unknown> = {
    run: { params: run.params },
    context: { resources: evidenceByStep },
  };
  const result: Record<string, unknown> = {};
  for (const [key, node] of Object.entries(inputMap)) {
    result[key] = resolveInputMapNode(node, root, key, 0);
  }
  return result;
}

/**
 * Recursively resolves a single InputMapNode. String leaves are resolved via resolvePath;
 * object nodes produce a nested Record by recursing into their entries.
 */
function resolveInputMapNode(
  node: InputMapNode,
  root: Record<string, unknown>,
  keyChain: string,
  depth: number,
): unknown {
  if (depth > MAX_INPUT_MAP_DEPTH) {
    throw new WorkflowError(
      `input_map path "${keyChain}": exceeded maximum nesting depth of ${MAX_INPUT_MAP_DEPTH}`,
      {
        code: 'INPUT_MAP_DEPTH_EXCEEDED',
        category: 'ENGINE',
        agentAction: 'report_to_user',
        retryable: false,
      },
    );
  }
  if (typeof node === 'string') {
    return resolvePath(node, root);
  }

  // Literal node — return the value directly without path resolution.
  if ('$literal' in node && Object.keys(node).length === 1) {
    return (node as LiteralNode).$literal;
  }

  // issue #287 — the RUNTIME MIRROR of the loader's directive gate. The loader stops new
  // registrations; this stops the ones already stored. That distinction is the whole point: a
  // registered realm workflow RE-EXECUTES its corruption on every run, so validating only at
  // authoring would leave existing definitions quietly producing garbage forever.
  //
  // Two cases, one code:
  //   (a) any `$`-prefixed key that is not a supported directive;
  //   (b) `$literal` WITH sibling keys — which the sole-key conjunct above lets fall through to
  //       nested-map recursion, where the literal's own VALUE gets resolved as a context path
  //       under a result key literally named "$literal". Silent garbage, and reachable today.
  //
  // Failing loudly here costs a step failure; not failing costs plausible-looking success, which
  // is what turned the originating incident into five weeks of corrupted records.
  const REMEDY =
    `To pass literal data containing $-keys, wrap the subtree in $literal. input_map values ` +
    `are context paths, nested maps, or $literal — templated strings are not supported.`;
  const DIRECTIVE_ERROR_OPTS = {
    code: 'INPUT_MAP_UNKNOWN_DIRECTIVE',
    category: 'ENGINE',
    agentAction: 'report_to_user',
    retryable: false,
  } as const;

  // (b) `$literal` with siblings. Named accurately rather than as an "unknown directive" — the
  // directive is fine, its company is not, and that is the mistake the author has to see.
  if ('$literal' in node) {
    const siblings = Object.keys(node).filter((k) => k !== '$literal');
    throw new WorkflowError(
      `input_map path "${keyChain}": $literal node must have exactly one key ($literal); found ` +
        `sibling keys: ${siblings.join(', ')}. ${REMEDY}`,
      DIRECTIVE_ERROR_OPTS,
    );
  }

  // (a) any other reserved-prefix key.
  for (const key of Object.keys(node)) {
    if (!key.startsWith('$')) continue;
    throw new WorkflowError(
      `input_map path "${keyChain}": unknown directive '${key}' — supported directives: $literal. ` +
        REMEDY,
      DIRECTIVE_ERROR_OPTS,
    );
  }

  // Nested object — recurse.
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(node)) {
    result[key] = resolveInputMapNode(child as InputMapNode, root, `${keyChain}.${key}`, depth + 1);
  }
  return result;
}

/**
 * True when the step receives what its `input_map` builds — the dispatch's own rule: an `auto` step
 * with a map and a `handler` or a `uses_service`. A bare `auto` step never applies its map (it is
 * inert there), and an agent step's answer is always what is checked, even on a definition that
 * skipped the loader with a raw `input_map`.
 */
export function consumesInputMap(step: InputMapStep): boolean {
  return (
    step.execution === 'auto' &&
    step.input_map !== undefined &&
    (step.handler !== undefined || step.uses_service !== undefined)
  );
}

/**
 * For a step that consumes its map: the top-level key of the input the map builds that the step's
 * `input_schema` refuses first — the first validation error's path segment (`~1` and `~0`
 * unescaped), or for a root `required` the missing property. `undefined` when the built input
 * fits, when the map cannot be resolved, when the first error is a root error of another keyword
 * (`additionalProperties`, `type`, `minProperties`, …: no single key of the map is at fault), and
 * for any other step. Never throws.
 */
export function refusedInputField(step: InputMapStep, run: RunRecord): string | undefined {
  if (!consumesInputMap(step) || step.input_schema === undefined) return undefined;
  let built: Record<string, unknown>;
  try {
    built = resolveInputMap(step.input_map, {}, run);
  } catch {
    return undefined;
  }
  try {
    validateInputSchema(built, step.input_schema, 'input_map');
    return undefined;
  } catch (err) {
    const errors =
      err instanceof WorkflowError ? (err.details as { errors?: unknown }).errors : undefined;
    const first = Array.isArray(errors)
      ? (errors[0] as Record<string, unknown> | undefined)
      : undefined;
    if (first === undefined) return undefined;
    const path = typeof first['instancePath'] === 'string' ? first['instancePath'] : '';
    if (path !== '') {
      return path.slice(1).split('/')[0]!.replace(/~1/g, '/').replace(/~0/g, '~');
    }
    if (first['keyword'] !== 'required') return undefined;
    const missing = (first['params'] as Record<string, unknown> | undefined)?.['missingProperty'];
    return typeof missing === 'string' ? missing : undefined;
  }
}

/** True when a map node reads the run's params — the same walk as the resolver, never throwing. */
function readsRunParams(node: unknown): boolean {
  if (typeof node === 'string') {
    const path = node.trim();
    return path === 'run.params' || path.startsWith('run.params.');
  }
  if (typeof node !== 'object' || node === null) return false;
  if ('$literal' in node && Object.keys(node).length === 1) return false;
  return Object.values(node).some((child) => readsRunParams(child));
}

/**
 * Can a new run's params change what this step's `input_schema` checks? For a step that consumes
 * its map: only when the key it refuses ({@link refusedInputField}) is built from `run.params`. For
 * any other step: when it has no `depends_on` — the engine then gives it the run's params.
 */
export function newRunCanChangeInput(step: InputMapStep, run: RunRecord): boolean {
  if (!consumesInputMap(step)) return (step.depends_on ?? []).length === 0;
  const field = refusedInputField(step, run);
  if (field === undefined) return false;
  const map = step.input_map as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(map, field) && readsRunParams(map[field]);
}
