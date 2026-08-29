// agent-utils.ts — Shared utility functions for LLM provider agentic loops.
import type { ValidationErrorSummaryEntry, RawValidationError } from '@sensigo/realm';

const SYSTEM_PROMPT_BASE =
  'You are an AI agent executing a step in a structured workflow.\n' +
  'Your task is described below. Respond with a JSON object only — no markdown, no explanation.';

// Used only when a `__realm_submit__` tool is actually offered on the call this prompt accompanies
// (anthropic-provider.ts callStep) — the JSON-only line is replaced with a call-the-tool-or-answer
// line so the model knows the tool exists. Otherwise output is byte-unchanged (see structuredToolOffered).
const SYSTEM_PROMPT_BASE_WITH_TOOL =
  'You are an AI agent executing a step in a structured workflow.\n' +
  'Your task is described below. Call the `__realm_submit__` tool with your result, or respond ' +
  'with a JSON object only — no markdown, no explanation.';

/**
 * Builds the system prompt for an agent step, optionally prepending an agent profile and/or
 * including the output schema.
 *
 * @param structuredToolOffered When true, the JSON-only line is replaced to mention the
 *   `__realm_submit__` tool. Pass true ONLY when a call actually offers that tool (never true
 *   just because a schema is present) — the default/absent path is byte-identical to before.
 */
export function buildSystemPrompt(
  inputSchema?: Record<string, unknown>,
  agentProfileInstructions?: string,
  structuredToolOffered?: boolean,
): string {
  const basePrompt =
    structuredToolOffered === true ? SYSTEM_PROMPT_BASE_WITH_TOOL : SYSTEM_PROMPT_BASE;
  const base =
    agentProfileInstructions !== undefined
      ? `${agentProfileInstructions}\n\n${basePrompt}`
      : basePrompt;
  if (inputSchema === undefined) return base;
  return `${base}\nThe JSON must conform to this schema: ${JSON.stringify(inputSchema)}`;
}

/**
 * Additional literal values to redact on the provider-loop surfaces — manifest-resolved
 * secret VALUES (dotenv-sourced values are absent from process.env, so without this they
 * would pass unredacted). Values only, module-level, never persisted anywhere; set once
 * per agent run by runAgent from the loaded extensions result.
 */
let additionalRedactionValues: readonly string[] = [];

/** Sets the manifest-secret values redacted alongside process.env values. */
export function setAdditionalRedactionValues(values: readonly string[]): void {
  additionalRedactionValues = values;
}

/**
 * The THREE launcher keys whose values are public by name, not by prefix (issue #407).
 *
 * Exact keys, deliberately — the prefix form they replace was a secret channel. Yarn classic
 * flattens the ENTIRE package.json into `npm_package_*`, so `npm_package_deploy_apiKey` was
 * excluded from redaction under that launcher. With a closed set of three, everything a launcher
 * invents is swept by default: `npm_package_config_*`, `npm_config_*`, every yarn1-flattened
 * field, and `npm_lifecycle_script` — whose value is author-written script text that can carry an
 * inline token, and whose whole line is echoed by a spawn failure.
 *
 * `npm_package_json` is NOT here: it is path-valued on every launcher that sets it, so it belongs
 * to the under-HOME value rule below — a checkout under home keeps its tail, one outside home is
 * redacted whole, which is the same privacy trade every other path value gets.
 *
 * Case-sensitive on purpose: a hostile `NPM_PACKAGE_NAME` is not one of these and stays swept.
 */
const EXCLUDED_LAUNCHER_METADATA = new Set([
  'npm_package_name',
  'npm_package_version',
  'npm_lifecycle_event',
]);

/**
 * Values that are public by SHAPE: booleans, and 2-or-3-segment dotted version numbers.
 *
 * Launchers inject these constantly — pnpm's `pnpm_config_verify_deps_before_run=false`, yarn1's
 * `YARN_WRAP_OUTPUT=false`, npm's `npm_config_npm_version=11.8.0` — so the word "false" and any
 * matching version string were being cut out of every message and every recorded tool result.
 *
 * The bound is narrow on purpose. A looser `\d+(\.\d+)*` would admit bare integers (numeric
 * PINs, account ids) and IPv4 addresses — values the sweep exists for. Two or three segments,
 * each dotted, and nothing else: `1.0.0-beta` and four-segment strings stay swept.
 *
 * Case-sensitive: `FALSE` stays swept. The `true` alternative is dead today — four characters,
 * already below the length filter — and is kept as defense should that filter ever change.
 */
const PUBLIC_VALUE_SHAPE = /^(true|false|\d+\.\d+(\.\d+)?)$/;

/**
 * Converts an error value to a string and strips sensitive patterns: Bearer tokens,
 * query-string tokens, process.env values longer than 4 characters, and the additional
 * (manifest-secret) values. All literal values are redacted in ONE combined pass,
 * deduped and applied LONGEST-FIRST — a short value contained in a longer one can no
 * longer leave fragments of the longer value behind.
 *
 * THE BOUNDARY (issue #407). The default is fail-closed — every env value over four characters
 * is redacted — with three bounded exceptions, and everything else swept. Where the field bounds
 * redaction by key semantics or by registered values, realm keeps the closed default and names
 * its exceptions.
 *
 * Why it exists at all: under npm, `npm_package_name` is `"realm"`, so realm redacted its own
 * name out of its own error messages. Console-only that was cosmetic; issue #401 persists those
 * messages in the run record, which made the mangling durable evidence.
 *
 * The first fix excluded `npm_package_*` BY PREFIX — and that was itself a secret channel. Yarn
 * classic flattens the whole package.json into that namespace, so `npm_package_deploy_apiKey`
 * and `npm_package_scripts_ship` (a script line with an inline token) were excluded from
 * redaction. The premise "npm_package_* is public metadata" is true of npm, pnpm, bun and berry,
 * and FALSE of yarn 1.x. Exact keys cannot be flattened into.
 *
 * The three rules, applied to the ENV SWEEP ONLY:
 *
 *  1. EXACT KEYS — {@link EXCLUDED_LAUNCHER_METADATA}, three of them, none path-valued.
 *  2. PUBLIC SHAPE — {@link PUBLIC_VALUE_SHAPE}: booleans and dotted versions, which launchers
 *     inject everywhere and which mangled ordinary prose ("received false") and version numbers.
 *  3. UNDER HOME — a value starting with `HOME + '/'` leaves the sweep, so a require stack
 *     renders `[REDACTED]/code/realm/…`: the tail is the informative half, the username is not.
 *     HOME ITSELF stays swept, which is what strips the prefix.
 *
 * Rule 3 is CONDITIONAL PRIVACY, and the condition is the point: a path outside home — the WSL
 * `/mnt/c/Users/<Name>` shape — cannot have its username stripped by a home-prefix rule, so it
 * stays redacted whole. Accepted bound: a path INTO home (`SECRET_PATH=/home/x/secrets/key.pem`)
 * reveals its tail. A path to a secret is not the secret — file content never transits env — but
 * the tail can disclose directory structure. The remedy for a sensitive path is to declare it a
 * manifest secret: the exemption below redacts declared values even under home.
 *
 * THE EXEMPTION, load-bearing: rules 2 and 3 filter the ENV sweep only. `additionalRedactionValues`
 * — values an author DECLARED secret — are never filtered, however public-shaped they look or
 * wherever they live.
 *
 * BLAST RADIUS: {@link serializeToolResult} runs this same pass, so persisted tool results heal
 * with it — going forward. Records written by earlier releases keep the mangled form.
 */
export function sanitizeError(err: unknown): string {
  let text: string;
  if (err instanceof Error) {
    text = err.message;
  } else if (typeof err === 'string') {
    text = err;
  } else {
    text = String(err);
  }
  text = text.replace(/Bearer [A-Za-z0-9._-]+/g, 'Bearer [REDACTED]');
  text = text.replace(/token=[A-Za-z0-9._-]+/g, 'token=[REDACTED]');
  // Read PER CALL, never captured at module scope: a module-scope read is the issue-#285 class
  // and would make every `vi.stubEnv('HOME', …)` cell test the process's real home instead.
  //
  // Keyed on `process.env.HOME`, deliberately NOT `os.homedir()`, and the listen.ts #332
  // precedent that brands bare HOME reads house-inconsistent does not apply here: the filter key
  // MUST be the same string the sweep can still redact. With homedir() and HOME unset or
  // different, under-home values would leave the sweep while nothing redacted their prefix, and
  // the full path would ship bare. The coupling is the mechanism.
  //
  // The length guard is not cosmetic: a HOME of four characters or fewer is itself outside the
  // sweep, so nothing would redact the prefix it strips. No normalization either — a trailing
  // slash makes `HOME + '/'` never match, the rule no-ops, and the value stays redacted.
  //
  // win32 is a stated non-goal rather than an oversight (realm has live win32 branches
  // elsewhere): HOME is typically undefined there, so the rule no-ops into today's fail-closed
  // full redaction, and `USERPROFILE` is deliberately unhandled — its value stays swept.
  const home = process.env['HOME'];
  const homePrefix = home !== undefined && home.length > 4 ? `${home}/` : undefined;
  const envValues = Object.entries(process.env)
    .filter(([key]) => !EXCLUDED_LAUNCHER_METADATA.has(key))
    .map(([, val]) => val)
    .filter((val): val is string => val !== undefined && val.length > 4)
    .filter((val) => !PUBLIC_VALUE_SHAPE.test(val))
    .filter((val) => homePrefix === undefined || !val.startsWith(homePrefix));
  const combined = [...new Set([...envValues, ...additionalRedactionValues])].sort(
    (a, b) => b.length - a.length,
  );
  for (const val of combined) {
    text = text.split(val).join('[REDACTED]');
  }
  return text;
}

/**
 * Serializes an MCP tool result to a string and applies the same sanitization pass
 * as sanitizeError to strip any tokens that upstream services may have echoed.
 */
export function serializeToolResult(result: unknown): string {
  const raw = typeof result === 'string' ? result : JSON.stringify(result);
  return sanitizeError(raw);
}

/** The `error` text for a Class-B result whose content carries no readable text at all. */
export const CLASS_B_NO_TEXT_MARKER = 'tool returned isError with no text content';

/**
 * Extracts the failure text from a POLITELY FAILED tool call — issue #345.
 *
 * MCP defines two ways a tool call fails. The transport can reject (Class A: an exception, which
 * the providers' catch branch already records honestly), or the call can RETURN normally with
 * `isError: true` inside the result (Class B: the polite failure the spec defines for a tool
 * reporting its own error to the model). Class B used to be minted as a success — no `error`
 * field, the failure text buried inside `result` — which made the record type's own doc contract
 * false and made every tool-reliability count read failures as successes.
 *
 * Returns the sanitized failure text for a Class-B result, or `undefined` for anything else — so
 * a caller writes `const err = classBError(raw)` and branches on presence.
 *
 * WHY `=== true` AND NOT TRUTHINESS. The SDK zod-validates every `callTool` response against
 * `CallToolResultSchema`, where `isError` is `z.boolean().optional()`. A non-boolean `isError`
 * fails that parse, the promise REJECTS, and the call lands in the catch branch as Class A —
 * recorded WITH an `error` either way. So the spec-illegal world cannot reach this mint through
 * the real transport, and a strict check cannot silently swallow a failure. (The fixture in the
 * strict-boolean cell models a wire state that cannot occur; it exists to pin the choice, not a
 * reachable case.) This premise breaks only if realm switches to
 * `CompatibilityCallToolResultSchema` or talks to a raw transport that skips validation — if that
 * ever happens, revisit this line first.
 */
export function classBError(rawResult: unknown): string | undefined {
  if (typeof rawResult !== 'object' || rawResult === null) return undefined;
  const result = rawResult as { isError?: unknown; content?: unknown };
  if (result.isError !== true) return undefined;

  const blocks = Array.isArray(result.content) ? result.content : [];
  const text = blocks
    .filter(
      (b): b is { type: 'text'; text: string } =>
        typeof b === 'object' &&
        b !== null &&
        (b as { type?: unknown }).type === 'text' &&
        typeof (b as { text?: unknown }).text === 'string',
    )
    .map((b) => b.text)
    // '\n' is specified rather than incidental: two providers mint this and a different join
    // would make the same failure read differently depending on which one ran.
    .join('\n');

  // Empty JOINED text, not merely absent blocks — `text: ''` is transport-legal, and an empty
  // `error` would be invisible to inspect's truthiness check, so a politely-failed call would
  // render as unfailed. The marker is what stops that.
  //
  // Tested on the TRIMMED text, and that is not fussiness: TWO empty blocks join to `'\n'`, which
  // is length 1 and would have sailed past a `length === 0` check — producing an `error` that is
  // technically truthy and visually nothing, which is the same invisible failure wearing a
  // different hat. (Found by the all-empty cell below, which is why it exists.) The returned text
  // is never trimmed — only the emptiness question is.
  if (text.trim().length === 0) return CLASS_B_NO_TEXT_MARKER;
  return sanitizeError(text);
}

/** Splits "server_id:tool_name" into its components. Throws if the format is invalid. */
export function parseNamespacedId(id: string): { serverId: string; toolName: string } {
  const colonIdx = id.indexOf(':');
  if (colonIdx === -1) {
    throw new Error(`Invalid namespaced tool id '${id}' (expected format: 'serverId:toolName')`);
  }
  return { serverId: id.slice(0, colonIdx), toolName: id.slice(colonIdx + 1) };
}

/** Returns the text of every ```-fenced code block (language tag optional), in document order. */
function extractFencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  const fenceRe = /```[^\n`]*\n?([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(text)) !== null) {
    blocks.push(match[1] ?? '');
  }
  return blocks;
}

/**
 * Scans text for top-level (depth-0) balanced `{...}` substrings, left to right. A `{`/`}`
 * inside a string literal — including an escaped quote `\"` or escaped backslash `\\` — never
 * affects brace depth, so a value like `{"a":"}"}` is captured whole rather than truncated at
 * the brace inside the string.
 */
function findBalancedObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escapeNext = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escapeNext) {
        escapeNext = false;
      } else if (ch === '\\') {
        escapeNext = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) {
        candidates.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return candidates;
}

/** Parses each candidate; returns the LAST one that is a plain object, or null if none are. */
function lastParsedObject(candidates: string[]): Record<string, unknown> | null {
  let result: Record<string, unknown> | null = null;
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        result = parsed as Record<string, unknown>;
      }
    } catch {
      // A brace-balanced substring is not necessarily valid JSON on its own — skip and keep scanning.
    }
  }
  return result;
}

/**
 * Extracts a single JSON object from LLM output text — the robust fallback for a model that
 * ignores "respond with JSON only" and instead wraps its answer in a fenced code block, a
 * preamble/postamble, or an illustrative example before the real answer. Object-only: a bare
 * top-level array or scalar is rejected (returns null).
 *
 * Algorithm: prefer the content of ```-fenced code blocks, if any are present (falling back to
 * the raw text if fences yield no usable object); scan for top-level balanced `{...}` substrings
 * (string/escape-aware); return the LAST candidate that parses to a plain object. Preferring the
 * last candidate — not the first — defeats the "For example {...}. Answer: {...}" preamble trap,
 * where an earlier illustrative example must not be mistaken for the real answer.
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const fenced = extractFencedBlocks(text);
  if (fenced.length > 0) {
    const fromFences = lastParsedObject(findBalancedObjectCandidates(fenced.join('\n')));
    if (fromFences !== null) return fromFences;
    // Fences present but didn't contain a usable object — fall back to the full raw text.
  }
  return lastParsedObject(findBalancedObjectCandidates(text));
}

// issue #224: the required-keys-only `validateSchema` check that used to gate both providers'
// in-conversation correction loops has been REPLACED at its only two call sites by the full-AJV
// `validateAgentSubmission` (core) — see anthropic-provider.ts/openai-provider.ts. Removed here
// rather than left dead: it had no other caller and no test referenced it directly.

const MAX_FIELD_CHARS = 200;

function truncateField(value: string): string {
  return value.length > MAX_FIELD_CHARS ? value.slice(0, MAX_FIELD_CHARS) : value;
}

function asStringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * issue #224 — a #224-LOCAL entry type: `ValidationErrorSummaryEntry`'s exact shape (imported
 * from core) PLUS an optional `allowedValues`. Deliberately NOT added to core's exported
 * `ValidationErrorSummaryEntry` (that type feeds issue #217's SHIPPED durable
 * sidecar/telemetry — widening it would silently change #217's on-disk surface and need
 * re-running its own leak tests; see failed-attempt-record.ts's #224 note on the same file).
 */
export interface AgentValidationErrorEntry extends ValidationErrorSummaryEntry {
  /**
   * The schema's OWN declared `enum` values (`params.allowedValues`) or `const` value
   * (`params.allowedValue`, normalized to a one-element array here) — present ONLY for those two
   * keywords. Value-safe: these are SCHEMA constants an author wrote (already present in the
   * system prompt the model was given), never submitted/user data — see
   * failed-attempt-record.ts's corrected doc comment for the full distinction from a genuine
   * leak vector (Ajv's `data`, which is never surfaced here either).
   */
  allowedValues?: unknown[];
}

/**
 * issue #224 — builds the #224-local entry list DIRECTLY from raw ajv error rows
 * (`validateAgentSubmission`'s `rawErrors`, never core's private `summarizeAjvErrors`, which
 * drops `params`/`data` wholesale and has no `allowedValues` field at all — see the design
 * record's DATA-PATH PIN). Mirrors core's whitelisting shape exactly (instancePath/schemaPath/
 * keyword/message + the two keyword-conditional key-NAME fields) and ADDS `allowedValues`. Caps
 * at 10 entries, truncates string fields to 200 chars, like core's summarizer. Never throws.
 */
export function summarizeAgentValidationErrors(
  rawErrors: RawValidationError[],
): AgentValidationErrorEntry[] {
  const out: AgentValidationErrorEntry[] = [];
  for (const entry of rawErrors) {
    if (out.length >= 10) break;
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as unknown as Record<string, unknown>;
    const keyword = truncateField(asStringField(e['keyword']));
    const params =
      e['params'] !== null && typeof e['params'] === 'object'
        ? (e['params'] as Record<string, unknown>)
        : undefined;
    const additionalProperty =
      keyword === 'additionalProperties' && typeof params?.['additionalProperty'] === 'string'
        ? params['additionalProperty']
        : undefined;
    const missingProperty =
      keyword === 'required' && typeof params?.['missingProperty'] === 'string'
        ? params['missingProperty']
        : undefined;
    // enum → params.allowedValues (already an array); const → params.allowedValue (a single
    // value, normalized into a one-element array so callers have one uniform shape to render).
    const allowedValues =
      keyword === 'enum' && Array.isArray(params?.['allowedValues'])
        ? (params['allowedValues'] as unknown[])
        : keyword === 'const' && params !== undefined && 'allowedValue' in params
          ? [params['allowedValue']]
          : undefined;
    out.push({
      instancePath: truncateField(asStringField(e['instancePath'])),
      schemaPath: truncateField(asStringField(e['schemaPath'])),
      keyword,
      message: truncateField(asStringField(e['message'])),
      ...(additionalProperty !== undefined
        ? { additional_property: truncateField(additionalProperty) }
        : {}),
      ...(missingProperty !== undefined
        ? { missing_property: truncateField(missingProperty) }
        : {}),
      ...(allowedValues !== undefined ? { allowedValues } : {}),
    });
  }
  return out;
}

/**
 * Renders one whitelisted Ajv-error summary entry (issue #217, extended by issue #224 with
 * `allowedValues`) as a single human-readable line for the schema-repair/in-conversation
 * correction prompt trailer. Key NAMES + schema-declared allowed VALUES only — never a
 * submitted/offending value (see `AgentValidationErrorEntry`'s own doc for the leak-safety
 * argument). RELOCATED from run-agent.ts (issue #217) to here: a provider statically importing
 * run-agent.ts risks a load cycle, and both providers now need this renderer too (issue #224).
 */
export function renderValidationSummaryEntry(entry: AgentValidationErrorEntry): string {
  const path = entry.instancePath !== '' ? entry.instancePath : '(root)';
  let line = `- ${path}: ${entry.message} [${entry.keyword}]`;
  if (entry.additional_property !== undefined) {
    line += ` (additional property: '${entry.additional_property}')`;
  }
  if (entry.missing_property !== undefined) {
    line += ` (missing property: '${entry.missing_property}')`;
  }
  if (entry.allowedValues !== undefined) {
    line += ` (allowed values: ${JSON.stringify(entry.allowedValues)})`;
  }
  return line;
}

/** Returns a Promise that rejects with a timeout error after `ms` milliseconds. */
export function rejectAfter(ms: number): Promise<never> {
  return new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`tool call timed out after ${ms}ms`)), ms),
  );
}

/**
 * Issue #313: the ONE shared HTTP-status extractor, hoisted verbatim from anthropic-provider.ts
 * so both provider ladders key on the same duck-type instead of maintaining a copy each.
 *
 * Duck-typed by necessity — both `@anthropic-ai/sdk` and `openai` are consumer-supplied peer
 * dependencies (absent from this repo and CI), so neither SDK's real error class can be
 * imported or `instanceof`-checked here. `.status` is the documented public `APIError` contract
 * of both SDKs. ACCEPTED RESIDUAL, on record and owner-ratified: this shape cannot be verified
 * in CI. It inherits exactly the class the owner ratified for the Anthropic SDK in #236 — if a
 * future SDK major renamed the field, the ladder would stop engaging and every strict failure
 * would surface as a plain error rather than a silent wrong downgrade (fail-loud, not fail-quiet).
 */
export function extractHttpStatus(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const status = (err as { status?: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return undefined;
}

/**
 * Issue #313: the provider's machine-readable error fields, captured VERBATIM for evidence.
 * `null` is preserved and meaningful — OpenAI returns `param: null, code: null` for the
 * model-unsupported class, where the message is prose-only. Realm never keys on these.
 */
export function extractApiErrorFields(err: unknown): {
  api_param?: string | null;
  api_code?: string | null;
} {
  if (typeof err !== 'object' || err === null) return {};
  const e = err as { param?: unknown; code?: unknown };
  const out: { api_param?: string | null; api_code?: string | null } = {};
  if ('param' in e) out.api_param = typeof e.param === 'string' ? e.param : null;
  if ('code' in e) out.api_code = typeof e.code === 'string' ? e.code : null;
  return out;
}

// =================================================================================================
// issue #401 — the per-create budget: the counting fetch, the ceiling, and the attribution
//
// THE INVARIANT: no single model request can hold a drive hostage. The SDK's own `timeout` bounds
// one ATTEMPT; nothing bounded the whole create, so a server directing a two-hour Retry-After, or
// a connection that hung after headers, could park a drive indefinitely with nothing recorded.
//
// Scope, stated because the claim must not overreach: this bounds realm's IN-REPO providers, which
// consume the clock. A `--provider-module` provider still gets the RECORD when it fails — it just
// does not get the bound.
// =================================================================================================

/** Realm's own retry count, passed EXPLICITLY to every SDK client. */
export const MAX_RETRIES = 2;

/** The download allowance the derived ceiling adds on top of the retry budget. */
const DOWNLOAD_ALLOWANCE_MS = 60_000;

/** What a provider attaches to an error it throws, so a chokepoint can classify it precisely. */
export interface DriveCallPayload {
  error_class?: string;
  /**
   * Attempts the wrapper SAW COMPLETE. An attempt still in flight when the ceiling fired is not
   * counted — so a pre-header hang records 0, truthfully: nothing came back.
   */
  attempts_sdk?: number;
  elapsed_ms?: number;
  last_observed_status?: number;
  retry_after_observed_ms?: number;
  declared_per_attempt_ms?: number;
  derived_ceiling_ms?: number;
}

/** What one client's fetch wrapper has seen. Per-invocation, minted beside the client. */
export interface WireCounters {
  attempts: number;
  lastStatus?: number;
  lastRetryAfterMs?: number;
}

/** The clock one step drives under. */
export interface LlmClock {
  ceilingMs: number;
  declaredPerAttemptMs?: number;
  /**
   * WHERE the per-attempt value came from. Set once, at run-agent's clock construction, and read
   * only by the disclosure: it decides whether `declared_per_attempt_ms` is recorded at all (a
   * default nobody chose is not a declaration) and which lever the abort message names.
   *
   * Absent on a hand-built clock — a unit cell, a caller that constructed one directly — and the
   * message then names BOTH levers, because with no provenance either could be the live one.
   */
  perAttemptSource?: 'step' | 'flag' | 'default';
}

/**
 * The largest delay a timer can hold. Past it `setTimeout` overflows and fires ~immediately,
 * which would inVERT a huge budget into an instant abort (gate-expiry-timer.ts:24 clamps for the
 * same reason). Both timers matter here: realm's own ceiling, and the `timeout` realm hands the
 * SDK — an unclamped per-attempt value overflows one layer down and returns as a
 * `connection_timeout` that has nothing to do with the connection.
 */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Derives the whole-create ceiling from a per-attempt value.
 *
 * `perAttempt × (MAX_RETRIES + 1)` covers every attempt the SDK will make, plus the backoff it
 * sleeps between them, plus a download allowance so a large-but-progressing response is never
 * killed for being large. The backoff term is the SDK's OWN schedule summed as an UPPER bound —
 * its jitter only ever reduces the wait, so budgeting the un-jittered sum cannot cut short a
 * retry the SDK scheduled for itself.
 *
 * A SERVER-DIRECTED wait is a different thing and is deliberately NOT budgeted. A `Retry-After`
 * can ask for hours; the ceiling outranks it on purpose, which is the point of the bound rather
 * than a gap in it.
 */
export function deriveLlmClock(perAttemptMs: number): LlmClock {
  let backoffMarginMs = 0;
  for (let n = 0; n < MAX_RETRIES; n++) backoffMarginMs += Math.min(0.5 * 2 ** n, 8) * 1000;
  // Clamped BEFORE the arithmetic and again after it, because both numbers arm a real timer. The
  // clamped per-attempt value is what gets recorded too — the record states what actually bounds
  // the attempt, not what someone asked for. There is deliberately no validator upper bound: a
  // huge value is not an authoring error, it is a request for "effectively no limit", and that is
  // what it gets.
  const perAttempt = Math.min(perAttemptMs, MAX_TIMEOUT_MS);
  return {
    ceilingMs: Math.min(
      perAttempt * (MAX_RETRIES + 1) + backoffMarginMs + DOWNLOAD_ALLOWANCE_MS,
      MAX_TIMEOUT_MS,
    ),
    declaredPerAttemptMs: perAttempt,
  };
}

/**
 * Parses all three Retry-After forms into milliseconds: `retry-after-ms`, a numeric
 * `Retry-After` in seconds, and an HTTP-date `Retry-After`. OBSERVED, never honored by realm.
 *
 * The date form is legal, the SDKs honor it, and a parser that only understood numbers dropped a
 * whole header form on the floor — recording nothing for a rate limit that was clearly signalled.
 * A date already in the past observes as 0 (the wait is over; a negative number would be a
 * nonsense measurement), while a header nobody can parse observes as nothing at all — realm has
 * no idea what was asked for and says so by omission rather than by inventing a zero.
 */
function parseRetryAfterMs(headers: Headers): number | undefined {
  const ms = headers.get('retry-after-ms');
  if (ms !== null && ms.trim() !== '' && Number.isFinite(Number(ms))) return Number(ms);
  const after = headers.get('retry-after');
  if (after === null || after.trim() === '') return undefined;
  if (Number.isFinite(Number(after))) return Number(after) * 1000;
  // `Number`, deliberately, not `parseFloat`. RFC 9110 says a Retry-After is EITHER digits-only
  // seconds or an HTTP-date; `parseFloat('7200abc')` would happily read 7200 out of a header that
  // is neither, and record a measurement the server never sent. The strict parse falls through to
  // the date arm and then to nothing, which is the truthful answer for a malformed header.
  const at = Date.parse(after);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, at - Date.now());
}

/**
 * Wraps `fetch` so realm can SEE what the SDK's retry ladder did — how many attempts it made, the
 * last status, and any Retry-After the server asked for, in all three of its legal forms
 * (`retry-after-ms`, a numeric `Retry-After`, an HTTP-date `Retry-After`).
 *
 * Observation only. Realm never honors a Retry-After: acting on it would be a scheduling decision
 * this layer does not make, and recording it is what lets an operator tell a rate limit apart from
 * a hang. The inner fetch is injectable so the wrapper is unit-testable without a socket.
 */
export function makeCountingFetch(
  counters: WireCounters,
  innerFetch: typeof fetch = globalThis.fetch,
): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    try {
      const res = await innerFetch(input, init);
      counters.attempts++;
      counters.lastStatus = res.status;
      const retryAfter = parseRetryAfterMs(res.headers);
      if (retryAfter !== undefined) counters.lastRetryAfterMs = retryAfter;
      return res;
    } catch (err) {
      // A rejection is still an attempt — it just carries no status to observe.
      counters.attempts++;
      throw err;
    }
  };
}

/**
 * Attaches a payload to an error, WITHOUT overwriting one that is already there.
 *
 * TOTAL. Both the probe and the assignment can throw on a value realm did not create — `in` runs
 * a proxy's `has` trap, and assigning to a frozen object throws in strict mode. Either one would
 * hand the caller the attacher's own TypeError in place of the failure it was trying to describe,
 * which is the whole attribution chain defeated by the last link in it. An error that cannot be
 * enriched still propagates, intact and unenriched; shape classification never needed the payload.
 */
export function attachDriveCall(err: unknown, payload: DriveCallPayload): void {
  if (typeof err !== 'object' || err === null) return;
  try {
    if ('driveCall' in err) return; // e.g. getClient's sdk_missing attach — never re-attributed
    (err as { driveCall: DriveCallPayload }).driveCall = payload;
  } catch {
    /* enrichment never out-throws the error being attributed */
  }
}

/**
 * Converts any thrown value to display text, TOTALLY.
 *
 * The chokepoints interpolate the thrown value into their console line BEFORE recording it, so a
 * poisoned `toString` used to out-throw at the print — replacing the operator's error with a
 * secondary one before the (already hardened) mint could run.
 */
export function safeErrorText(err: unknown): string {
  try {
    return err instanceof Error ? err.message : String(err);
  } catch {
    return 'unrenderable thrown value';
  }
}

/**
 * Classifies an SDK-raised error by shape, for the payload's `error_class`.
 *
 * BOTH `name` and `constructor.name` are checked, and the second is the one that works. Neither
 * installed SDK sets `.name` on its error classes — a real `APIConnectionError` from either one
 * reports `name === 'Error'` and carries its identity on the constructor — so a check on `.name`
 * alone recorded every genuine connection failure and every genuine request timeout as `other`.
 * `.name` is kept because a wrapper that re-throws with a copied name is a real shape too.
 *
 * The timeout arm sits first as a belt: under exact string equality a real timeout cannot match
 * the connection arm anyway (its constructor name is the leaf), but a wrapper copying a parent
 * `.name` onto a timeout instance could.
 *
 * TOTAL. This runs inside driveCreate's catch, where a throw would replace the operator's failure
 * with realm's own — and reading `constructor` and `name` off a value realm did not create can
 * throw. (That hole predates the constructor check: a poisoned `.name` getter out-threw here.)
 */
function shapeClass(err: unknown): string {
  try {
    const name = (err as { name?: unknown } | null)?.name;
    const ctor = (err as { constructor?: { name?: unknown } } | null)?.constructor?.name;
    if (name === 'APIConnectionTimeoutError' || ctor === 'APIConnectionTimeoutError') {
      return 'connection_timeout';
    }
    if (name === 'APIConnectionError' || ctor === 'APIConnectionError') return 'connection_error';
    if (extractHttpStatus(err) !== undefined) return 'api_status';
    return 'other';
  } catch {
    return 'other';
  }
}

/**
 * Runs ONE model create under realm's ceiling.
 *
 * Two mechanisms, because one is not enough. The timer is what bounds the wall clock; the abort is
 * what actually stops work — but only as far as the SDK will let it. The SDK's sleep primitive is
 * signal-aware, yet its retry site passes no signal, so a raced-out backoff sleep runs to
 * completion in the worker. That is the ceiling's known reach, not a bug in it: an SDK bump that
 * threads the signal there would make the race leg partially redundant, and it would still be
 * earning its keep on the post-header body hang.
 *
 * Wraps the CREATE only. Client construction stays outside — that is where a missing SDK attaches
 * its own payload, and this must never re-attribute it.
 */
export async function driveCreate<T>(
  rawCreate: (body: Record<string, unknown>, opts: Record<string, unknown>) => Promise<T>,
  body: Record<string, unknown>,
  clock: LlmClock,
  counters: WireCounters,
): Promise<T> {
  const before: WireCounters = { ...counters };
  // The observations are cleared, the attempt total is not. `attempts` is a running count, so a
  // delta is the right question for it; a status is an OBSERVATION, and asking "did it change?"
  // means a second identical 429 reads as nothing observed at all — the discriminator vanishing
  // exactly during the rate-limit storm it exists to describe. Cleared here, they are present in
  // the payload if and only if THIS create saw them.
  delete counters.lastStatus;
  delete counters.lastRetryAfterMs;
  const started = Date.now();
  const controller = new AbortController();

  let timer: ReturnType<typeof setTimeout> | undefined;
  let fired = false;
  const ceiling = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      fired = true;
      reject(new Error('__realm_ceiling__'));
    }, clock.ceilingMs);
  });
  // A race has a LOSER, and an unobserved rejected promise takes the process down on Node >= 15.
  // DEFENSE IN DEPTH, stated precisely: `Promise.race` subscribes to every promise it is given,
  // and that subscription counts as handling — so as long as the race below actually runs, neither
  // loser can go unhandled, and probing this line away does NOT trip an unhandledRejection trap.
  // What made the class real was the path where the race NEVER RAN: a create that threw
  // synchronously escaped before `Promise.race`, leaving this timer to fire into nothing and kill
  // the process. That path is closed structurally below; this line is the belt for a future
  // refactor that stops racing, which is why it survives a probe showing it does nothing today.
  void ceiling.catch(() => undefined);

  // Declared out here so the fired path can observe the loser; ASSIGNED inside the try, because a
  // provider whose create throws SYNCHRONOUSLY (a bad argument, a mocked double) would otherwise
  // escape past both the classification and the `finally` — leaving the error unattributed and
  // the timer running to fire into nothing.
  let sdkCall: Promise<T> | undefined;

  try {
    sdkCall = (async () => rawCreate(body, { signal: controller.signal }))();
    return await Promise.race([sdkCall, ceiling]);
  } catch (err) {
    // Present iff THIS create observed them — the fields were cleared at the top, so a stale
    // status from a previous create cannot attach to this failure and tell a confident lie about
    // what just happened.
    const sawStatus = counters.lastStatus !== undefined;
    const sawRetryAfter = counters.lastRetryAfterMs !== undefined;
    const delta: DriveCallPayload = {
      attempts_sdk: counters.attempts - before.attempts,
      elapsed_ms: Date.now() - started,
      ...(sawStatus ? { last_observed_status: counters.lastStatus } : {}),
      ...(sawRetryAfter ? { retry_after_observed_ms: counters.lastRetryAfterMs } : {}),
      ...(clock.declaredPerAttemptMs !== undefined
        ? { declared_per_attempt_ms: clock.declaredPerAttemptMs }
        : {}),
      derived_ceiling_ms: clock.ceilingMs,
    };

    if (fired) {
      controller.abort();
      // The loser's rejection still arrives — an APIUserAbortError, moments later. Same defense
      // in depth as the timer's catch above, and the same honest caveat: the race is already
      // subscribed, so this is insurance rather than the thing currently preventing a crash.
      void sdkCall?.catch(() => undefined);
      // The lever named is the one that is actually LIVE. Telling an operator to raise a flag
      // that a step key is already overriding sends them to change something with no effect —
      // so provenance decides which arm renders. With no provenance at all (a hand-built clock)
      // both arms render, because either could be the live one.
      const source = clock.perAttemptSource;
      const stepArm = source === undefined || source === 'step';
      const flagArm = source === undefined || source === 'flag' || source === 'default';
      const levers = [
        ...(stepArm ? ['raise llm_timeout_seconds on the step'] : []),
        ...(flagArm ? ['pass a larger --llm-timeout'] : []),
      ].join(' or ');
      const aborted = new Error(
        `LLM create exceeded the per-create ceiling (${String(clock.ceilingMs)}ms) — ${levers}`,
      );
      attachDriveCall(aborted, { error_class: 'aborted_by_budget', ...delta });
      throw aborted;
    }

    attachDriveCall(err, { error_class: shapeClass(err), ...delta });
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
