// structured-output-eligibility.ts — issue #236, the L0 prevention layer.
//
// assessStructuredOutputEligibility is the SINGLE pure verdict function both authoring surfaces
// (Phase A: loader/validate/register/create_workflow — REJECT on ineligible) and the runtime
// (Phase B: run-agent — DEGRADE LOUDLY on ineligible, DISCLOSE on eligible_with_caveats) call. It
// is DERIVE-ALWAYS, never persisted (design record §2) — self-healing under API drift, and the
// registrar's schema_version hammer is never involved.
//
// The eligibility gate exists because Anthropic's strict/grammar-constrained tool use provably
// REJECTS some legal-per-Ajv schemas (a 400) and SILENTLY WEAKENS others (an off-allowlist
// keyword is neither honored nor rejected — it is dropped from the grammar with no error; see
// plans/issue-236/premise-probe-raw.md §2 Q-B/E1, the `minLength` silent-ignore witness). A
// static compat-gate can therefore never be complete (two failure classes — internal grammar-size
// limits and the 180s compile timeout — are documented as unpredictable from the schema alone),
// which is why the provider-side fallback ladder (anthropic-provider.ts) is architecturally
// required, not defensive garnish — this function only narrows the surface, it cannot eliminate
// live 400/503s.
import type { JsonSchema, StepDefinition } from '../types/workflow-definition.js';

/** A single ineligibility reason. `remediation` is author-grade — it names the exact fix. */
export interface StructuredOutputReason {
  code:
    | 'no_schema'
    | 'missing_additional_properties'
    | 'unsupported_keyword'
    | 'too_many_optionals'
    | 'too_many_unions'
    | 'unsupported_context_tools';
  /** Schema-relative path to the offending node (`''` = root; e.g. `properties.address`). */
  path: string;
  remediation: string;
}

/** A caveat: the schema is eligible, but this feature is enforced post-hoc by realm (Ajv), not
 *  by the grammar itself — silently ignored or rejected by the API either way. */
export interface StructuredOutputCaveat {
  code: 'unenforced_keyword' | 'unenforced_format' | 'unenforced_pattern' | 'optional_emission';
  path: string;
  remediation: string;
}

export type StructuredOutputVerdict =
  | { verdict: 'eligible' }
  | { verdict: 'eligible_with_caveats'; caveats: StructuredOutputCaveat[] }
  // The ineligible arm CARRIES caveat findings too (C2/C4 pin this) — the nudge prints the full
  // delta even for an ineligible schema; Phase B ignores `caveats` here since strict is never sent.
  | {
      verdict: 'ineligible';
      reasons: StructuredOutputReason[];
      caveats?: StructuredOutputCaveat[];
    };

/**
 * Phase A entry: the step definition itself — the effective-schema collapse
 * (`output_schema ?? input_schema`) happens INSIDE this function. Mirrors the two real runtime
 * chains (`run-agent.ts:426-429`/`:556-558`, `execution-loop.ts`), which collapse to this same
 * two-term formula statically. Gate-step `input_schema` (never sent to a provider) is out of
 * population — callers only invoke Phase A for `execution: 'agent'` steps.
 */
type PhaseAInput = Pick<StepDefinition, 'output_schema' | 'input_schema' | 'tools'>;

/**
 * Phase B entry: the RESOLVED schema value actually passed to the provider, plus the step's
 * `tools` flag — never re-derived from a step definition (design §2, the Rv11 verdict-vs-wire
 * rule: keeps the crack between "what was gated" and "what was sent" closed).
 */
interface PhaseBInput {
  schema: unknown;
  tools: boolean;
}

function isPhaseB(input: PhaseAInput | PhaseBInput): input is PhaseBInput {
  return 'schema' in input;
}

/**
 * G2 keyword allowlist — snapshot-dated 2026-08-05, CONTENTS transcribed verbatim from the
 * "Supported features" accordion at `plans/issue-236/refs/structured-outputs.md:2822-2832`
 * (that file is a frozen doc snapshot; re-verify against Anthropic's current docs before ever
 * editing this list). `type`/`properties`/`items`/`description`/`title` are added as structural
 * necessities never called out as unsupported anywhere in the source doc — everything else below
 * this comment is a direct transcription:
 *   "All basic types: object, array, string, integer, number, boolean, null" (the `type` keyword)
 *   `enum` · `const` · `anyOf` and `allOf` · `$ref`, `$def`, and `definitions` · `default` ·
 *   `required` and `additionalProperties` · string `format` (10 values — gated separately, G4) ·
 *   array `minItems`.
 * A keyword present on a schema node but absent from this set is NOT necessarily rejected by the
 * API — G2's hard class (minimum/maximum/multipleOf, recursion, external $ref, complex enum
 * members) is enumerated separately below; everything else off-allowlist degrades to a caveat
 * ("silently ignored or rejected by the API — either way enforced post-hoc by realm").
 */
export const STRICT_SUPPORTED_KEYWORDS = new Set([
  'type',
  'properties',
  'items',
  'description',
  'title',
  'enum',
  'const',
  'anyOf',
  'allOf',
  '$ref',
  '$def',
  'definitions',
  'default',
  'required',
  'additionalProperties',
  'format',
  'minItems',
]);

/** The 10 documented-supported `format` values (G4) — refs/structured-outputs.md:2830. */
const SUPPORTED_FORMATS = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'uri',
  'ipv4',
  'ipv6',
  'uuid',
]);

/** Keywords handled by their OWN dedicated verdict row — excluded from G2's generic off-allowlist
 *  walk so a `format`/`pattern` node is never ALSO flagged as a generic `unenforced_keyword`. */
const OWN_ROW_KEYWORDS = new Set(['format', 'pattern']);

/** Keys that are never schema keywords themselves — traversal structure, not gate subjects. */
const NON_KEYWORD_KEYS = new Set(['properties', 'items', '$defs', 'definitions']);

interface Ctx {
  hardReasons: StructuredOutputReason[];
  caveats: StructuredOutputCaveat[];
  optionalCount: number;
  unionCount: number;
  seenUnenforcedKeywords: Set<string>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function joinPath(base: string, next: string): string {
  return base === '' ? next : `${base}.${next}`;
}

/** Detects a cycle among `$defs`/`definitions` entries via local-$ref adjacency + DFS coloring.
 *  Author-fixture-scale only (finite, hand-authored schemas) — not a general-purpose resolver. */
function hasDefsCycle(defs: Record<string, unknown>): boolean {
  const names = Object.keys(defs);
  if (names.length === 0) return false;

  function localRefsFrom(node: unknown, acc: Set<string>): void {
    if (Array.isArray(node)) {
      for (const item of node) localRefsFrom(item, acc);
      return;
    }
    if (!isPlainObject(node)) return;
    const ref = node['$ref'];
    if (typeof ref === 'string') {
      const m = /^#\/(?:\$defs|definitions)\/([^/]+)$/.exec(ref);
      if (m) acc.add(m[1]!);
    }
    for (const v of Object.values(node)) localRefsFrom(v, acc);
  }

  const graph = new Map<string, Set<string>>();
  for (const name of names) {
    const acc = new Set<string>();
    localRefsFrom(defs[name], acc);
    graph.set(name, acc);
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(names.map((n) => [n, WHITE]));
  const dfs = (n: string): boolean => {
    color.set(n, GRAY);
    for (const next of graph.get(n) ?? []) {
      const c = color.get(next);
      if (c === GRAY) return true; // back-edge — a cycle
      if (c === WHITE && dfs(next)) return true;
    }
    color.set(n, BLACK);
    return false;
  };
  for (const name of names) {
    if (color.get(name) === WHITE && dfs(name)) return true;
  }
  return false;
}

/** Recursively walks one schema node, mutating `ctx` with every G1/G2/G4/G5 finding + the G3
 *  optional/union counts. `path` is the schema-relative dotted path to THIS node. */
function walkNode(node: unknown, path: string, ctx: Ctx): void {
  if (!isPlainObject(node)) return;

  // G2-hard: root self-reference ('#') — the API neither enforces nor cleanly rejects this edge
  // (premise-probe-raw.md §Live-probe: silent-prune when optional, a persistent 503 when
  // required) — it must NEVER fall to the generic caveat class.
  const ref = node['$ref'];
  if (typeof ref === 'string') {
    if (ref === '#') {
      ctx.hardReasons.push({
        code: 'unsupported_keyword',
        path,
        remediation: `recursive schema at '${path || '(root)'}' ($ref: '#') is not supported — remove the self-reference or restructure without recursion`,
      });
    } else if (!ref.startsWith('#')) {
      ctx.hardReasons.push({
        code: 'unsupported_keyword',
        path,
        remediation: `external $ref at '${path || '(root)'}' ('${ref}') is not supported — inline the referenced schema or use a local '#/$defs/...' reference`,
      });
    }
  }

  // G2-hard: numeric constraints.
  for (const kw of ['minimum', 'maximum', 'multipleOf'] as const) {
    if (kw in node) {
      ctx.hardReasons.push({
        code: 'unsupported_keyword',
        path,
        remediation: `'${kw}' at '${path || '(root)'}' is not supported by strict mode — remove it (Ajv still enforces it at submission time) or drop 'structured_output: strict' for this step`,
      });
    }
  }

  // G2-hard: complex enum members (object/array).
  const enumVal = node['enum'];
  if (Array.isArray(enumVal) && enumVal.some((m) => isPlainObject(m) || Array.isArray(m))) {
    ctx.hardReasons.push({
      code: 'unsupported_keyword',
      path,
      remediation: `'enum' at '${path || '(root)'}' contains a complex (object/array) member — strict mode only supports string/number/boolean/null enum members`,
    });
  }

  // G4: format.
  const format = node['format'];
  if (typeof format === 'string' && !SUPPORTED_FORMATS.has(format)) {
    ctx.caveats.push({
      code: 'unenforced_format',
      path,
      remediation: `'format: ${format}' at '${path || '(root)'}' is silently ignored or rejected by the API — enforced post-hoc by realm's own validation only`,
    });
  }

  // G5: pattern — always a caveat when present, regardless of regex complexity.
  if (typeof node['pattern'] === 'string') {
    ctx.caveats.push({
      code: 'unenforced_pattern',
      path,
      remediation: `'pattern' at '${path || '(root)'}' is silently ignored or rejected by the API — enforced post-hoc by realm's own validation only`,
    });
  }

  // G2 generic off-allowlist walk — every OTHER key on this node not itself a keyword we already
  // handle above, not a pure traversal-structure key, and not in the allowlist ⇒ caveat.
  for (const key of Object.keys(node)) {
    if (NON_KEYWORD_KEYS.has(key) || OWN_ROW_KEYWORDS.has(key)) continue;
    if (key === 'minimum' || key === 'maximum' || key === 'multipleOf' || key === 'enum') continue; // already handled (hard or allowlisted)
    if (STRICT_SUPPORTED_KEYWORDS.has(key)) continue;
    if (ctx.seenUnenforcedKeywords.has(`${path}:${key}`)) continue;
    ctx.seenUnenforcedKeywords.add(`${path}:${key}`);
    ctx.caveats.push({
      code: 'unenforced_keyword',
      path,
      remediation: `'${key}' at '${path || '(root)'}' is silently ignored or rejected by the API — either way enforced post-hoc by realm`,
    });
  }

  // G1: every object (root + nested) must carry explicit additionalProperties: false.
  if (node['type'] === 'object' || node['properties'] !== undefined) {
    if (node['additionalProperties'] !== false) {
      ctx.hardReasons.push({
        code: 'missing_additional_properties',
        path,
        remediation: `add 'additionalProperties: false' at '${path || 'the schema root'}'`,
      });
    }
  }

  // Recurse into properties (G3 optional/union counting happens per-property here) + items +
  // anyOf/allOf branches + $defs/definitions bodies.
  const properties = node['properties'];
  if (isPlainObject(properties)) {
    const required = Array.isArray(node['required'])
      ? new Set(node['required'] as string[])
      : new Set<string>();
    for (const [propName, propSchema] of Object.entries(properties)) {
      const propPath = joinPath(path, `properties.${propName}`);
      if (!required.has(propName)) {
        ctx.optionalCount += 1;
        if (
          isPlainObject(propSchema) &&
          (Array.isArray(propSchema['anyOf']) ||
            (Array.isArray(propSchema['type']) && (propSchema['type'] as unknown[]).length > 1))
        ) {
          ctx.unionCount += 1;
        }
      }
      walkNode(propSchema, propPath, ctx);
    }
  }

  const items = node['items'];
  if (items !== undefined) walkNode(items, joinPath(path, 'items'), ctx);

  for (const branchKey of ['anyOf', 'allOf'] as const) {
    const branches = node[branchKey];
    if (Array.isArray(branches)) {
      branches.forEach((b, i) => walkNode(b, joinPath(path, `${branchKey}[${i}]`), ctx));
    }
  }

  for (const defsKey of ['$defs', 'definitions'] as const) {
    const defs = node[defsKey];
    if (isPlainObject(defs)) {
      if (hasDefsCycle(defs)) {
        ctx.hardReasons.push({
          code: 'unsupported_keyword',
          path: joinPath(path, defsKey),
          remediation: `a circular reference exists among '${defsKey}' entries at '${path || '(root)'}' — recursive schemas are not supported; restructure without the cycle`,
        });
      }
      for (const [name, defSchema] of Object.entries(defs)) {
        walkNode(defSchema, joinPath(path, `${defsKey}.${name}`), ctx);
      }
    }
  }
}

/**
 * Assesses whether a step's effective output schema is eligible for Anthropic strict/grammar-
 * constrained tool use. Pure, synchronous, derive-always (never persisted). See the verdict table
 * in `docs/reference/yaml-schema.md`'s `structured_output` section for the full G0–G7' rule set
 * with citations; the summary:
 *   G0 no effective schema / non-object root ⇒ ineligible · G1 every object missing explicit
 *   `additionalProperties: false` ⇒ ineligible · G2 hard class (numeric constraints, recursion
 *   incl. root `$ref:'#'`, external `$ref`, complex enum members) ⇒ ineligible; any other
 *   off-allowlist keyword ⇒ caveat · G3 >24 optional properties / >16 union-typed ⇒ ineligible ·
 *   G4 unsupported `format` value ⇒ caveat · G5 `pattern` present ⇒ caveat · G6 `tools`-bearing
 *   step ⇒ ineligible (checked FIRST, short-circuits everything else) · G7' (Amendment 2) ANY
 *   optional properties on an otherwise-eligible schema ⇒ caveat `optional_emission` (strict
 *   measurably suppresses optional-field emission — see the benchmark cited in the docs section;
 *   the remedy is making consumer-load-bearing fields `required`).
 */
export function assessStructuredOutputEligibility(
  input: PhaseAInput | PhaseBInput,
): StructuredOutputVerdict {
  const phaseB = isPhaseB(input);
  const schema: unknown = phaseB ? input.schema : (input.output_schema ?? input.input_schema);
  const toolsFlag = phaseB
    ? input.tools === true
    : Array.isArray(input.tools) && input.tools.length > 0;

  // G6 — checked FIRST; short-circuits every other row (fixture C8: "⇒ G6 exactly", no caveats).
  if (toolsFlag) {
    return {
      verdict: 'ineligible',
      reasons: [
        {
          code: 'unsupported_context_tools',
          path: '',
          remediation:
            'this step declares tools — structured_output: strict is not supported on tools-bearing steps in v1; remove tools or drop structured_output',
        },
      ],
    };
  }

  // G0 — no effective schema, or a root that isn't type:'object'. Two distinct remediations.
  if (schema === undefined) {
    return {
      verdict: 'ineligible',
      reasons: [
        {
          code: 'no_schema',
          path: '',
          remediation:
            'add output_schema (or input_schema) — structured_output: strict has no schema to constrain generation with',
        },
      ],
    };
  }
  if (!isPlainObject(schema) || schema['type'] !== 'object') {
    return {
      verdict: 'ineligible',
      reasons: [
        {
          code: 'no_schema',
          path: '',
          remediation:
            "declare `type: 'object'` at the schema root — strict mode requires an object-rooted schema",
        },
      ],
    };
  }

  const ctx: Ctx = {
    hardReasons: [],
    caveats: [],
    optionalCount: 0,
    unionCount: 0,
    seenUnenforcedKeywords: new Set(),
  };
  walkNode(schema, '', ctx);

  if (ctx.optionalCount > 24) {
    ctx.hardReasons.push({
      code: 'too_many_optionals',
      path: '',
      remediation: `this schema has ${ctx.optionalCount} optional properties (limit: 24) — reduce the optional-property count or make more fields required`,
    });
  }
  if (ctx.unionCount > 16) {
    ctx.hardReasons.push({
      code: 'too_many_unions',
      path: '',
      remediation: `this schema has ${ctx.unionCount} union-typed properties (limit: 16) — reduce the anyOf/multi-type property count`,
    });
  }

  if (ctx.hardReasons.length > 0) {
    return {
      verdict: 'ineligible',
      reasons: ctx.hardReasons,
      ...(ctx.caveats.length > 0 ? { caveats: ctx.caveats } : {}),
    };
  }

  // G7' (Amendment 2): any optional property on an otherwise-eligible schema ⇒ caveat. Measured:
  // strict emitted the optional reasoning field 4/24 vs baseline 24/24 on the current cs1 schema
  // (benchmark-raw.md §Run 2) — emission propensity is schema-shape-dependent, so this is a
  // general caveat, not a reasoning-specific rule. The nudge additionally names the
  // reasoning-position instance as the sharpest example (validate.ts).
  if (ctx.optionalCount > 0) {
    ctx.caveats.push({
      code: 'optional_emission',
      path: '',
      remediation:
        'under strict, the model emitted an optional field in 4/24 runs vs 24/24 unconstrained on a measured schema (see docs) — make fields your consumers rely on `required`',
    });
  }

  if (ctx.caveats.length > 0) {
    return { verdict: 'eligible_with_caveats', caveats: ctx.caveats };
  }
  return { verdict: 'eligible' };
}

/** Renders a step's structured_output declaration into a plain-English author message, combining
 *  every reason's own remediation (`; `-joined) — the shared formatter both the loader's typed
 *  error and create_workflow's PRE-register rejection use, so the two surfaces never drift. */
export function renderIneligibleMessage(reasons: StructuredOutputReason[]): string {
  return reasons.map((r) => r.remediation).join('; ');
}

// Re-exported for callers that only have a raw JsonSchema value in hand (Phase B call sites,
// evidence/nudge rendering) without wanting to import the type twice.
export type { JsonSchema };
