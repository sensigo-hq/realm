// Input schema validation — validates step input against a declared JSON Schema using Ajv.
import { Ajv } from 'ajv';
import type { ValidateFunction } from 'ajv';
import type { JsonSchema } from '../types/workflow-definition.js';
import { WorkflowError } from '../types/workflow-error.js';
import type { TraceEntry } from '../types/run-record.js';

/**
 * The ONE Ajv construction for AUTHORED JSON-Schema blocks (`params_schema`, and a step's
 * `input_schema` / `output_schema` / `trace_schema`). Issue #586: the loader compiles every
 * authored block at admission through THIS function, and the run time validates through it too,
 * so the load-time verdict can never diverge from the run-time verdict (the B10 doctrine, one
 * level up).
 *
 * Bare Ajv defaults — `strictSchema` is `true`, so an unknown keyword inside a block throws here
 * exactly as it throws at run time. A compile failure propagates Ajv's own throw untouched
 * (`Error` / `MissingRefError` / a bare `TypeError` for a non-schema); wrapping it is the LOADER's
 * job (it has the author's line), never this helper's — issue #556 owns the run-time envelope.
 *
 * `opts.onStrictLog` replaces Ajv's default logger so the caller can CAPTURE the strict-mode
 * advisory lines (`strict mode: use allowUnionTypes …`) as data. When it is absent the logger is
 * `false`, which SILENCES those lines: decision D7 (revised) — the strict-mode class is disclosed
 * ONCE, by the admission surfaces, as a `SCHEMA_STRICT_ADVISORY` warning carrying the key's own
 * line. Before #586 Ajv printed the same sentence to the console on every compile at run time,
 * unattributed and unciteable; `realm run` would have printed it twice in two voices. `false` is
 * verdict-neutral (executed on ajv 8.20.0: every compile-error class still throws).
 *
 * Issue #560's seam: a compiled-validator cache belongs HERE (one construction site, one key).
 * Issue #552's seam: an admission-time cost bound on a legal-but-enormous schema belongs here too.
 * Neither is built.
 */
export function compileSchema(
  schema: JsonSchema,
  opts?: { onStrictLog?: (line: string) => void },
): ValidateFunction {
  const onStrictLog = opts?.onStrictLog;
  // ONE constructor call, always — the source-text witness counts the construction shape in this
  // file (comments stripped) and that count IS the load-≡-run guarantee, so a ternary over two
  // constructor calls is forbidden here. The whole conditional lives in the OPTIONS OBJECT.
  return newAjv(onStrictLog).compile(schema as object);
}

/** The ONE construction (see `compileSchema`); every authored-block check goes through it. */
function newAjv(onStrictLog?: (line: string) => void): Ajv {
  const fwd = (...args: unknown[]): void => onStrictLog?.(args.map(String).join(' '));
  const ajv = new Ajv({
    logger: onStrictLog === undefined ? false : { log: fwd, warn: fwd, error: fwd },
  });
  return ajv;
}

/**
 * The JSON-Schema keywords realm's validator knows — the draft-07 meta-schema's own `properties`,
 * read off the shared construction (never a hand-typed list, so it cannot drift from what the
 * validator actually accepts). Used for the near-miss suggestion on an unknown keyword (issue
 * #586, walk #15: `minlength` was told "correct its spelling" without being handed `minLength`).
 */
export function knownSchemaKeywords(): readonly string[] {
  const meta = newAjv().getSchema('http://json-schema.org/draft-07/schema');
  const properties = (meta?.schema as { properties?: Record<string, unknown> } | undefined)
    ?.properties;
  return properties === undefined ? [] : Object.keys(properties);
}

/** One meta-schema failure of an authored block, as the validator reports it structurally. */
export interface SchemaFailure {
  keyword: string;
  /** JSON pointer inside the block (`/properties/a/type`; `''` for the block itself). */
  instancePath: string;
  message: string;
  params: Record<string, unknown>;
}

/**
 * The FIRST meta-schema failure of a block, structurally (issue #586, walk #13) — the input of
 * realm's own sentence in place of the validator's cascade. `compile` throws the cascade as one
 * string (`data/type must be equal to one of the allowed values, data/type must be array,
 * data/type must match a schema in anyOf` — three clauses for one typo, the second read as advice
 * and obeyed at a cost of a round trip); `validateSchema` on the same construction returns the
 * errors as objects, with the allowed values and the expected type as data. The `anyOf`/`oneOf`
 * wrapper rows are skipped (the cascade's outer branches, never the offender). A dangling `$ref`
 * PASSES the meta-schema and dies at compile (`MissingRefError`, which names the TARGET, never the
 * site) — so on a clean meta-schema pass this compiles once more, on the failure path only, and
 * describes that member structurally too: keyword `$ref`, the pointer to the `$ref` KEY that
 * carries the missing target, the target in `params.ref`. `undefined` when the block compiles, for
 * a strict-mode refusal (another class's arm), or when a check itself throws — the caller then
 * keeps the validator's own words.
 */
export function describeSchemaFailure(schema: unknown): SchemaFailure | undefined {
  let valid: unknown;
  const ajv = newAjv();
  try {
    valid = ajv.validateSchema(schema as object);
  } catch {
    return undefined;
  }
  if (valid === true) {
    try {
      ajv.compile(schema as object);
      return undefined;
    } catch (err) {
      if (!(err instanceof Ajv.MissingRefError)) return undefined;
      return {
        keyword: '$ref',
        instancePath: refPointerOf(schema, err.missingRef),
        message: err.message,
        params: { ref: err.missingRef },
      };
    }
  }
  const rows = ajv.errors ?? [];
  const first =
    rows.find(
      (e) => !['anyOf', 'oneOf', 'allOf', 'if', 'then', 'else', 'not'].includes(e.keyword),
    ) ?? rows[0];
  if (first === undefined) return undefined;
  return {
    keyword: first.keyword,
    instancePath: first.instancePath,
    message: first.message ?? '',
    params: (first.params ?? {}) as Record<string, unknown>,
  };
}

/**
 * The JSON pointer of the `$ref` KEY whose value is `ref` — the first `$ref` in the block when
 * none matches exactly (a relative reference resolved against an `$id`); `''` when the block has
 * none at all. Depth-first, so the cite lands where the author wrote the reference.
 */
function refPointerOf(block: unknown, ref: string): string {
  const escape = (seg: string): string => seg.replace(/~/g, '~0').replace(/\//g, '~1');
  let first: string | undefined;
  const walk = (node: unknown, pointer: string): string | undefined => {
    if (node === null || typeof node !== 'object') return undefined;
    if (!Array.isArray(node)) {
      const here = (node as Record<string, unknown>)['$ref'];
      if (typeof here === 'string') {
        if (here === ref) return `${pointer}/$ref`;
        first ??= `${pointer}/$ref`;
      }
    }
    const entries = Array.isArray(node)
      ? node.map((v, i): [string, unknown] => [String(i), v])
      : Object.entries(node as Record<string, unknown>);
    for (const [k, v] of entries) {
      const hit = walk(v, `${pointer}/${escape(k)}`);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  return walk(block, '') ?? first ?? '';
}

function pointerSegmentsOf(pointer: string): string[] {
  return pointer
    .split('/')
    .filter((seg) => seg !== '')
    .map((seg) => seg.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function valueAt(block: unknown, segments: readonly string[]): unknown {
  let node: unknown = block;
  for (const seg of segments) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[seg];
  }
  return node;
}

/** A value as an author wrote it in YAML, short: `banana`, `1`, `[]`, `{…}`. */
export function renderAuthoredValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object') return String(value);
  const text = JSON.stringify(value);
  return text.length <= 30 ? text : Array.isArray(value) ? '[…]' : '{…}';
}

/**
 * The `type` value the block's OTHER keywords already imply (walk #14: seven equal values were
 * offered while `properties:` on the next line determined one, and six of the seven cost a second
 * round trip — a strictTypes advisory naming a different keyword at a different line).
 */
function typeThatFits(node: unknown): { type: string; because: string } | undefined {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
  const keys = Object.keys(node as Record<string, unknown>);
  const table: Array<[string, string[]]> = [
    ['object', ['properties', 'required', 'additionalProperties', 'patternProperties']],
    ['array', ['items', 'minItems', 'maxItems', 'uniqueItems']],
    ['string', ['pattern', 'minLength', 'maxLength']],
    ['number', ['minimum', 'maximum', 'multipleOf', 'exclusiveMinimum', 'exclusiveMaximum']],
  ];
  for (const [type, markers] of table) {
    const because = markers.find((m) => keys.includes(m));
    if (because !== undefined) return { type, because };
  }
  return undefined;
}

function describeExpectedType(type: unknown): string {
  const list = Array.isArray(type) ? type.map(String) : [String(type)];
  if (list.includes('object') && list.includes('boolean')) {
    return 'a schema — an object, or the boolean true/false';
  }
  const words: Record<string, string> = {
    array: 'a list',
    integer: 'a whole number',
    number: 'a number',
    string: 'text',
    boolean: 'true or false',
    object: 'an object',
    null: 'null',
  };
  return list.map((t) => words[t] ?? t).join(' or ');
}

/**
 * realm's sentence for a meta-schema failure (issue #586, walk #13): the offending keyword, what
 * it must be, the value as written, the path inside the block, and a remedy that names what to
 * type — never the generic "fix the schema", never the validator's cascade. `segments` is the
 * pointer to the offending key, for the cite.
 */
export function composeSchemaFailure(
  failure: SchemaFailure,
  key: string,
  block: unknown,
): { detail: string; remedy: string; segments: string[] } {
  const segments = pointerSegmentsOf(failure.instancePath);
  const leaf = segments.length === 0 ? key : segments[segments.length - 1]!;
  const value = valueAt(block, segments);
  // The path names the CONTAINING node, the keyword its own name — the shape the format and
  // unknown-keyword arms use (`at "input_schema/properties/email"` for a `format` inside `email`).
  const parent = segments.slice(0, -1);
  // No path at the block root — `at "input_schema"` after `'input_schema' is not a valid …`
  // located nothing (walk #16); the path earns its place only when it descends.
  const at = parent.length === 0 ? '' : `, at "${key}/${parent.join('/')}"`;
  const allowed = failure.params['allowedValues'];
  if (failure.keyword === 'enum' && Array.isArray(allowed)) {
    const fit = leaf === 'type' ? typeThatFits(valueAt(block, parent)) : undefined;
    const here =
      value === undefined
        ? ''
        : ` ('${leaf}: ${renderAuthoredValue(value)}' here` +
          (fit === undefined
            ? ')'
            : `; '${fit.type}' is the one that fits the '${fit.because}' beside it)`);
    return {
      detail: `'${leaf}' must be one of ${allowed.map(String).join(', ')}${here}${at}`,
      remedy:
        fit === undefined ? `set '${leaf}' to one of those values` : `set '${leaf}' to ${fit.type}`,
      segments,
    };
  }
  const here = value === undefined ? '' : ` ('${leaf}: ${renderAuthoredValue(value)}' here)`;
  if (failure.keyword === '$ref') {
    // The value is said ONCE (in the here-clause); the detail says what is wrong with it and the
    // remedy names two acts, the one executable FROM THE SENTENCE first. A local pointer is a
    // definition the block lacks — the pointer says where to add it. Anything else is a fetch realm
    // never performs (no remote schemas, no `$id` resolution): the author cannot "inline" a
    // definition the sentence just said nobody fetches (walk #19 guessed one), so removal leads
    // and the paste names its place. And the REMOVE act names an object whose removal leaves a
    // schema behind: in YAML, deleting the last child of a mapping leaves `null`, never `{}` —
    // walk #20 obeyed "remove the '$ref'" on a property whose only key it was, got `a: null`, and
    // was refused again (and removing that sole property leaves `properties: null`). So the act
    // climbs from the `$ref` to the first node with a sibling; when nothing on the way up has one,
    // the act is the whole block.
    const ref = String(failure.params['ref'] ?? value ?? '');
    const local = ref.startsWith('#');
    let path = [...parent, '$ref'];
    while (path.length > 0) {
      const container = valueAt(block, path.slice(0, -1));
      const siblings = Array.isArray(container)
        ? container.length
        : container !== null && typeof container === 'object'
          ? Object.keys(container).length
          : 0;
      if (siblings > 1) break;
      path = path.slice(0, -1);
    }
    const last = path[path.length - 1];
    const removeAct =
      last === undefined
        ? `remove the '${key}' block`
        : last === '$ref'
          ? "remove the '$ref'"
          : /^\d+$/.test(last)
            ? `remove that entry from '${path[path.length - 2] ?? key}'`
            : `remove '${last}'`;
    return {
      detail: local
        ? `'$ref' points at a definition this block does not have${here}${at}`
        : `'$ref' points outside this block, and realm fetches no remote schemas${here}${at}`,
      remedy: local
        ? `add that definition, or ${removeAct}`
        : `${removeAct}, or paste the schema it points at in its place`,
      segments,
    };
  }
  if (failure.keyword === 'type') {
    const expected = describeExpectedType(failure.params['type']);
    return {
      detail: `'${leaf}' must be ${expected}${here}${at}`,
      remedy: expected.startsWith('a schema')
        ? 'write a schema there'
        : `give '${leaf}' ${expected}`,
      segments,
    };
  }
  if (failure.keyword === 'minItems') {
    return {
      detail: `'${leaf}' must not be empty${here}${at}`,
      remedy: `add at least one value to '${leaf}', or remove it`,
      segments,
    };
  }
  if (failure.keyword === 'required' && typeof failure.params['missingProperty'] === 'string') {
    const missing = failure.params['missingProperty'];
    return {
      detail: `'${leaf}' is missing '${missing}'${at}`,
      remedy: `add '${missing}'`,
      segments,
    };
  }
  return { detail: `'${leaf}' ${failure.message}${here}${at}`, remedy: `fix '${leaf}'`, segments };
}

/**
 * Validates input against the step's declared JSON Schema.
 * Throws WorkflowError(VALIDATION_INPUT_SCHEMA) on failure.
 */
export function validateInputSchema(
  input: Record<string, unknown>,
  schema: JsonSchema,
  stepId: string,
): void {
  const validate = compileSchema(schema);
  const valid = validate(input);
  if (!valid) {
    throw new WorkflowError(`Invalid input for step '${stepId}'`, {
      code: 'VALIDATION_INPUT_SCHEMA',
      category: 'VALIDATION',
      agentAction: 'provide_input',
      retryable: false,
      details: { errors: validate.errors ?? [] },
      stepId,
    });
  }
}

/**
 * Validates the agent's submitted output against the step's declared JSON Schema.
 * Throws WorkflowError(VALIDATION_OUTPUT_SCHEMA) on failure.
 */
export function validateOutputSchema(
  output: Record<string, unknown>,
  schema: JsonSchema,
  stepId: string,
): void {
  const validate = compileSchema(schema);
  const valid = validate(output);
  if (!valid) {
    throw new WorkflowError(`Output validation failed for step '${stepId}'`, {
      code: 'VALIDATION_OUTPUT_SCHEMA',
      category: 'VALIDATION',
      agentAction: 'provide_input',
      retryable: false,
      details: { errors: validate.errors ?? [] },
      stepId,
    });
  }
}

/**
 * Issue #586 — validates a RUN's params against the workflow's declared `params_schema`, on every
 * surface that creates a run (`start_run`, `start_run_batch`, `listen`, `realm run`, `realm
 * agent`). Separate from `validateInputSchema` because that function's message is
 * `Invalid input for step '<id>'` — a false statement when what was validated is a workflow's
 * params (before #586 `start_run_batch` printed `Invalid input for step 'item[0]'` and `listen`
 * printed `Invalid input for step '<workflow id>'`; neither names a step and neither validated a
 * step's input).
 *
 * Throws `WorkflowError(VALIDATION_INPUT_SCHEMA)` — the same code every params refusal already
 * carries, so no consumer's error-code switch moves. The message names the FIRST failing row; all
 * rows are on `details.errors`.
 */
/**
 * Whether an Ajv compile failure is a STRICT-MODE refusal — an unknown keyword (`strict mode: …`)
 * or a `format` with no format plugin — as opposed to a meta-schema failure. The distinction is
 * the truth of the refusal's opener (issue #586, walk #11): a strict-mode block IS valid JSON
 * Schema by the spec (unknown keywords are permitted; `format` is a spec keyword), so realm says
 * "is refused by realm's validator" there and "is not a valid JSON Schema" only where the
 * meta-schema itself rejects the block.
 */
export function isStrictModeRefusal(ajvMessage: string): boolean {
  return ajvMessage.startsWith('strict mode: ') || ajvMessage.startsWith('unknown format "');
}

export function validateRunParams(
  params: Record<string, unknown>,
  schema: JsonSchema,
  workflowId: string,
): void {
  let validate: ValidateFunction;
  try {
    validate = compileSchema(schema);
  } catch (err) {
    // The GRANDFATHERED population (#586 walk, finding D2): `start_run` / `start_run_batch` read
    // the REGISTERED copy, which the loader never sees again — so a stored `params_schema` that
    // this release refuses at load is still compiled HERE, for the first time, at run-creation.
    // Left bare it surfaced as `ENGINE_INTERNAL` + `agent_action: stop` carrying nothing but the
    // validator's sentence: no workflow name, no key, no line, no remedy — verbatim the shape
    // this issue exists to abolish. It is typed here, and ONLY here: the three step validators
    // above keep their bare throw, which is issue #556's envelope to fix.
    // Same pointer rewrite as the loader's TRANSFORM 1 (yaml-loader.ts, `admitSchemaBlock`):
    // Ajv roots its pointers at `data`, which is the SCHEMA DOCUMENT here — `data/type` means
    // `params_schema.type`. This message is composed by realm at a run-creation door, so it
    // speaks the author's key like every other realm cite; the three step validators above stay
    // verbatim-bare (#556's envelope).
    const raw = err instanceof Error ? err.message : String(err);
    // realm's own sentence for a meta-schema failure (walk #13); the validator's words otherwise.
    const failure = isStrictModeRefusal(raw) ? undefined : describeSchemaFailure(schema);
    const detail =
      failure === undefined ? raw : composeSchemaFailure(failure, 'params_schema', schema).detail;
    // The opener is TRUE per class (walk #11): a strict-mode refusal — an unknown keyword, a
    // `format` — is valid JSON Schema by the spec; it is realm's validator that declines it.
    const opener = isStrictModeRefusal(raw)
      ? "realm's validator refuses"
      : 'is not a valid JSON Schema';
    throw new WorkflowError(
      `Workflow '${workflowId}' declares a params_schema that ${opener} — ` +
        `${detail}. No run was created. Re-register a fixed file — 'realm workflow validate ` +
        `<file>' shows the line; 'realm workflow validate --registered ${workflowId}' names the block.`,
      {
        code: 'VALIDATION_WORKFLOW_SCHEMA',
        category: 'VALIDATION',
        agentAction: 'stop',
        retryable: false,
      },
    );
  }
  if (validate(params)) return;
  const errors = validate.errors ?? [];
  const first = errors[0];
  const where = first === undefined || first.instancePath === '' ? '(root)' : first.instancePath;
  const detail = first?.message ?? 'is invalid';
  throw new WorkflowError(`Invalid params for workflow '${workflowId}': ${where} ${detail}`, {
    code: 'VALIDATION_INPUT_SCHEMA',
    category: 'VALIDATION',
    agentAction: 'provide_input',
    retryable: false,
    details: { errors },
  });
}

/**
 * issue #224 [audit F3] — the ajv-VERSION type trap. `cli` resolves ajv@6 from the repo root
 * (hoisted; `ErrorObject` is a NAMESPACE member there, `ajv.ErrorObject`, carrying `dataPath`);
 * `core` resolves its OWN ajv@8 (`ErrorObject` is a top-level named export, carrying
 * `instancePath`). A cli file that did `import type { ErrorObject } from 'ajv'` would resolve
 * against the WRONG major version and the wrong shape (or fail to resolve the named export at
 * all). This alias is exported FROM CORE (so it resolves against core's own ajv@8) — `cli` must
 * import `RawValidationError` from `@sensigo/realm`, never `from 'ajv'` directly. Runtime rows are
 * always ajv@8 (issue #586: this module now has exactly ONE construction site, `compileSchema`
 * above — bare, ajv@8 — used by `validateInputSchema`/`validateOutputSchema`/`validateTraceSchema`,
 * by `validateRunParams`, by the loader's admission check and by `create_workflow`) — this type is
 * a type-resolution fix only, not a runtime behavior change.
 */
export type RawValidationError = import('ajv').ErrorObject;

/** Result of {@link validateAgentSubmission}. */
export interface AgentSubmissionValidation {
  valid: boolean;
  /**
   * Raw (un-whitelisted) Ajv error rows from whichever validator rejected first — empty when
   * `valid` is true. Callers must whitelist these themselves before rendering/logging (core's own
   * `summarizeAjvErrors`, in `observability/failed-attempt-record.ts`, is private and drops fields
   * a caller may need, e.g. `params.allowedValues` — see that module's #224 note).
   */
  rawErrors: RawValidationError[];
}

/**
 * issue #224 — a NON-THROWING validator for the provider's IN-CONVERSATION correction loop
 * (never the engine — see below). PROVIDER-REPLICATE, not a unification: calls the exact same two
 * exported THROWING validators above, SEQUENTIALLY — `validateInputSchema` (when `inputSchema` is
 * given) THEN `validateOutputSchema` (when `outputSchema` is given) — each in its own try/catch,
 * mirroring the engine's Step 2b→2c order and its INPUT-FIRST SHORT-CIRCUIT (an input-schema
 * rejection returns immediately; output_schema is never checked that call, exactly like the
 * engine's own single-increment-per-rejection behavior). Both this function and the engine's Step
 * 2b/2c bottom on the SAME two functions + the same `compileSchema` construction (issue #586; see
 * `validateInputSchema`/`validateOutputSchema` above) — this is what makes the AJV verdict
 * divergence-proof between the provider's in-conversation check and the engine's drive-time gate,
 * WITHOUT touching or unifying the engine's own Step 2b/2c (issue #220's counting/exhaustion/
 * `last_ajv_errors` telemetry are built on those two separate throwing try-catches and must stay
 * byte-unchanged — see execution-loop.ts's `countRejection`).
 *
 * Mirrors the engine's `_debug` strip (execution-loop.ts:996-1002) before validating either
 * schema: the engine never validates a submission's `_debug` field, so a `_debug`-bearing object
 * that would PASS after stripping must also pass here — otherwise, under
 * `additionalProperties:false`, this function would OVER-REJECT an object the engine would
 * happily accept, burning the shared tool-call budget on a would-succeed step.
 *
 * Returns the RAW error rows only (never a pre-summarized shape) — the caller does its own
 * whitelisting; see `AgentSubmissionValidation.rawErrors`'s own doc for why.
 *
 * **Do NOT construct a fresh `Ajv()` anywhere in this function** (pin (a), the source-text guard)
 * — every verdict must route through `validateInputSchema`/`validateOutputSchema` above.
 */
export function validateAgentSubmission(
  obj: Record<string, unknown>,
  schemas: { inputSchema?: JsonSchema; outputSchema?: JsonSchema },
  stepId: string,
): AgentSubmissionValidation {
  // Mirror execution-loop.ts's _debug strip exactly — never validated, never hashed.
  let effectiveObj = obj;
  if (Object.prototype.hasOwnProperty.call(obj, '_debug')) {
    const { _debug: _omit, ...rest } = obj;
    effectiveObj = rest;
  }

  if (schemas.inputSchema !== undefined) {
    try {
      validateInputSchema(effectiveObj, schemas.inputSchema, stepId);
    } catch (err) {
      return { valid: false, rawErrors: extractRawErrors(err) };
    }
  }
  if (schemas.outputSchema !== undefined) {
    try {
      validateOutputSchema(effectiveObj, schemas.outputSchema, stepId);
    } catch (err) {
      return { valid: false, rawErrors: extractRawErrors(err) };
    }
  }
  return { valid: true, rawErrors: [] };
}

/** Pulls the raw ajv error rows off a caught `WorkflowError`; `[]` for anything else. */
function extractRawErrors(err: unknown): RawValidationError[] {
  if (!(err instanceof WorkflowError)) return [];
  const errors = err.details['errors'];
  return Array.isArray(errors) ? (errors as RawValidationError[]) : [];
}

export interface TraceSchemaWarnResult {
  errorCount: number;
  warning: string;
}

/**
 * Validates canonical trace entries against the step's declared trace_schema.
 *
 * In 'enforce' mode: throws WorkflowError(VALIDATION_TRACE_SCHEMA, agentAction: 'provide_input').
 * In 'warn' mode: returns a result with errorCount and a human-readable warning string.
 * Returns { errorCount: 0, warning: '' } when validation passes in warn mode.
 */
export function validateTraceSchema(
  entries: TraceEntry[],
  schema: JsonSchema,
  stepId: string,
  mode: 'enforce',
): void;
export function validateTraceSchema(
  entries: TraceEntry[],
  schema: JsonSchema,
  stepId: string,
  mode: 'warn',
): TraceSchemaWarnResult;
export function validateTraceSchema(
  entries: TraceEntry[],
  schema: JsonSchema,
  stepId: string,
  mode: 'warn' | 'enforce',
): TraceSchemaWarnResult | void {
  const validate = compileSchema(schema);
  const valid = validate(entries);
  if (valid) {
    if (mode === 'warn') return { errorCount: 0, warning: '' };
    return;
  }

  if (mode === 'enforce') {
    throw new WorkflowError(`Trace schema validation failed for step '${stepId}'`, {
      code: 'VALIDATION_TRACE_SCHEMA',
      category: 'VALIDATION',
      agentAction: 'provide_input',
      retryable: false,
      details: { errors: validate.errors ?? [] },
      stepId,
    });
  }

  // warn mode — return error details without throwing
  const errorSummary = (validate.errors ?? [])
    .map((e) => `${e.instancePath !== '' ? e.instancePath + ' ' : ''}${e.message ?? ''}`.trim())
    .join('; ');
  return {
    errorCount: (validate.errors ?? []).length,
    warning: `Trace schema violation for step '${stepId}': ${errorSummary}`,
  };
}
