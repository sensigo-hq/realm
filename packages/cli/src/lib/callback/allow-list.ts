// allow-list.ts — R1.3 C1: the ONE grammar of the callback's allow-list. Pure. An entry is
// `[http://]<host>[:<port>]`: the port is part of the entry (443 by default, 80 under `http://`), and
// an `http://` entry allows `http` and `https` to that exact host and port, an entry without it only
// `https`. A URL is checked on its raw string first (the WHATWG parser silently strips spaces, tabs
// and newlines and accepts `https:host`), then parsed and matched by scheme, host and port. Host names
// compare after the parser's normalisation (case, punycode); a trailing dot is kept.
import { isIP } from 'node:net';

/** One parsed allow-list entry. `http`: whether `http` URLs are allowed too. */
export interface CallbackEntry {
  readonly text: string;
  readonly host: string;
  readonly port: number;
  readonly http: boolean;
}

/** The closed words an entry is refused with (a later unit prints "entry X refused: <word>"). */
export const ENTRY_REFUSAL_WORDS = [
  'path',
  'userinfo',
  'wildcard',
  'bracket',
  'colon',
  'port',
  'scheme',
  'empty',
  'host',
] as const;
export type EntryRefusalWord = (typeof ENTRY_REFUSAL_WORDS)[number];

/** The closed words a URL is refused with by the matcher. */
export type UrlRefusalWord = 'malformed' | 'too_long' | 'scheme' | 'userinfo' | 'not_allowed';

/** The two lists an operator gives: entries that allow public addresses, and private ones too. */
export interface CallbackLists {
  readonly public: readonly CallbackEntry[];
  readonly private: readonly CallbackEntry[];
}

export type EntryParse =
  | { readonly ok: true; readonly entry: CallbackEntry }
  | { readonly ok: false; readonly text: string; readonly word: EntryRefusalWord };

export type UrlMatch =
  | {
      readonly ok: true;
      readonly url: URL;
      readonly entry: CallbackEntry;
      readonly kind: 'public' | 'private';
      /** The URL's host without brackets, and its effective port. */
      readonly host: string;
      readonly port: number;
    }
  | { readonly ok: false; readonly word: UrlRefusalWord };

/** The longest callback URL accepted, in characters. */
export const CALLBACK_URL_MAX_LENGTH = 2048;

// eslint-disable-next-line no-control-regex
const SPACE_OR_CONTROL = /[\s\u0000-\u001f\u007f]/;

/** The host as the WHATWG parser normalises it, or `undefined` when it refuses it or reads more. */
function normaliseHost(host: string): string | undefined {
  try {
    const u = new URL(`http://${host}`);
    return u.pathname === '/' && u.search === '' && u.hash === '' && u.username === ''
      ? u.hostname
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parses one allow-list entry. One entry gets one word: the structural words in their order
 * (`path`, `userinfo`, `wildcard`, `bracket`, `colon`, `port`, `scheme`, `empty`) on what follows an
 * optional `<scheme>://` prefix (matched case-insensitively), then `host` on what remains: a space or
 * control character anywhere, or a host the parser refuses. Nothing is trimmed.
 */
export function parseCallbackEntry(text: string): EntryParse {
  const refuse = (word: EntryRefusalWord): EntryParse => ({ ok: false, text, word });
  const prefix = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(text);
  const scheme = prefix?.[1]?.toLowerCase();
  const rest = prefix !== null ? text.slice(prefix[0].length) : text;
  if (/[/?#]/.test(rest)) return refuse('path');
  if (rest.includes('@')) return refuse('userinfo');
  if (rest.includes('*')) return refuse('wildcard');
  if (/[[\]]/.test(rest)) return refuse('bracket');
  const colons = rest.split(':').length - 1;
  if (colons > 1 || rest.endsWith(':')) return refuse('colon');
  const [hostPart = '', portPart] = rest.split(':');
  if (portPart !== undefined) {
    if (!/^\d+$/.test(portPart)) return refuse('port');
    const p = Number(portPart);
    if (p < 1 || p > 65535) return refuse('port');
  }
  if (scheme !== undefined && scheme !== 'http') return refuse('scheme');
  if (hostPart === '') return refuse('empty');
  if (SPACE_OR_CONTROL.test(text)) return refuse('host');
  const host = normaliseHost(hostPart);
  if (host === undefined || host === '') return refuse('host');
  const http = scheme === 'http';
  return {
    ok: true,
    entry: { text, host, port: portPart !== undefined ? Number(portPart) : http ? 80 : 443, http },
  };
}

/**
 * Matches a callback URL against the two lists: the raw string first, then the parsed URL's scheme,
 * userinfo, host and effective port. The same host and port in both lists counts as `public`.
 */
export function matchCallbackEntry(lists: CallbackLists, raw: string): UrlMatch {
  const refuse = (word: UrlRefusalWord): UrlMatch => ({ ok: false, word });
  if (raw.length > CALLBACK_URL_MAX_LENGTH) return refuse('too_long');
  if (raw === '' || SPACE_OR_CONTROL.test(raw) || raw.includes('#')) return refuse('malformed');
  const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?\\]*)/.exec(raw)?.[1];
  if (authority === undefined || authority === '') return refuse('malformed');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse('malformed');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return refuse('scheme');
  if (url.username !== '' || url.password !== '' || authority.includes('@')) {
    return refuse('userinfo');
  }
  if (url.hostname === '' || url.port === '0') return refuse('malformed');
  const http = url.protocol === 'http:';
  const port = url.port !== '' ? Number(url.port) : http ? 80 : 443;
  // An IPv6 literal cannot be written as an entry (brackets are refused), so it matches none.
  if (url.hostname.startsWith('[')) return refuse('not_allowed');
  const host = url.hostname;
  let schemeOnly = false;
  for (const kind of ['public', 'private'] as const) {
    for (const entry of lists[kind]) {
      if (entry.host !== host || entry.port !== port) continue;
      if (http && !entry.http) {
        schemeOnly = true;
        continue;
      }
      return { ok: true, url, entry, kind, host, port };
    }
  }
  return refuse(schemeOnly ? 'scheme' : 'not_allowed');
}

/** Whether a matched URL's host is an IP literal (judged by the classifier, never looked up). */
export const isIpLiteralHost = (host: string): boolean => isIP(host) !== 0;
