/**
 * Parses the Retry-After HTTP header value into a delay in seconds.
 * Only handles the integer-seconds form (e.g. "30"). The HTTP-date form
 * ("Sat, 31 May 2026 12:00:00 GMT") is not supported — parseInt returns
 * NaN for date strings, which falls through to the fallback value.
 *
 * @param raw  The raw header value from response.headers.get('Retry-After').
 * @param fallback  Conservative default to use when the header is absent or unparseable.
 */
export function parseRetryAfterHeader(raw: string | null, fallback: number): number;
export function parseRetryAfterHeader(raw: string | null, fallback?: undefined): number | undefined;
export function parseRetryAfterHeader(raw: string | null, fallback?: number): number | undefined {
  if (raw !== null) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}
