// agent-utils.ts — Shared utility functions for LLM provider agentic loops.

const SYSTEM_PROMPT_BASE =
  'You are an AI agent executing a step in a structured workflow.\n' +
  'Your task is described below. Respond with a JSON object only — no markdown, no explanation.';

/** Builds the system prompt for an agent step, optionally prepending an agent profile and/or including the output schema. */
export function buildSystemPrompt(
  inputSchema?: Record<string, unknown>,
  agentProfileInstructions?: string,
): string {
  const base =
    agentProfileInstructions !== undefined
      ? `${agentProfileInstructions}\n\n${SYSTEM_PROMPT_BASE}`
      : SYSTEM_PROMPT_BASE;
  if (inputSchema === undefined) return base;
  return `${base}\nThe JSON must conform to this schema: ${JSON.stringify(inputSchema)}`;
}

/**
 * Converts an error value to a string and strips sensitive patterns:
 * Bearer tokens, query-string tokens, and any process.env value longer than 4 characters.
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
  for (const val of Object.values(process.env)) {
    if (val !== undefined && val.length > 4) {
      text = text.split(val).join('[REDACTED]');
    }
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

/** Tries to parse JSON; returns a plain object or null if parsing fails or the result is not an object. */
export function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
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
