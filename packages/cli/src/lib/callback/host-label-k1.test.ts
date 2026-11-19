// host-label-k1.test.ts — callback K1 (R1.3; the callback design rev 4 §1.2): the one host label a
// callback's signing keys and its allow-list entries are keyed by, `<hostname>:<effective port>` as
// the WHATWG parser normalises the address; and its agreement with C1's parsed entries over every
// string in C1's own test file that C1 accepts as an entry.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCallbackEntry, type CallbackEntry } from './allow-list.js';
import { callbackEntryLabel, callbackHostLabel } from './host-label.js';

describe('callback K1 — the host label of an address', () => {
  it('the parser’s host, case folded, punycode, 127.1 and IPv6 normalised, the default port written; nothing else of the text', () => {
    // (1) red when the default port is left out, the typed text (case, a path, userinfo) is kept, or a
    //     trailing dot is dropped; (2) prints each label.
    expect(
      Object.fromEntries(
        [
          'https://HOOKS.Example/x',
          'https://hooks.example/',
          'https://hooks.example:443/',
          'http://hooks.example/',
          'http://hooks.example:80/',
          'https://hooks.example:8443/a?b#c',
          'https://u:p@hooks.example:8443/',
          'https://hooks.example./',
          'https://bücher.example/',
          'http://127.1:8080/',
          'https://[::1]/',
          'https://[::1]:443/',
          'http://[::1]:9000/',
        ].map((u) => [u, callbackHostLabel(u)]),
      ),
    ).toEqual({
      'https://HOOKS.Example/x': 'hooks.example:443',
      'https://hooks.example/': 'hooks.example:443',
      'https://hooks.example:443/': 'hooks.example:443',
      'http://hooks.example/': 'hooks.example:80',
      'http://hooks.example:80/': 'hooks.example:80',
      'https://hooks.example:8443/a?b#c': 'hooks.example:8443',
      'https://u:p@hooks.example:8443/': 'hooks.example:8443',
      'https://hooks.example./': 'hooks.example.:443',
      'https://bücher.example/': 'xn--bcher-kva.example:443',
      'http://127.1:8080/': '127.0.0.1:8080',
      'https://[::1]/': '[::1]:443',
      'https://[::1]:443/': '[::1]:443',
      'http://[::1]:9000/': '[::1]:9000',
    });
  });

  it('a trailing dot is a different label', () => {
    // (1) red when the dot is stripped (two hosts would share one key); (2) prints both.
    expect([
      callbackHostLabel('https://hooks.example./'),
      callbackHostLabel('https://hooks.example/'),
    ]).toEqual(['hooks.example.:443', 'hooks.example:443']);
  });

  it('no label for an address the parser refuses, on port 0, or with no host', () => {
    // (1) red when an unparseable address throws, or a port-0 address gets a label; (2) prints each.
    expect({
      unparseable: callbackHostLabel('not a url'),
      empty: callbackHostLabel(''),
      noHost: callbackHostLabel('https://'),
      port0: callbackHostLabel('https://hooks.example:0/'),
      port0v6: callbackHostLabel('http://[::1]:0/'),
    }).toEqual({
      unparseable: undefined,
      empty: undefined,
      noHost: undefined,
      port0: undefined,
      port0v6: undefined,
    });
  });

  it('`https:///x` is labelled `x:443`: the parser skips the extra slash, and the label is not a validity gate', () => {
    // Pre-authorized by MA 3 after a stop: the parser reads `https:///x` as `https://x/`. C1's matcher
    // refuses the raw string as `malformed` first (allow-list.test.ts, `emptyHost`), as it does any
    // address the label is never asked about; like the userinfo case above, the label does not check it
    // again. (1) red when the label adds a raw-string check of its own; (2) prints the label.
    expect(callbackHostLabel('https:///x')).toBe('x:443');
  });

  it('no label for an ftp: address (the parser accepts it; a natural `port || 443` would mint one)', () => {
    // (1) red when the protocol is not checked; (2) prints the label.
    expect(callbackHostLabel('ftp://example.com/')).toBeUndefined();
  });

  it('no label for a file: address, nor for mailto: (the parser accepts both, with no host)', () => {
    // (1) red when neither the protocol nor the empty hostname is checked (each alone refuses both;
    //     an http or https address with no host never parses); (2) prints both labels.
    expect([callbackHostLabel('file:///x'), callbackHostLabel('mailto:x@y.z')]).toEqual([
      undefined,
      undefined,
    ]);
  });
});

/** C1's test file, whose string literals this cell reads (a new entry there is checked here too). */
const C1_TESTS = fileURLToPath(new URL('./allow-list.test.ts', import.meta.url));
/** Entries C1's tests parse, by name (the registry's count): the derived set must hold every one. */
const KNOWN = [
  'n8n.lan',
  'n8n.lan:5678',
  'http://n8n.lan',
  'http://n8n.lan:5678',
  'N8N.LAN',
  'bücher.lan',
  'localhost',
  'localhost.',
  '127.0.0.1:8443',
  '127.0.0.1:443',
  '127.0.0.1:9443',
  '169.254.169.254:443',
  'http://plain.lan:8080',
  'localhost.:9001',
  'localhost:9000',
];

/** An address of the entry's scheme and host: `http` for an `http://` entry, else `https`. */
const addressOf = (e: CallbackEntry): string =>
  `${e.http ? 'http' : 'https'}://${e.text.replace(/^http:\/\//i, '')}/`;

describe('callback K1 — the label agrees with C1’s entries', () => {
  it('for every string in C1’s test file that C1 accepts as an entry, the entry’s label is its address’s', () => {
    const literals = new Set(
      [...readFileSync(C1_TESTS, 'utf8').matchAll(/'((?:[^'\\\n]|\\.)*)'/g)].map((m) => m[1]!),
    );
    const entries = [...literals].flatMap((t) => {
      const r = parseCallbackEntry(t);
      return r.ok ? [r.entry] : [];
    });
    const differ = entries
      .map((e) => ({
        entry: e.text,
        entryLabel: callbackEntryLabel(e),
        addressLabel: callbackHostLabel(addressOf(e)),
      }))
      .filter((r) => r.entryLabel !== r.addressLabel);
    // (1) red when the label leaves out the default port (an entry's 443 or 80 is always written), or
    //     normalises a host differently from C1, or the extraction misses one of the known entries;
    //     (2) prints the known entries the extraction missed and every entry whose labels differ.
    expect({
      missed: KNOWN.filter((k) => !entries.some((e) => e.text === k)),
      differ,
      enough: entries.length >= KNOWN.length,
    }).toEqual({ missed: [], differ: [], enough: true });
  });
});
