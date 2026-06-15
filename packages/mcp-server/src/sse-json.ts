/**
 * Serializes a value to JSON, escaping the three Unicode characters that Python's
 * str.splitlines() treats as line terminators but JSON.stringify leaves unescaped:
 *   U+0085 (NEXT LINE), U+2028 (LINE SEPARATOR), U+2029 (PARAGRAPH SEPARATOR).
 *
 * When these characters appear in SSE data: lines, splitlines()-based parsers split
 * the line mid-JSON, producing truncated payloads that fail JSON.parse. All other
 * non-ASCII characters (accented letters, CJK, emoji surrogate pairs, etc.) are not
 * splitlines() split points and are left as-is -- preserving human-readable output and
 * avoiding payload inflation on multilingual ticket content.
 *
 * Content round-trips correctly through any standard JSON.parse.
 */
export function sseJsonStringify(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(
    /[\u0085\u2028\u2029]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
