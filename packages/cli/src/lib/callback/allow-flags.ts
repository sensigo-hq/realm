// allow-flags.ts — R1.3 callback C2c (the switch): `realm listen`'s two allow-list flags, read into
// C1's lists. Pure. `--callback-allow` entries may be reached on public addresses only,
// `--callback-allow-private` entries on private, local and shared ones too. Each entry is C1's grammar
// (`parseCallbackEntry`); an IP-literal entry that the classifier refuses for its flag can never be
// used, so it is refused here with its reason (the inert-config policy), not listed. The public list
// is read first, then the private one, each in the order given; the first refusal is the only one
// said. A repeated entry (the same host, port and scheme rule) is kept once.
import { classifyAddress } from './address.js';
import {
  isIpLiteralHost,
  parseCallbackEntry,
  type CallbackEntry,
  type CallbackLists,
} from './allow-list.js';
import { entryRefusalPhrase, quotedEntry } from './entry-words.js';

const PUBLIC_FLAG = '--callback-allow';
const PRIVATE_FLAG = '--callback-allow-private';

/** The lists the flags give, or the one line that refuses them. */
export type AllowFlags = { readonly lists: CallbackLists } | { readonly refusal: string };

/** Reads the two flags' raw values (see the module comment). */
export function readAllowFlags(
  publicRaw: readonly string[],
  privateRaw: readonly string[],
): AllowFlags {
  const lists: { public: CallbackEntry[]; private: CallbackEntry[] } = { public: [], private: [] };
  for (const [kind, flag, raw] of [
    ['public', PUBLIC_FLAG, publicRaw],
    ['private', PRIVATE_FLAG, privateRaw],
  ] as const) {
    const seen = new Set<string>();
    for (const text of raw) {
      const parsed = parseCallbackEntry(text);
      if (!parsed.ok) {
        return {
          refusal:
            `Error: ${flag}${quotedEntry(text, parsed.word)} is not an address Realm can allow: ` +
            `${entryRefusalPhrase(parsed.word)}. Give a host name, with a port if it is not 443: ` +
            'hooks.example.com, or http://hooks.example.com:8080 for plain http.',
        };
      }
      const { host } = parsed.entry;
      if (isIpLiteralHost(host) && !classifyAddress(host, kind).allowed) {
        const neverPrivate = !classifyAddress(host, 'private').allowed;
        return {
          refusal:
            `Error: ${flag}${quotedEntry(text)} can never be used: ` +
            (neverPrivate
              ? 'it is an address Realm never sends a callback to, whichever flag lists it, so every ' +
                'callback to it would be refused (address). Remove it.'
              : 'it is a private, local or shared address, which this flag does not allow, so every ' +
                `callback to it would be refused (address). List it with ${PRIVATE_FLAG} only.`),
        };
      }
      const key = `${host}\0${parsed.entry.port}\0${parsed.entry.http}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lists[kind].push(parsed.entry);
    }
  }
  return { lists };
}
