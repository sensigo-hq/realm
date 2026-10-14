// redaction-oracle.ts — the test oracle for redaction: does a text still carry a secret, in any
// form a reader could decode?
//
// INDEPENDENT BY CONSTRUCTION. It imports NO production code: it never asks the code under test
// which forms exist. It decodes instead — JSON (at every level), URL encoding, base64, base64url and
// hex in either case — and
// searches the decoded text for the RAW secret and for each line the caller lists by hand. So a
// form the code under test stops hiding is found here, decoded, whatever the code believes.
//
// It never returns or prints the secret: only WHERE a decoder found it (a path) and WHICH decoders
// it took. A path names an object key only when that key, decoded, holds no secret itself.
//
// It imports nothing from vitest either: `test-support/*.ts` compiles beside the shipped code (the
// package's `files` leave `dist/**/test-support/**` out of what is published).

/** Where a secret was found, and the decoders that reached it — never the secret itself. */
export interface LeakedForm {
  /** The JSON path (`content[0].text`), `(output)` for the text itself, `{key}` for a key. */
  path: string;
  /** The decoders in the order they were applied (`['json', 'base64']`); empty for the raw text. */
  decoders: string[];
}

/** Decoding stops this many levels down. */
const MAX_DEPTH = 6;

/** A run of base64 characters long enough to hold 6 bytes, with its padding. */
const BASE64_RUN = /[A-Za-z0-9+/]{8,}={0,2}/g;

/** A run of base64url characters long enough to hold 6 bytes (base64url carries no padding). */
const BASE64URL_RUN = /[A-Za-z0-9_-]{8,}/g;

/** A run of hex digits (either case) long enough to hold 4 bytes. */
const HEX_RUN = /[0-9A-Fa-f]{8,}/g;

/** The value `text` parses to as JSON, or `undefined` when it does not parse. */
function parseJson(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}

/** `text` URL-decoded, or `undefined` when it does not decode. */
function decodeUrl(text: string): string | undefined {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
}

/**
 * Every place `output` still carries `secret` or one of `lines`, after decoding. It starts from
 * `output`; when that parses as JSON it walks every key and string of the parsed value. For each
 * string it (1) searches the raw secret and each listed line; (2) when the string parses as JSON,
 * walks into it; (3) when the string holds `%` and URL-decodes to something else, searches the
 * decoded text; (4) for each run of base64 characters (8 or more), decodes it from the run's start
 * as UTF-8 and searches that; (5) the same for each run of base64url characters; (6) for each run
 * of hex digits (8 or more, either case), decodes it from the run's start, two digits a byte, as
 * UTF-8 and searches that. It stops at depth {@link MAX_DEPTH}.
 *
 * `lines` is written by hand per fixture — never computed with the production rule.
 */
export function leakedForms(
  output: string,
  secret: string,
  lines: readonly string[] = [],
): LeakedForm[] {
  const holds = (text: string): boolean =>
    text.includes(secret) || lines.some((line) => text.includes(line));

  const visitString = (
    text: string,
    path: string,
    decoders: string[],
    depth: number,
    hits: LeakedForm[],
  ): void => {
    if (depth > MAX_DEPTH) return;
    if (holds(text)) hits.push({ path: path === '' ? '(output)' : path, decoders });
    const parsed = parseJson(text);
    if (parsed !== undefined)
      visitValue(parsed.value, path, [...decoders, 'json'], depth + 1, hits);
    if (text.includes('%')) {
      const decoded = decodeUrl(text);
      if (decoded !== undefined && decoded !== text) {
        visitString(decoded, path, [...decoders, 'url'], depth + 1, hits);
      }
    }
    for (const run of text.match(BASE64_RUN) ?? []) {
      const decoded = Buffer.from(run, 'base64').toString('utf8');
      visitString(decoded, path, [...decoders, 'base64'], depth + 1, hits);
    }
    for (const run of text.match(BASE64URL_RUN) ?? []) {
      const decoded = Buffer.from(run, 'base64url').toString('utf8');
      visitString(decoded, path, [...decoders, 'base64url'], depth + 1, hits);
    }
    for (const run of text.match(HEX_RUN) ?? []) {
      const decoded = Buffer.from(run.slice(0, run.length - (run.length % 2)), 'hex').toString(
        'utf8',
      );
      visitString(decoded, path, [...decoders, 'hex'], depth + 1, hits);
    }
  };

  const visitValue = (
    value: unknown,
    path: string,
    decoders: string[],
    depth: number,
    hits: LeakedForm[],
  ): void => {
    if (typeof value === 'string') {
      visitString(value, path, decoders, depth, hits);
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => visitValue(item, `${path}[${index}]`, decoders, depth, hits));
    } else if (value !== null && typeof value === 'object') {
      Object.entries(value).forEach(([key, child], index) => {
        // The key is searched like any string. Its own hits decide whether the path may name it.
        const keyHits: LeakedForm[] = [];
        visitString(key, '', decoders, depth, keyHits);
        const segment = keyHits.length === 0 ? key : `{key #${index}}`;
        const childPath = path === '' ? segment : `${path}.${segment}`;
        for (const hit of keyHits) hits.push({ path: `${childPath}{key}`, decoders: hit.decoders });
        visitValue(child, childPath, decoders, depth, hits);
      });
    }
  };

  const hits: LeakedForm[] = [];
  visitString(output, '', [], 0, hits);
  return hits;
}
