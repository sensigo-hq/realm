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
    | 'unsupported_context_tools'
    // Issue #313, OpenAI profile only — PROBE-DERIVED (the S1 discriminator: an executed 400
    // naming the all-required rule in isolation). OpenAI requires EVERY property to appear in
    // `required`; the sanctioned way to express an optional field is a null union.
    | 'not_all_required'
    // Issue #313, OpenAI profile only. One code for all four documented size limits (nesting
    // depth, property count, total schema characters, enum-value count) — the specific limit,
    // the measured value, and the fix live in `remediation`, which is where this module always
    // puts the actionable detail.
    | 'exceeds_provider_limit';
  /** Schema-relative path to the offending node (`''` = root; e.g. `properties.address`). */
  path: string;
  remediation: string;
}

/** A caveat: the schema is eligible, but this feature is enforced post-hoc by realm (Ajv), not
 *  by the grammar itself — silently ignored or rejected by the API either way.
 *
 *  Issue #311: `tools_runtime_assessed` is the Phase-A nudge row for a strict-declared,
 *  tools-bearing step. It is a CAVEAT code, never a WarningCode — a new WarningCode would
 *  auto-fail `validate --strict` (validate.ts's own rail), which would turn an informational
 *  nudge into a build break. */
export interface StructuredOutputCaveat {
  code:
    | 'unenforced_keyword'
    | 'unenforced_format'
    | 'unenforced_pattern'
    | 'optional_emission'
    | 'tools_runtime_assessed'
    // Issue #313, OpenAI profile only — the measured counterpart to `optional_emission`. Under
    // OpenAI strict every property is required, so Anthropic's OMISSION hazard is structurally
    // impossible; what replaces it is null-propensity on low-salience fields (P5, measured).
    | 'null_union_emission';
  path: string;
  remediation: string;
}

/**
 * Issue #313: which PROVIDER's strict rules to assess against. Phase A (authoring) is
 * deliberately provider-blind — it cannot know the drive-time provider — so this is a Phase-B
 * concern only, and it defaults to `'anthropic'`, making every pre-#313 call site zero-diff.
 *
 * The two profiles are NOT subset-related: OpenAI's keyword allowlist is WIDER (pattern, format,
 * numeric bounds, minLength and recursion are all first-class), while its structural rules are
 * STRICTER (every property must be required). Only the enumerated rows below fork; every other
 * #236 rule applies unchanged under both.
 */
export type StructuredOutputProfile = 'anthropic' | 'openai';

/**
 * Issue #311: which subject this assessment is about. Default (`step_output`) is the #236
 * behaviour — the step's own output schema, which realm DOES post-hoc validate with Ajv.
 * `tool_args` assesses a third-party MCP tool's `inputSchema` for per-tool strict attachment;
 * there is NO Ajv on the tools path, so enforcement-class caveats must not claim realm enforces
 * anything, and every remediation's fix-owner is the MCP SERVER, never the workflow author.
 */
export type StructuredOutputSubject = 'step_output' | 'tool_args';

/**
 * Issue #311: `optional_count` is the walk's own optional-property tally, exported so the
 * per-tool budget walk (run-agent.ts) can sum optionals across strict-attached tools against the
 * API's 24 limit without re-walking each schema. Present IFF the schema walk actually ran — the
 * short-circuit arms (G0 no-schema/non-object root, Phase-B G6, and the Phase-A
 * `tools_runtime_assessed` row) return before any counting, so the field is absent there rather
 * than falsely reporting 0.
 */
export type StructuredOutputVerdict =
  | { verdict: 'eligible'; optional_count?: number }
  | {
      verdict: 'eligible_with_caveats';
      caveats: StructuredOutputCaveat[];
      optional_count?: number;
    }
  // The ineligible arm CARRIES caveat findings too (C2/C4 pin this) — the nudge prints the full
  // delta even for an ineligible schema; Phase B ignores `caveats` here since strict is never sent.
  | {
      verdict: 'ineligible';
      reasons: StructuredOutputReason[];
      caveats?: StructuredOutputCaveat[];
      optional_count?: number;
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
  /** Issue #311: `tool_args` forks the remediation vocabulary (fix-owner = the MCP server) and
   *  the enforcement-class caveat text (no Ajv on the tools path). Default `step_output`. */
  subject?: StructuredOutputSubject;
  /** Issue #313: which provider's strict RULES to assess against. Default `anthropic` — every
   *  pre-#313 call site is therefore byte-identical. Phase A never passes this (authoring is
   *  provider-blind by design); only the drive-time Phase-B call knows the provider. */
  profile?: StructuredOutputProfile;
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
 *     ^ `$def` (singular) is transcribed VERBATIM from Anthropic's own list — see the entry's own
 *       comment below; it is not a typo in this file.
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
  // Issue #311 ride-along (ledger R7), re-verified against Anthropic's CURRENT published docs on
  // 2026-08-16: the source list still reads "`$ref`, `$def`, and `definitions`" — `$def`
  // SINGULAR, with no `$defs` anywhere in the document. This entry therefore transcribes upstream
  // faithfully (upstream's own apparent typo — JSON Schema's real keyword is `$defs`), which is
  // why it is kept rather than "corrected". It is inert either way: the real `$defs` key is
  // handled STRUCTURALLY by NON_KEYWORD_KEYS below, so it never reaches this allowlist at all.
  // Dead but harmless — do not delete it as dead code without re-reading the upstream list.
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

/**
 * Issue #313 — the OpenAI profile's keyword allowlist. WIDER than Anthropic's: every keyword
 * Anthropic hard-rejects or silently ignores in the numeric/string-constraint family is
 * first-class here, and `$ref` recursion is supported outright.
 *
 * Provenance (api-facts-lane + MA-executed probes, 2026-08-16): the docs were wrong in BOTH
 * directions for both vendors, so acceptance is probe-anchored, never docs-derived. P2 in
 * particular FLIPPED the expectation — `minLength` is accepted AND enforced (a 2-char answer
 * came back padded to exactly 10 characters: the constrained-decoding signature), the exact
 * opposite of Anthropic's live-proven accept-and-ignore of the same keyword.
 */
const OPENAI_SUPPORTED_KEYWORDS = new Set([
  // structural
  'type',
  'properties',
  'items',
  'description',
  'title',
  'required',
  'additionalProperties',
  '$ref',
  '$defs',
  'definitions',
  'default',
  // value constraints — all first-class under OpenAI strict
  'enum',
  'const',
  'anyOf',
  'pattern',
  'format',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
]);

/**
 * Issue #313 — the OpenAI profile's HARD rejection set, with PER-MEMBER provenance labels
 * (final-gate correction 1). Misclassifying a member here costs only the safe json_object
 * fallback — never a falsity — which is why the docs-derived members are kept conservative:
 *
 * - `allOf`              — 400-EXECUTED (probe P3a: "In context=('properties','x'), 'allOf' is
 *                          not permitted", param=response_format).
 * - `not`                — DOCS-DERIVED-CONSERVATIVE.
 * - `dependentRequired`  — DOCS-DERIVED-CONSERVATIVE.
 * - `dependentSchemas`   — DOCS-DERIVED-CONSERVATIVE.
 * - `if` / `then` / `else` — DOCS-DERIVED-CONSERVATIVE.
 *
 * The class posture (reject-on-unsupported, rather than Anthropic's silent strip) was confirmed
 * on the one executed member; the rest ride that confirmation conservatively.
 */
const OPENAI_UNSUPPORTED_KEYWORDS = new Set([
  'allOf',
  'not',
  'dependentRequired',
  'dependentSchemas',
  'if',
  'then',
  'else',
]);

/**
 * Issue #313 — OpenAI's schema size limits, with PER-MEMBER PROVENANCE LABELS (the same
 * discipline the keyword sets above carry, for the same reason: two of these four were executed
 * against the live API and two were read off documentation that has already been wrong in both
 * directions for both vendors).
 *
 * Misclassification cost is asymmetric and worth stating: a limit set too LOW silently withholds
 * strict from a schema the API would have accepted (no error, no signal — the exact class this
 * issue exists to remove), while a limit set too HIGH simply lets the request go and be caught by
 * the live 400 arm, which drops strict, retries, and discloses. That is why the two unprobed
 * members are kept at their documented values rather than tightened defensively.
 */
const OPENAI_LIMITS = {
  /** Nesting depth. BOUNDARY-EXECUTED: depth 10 ⇒ 200, depth 11 ⇒ 400 ("11 levels of nesting
   *  exceeds limit of 10"). Measured in OBJECT nesting levels — see walkNode. */
  maxDepth: 10,
  /** Total properties across the schema. DOCS-DERIVED-CONSERVATIVE — unprobed at this scale;
   *  drift is caught by the live 400 arm, not by this number. */
  maxProperties: 5000,
  /** Total characters across property names, enum values and const values.
   *  DOCS-DERIVED-CONSERVATIVE — unprobed at this scale. Note the counted set is names + enum +
   *  const; whether descriptions count is unstated upstream and they are deliberately NOT
   *  counted here (counting them would reject more schemas on an assumption). */
  maxChars: 120_000,
  /** Values in a single enum. BOUNDARY-EXECUTED: 1000 ⇒ 200, 1001 ⇒ 400 (the error names the
   *  limit and the received count). */
  maxEnumValues: 1000,
} as const;

interface Ctx {
  hardReasons: StructuredOutputReason[];
  caveats: StructuredOutputCaveat[];
  optionalCount: number;
  unionCount: number;
  seenUnenforcedKeywords: Set<string>;
  /** Issue #311: drives the enforcement-class caveat wording + remediation fix-owner. */
  subject: StructuredOutputSubject;
  /** Issue #313: drives which provider's RULE CONTENT applies (vs `subject`, which forks only
   *  wording). Per-row conditionals below — deliberately one walk, never a forked copy. */
  profile: StructuredOutputProfile;
  /** Issue #313 (OpenAI limits) — accumulated while walking. Unused under 'anthropic'. */
  maxDepthSeen: number;
  propertyCount: number;
  charCount: number;
  maxEnumValuesSeen: number;
  /** Issue #313 (OpenAI) — a property that is null-union-typed, i.e. the sanctioned way to
   *  express "optional" under a profile that requires every property to be required. */
  nullUnionCount: number;
}

/**
 * Issue #311: the enforcement-class clause, forked by subject. On the step-output path realm's
 * own Ajv still enforces the keyword after the model answers, so each row keeps its EXISTING
 * wording verbatim (passed in — the two rows word it differently today and both are pinned). On
 * the tools path there is NO Ajv at all — the arguments go straight to the MCP server — so
 * claiming realm enforces them would be a lie; enforcement genuinely falls to the server.
 */
function enforcementClause(subject: StructuredOutputSubject, stepOutputClause: string): string {
  return subject === 'tool_args'
    ? 'is not grammar-enforced and NOT post-hoc enforced by realm — enforcement falls to the MCP server at call time'
    : stepOutputClause;
}

/** Issue #311: who fixes it. A third-party tool's schema is never the workflow author's to edit,
 *  so every tool-args remediation retargets the fix-owner to the publishing MCP server. */
function fixOwnerHint(subject: StructuredOutputSubject): string {
  return subject === 'tool_args'
    ? " (this schema is published by the MCP server — the fix belongs to that server's maintainer, not this workflow)"
    : '';
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
function walkNode(node: unknown, path: string, ctx: Ctx, depth = 1): void {
  if (!isPlainObject(node)) return;

  const openai = ctx.profile === 'openai';
  // Depth is measured in OBJECT nesting levels — the unit OpenAI's own limit is stated in. A
  // scalar leaf (`{type: 'string'}`) is a nested schema node but not a nested level, so counting
  // every node would reject at 9 real levels and silently cost strict on schemas the API accepts.
  if ((node['type'] === 'object' || node['properties'] !== undefined) && depth > ctx.maxDepthSeen) {
    ctx.maxDepthSeen = depth;
  }

  // issue #313 (OpenAI hard set): keywords the API rejects outright with a 400. Checked BEFORE
  // the generic allowlist walk so they never degrade to the caveat class.
  if (openai) {
    for (const kw of Object.keys(node)) {
      if (!OPENAI_UNSUPPORTED_KEYWORDS.has(kw)) continue;
      ctx.hardReasons.push({
        code: 'unsupported_keyword',
        path,
        remediation: `'${kw}' at '${path || '(root)'}' is not supported by OpenAI strict mode and is rejected with a 400 — restructure without it (for '${kw}' inside a composition, express the shape directly or use 'anyOf')${fixOwnerHint(ctx.subject)}`,
      });
    }
    // Enum-value cap is per-enum, so it is measured here rather than summed.
    const enumForCap = node['enum'];
    if (Array.isArray(enumForCap) && enumForCap.length > ctx.maxEnumValuesSeen) {
      ctx.maxEnumValuesSeen = enumForCap.length;
    }
    // Character budget: property names + enum values + const values.
    for (const v of Array.isArray(enumForCap) ? enumForCap : []) {
      ctx.charCount += String(v).length;
    }
    if (node['const'] !== undefined) ctx.charCount += String(node['const']).length;
  }

  // G2-hard: root self-reference ('#') — the API neither enforces nor cleanly rejects this edge
  // (premise-probe-raw.md §Live-probe: silent-prune when optional, a persistent 503 when
  // required) — it must NEVER fall to the generic caveat class.
  //
  // issue #313: OpenAI supports `$ref` recursion FIRST-CLASS (api-facts lane), so the recursive
  // arm is Anthropic-only. The external-$ref arm applies to BOTH — an unresolvable reference is
  // unresolvable everywhere.
  const ref = node['$ref'];
  if (typeof ref === 'string') {
    if (ref === '#') {
      if (!openai) {
        ctx.hardReasons.push({
          code: 'unsupported_keyword',
          path,
          remediation: `recursive schema at '${path || '(root)'}' ($ref: '#') is not supported — remove the self-reference or restructure without recursion`,
        });
      }
    } else if (!ref.startsWith('#')) {
      ctx.hardReasons.push({
        code: 'unsupported_keyword',
        path,
        remediation: `external $ref at '${path || '(root)'}' ('${ref}') is not supported — inline the referenced schema or use a local '#/$defs/...' reference`,
      });
    }
  }

  // G2-hard: numeric constraints. ANTHROPIC ONLY — OpenAI supports the whole numeric-bound
  // family first-class (api-facts lane), so flagging them under 'openai' would reject schemas
  // the API accepts and enforces.
  for (const kw of openai ? [] : (['minimum', 'maximum', 'multipleOf'] as const)) {
    if (kw in node) {
      ctx.hardReasons.push({
        code: 'unsupported_keyword',
        path,
        remediation:
          ctx.subject === 'tool_args'
            ? `'${kw}' at '${path || '(root)'}' is not supported by strict mode — this tool rides unconstrained${fixOwnerHint(ctx.subject)}`
            : `'${kw}' at '${path || '(root)'}' is not supported by strict mode — remove it (Ajv still enforces it at submission time) or drop 'structured_output: strict' for this step`,
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

  // G4: format. ANTHROPIC ONLY — under OpenAI, `format` is supported and NOT flagged (the
  // profile's deltas are enumerated; inventing a suppression-or-flag beyond them is banned).
  const format = openai ? undefined : node['format'];
  if (typeof format === 'string' && !SUPPORTED_FORMATS.has(format)) {
    ctx.caveats.push({
      code: 'unenforced_format',
      path,
      remediation: `'format: ${format}' at '${path || '(root)'}' ${enforcementClause(ctx.subject, "is silently ignored or rejected by the API — enforced post-hoc by realm's own validation only")}${fixOwnerHint(ctx.subject)}`,
    });
  }

  // G5: pattern — always a caveat when present, regardless of regex complexity. ANTHROPIC ONLY:
  // OpenAI accepts `pattern` and (P2, INFERRED-strong) genuinely enforces it via constrained
  // decoding, so a "realm enforces this post-hoc, the grammar doesn't" caveat would be false.
  if (!openai && typeof node['pattern'] === 'string') {
    ctx.caveats.push({
      code: 'unenforced_pattern',
      path,
      remediation: `'pattern' at '${path || '(root)'}' ${enforcementClause(ctx.subject, "is silently ignored or rejected by the API — enforced post-hoc by realm's own validation only")}${fixOwnerHint(ctx.subject)}`,
    });
  }

  // G2 generic off-allowlist walk — every OTHER key on this node not itself a keyword we already
  // handle above, not a pure traversal-structure key, and not in the allowlist ⇒ caveat.
  for (const key of Object.keys(node)) {
    if (NON_KEYWORD_KEYS.has(key) || OWN_ROW_KEYWORDS.has(key)) continue;
    if (key === 'minimum' || key === 'maximum' || key === 'multipleOf' || key === 'enum') continue; // already handled (hard or allowlisted)
    // issue #313: each profile walks its OWN allowlist. Under 'openai' the hard set was already
    // rejected above, so anything still off-allowlist here is the genuine unknown-keyword class.
    if (openai) {
      if (OPENAI_SUPPORTED_KEYWORDS.has(key) || OPENAI_UNSUPPORTED_KEYWORDS.has(key)) continue;
    } else if (STRICT_SUPPORTED_KEYWORDS.has(key)) continue;
    if (ctx.seenUnenforcedKeywords.has(`${path}:${key}`)) continue;
    ctx.seenUnenforcedKeywords.add(`${path}:${key}`);
    ctx.caveats.push({
      code: 'unenforced_keyword',
      path,
      remediation: `'${key}' at '${path || '(root)'}' ${enforcementClause(ctx.subject, 'is silently ignored or rejected by the API — either way enforced post-hoc by realm')}${fixOwnerHint(ctx.subject)}`,
    });
  }

  // G1: every object (root + nested) must carry explicit additionalProperties: false.
  if (node['type'] === 'object' || node['properties'] !== undefined) {
    if (node['additionalProperties'] !== false) {
      ctx.hardReasons.push({
        code: 'missing_additional_properties',
        path,
        remediation: `add 'additionalProperties: false' at '${path || 'the schema root'}'${fixOwnerHint(ctx.subject)}`,
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
      ctx.propertyCount += 1;
      if (openai) ctx.charCount += propName.length;
      const isNullUnion =
        isPlainObject(propSchema) &&
        Array.isArray(propSchema['type']) &&
        (propSchema['type'] as unknown[]).includes('null');
      if (!required.has(propName)) {
        ctx.optionalCount += 1;
        if (
          isPlainObject(propSchema) &&
          (Array.isArray(propSchema['anyOf']) ||
            (Array.isArray(propSchema['type']) && (propSchema['type'] as unknown[]).length > 1))
        ) {
          ctx.unionCount += 1;
        }
        // issue #313 (OpenAI): EVERY property must be listed in `required` — probe-derived, the
        // S1 discriminator isolated it from the additionalProperties rule P1 had conflated it
        // with. The sanctioned way to express "may be absent" is a null union + required.
        if (openai) {
          ctx.hardReasons.push({
            code: 'not_all_required',
            path: propPath,
            remediation: `'${propName}' is not listed in 'required' at '${path || 'the schema root'}' — OpenAI strict requires EVERY property to be required. Add it to 'required'; if it genuinely may be absent, keep it required and widen its type to a null union (e.g. type: ['string', 'null']). Measured (gpt-4o, 24 runs): load-bearing fields stayed filled 24/24 under this rewrite, while a low-salience optional shifted to null 21/24 — so consumers must treat null as equivalent to absent${fixOwnerHint(ctx.subject)}`,
          });
        }
      } else if (openai && isNullUnion) {
        ctx.nullUnionCount += 1;
      }
      walkNode(propSchema, propPath, ctx, depth + 1);
    }
  }

  const items = node['items'];
  if (items !== undefined) walkNode(items, joinPath(path, 'items'), ctx, depth + 1);

  for (const branchKey of ['anyOf', 'allOf'] as const) {
    const branches = node[branchKey];
    if (Array.isArray(branches)) {
      branches.forEach((b, i) => walkNode(b, joinPath(path, `${branchKey}[${i}]`), ctx, depth + 1));
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
 *   step ⇒ checked FIRST, short-circuits everything else, and FORKS BY PHASE (issue #311):
 *   Phase A ⇒ caveat `tools_runtime_assessed` (strict applies to tool-call arguments, assessed
 *   per tool at runtime), Phase B ⇒ ineligible `unsupported_context_tools` (the step's own
 *   output is still never grammar-constrained on the tools fork) · G7' (Amendment 2) ANY
 *   optional properties on an otherwise-eligible schema ⇒ caveat `optional_emission` (strict
 *   measurably suppresses optional-field emission — see the benchmark cited in the docs section;
 *   the remedy is making consumer-load-bearing fields `required`).
 */
export function assessStructuredOutputEligibility(
  input: PhaseAInput | PhaseBInput,
): StructuredOutputVerdict {
  const phaseB = isPhaseB(input);
  const schema: unknown = phaseB ? input.schema : (input.output_schema ?? input.input_schema);
  const subject: StructuredOutputSubject = phaseB
    ? (input.subject ?? 'step_output')
    : 'step_output';
  // Phase A is provider-blind by design (authoring cannot know the drive-time provider), so it
  // always assesses under the default profile — separation in TIME, not a trade-off.
  const profile: StructuredOutputProfile = phaseB ? (input.profile ?? 'anthropic') : 'anthropic';
  const toolsFlag = phaseB
    ? input.tools === true
    : Array.isArray(input.tools) && input.tools.length > 0;

  // G6 — checked FIRST; short-circuits every other row (fixture C8). Issue #311 forks it BY PHASE:
  //
  // Phase A (authoring: loader/validate/register/create_workflow) now ACCEPTS a strict-declared
  // tools-bearing step with an INFO-channel nudge instead of rejecting it. Strict is real on this
  // fork — it just applies to the TOOL-CALL ARGUMENTS, per third-party tool, assessed at runtime
  // (the tool schemas are not the author's to fix, and are not even known until the MCP servers
  // are contacted). The step's own output stays post-hoc validated (L1), never grammar-
  // constrained. The nudge is a CAVEAT row, never a WarningCode — a new WarningCode would
  // auto-fail `validate --strict` and turn an informational nudge into a build break.
  //
  // The short-circuit is retained deliberately: the step-level output schema is never
  // grammar-constrained on the tools fork, so walking it here would report findings about a
  // schema that is never sent to a grammar — including on the composite cell (strict + tools +
  // an ineligible step-level output_schema), which must NOT reject.
  //
  // Phase B (`tools: true`) keeps the #236 `ineligible` verdict verbatim: it is the RUNTIME
  // step-output question ("may realm grammar-constrain THIS step's output?"), whose answer on a
  // tools-bearing step is still no — that is what the #332 `unsupported_context_tools` mint
  // discloses. It has zero production callers today and stays defensive.
  if (toolsFlag) {
    if (phaseB) {
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
    return {
      verdict: 'eligible_with_caveats',
      caveats: [
        {
          code: 'tools_runtime_assessed',
          path: '',
          remediation:
            'this step declares tools — strict applies to tool-call arguments here, not to the step output; tool schemas are third-party and are assessed per tool at runtime (a tool whose schema is not strict-compatible simply rides unconstrained), and this step output stays post-hoc validated by realm',
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
    subject,
    profile,
    maxDepthSeen: 0,
    propertyCount: 0,
    charCount: 0,
    maxEnumValuesSeen: 0,
    nullUnionCount: 0,
  };
  walkNode(schema, '', ctx);

  // The two size caps below are ANTHROPIC's (G3). OpenAI publishes no strict-count or optional
  // budget at all; its limits are structural size limits, applied instead — see below.
  if (profile === 'anthropic') {
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
  } else {
    // issue #313 — OpenAI's documented size limits (depth boundary and enum-count boundary both
    // executed against the live API; the other two are documented and untested at that scale).
    if (ctx.maxDepthSeen > OPENAI_LIMITS.maxDepth) {
      ctx.hardReasons.push({
        code: 'exceeds_provider_limit',
        path: '',
        remediation: `this schema nests ${ctx.maxDepthSeen} levels deep (OpenAI strict limit: ${OPENAI_LIMITS.maxDepth}) — flatten the deepest branch`,
      });
    }
    if (ctx.propertyCount > OPENAI_LIMITS.maxProperties) {
      ctx.hardReasons.push({
        code: 'exceeds_provider_limit',
        path: '',
        remediation: `this schema declares ${ctx.propertyCount} properties (OpenAI strict limit: ${OPENAI_LIMITS.maxProperties}) — split the schema or drop properties`,
      });
    }
    if (ctx.charCount > OPENAI_LIMITS.maxChars) {
      ctx.hardReasons.push({
        code: 'exceeds_provider_limit',
        path: '',
        remediation: `this schema's property names, enum values and const values total ${ctx.charCount} characters (OpenAI strict limit: ${OPENAI_LIMITS.maxChars}) — shorten names or reduce enum members`,
      });
    }
    if (ctx.maxEnumValuesSeen > OPENAI_LIMITS.maxEnumValues) {
      ctx.hardReasons.push({
        code: 'exceeds_provider_limit',
        path: '',
        remediation: `an enum in this schema has ${ctx.maxEnumValuesSeen} values (OpenAI strict limit: ${OPENAI_LIMITS.maxEnumValues}) — reduce the enum or model the field as a plain string`,
      });
    }
  }

  if (ctx.hardReasons.length > 0) {
    return {
      verdict: 'ineligible',
      reasons: ctx.hardReasons,
      ...(ctx.caveats.length > 0 ? { caveats: ctx.caveats } : {}),
      optional_count: ctx.optionalCount,
    };
  }

  // G7' (Amendment 2): any optional property on an otherwise-eligible schema ⇒ caveat. Measured:
  // strict emitted the optional reasoning field 4/24 vs baseline 24/24 on the current cs1 schema
  // (benchmark-raw.md §Run 2) — emission propensity is schema-shape-dependent, so this is a
  // general caveat, not a reasoning-specific rule. The nudge additionally names the
  // reasoning-position instance as the sharpest example (validate.ts).
  // issue #313: G7' is ANTHROPIC-ONLY. Under OpenAI every property must be required, so a
  // schema that reaches this point has no optionals at all and the omission hazard G7' warns
  // about is structurally impossible. What replaces it is the MEASURED null-propensity of
  // null-union properties — a different hazard needing different words and different numbers.
  if (profile === 'openai' && ctx.nullUnionCount > 0) {
    ctx.caveats.push({
      code: 'null_union_emission',
      path: '',
      remediation: `this schema has ${ctx.nullUnionCount} null-union propert${ctx.nullUnionCount === 1 ? 'y' : 'ies'} (the OpenAI-sanctioned way to say "may be absent"). Measured over 24 real inputs: on gpt-4o a load-bearing field stayed filled 24/24 under strict, while a low-salience field shifted to null 21/24 (on gpt-4o-mini, 3/24 vs its own 2/24 unconstrained omission rate) — so a null here means "the model had nothing to say", not "the field is broken". Consumers MUST treat null as equivalent to absent${fixOwnerHint(ctx.subject)}`,
    });
  }
  if (profile === 'anthropic' && ctx.optionalCount > 0) {
    ctx.caveats.push({
      code: 'optional_emission',
      path: '',
      // Issue #311: the G7' propensity text is subject-independent (it is a fact about strict
      // itself, measured on a step-output schema but applying to any grammar-constrained
      // arguments); only the FIX-OWNER retargets on the tools path.
      remediation: `under strict, the model emitted an optional field in 4/24 runs vs 24/24 unconstrained on a measured schema (see docs) — make fields your consumers rely on \`required\`${fixOwnerHint(ctx.subject)}`,
    });
  }

  if (ctx.caveats.length > 0) {
    return {
      verdict: 'eligible_with_caveats',
      caveats: ctx.caveats,
      optional_count: ctx.optionalCount,
    };
  }
  return { verdict: 'eligible', optional_count: ctx.optionalCount };
}

/** Renders a step's structured_output declaration into a plain-English author message, combining
 *  every reason's own remediation (`; `-joined) — the shared formatter both the loader's typed
 *  error and create_workflow's PRE-register rejection use, so the two surfaces never drift. */
// Issue #313: the parameter is widened ADDITIVELY to the structural minimum this function has
// always used, so CAVEATS can feed it too (the drive-time remediation nudge prints for
// ineligible AND caveated verdicts). Every existing caller passes `StructuredOutputReason[]`,
// which remains assignable — verified at all three: validate.ts, create-workflow.ts, yaml-loader.ts.
export function renderIneligibleMessage(reasons: Array<{ remediation: string }>): string {
  return reasons.map((r) => r.remediation).join('; ');
}

// Re-exported for callers that only have a raw JsonSchema value in hand (Phase B call sites,
// evidence/nudge rendering) without wanting to import the type twice.
export type { JsonSchema };
