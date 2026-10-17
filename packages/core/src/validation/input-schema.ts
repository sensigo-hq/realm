// Input schema validation — validates step input against a declared JSON Schema using Ajv.
import { Ajv } from 'ajv';
import type { ValidateFunction } from 'ajv';
import type { JsonSchema } from '../types/workflow-definition.js';
import { WorkflowError } from '../types/workflow-error.js';
import type { TraceEntry } from '../types/run-record.js';
import { quotedCommand, shellWord } from '../utils/shell-word.js';
import {
  VALIDATION_PROBLEMS_SHOWN,
  describeValidationProblems,
  renderProblemsSentence,
  validationFactsOfError,
} from './validation-problems.js';

/**
 * The exported compile for AUTHORED JSON-Schema blocks (`params_schema`, and a step's
 * `input_schema` / `output_schema` / `trace_schema`). Issue #586: every authored block compiles
 * through ONE inner compile, `compileInner` — the loader at admission through `compileCapturing`,
 * the run-time checks through `compileCached`, and this function — so the load-time verdict can
 * never diverge from the run-time verdict (the B10 doctrine, one level up).
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
 * Issue #560: THIS exported function is uncached — a fresh validator on every call, compiled from
 * the caller's own object and shared with no one, so its `.errors` belong to the caller. The
 * compiled-validator cache serves only this file's own run-time checks (`compileCached`) and the
 * loader's admission (`compileCapturing`); every entry compiles through the one inner compile,
 * `compileInner`. Issue #552's seam — an admission-time cost bound on a legal-but-enormous schema —
 * still belongs there, and is still not built.
 *
 * A schema whose ROOT carries a truthy `$async` compiles (Ajv) to a validator that answers with a
 * Promise. Realm checks data synchronously, so such a schema is refused in `compileInner`, read
 * off the compiled validator (`$async === true`, which Ajv sets exactly when the root `$async` is
 * truthy) — never off the key — with a typed `WorkflowError` (`isAsyncSchemaRefusal`). Every door
 * and every check kind compiles through `compileInner`, so none can run such a check.
 */
export function compileSchema(
  schema: JsonSchema,
  opts?: { onStrictLog?: (line: string) => void },
): ValidateFunction {
  return compileInner(schema as object, opts?.onStrictLog);
}

/** `details.reason` of the refusal of a schema whose root carries a truthy `$async`. */
const ASYNC_SCHEMA_REASON = 'async_schema';

/**
 * The validity clause of a schema whose root carries a truthy `$async`, with the value as the
 * author wrote it. ONE home: the run-time refusal, the loader and `create_workflow` all state it.
 */
export function asyncSchemaValidity(value: unknown): string {
  return (
    `\`$async: ${renderAsyncValue(value)}\`, which Realm does not support: it checks data ` +
    `against a schema synchronously and cannot wait for an asynchronous check`
  );
}

/** Characters a terminal or a Markdown code span would act on, written as `\uXXXX` in a shown
 *  string: C1 controls and DEL, the line and paragraph separators, the bidirectional embeddings,
 *  overrides and isolates, and the backtick that would close the code span around the value. */
const SHOWN_STRING_ESCAPES = /[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069`]/g;

/**
 * The `$async` value as written, for the validity clause. A string is quoted, so the refused
 * string `"false"` never reads as the accepted boolean `false`; it is cut at 30 code points (a
 * `…` after the closing quote says so) and every character a terminal or a Markdown code span
 * would act on is escaped (`SHOWN_STRING_ESCAPES`; `JSON.stringify` already escapes C0 controls,
 * the quote and the backslash). Any other value renders as `renderAuthoredValue` renders it.
 */
function renderAsyncValue(value: unknown): string {
  if (typeof value !== 'string') return renderAuthoredValue(value);
  const codePoints = Array.from(value);
  const quoted = JSON.stringify(codePoints.slice(0, 30).join('')).replace(
    SHOWN_STRING_ESCAPES,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return codePoints.length > 30 ? `${quoted}…` : quoted;
}

/** The root `$async` of an authored schema block, as written (`undefined` for a boolean schema). */
function rootAsyncValue(schema: unknown): unknown {
  return schema !== null && typeof schema === 'object'
    ? (schema as Record<string, unknown>)['$async']
    : undefined;
}

/** Whether `err` is the refusal of a schema whose root carries a truthy `$async` — by type and
 *  `details.reason`, never by message text. */
export function isAsyncSchemaRefusal(err: unknown): err is WorkflowError {
  return (
    err instanceof WorkflowError &&
    err.code === 'VALIDATION_WORKFLOW_SCHEMA' &&
    err.details['reason'] === ASYNC_SCHEMA_REASON
  );
}

/** The run-time form: what a check of a definition stored before this refusal existed replies. A
 *  YAML workflow heals by registering it again (a run reads its definition by id); a workflow
 *  made by `create_workflow` gets a new id when created again, so its old run is abandoned. */
function asyncSchemaRefusal(schema: unknown): WorkflowError {
  return new WorkflowError(
    `This schema declares ${asyncSchemaValidity(rootAsyncValue(schema))}, so this check ` +
      `cannot run. Remove \`$async\` from the schema and register the workflow again, then ` +
      `retry; for a workflow made by \`create_workflow\`, create it again without \`$async\`, ` +
      `start a new run on it, and abandon this one.`,
    {
      code: 'VALIDATION_WORKFLOW_SCHEMA',
      category: 'VALIDATION',
      agentAction: 'stop',
      retryable: false,
      details: { reason: ASYNC_SCHEMA_REASON },
    },
  );
}

/**
 * Issue #560 — the ONE inner compile every entry goes through: the exported `compileSchema`, the
 * run-time checks' `compileCached` and the loader's `compileCapturing`. Any refusal that follows a
 * compile belongs HERE, before anything is returned or cached.
 */
function compileInner(source: object, onStrictLog?: (line: string) => void): ValidateFunction {
  // ONE constructor call, always — the source-text witness counts the construction shape in this
  // file (comments stripped) and that count IS the load-≡-run guarantee, so a ternary over two
  // constructor calls is forbidden here. The whole conditional lives in the OPTIONS OBJECT. A throw
  // propagates before anything is cached.
  const validate = newAjv(onStrictLog).compile(source);
  if ((validate as { $async?: unknown }).$async === true) throw asyncSchemaRefusal(source);
  return validate;
}

/**
 * Issue #560 — the run-time checks' compile: a schema whose content is exactly JSON (`keyOf`) and
 * that can be kept (`cacheableKey`) is compiled once per process, from its own frozen copy, and the
 * validator is reused by every later check with the same content. Each check clears the errors the
 * validator keeps right after its last read (`releaseErrors`), so a kept validator keeps no error
 * rows between checks. Any other schema is compiled fresh from the caller's object, as before. A
 * schema with a `$ref` into another schema (such as the JSON-Schema meta-schema) whose target holds
 * a `$ref` of its own is compiled fresh on every call, as before (`staysInsideItself`). A compile
 * that throws is not cached. Internal: exported for the tests, never from the package.
 */
export function compileCached(schema: JsonSchema): ValidateFunction {
  const cacheable = cacheableKey(schema);
  if (cacheable === undefined) return compileInner(schema as object);
  const hit = compiledSchemas.get(cacheable.key);
  if (hit !== undefined) {
    compiledSchemas.delete(cacheable.key);
    compiledSchemas.set(cacheable.key, hit);
    return hit.validate;
  }
  // The frozen copy: Ajv reads object-valued `enum`/`const` members at validate time and its error
  // rows alias them, so a kept validator must never see a caller change its schema.
  const validate = compileInner(deepFreeze(JSON.parse(cacheable.key)) as object);
  if (!staysInsideItself(validate)) return validate;
  rememberCompiled(cacheable.key, validate, weightOf(cacheable.key, cacheable.nodes, validate));
  return validate;
}

/**
 * Issue #560, decision D7 — the loader's compile at admission: it compiles fresh on every call, so
 * the strict-mode lines are captured on every load, then writes the cache when the schema can be
 * kept, and never reads it — so the run time's first check reuses admission's compile. Internal,
 * like `compileCached`.
 */
export function compileCapturing(
  schema: JsonSchema,
  onStrictLog: (line: string) => void,
): ValidateFunction {
  const cacheable = cacheableKey(schema);
  if (cacheable === undefined) return compileInner(schema as object, onStrictLog);
  const validate = compileInner(deepFreeze(JSON.parse(cacheable.key)) as object, onStrictLog);
  if (!staysInsideItself(validate)) return validate;
  rememberCompiled(cacheable.key, validate, weightOf(cacheable.key, cacheable.nodes, validate));
  return validate;
}

/**
 * The key of a schema the cache could keep, or `undefined`. An entry whose key and JSON values
 * alone (`key.length + NODE_WEIGHT × nodes`, known before any compile) are over the whole bound can
 * never be kept, so it is compiled from the caller's object like a schema with no key: no parse, no
 * frozen copy, no cache. Its key's `JSON.stringify` is still paid on every call (issue #552's bound
 * would refuse it first).
 */
function cacheableKey(schema: JsonSchema): { key: string; nodes: number } | undefined {
  const keyed = keyOf(schema);
  return keyed !== undefined && keyed.key.length + NODE_WEIGHT * keyed.nodes <= MAX_CACHED_WEIGHT
    ? keyed
    : undefined;
}

/** A workflow declares tens of schemas; 256 holds every schema of many workflows at once. */
const MAX_CACHED_SCHEMAS = 256;
/**
 * The bound on the cache's total weight, 4 Mi. An entry's weight (`weightOf`) is its key's
 * characters, `NODE_WEIGHT` per JSON value in its schema, and the source characters of every
 * compiled function it keeps. The key alone says little about what an entry holds: Ajv copies a
 * `$ref` target's code into the validator once per reference when the target holds no `$ref` of
 * its own, and compiles it as a separate function (which the root's source never shows) when it
 * does; and a schema of many small JSON values holds more per character than its text.
 *
 * Measured 2026-10-17 (Node 24.21, Ajv 8.20 with `allErrors`; each kept validator called 2,000
 * times with a passing input, then once refused through its check, the larger heap reading kept):
 * 1.99 to 6.49 bytes of heap per weight character across six shapes (code copied per reference,
 * references compiled apart, 50,000 JSON values, 3,000 plain properties, non-Latin text, 2,000
 * properties each with its own `pattern`), plus about 3.1 MB for 256 small schemas — so at most
 * about 30 MB at the bound in the heaviest case measured (6.49 × 4 Mi + 3.12 MB). A kept validator
 * keeps no error rows between checks (`releaseErrors`).
 */
const MAX_CACHED_WEIGHT = 4 * 1024 * 1024;
/** The weight of one JSON value in a schema. A value holds more memory than its few characters of
 *  text (the cache keeps the schema parsed and frozen): a `const` of 50,000 empty objects is 150,049
 *  characters and held about 3.3 MB (measured 2026-10-17). */
const NODE_WEIGHT = 32;

/** The compiled validators by key, least recently used first (a `Map` keeps insertion order). */
const compiledSchemas = new Map<string, { validate: ValidateFunction; weight: number }>();
let cachedWeight = 0;

/** Inserts (or refreshes) one validator, then evicts the oldest until within both bounds. An entry
 *  heavier than the whole bound is never cached, and evicts nothing. */
function rememberCompiled(key: string, validate: ValidateFunction, weight: number): void {
  if (weight > MAX_CACHED_WEIGHT) return;
  const previous = compiledSchemas.get(key);
  if (previous !== undefined) {
    compiledSchemas.delete(key);
    cachedWeight -= previous.weight;
  }
  compiledSchemas.set(key, { validate, weight });
  cachedWeight += weight;
  while (compiledSchemas.size > MAX_CACHED_SCHEMAS || cachedWeight > MAX_CACHED_WEIGHT) {
    const [oldestKey, oldest] = compiledSchemas.entries().next().value as [
      string,
      { weight: number },
    ];
    compiledSchemas.delete(oldestKey);
    cachedWeight -= oldest.weight;
  }
}

/**
 * What one entry holds, in characters: its key, `NODE_WEIGHT` per JSON value, and the source of
 * every DISTINCT compiled function it keeps — the validator itself and each separately compiled
 * reference target (`schemaEnv.root.refs[*].validate`; a target inlined into the validator is
 * already in its source).
 */
function weightOf(key: string, nodes: number, validate: ValidateFunction): number {
  let code = 0;
  for (const fn of keptFunctions(validate)) code += fn.toString().length;
  return key.length + NODE_WEIGHT * nodes + code;
}

/** The DISTINCT compiled functions a KEPT validator holds: itself and each separately compiled
 *  reference target (`schemaEnv.root.refs[*].validate`). ONE list, read by the weight and by
 *  `releaseErrors`, so what is weighed and what is cleared cannot drift apart. It is complete only
 *  for a validator whose references stay inside its own schema (`staysInsideItself`), which is the
 *  only kind the cache keeps. */
function keptFunctions(validate: ValidateFunction): Set<ValidateFunction> {
  const functions = new Set<ValidateFunction>([validate]);
  for (const ref of Object.values(validate.schemaEnv.root.refs)) {
    if (ref !== null && typeof ref === 'object') {
      const sub = (ref as { validate?: unknown }).validate;
      if (typeof sub === 'function') functions.add(sub as ValidateFunction);
    }
  }
  return functions;
}

/**
 * Issue #560 — whether every reference target this validator compiled as its own function belongs
 * to its own schema. A `$ref` into another schema (such as the JSON-Schema meta-schema) whose
 * target holds a `$ref` of its own is compiled as a function of THAT schema's root, outside the
 * list `keptFunctions` reads, so the weight and the clearing would miss it: such a validator is
 * never kept. An inlined target is a plain schema object with no `.root`, and a boolean target is
 * not an object — neither leaves the schema.
 */
function staysInsideItself(validate: ValidateFunction): boolean {
  const root = validate.schemaEnv.root;
  for (const ref of Object.values(root.refs)) {
    if (ref === null || typeof ref !== 'object') continue;
    const targetRoot = (ref as { root?: unknown }).root;
    if (targetRoot !== undefined && targetRoot !== root) return false;
  }
  return true;
}

/**
 * Issue #560 — Ajv stores every call's full error list ON the validator function, and on each
 * reference target compiled as its own function; a kept validator would hold its last refused
 * call's rows (and a passing call's failed `anyOf`/`oneOf` branch rows) until its next check. Each
 * run-time check calls this in a `finally`, after its last read: the rows it keeps are copies.
 */
function releaseErrors(validate: ValidateFunction): void {
  for (const fn of keptFunctions(validate)) fn.errors = null;
}

/** Thrown inside `keyOf`'s replacer to void a key. */
const NOT_JSON_EXACT: unique symbol = Symbol('not JSON-exact');

/**
 * The cache key: the schema's JSON text and its count of JSON values (the root included), or
 * `undefined` (never cached) when its content is not exactly JSON — a non-finite number,
 * `undefined`, a function, a `bigint` or a symbol, an object that is not a plain object or array (a
 * `Date`, a typed array, a `RegExp`, a `Map`, an instance), or a cycle. Why: the YAML loader keeps
 * js-yaml's `Date`/`Infinity`/`Uint8Array` values, which `JSON.stringify` maps onto other JSON — a
 * key shared with a schema Ajv judges differently.
 */
function keyOf(schema: unknown): { key: string; nodes: number } | undefined {
  let nodes = 0;
  try {
    // The replacer reads `this[k]`, the RAW value: `JSON.stringify` calls a `Date`'s `toJSON`
    // before the replacer sees `value`. It runs once per JSON value, so it also counts them.
    const key = JSON.stringify(schema, function (this: unknown, k: string, value: unknown) {
      nodes += 1;
      if (!isJsonExact((this as Record<string, unknown>)[k])) throw NOT_JSON_EXACT;
      return value;
    });
    return typeof key === 'string' ? { key, nodes } : undefined;
  } catch {
    return undefined;
  }
}

/** Whether one raw value is carried exactly by JSON (its members are checked as they are visited). */
function isJsonExact(raw: unknown): boolean {
  if (raw === null) return true;
  switch (typeof raw) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(raw);
    case 'object': {
      const proto: unknown = Object.getPrototypeOf(raw);
      if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) return false;
      // A plain object with its own `toJSON` serializes as something else.
      return typeof (raw as { toJSON?: unknown }).toJSON !== 'function';
    }
    default:
      return false;
  }
}

/** Freezes a value parsed from JSON, all the way down. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const member of Object.values(value as object)) deepFreeze(member);
    Object.freeze(value);
  }
  return value;
}

/** The ONE construction (see `compileInner`); every authored-block compile goes through it. */
function newAjv(onStrictLog?: (line: string) => void): Ajv {
  const fwd = (...args: unknown[]): void => onStrictLog?.(args.map(String).join(' '));
  const ajv = new Ajv({
    // issue #759: every rule an answer breaks, not only the first — Ajv's production note
    // (`allErrors` validates past the first failure) is bounded by the author's own
    // `maxLength` / `maxItems`; the general bound is #552's seam above.
    allErrors: true,
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
  const validate = compileCached(schema);
  try {
    const valid = validate(input);
    if (!valid) {
      throw new WorkflowError(`Invalid input for step '${stepId}'`, {
        code: 'VALIDATION_INPUT_SCHEMA',
        category: 'VALIDATION',
        agentAction: 'provide_input',
        retryable: false,
        // issue #759 (Amendment 11): the rows are this code's typed facts — capped, with the
        // total; `details` keeps no second copy of the list.
        facts: validationFactsOf(validate.errors ?? []),
        stepId,
      });
    }
  } finally {
    releaseErrors(validate);
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
  const validate = compileCached(schema);
  try {
    const valid = validate(output);
    if (!valid) {
      throw new WorkflowError(`Output validation failed for step '${stepId}'`, {
        code: 'VALIDATION_OUTPUT_SCHEMA',
        category: 'VALIDATION',
        agentAction: 'provide_input',
        retryable: false,
        // issue #759 (Amendment 11): the rows are this code's typed facts — capped, with the
        // total; `details` keeps no second copy of the list.
        facts: validationFactsOf(validate.errors ?? []),
        stepId,
      });
    }
  } finally {
    releaseErrors(validate);
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
 * carries, so no consumer's error-code switch moves. The message names every failing row, up to
 * `VALIDATION_PROBLEMS_SHOWN`, and how many more (issue #759), in the pointer words — an extra
 * property by its own pointer (`/zzextra is not allowed`); the rows are the error's typed
 * `facts.errors` (capped), the total `facts.error_count`.
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
    validate = compileCached(schema);
  } catch (err) {
    // A root `$async`: realm's own sentence for this cause, never the generic opener (which is
    // false here — the schema is valid JSON Schema) and never the run-time form's remedy twice.
    if (isAsyncSchemaRefusal(err)) {
      const value = (schema as Record<string, unknown>)['$async'];
      throw new WorkflowError(
        `Workflow '${workflowId}' declares a params_schema with ${asyncSchemaValidity(value)}. ` +
          `No run was created. Remove \`$async\` from params_schema and register the workflow ` +
          `again.`,
        {
          code: 'VALIDATION_WORKFLOW_SCHEMA',
          category: 'VALIDATION',
          agentAction: 'stop',
          retryable: false,
          details: { reason: ASYNC_SCHEMA_REASON },
        },
      );
    }
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
        `<file>' shows the line; ${quotedCommand(`realm workflow validate --registered ${shellWord(workflowId)}`)} names the block.`,
      {
        code: 'VALIDATION_WORKFLOW_SCHEMA',
        category: 'VALIDATION',
        agentAction: 'stop',
        retryable: false,
      },
    );
  }
  try {
    if (validate(params)) return;
    const errors = validate.errors ?? [];
    // issue #759 (r1.2): every problem, in this site's pointer words (`(root) <message>` /
    // `<instancePath> <message>`; an extra property by its key, `/<key> is not allowed` — #759
    // correction 1) — any other first clause byte-identical to the single one before; with no
    // usable row, today's `(root) is invalid`.
    const sentence = renderProblemsSentence(describeValidationProblems(errors, 'pointer'));
    throw new WorkflowError(
      `Invalid params for workflow '${workflowId}': ${sentence === '' ? '(root) is invalid' : sentence}`,
      {
        code: 'VALIDATION_INPUT_SCHEMA',
        category: 'VALIDATION',
        agentAction: 'provide_input',
        retryable: false,
        facts: validationFactsOf(errors),
      },
    );
  } finally {
    releaseErrors(validate);
  }
}

/**
 * issue #224 [audit F3] — the ajv-VERSION type trap. `cli` resolves ajv@6 from the repo root
 * (hoisted; `ErrorObject` is a NAMESPACE member there, `ajv.ErrorObject`, carrying `dataPath`);
 * `core` resolves its OWN ajv@8 (`ErrorObject` is a top-level named export, carrying
 * `instancePath`). A cli file that did `import type { ErrorObject } from 'ajv'` would resolve
 * against the WRONG major version and the wrong shape (or fail to resolve the named export at
 * all). This alias is exported FROM CORE (so it resolves against core's own ajv@8) — `cli` must
 * import `RawValidationError` from `@sensigo/realm`, never `from 'ajv'` directly. Runtime rows are
 * always ajv@8 (issue #586: this module has exactly ONE construction site, `compileInner` above —
 * bare, ajv@8 — used by every entry: `compileCached` for `validateInputSchema` /
 * `validateOutputSchema` / `validateTraceSchema` / `validateRunParams`, `compileCapturing` for the
 * loader's admission check, and the exported `compileSchema` for `create_workflow`) — this type is
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
  /**
   * issue #759: the total number of problems the validator found — `rawErrors` holds at most
   * `VALIDATION_PROBLEMS_SHOWN` of them, so a renderer's "and N more" is `errorCount −
   * rawErrors.length`, never a recount. `0` when `valid` is true.
   */
  errorCount: number;
}

/**
 * issue #224 — a validator that ANSWERS (a verdict, never a throw) for the provider's
 * IN-CONVERSATION correction loop (never the engine — see below). Its one throw is the refusal of a
 * schema that cannot be checked at all (`isAsyncSchemaRefusal`): that is not the model's mistake,
 * so it is never turned into a correction request. PROVIDER-REPLICATE, not a unification: calls
 * the exact same two exported THROWING validators above, SEQUENTIALLY — `validateInputSchema`
 * (when `inputSchema` is given) THEN `validateOutputSchema` (when `outputSchema` is given) — each
 * in its own try/catch, mirroring the engine's Step 2b→2c order and its INPUT-FIRST
 * SHORT-CIRCUIT (an input-schema rejection returns immediately; output_schema is never checked
 * that call, exactly like the
 * engine's own single-increment-per-rejection behavior). Both this function and the engine's Step
 * 2b/2c bottom on the SAME two functions + the same inner compile, `compileInner` (issue #586; see
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
      // A schema that cannot be checked is not the model's mistake: never a correction request.
      if (isAsyncSchemaRefusal(err)) throw err;
      return { valid: false, ...extractRawErrors(err) };
    }
  }
  if (schemas.outputSchema !== undefined) {
    try {
      validateOutputSchema(effectiveObj, schemas.outputSchema, stepId);
    } catch (err) {
      if (isAsyncSchemaRefusal(err)) throw err;
      return { valid: false, ...extractRawErrors(err) };
    }
  }
  return { valid: true, rawErrors: [], errorCount: 0 };
}

/**
 * Pulls the raw ajv error rows (capped) and their total off a caught `WorkflowError`'s typed facts
 * (issue #759); none for anything else.
 */
function extractRawErrors(err: unknown): { rawErrors: RawValidationError[]; errorCount: number } {
  if (!(err instanceof WorkflowError)) return { rawErrors: [], errorCount: 0 };
  const facts = validationFactsOfError(err);
  if (facts === undefined) return { rawErrors: [], errorCount: 0 };
  return { rawErrors: [...facts.errors], errorCount: facts.error_count };
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
  let validate: ValidateFunction;
  try {
    validate = compileCached(schema);
  } catch (err) {
    // Warn mode never throws (the engine's contract): a trace schema that cannot be checked is
    // reported as one problem, naming the step, the cause and its own remedy — the trace was kept
    // unchecked, so there is nothing to retry and no run to abandon (the run-time form's remedy
    // would say both); enforce mode refuses.
    if (mode === 'warn' && isAsyncSchemaRefusal(err)) {
      return {
        errorCount: 1,
        warning:
          `Trace schema for step '${stepId}' was not checked: ` +
          `${asyncSchemaValidity(rootAsyncValue(schema))}. Remove \`$async\` from the trace ` +
          `schema and register the workflow again; this step's trace was kept unchecked.`,
      };
    }
    throw err;
  }
  try {
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
        // issue #759 (rail 4): the untyped bag carries the capped rows and their total, under the
        // typed codes' key names.
        details: {
          errors: (validate.errors ?? []).slice(0, VALIDATION_PROBLEMS_SHOWN),
          error_count: (validate.errors ?? []).length,
        },
        stepId,
      });
    }

    // warn mode — return error details without throwing. issue #759 (r1.6): the same composer, in
    // the pointer words (a root violation reads `(root) <message>`; an extra property its own
    // pointer, `/0/seq is not allowed`), capped, with `; and N more`; the count is the true total.
    const problems = describeValidationProblems(validate.errors ?? [], 'pointer');
    return {
      errorCount: problems.total,
      warning: `Trace schema violation for step '${stepId}': ${renderProblemsSentence(problems)}`,
    };
  } finally {
    releaseErrors(validate);
  }
}

/**
 * issue #759: a validation refusal's typed facts (Amendment 11) — the rows capped at
 * `VALIDATION_PROBLEMS_SHOWN` in Ajv's own order, and the total before the cap, counted here, once.
 */
function validationFactsOf(rows: readonly RawValidationError[]): {
  errors: RawValidationError[];
  error_count: number;
} {
  return { errors: rows.slice(0, VALIDATION_PROBLEMS_SHOWN), error_count: rows.length };
}
