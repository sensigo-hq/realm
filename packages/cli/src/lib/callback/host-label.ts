// host-label.ts — callback K1 (R1.3; the callback design rev 4 §1.2): the one host label a callback's
// signing keys and its allow-list entries are keyed by: `<hostname>:<effective port>`, as the WHATWG
// parser normalises the address (case folded, punycode, `127.1` as `127.0.0.1`, an IPv6 host in
// brackets, a trailing dot kept) with the port written even when it is the scheme's default. Pure. It
// is not a validity gate (it accepts userinfo): C2 runs C1's matcher first.
import type { CallbackEntry } from './allow-list.js';

const DEFAULT_PORT: Readonly<Record<string, number>> = { 'http:': 80, 'https:': 443 };

/**
 * The host label of a callback address, or `undefined` for one the parser refuses, one whose protocol
 * is not `http:` or `https:`, one with no hostname, or one on port 0.
 */
export function callbackHostLabel(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const fallback = DEFAULT_PORT[parsed.protocol];
  if (fallback === undefined || parsed.hostname === '') return undefined;
  const port = parsed.port === '' ? fallback : Number(parsed.port);
  return port === 0 ? undefined : `${parsed.hostname}:${port}`;
}

/** The host label of one of C1's parsed allow-list entries: the same shape as an address's. */
export function callbackEntryLabel(entry: CallbackEntry): string {
  return `${entry.host}:${entry.port}`;
}
