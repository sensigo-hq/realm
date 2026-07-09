// agent-utils.ts — Shared utility functions for LLM provider agentic loops.

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
 * Converts an error value to a string and strips sensitive patterns: Bearer tokens,
 * query-string tokens, process.env values longer than 4 characters, and the additional
 * (manifest-secret) values. All literal values are redacted in ONE combined pass,
 * deduped and applied LONGEST-FIRST — a short value contained in a longer one can no
 * longer leave fragments of the longer value behind.
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
  const envValues = Object.values(process.env).filter(
    (val): val is string => val !== undefined && val.length > 4,
  );
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

/**
 * Returns true if all required properties from the schema are present in the parsed object.
 * Returns true when no schema is provided.
 */
export function validateSchema(
  parsed: Record<string, unknown>,
  schema?: Record<string, unknown>,
): boolean {
  if (!schema) return true;
  const required = schema['required'];
  if (!Array.isArray(required)) return true;
  return (required as unknown[]).every((key) => typeof key === 'string' && key in parsed);
}

/** Returns a Promise that rejects with a timeout error after `ms` milliseconds. */
export function rejectAfter(ms: number): Promise<never> {
  return new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`tool call timed out after ${ms}ms`)), ms),
  );
}
