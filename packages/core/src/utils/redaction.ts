// Shared redaction/bounding primitives (issue #111 extraction — were inline in
// adapters/adapter-utils.ts's redactErrorBody). Neutral module: no imports from engine/ or
// adapters/, so both can depend on it without creating an import cycle between them.

/** The realistic PII an API error body or a resolved evidence value echoes back: an email address. */
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

/** Scrubs email addresses from `s`, replacing each with `[REDACTED_EMAIL]`. */
export function scrubEmail(s: string): string {
  return s.replace(EMAIL_PATTERN, '[REDACTED_EMAIL]');
}

/** Shared length cap for a redacted/bounded string, in characters (before the truncation suffix). */
export const REDACTION_CHAR_CAP = 500;

/** Caps `text` at {@link REDACTION_CHAR_CAP} characters, appending a truncation marker if cut. */
export function capText(text: string): string {
  return text.length > REDACTION_CHAR_CAP
    ? `${text.slice(0, REDACTION_CHAR_CAP)}…[truncated]`
    : text;
}

/**
 * Bounds an arbitrary resolved value (issue #111) for durable storage in a `SkipDetail`'s
 * `resolved_value` — type-faithful for scalars (`null`/`undefined`/`boolean`/`number` pass
 * through verbatim, so the typo case's "absent" vs. "present but falsy" distinction survives),
 * length-capped and email-scrubbed for strings/objects (the same bounding discipline as
 * `redactErrorBody`, applied to an evidence value instead of an error body).
 */
export function boundResolvedValue(v: unknown): unknown {
  if (v === null || v === undefined || typeof v === 'boolean' || typeof v === 'number') {
    return v;
  }
  if (typeof v === 'string') {
    return v.length <= REDACTION_CHAR_CAP
      ? scrubEmail(v)
      : scrubEmail(v.slice(0, REDACTION_CHAR_CAP)) + '…[truncated]';
  }
  let s: string;
  try {
    s = JSON.stringify(v) ?? String(v);
  } catch {
    s = '<unserializable>';
  }
  return scrubEmail(
    s.length <= REDACTION_CHAR_CAP ? s : s.slice(0, REDACTION_CHAR_CAP) + '…[truncated]',
  );
}
