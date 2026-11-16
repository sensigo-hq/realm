// allow-list.test.ts — R1.3 C1: the callback's allow-list grammar: an entry's forms and its nine closed
// refusal words (the prompt's eight and `host`, MA 3 2026-11-17), the URL's raw-string checks, the
// IPv4 spellings that are IP literals, and each of scheme, host and port pinned on its own.
//
// Each assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, expect, it } from 'vitest';
import {
  CALLBACK_URL_MAX_LENGTH,
  ENTRY_REFUSAL_WORDS,
  isIpLiteralHost,
  matchCallbackEntry,
  parseCallbackEntry,
  type CallbackEntry,
  type CallbackLists,
} from './allow-list.js';

/** The entry `text` parses to, or the word it is refused with. */
const parsed = (text: string) => {
  const r = parseCallbackEntry(text);
  return r.ok ? { host: r.entry.host, port: r.entry.port, http: r.entry.http } : r.word;
};
const entry = (text: string): CallbackEntry => {
  const r = parseCallbackEntry(text);
  if (!r.ok) throw new Error(`fixture: ${text} refused ${r.word}`);
  return r.entry;
};
const lists = (pub: string[], priv: string[] = []): CallbackLists => ({
  public: pub.map(entry),
  private: priv.map(entry),
});
/** What the matcher says of `url`: the entry's text and kind, or the word. */
const matched = (l: CallbackLists, url: string) => {
  const r = matchCallbackEntry(l, url);
  return r.ok ? `${r.kind}:${r.entry.text}` : r.word;
};

describe('R1.3 C1 — an allow-list entry', () => {
  it('the entry forms: the port is part of the entry (443, or 80 under http://); hosts as the parser normalises them', () => {
    // (a) red when a default port, the http flag or the host normalisation changes; (b) prints them.
    expect(
      Object.fromEntries(
        [
          'n8n.lan',
          'n8n.lan:5678',
          'http://n8n.lan',
          'http://n8n.lan:5678',
          'N8N.LAN',
          'bücher.lan',
          'localhost',
          'localhost.',
          '127.0.0.1:8443',
        ].map((t) => [t, parsed(t)]),
      ),
    ).toEqual({
      'n8n.lan': { host: 'n8n.lan', port: 443, http: false },
      'n8n.lan:5678': { host: 'n8n.lan', port: 5678, http: false },
      'http://n8n.lan': { host: 'n8n.lan', port: 80, http: true },
      'http://n8n.lan:5678': { host: 'n8n.lan', port: 5678, http: true },
      'N8N.LAN': { host: 'n8n.lan', port: 443, http: false },
      'bücher.lan': { host: 'xn--bcher-kva.lan', port: 443, http: false },
      localhost: { host: 'localhost', port: 443, http: false },
      'localhost.': { host: 'localhost.', port: 443, http: false },
      '127.0.0.1:8443': { host: '127.0.0.1', port: 8443, http: false },
    });
  });

  it('each closed refusal word, one entry one word, in order', () => {
    const cases: Record<string, string> = {
      'n8n.lan/x': 'path',
      'n8n.lan?x': 'path',
      'n8n.lan#x': 'path',
      'n8n.lan/x y': 'path',
      'u@n8n.lan': 'userinfo',
      'u:p@n8n.lan': 'userinfo',
      '*.lan': 'wildcard',
      '[::1]:443': 'bracket',
      'a:b:c': 'colon',
      'n8n.lan:': 'colon',
      'n8n.lan:0': 'port',
      'n8n.lan:65536': 'port',
      'n8n.lan:abc': 'port',
      'https://n8n.lan': 'scheme',
      'ftp://n8n.lan': 'scheme',
      '': 'empty',
      'http://': 'empty',
      ':443': 'empty',
      '   ': 'host',
      'exa mple.lan': 'host',
      'a%zz.lan': 'host',
      'a<b.lan': 'host',
      'http:// n8n.lan': 'host',
      'n8n.lan\\x': 'host',
    };
    // (a) red when an entry gets another word, or none; (b) prints each entry's word.
    expect(Object.fromEntries(Object.keys(cases).map((t) => [t, parsed(t)]))).toEqual(cases);
    // The parser hands the entry text back with its word, for "entry X refused: <word>".
    expect(parseCallbackEntry('n8n.lan:0')).toEqual({ ok: false, text: 'n8n.lan:0', word: 'port' });
    // The closed set, the nine words in their check order.
    expect([...ENTRY_REFUSAL_WORDS]).toEqual([
      'path',
      'userinfo',
      'wildcard',
      'bracket',
      'colon',
      'port',
      'scheme',
      'empty',
      'host',
    ]);
  });

  // MA 3's five pins (2026-11-17): nothing is trimmed; the prefixes are matched case-insensitively.
  it('a trailing space is `host`', () => {
    // (a) red when the entry is trimmed; (b) prints the word.
    expect(parsed('n8n.lan ')).toBe('host');
  });
  it('a tab is `host`', () => {
    // (a) red when a tab passes (the URL parser strips it silently); (b) prints the word.
    expect(parsed('n8n\t.lan')).toBe('host');
  });
  it('`256.1.1.1` is `host` (the parser refuses it)', () => {
    // (a) red when a host the parser throws on is accepted or gets another word; (b) prints it.
    expect(parsed('256.1.1.1')).toBe('host');
  });
  it('`HTTP://n8n.lan` is the same entry as `http://n8n.lan`', () => {
    // (a) red when the prefix is matched case-sensitively; (b) prints both parses.
    expect(parsed('HTTP://n8n.lan')).toEqual(parsed('http://n8n.lan'));
  });
  it('`HTTPS://n8n.lan` is `scheme`', () => {
    // (a) red when the refused prefix is matched case-sensitively; (b) prints the word.
    expect(parsed('HTTPS://n8n.lan')).toBe('scheme');
  });
});

describe('R1.3 C1 — a URL against the lists', () => {
  const l = lists(['n8n.lan:5678', 'http://plain.lan:8080', '127.0.0.1:9443'], ['localhost:9000']);

  it('the raw string first: malformed and too_long, before the parser can strip or accept it', () => {
    const long = `https://n8n.lan:5678/${'a'.repeat(CALLBACK_URL_MAX_LENGTH)}`;
    const cases = {
      empty: '',
      space: 'https://n8n.lan:5678/a b',
      leadingSpace: ' https://n8n.lan:5678/',
      tab: 'https://n8n\t.lan:5678/',
      newline: 'https://n8n.lan:5678/\n',
      hash: 'https://n8n.lan:5678/#x',
      noSlashes: 'https:n8n.lan:5678/',
      emptyHost: 'https:///x',
      portZero: 'https://n8n.lan:0/',
      portHigh: 'https://n8n.lan:65536/',
      throws: 'https://exa mple.lan/'.replace(' ', '%20'),
      tooLong: long,
    };
    // (a) red when a raw form passes to the parser, or a word is wrong; (b) prints each word.
    expect(Object.fromEntries(Object.entries(cases).map(([k, u]) => [k, matched(l, u)]))).toEqual({
      empty: 'malformed',
      space: 'malformed',
      leadingSpace: 'malformed',
      tab: 'malformed',
      newline: 'malformed',
      hash: 'malformed',
      noSlashes: 'malformed',
      emptyHost: 'malformed',
      portZero: 'malformed',
      portHigh: 'malformed',
      throws: 'malformed',
      tooLong: 'too_long',
    });
  });

  it('then parsed: scheme, userinfo, not_allowed; an IPv6 literal URL is not_allowed', () => {
    // (a) red when a parsed refusal gets another word; (b) prints each word.
    expect({
      ftp: matched(l, 'ftp://n8n.lan:5678/'),
      user: matched(l, 'https://u@n8n.lan:5678/'),
      userPass: matched(l, 'https://u:p@n8n.lan:5678/'),
      emptyUser: matched(l, 'https://@n8n.lan:5678/'),
      unlisted: matched(l, 'https://other.lan:5678/'),
      ipv6: matched(l, 'https://[::1]:9000/'),
      ipv6Mapped: matched(l, 'https://[::ffff:127.0.0.1]:9443/'),
      empty: matched({ public: [], private: [] }, 'https://n8n.lan:5678/'),
    }).toEqual({
      ftp: 'scheme',
      user: 'userinfo',
      userPass: 'userinfo',
      emptyUser: 'userinfo',
      unlisted: 'not_allowed',
      ipv6: 'not_allowed',
      ipv6Mapped: 'not_allowed',
      empty: 'not_allowed',
    });
  });

  it('`localhost.` is not `localhost`; the spellings 2130706433, 0x7f000001, 127.1, 0251.0376.0251.0376 are IP literals', () => {
    const names = lists([], ['localhost:9000', 'localhost.:9001']);
    const spellings = ['2130706433', '0x7f000001', '127.1', '0251.0376.0251.0376'];
    const hostOf = (u: string) => {
      const r = matchCallbackEntry(lists(['127.0.0.1:443', '169.254.169.254:443']), u);
      return r.ok ? [r.host, isIpLiteralHost(r.host)] : r.word;
    };
    // (a) red when a trailing dot is stripped, or a numeric spelling matches a name entry or is not
    //     read as the IP literal the parser makes of it; (b) prints them.
    expect({
      dotted: matched(names, 'https://localhost.:9000/'),
      plain: matched(names, 'https://localhost:9001/'),
      dottedOwn: matched(names, 'https://localhost.:9001/'),
      byName: spellings.map((s) => matched(names, `https://${s}:9000/`)),
      literal: spellings.map((s) => hostOf(`https://${s}/`)),
    }).toEqual({
      dotted: 'not_allowed',
      plain: 'not_allowed',
      dottedOwn: 'private:localhost.:9001',
      byName: ['not_allowed', 'not_allowed', 'not_allowed', 'not_allowed'],
      literal: [
        ['127.0.0.1', true],
        ['127.0.0.1', true],
        ['127.0.0.1', true],
        ['169.254.169.254', true],
      ],
    });
  });

  it('the conjuncts: scheme, host and port each refuse on their own', () => {
    // (a) red when one conjunct is dropped from the match; (b) prints each answer.
    expect({
      noPortEntry: matched(lists(['n8n.lan']), 'https://n8n.lan:5678/x'),
      otherPort: matched(lists(['n8n.lan:5678']), 'https://n8n.lan:5679/x'),
      samePort: matched(lists(['n8n.lan:5678']), 'https://n8n.lan:5678/x'),
      otherHost: matched(lists(['n8n.lan:5678']), 'https://n9n.lan:5678/x'),
      httpsOnlyEntry: matched(lists(['n8n.lan:5678']), 'http://n8n.lan:5678/x'),
      httpEntryHttp: matched(lists(['http://n8n.lan:5678']), 'http://n8n.lan:5678/x'),
      httpEntryHttps: matched(lists(['http://n8n.lan:5678']), 'https://n8n.lan:5678/x'),
      httpDefaultHttp: matched(lists(['http://n8n.lan']), 'http://n8n.lan/'),
      httpDefaultHttps: matched(lists(['http://n8n.lan']), 'https://n8n.lan/'),
    }).toEqual({
      noPortEntry: 'not_allowed',
      otherPort: 'not_allowed',
      samePort: 'public:n8n.lan:5678',
      otherHost: 'not_allowed',
      httpsOnlyEntry: 'scheme',
      httpEntryHttp: 'public:http://n8n.lan:5678',
      httpEntryHttps: 'public:http://n8n.lan:5678',
      httpDefaultHttp: 'public:http://n8n.lan',
      httpDefaultHttps: 'not_allowed',
    });
  });

  it('the same host and port in both lists counts as public; the matcher names the entry and its kind', () => {
    // (a) red when the private list is read first; (b) prints the match.
    expect({
      both: matched(lists(['n8n.lan:5678'], ['n8n.lan:5678']), 'https://n8n.lan:5678/'),
      privateOnly: matched(lists([], ['n8n.lan:5678']), 'https://n8n.lan:5678/'),
    }).toEqual({ both: 'public:n8n.lan:5678', privateOnly: 'private:n8n.lan:5678' });
  });
});
