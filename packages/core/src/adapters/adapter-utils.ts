import { scrubEmail, capText } from '../utils/redaction.js';

/**
 * Bounds and redacts an adapter error body before it is attached to a WorkflowError's
 * `details` (which surfaces in the user-facing envelope as error_details). Caps length and
 * scrubs email addresses — the realistic PII an API error body echoes back from a request.
 */
export function redactErrorBody(body: unknown): string {
  let text: string;
  if (typeof body === 'string') {
    text = body;
  } else {
    try {
      text = JSON.stringify(body);
    } catch {
      text = String(body);
    }
  }
  return scrubEmail(capText(text));
}

/**
 * Parses the Retry-After HTTP header value into a delay in seconds.
 * Handles both integer-seconds form (e.g. "30") and HTTP-date form
 * (e.g. "Sat, 31 May 2026 12:00:00 GMT").
 *
 * Known limitation: clock skew between client and server is not corrected.
 * Math.max(0, ...) prevents negative values when the date is in the past.
 *
 * @param raw  The raw header value from response.headers.get('Retry-After').
 * @param fallback  Conservative default to use when the header is absent or unparseable.
 */
export function parseRetryAfterHeader(raw: string | null, fallback: number): number;
export function parseRetryAfterHeader(raw: string | null, fallback?: undefined): number | undefined;
export function parseRetryAfterHeader(raw: string | null, fallback?: number): number | undefined {
  if (raw !== null) {
    // Integer-seconds form (e.g. "30"). parseInt handles potential decimal inputs
    // from non-conformant servers (e.g. "30.5" → 30).
    const n = parseInt(raw, 10);
    if (Number.isFinite(n)) return Math.max(0, n);
    // HTTP-date form (e.g. "Sat, 31 May 2026 12:00:00 GMT").
    // Known limitation: clock skew between client and server is not corrected.
    // Math.max(0, ...) prevents negative values when the date is in the past.
    const date = new Date(raw);
    if (Number.isFinite(date.getTime())) {
      return Math.max(0, Math.floor((date.getTime() - Date.now()) / 1000));
    }
  }
  return fallback;
}
