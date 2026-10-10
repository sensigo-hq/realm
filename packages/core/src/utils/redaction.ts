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

/**
 * The escaped, bounded value renderer (issue #625 PR-2a, F2; F5 renders the precondition refusal's
 * value through it): a free-text or step-output value as one line a surface can print — written as
 * JSON, so a newline, an escape character or any other control character is its escape sequence and
 * can neither start a line nor drive a terminal (the C1 controls and the Unicode line separators,
 * which JSON leaves as they are, are escaped too); THEN capped and email-scrubbed by
 * {@link boundResolvedValue}. Escaping comes first because it can grow a value up to six times
 * (`\u001b` for one character), and the cap must hold on what is printed. `undefined` reads
 * `undefined`.
 */
export function escapedBoundedValue(v: unknown): string {
  let json: string;
  if (v === undefined) {
    json = 'undefined';
  } else {
    try {
      json = JSON.stringify(v) ?? String(v);
    } catch {
      json = '<unserializable>';
    }
  }
  const escaped = json.replace(
    // eslint-disable-next-line no-control-regex -- the control characters are what is escaped
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return boundResolvedValue(escaped) as string;
}
