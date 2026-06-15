/**
 * Serializes a value to JSON, escaping all non-ASCII characters as \uXXXX sequences.
 *
 * JavaScript's JSON.stringify leaves characters such as U+0085 (NEXT LINE), U+2028
 * (LINE SEPARATOR), and U+2029 (PARAGRAPH SEPARATOR) unescaped. SSE parsers —
 * including Python's str.splitlines() — treat these as line terminators, splitting
 * the data: line mid-JSON and producing a truncated payload that fails JSON.parse.
 *
 * Escaping ALL characters U+0080–U+FFFF produces pure 7-bit ASCII output: immune to
 * any Unicode-based line-splitting by any SSE client, regardless of language or library.
 * Content round-trips correctly through any standard JSON.parse.
 */
export function sseJsonStringify(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(
    /[\x80-￿]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
