// entry-words.ts — callback K2a-2 (R1.3; the owner's K2 page: eaa442b9): the phrase that says why a
// receiver address an operator typed is not one, for each of C1's closed refusal words. One function,
// so every command that refuses an entry (`realm callback key --host`, C2c's allow-list flags) says the
// same thing. And (C2c) how much of the typed entry such a line quotes back: never a password or a
// token pasted into a path or query.
import type { EntryRefusalWord } from './allow-list.js';

const PHRASES: Readonly<Record<EntryRefusalWord, string>> = {
  path: 'it has a path, query or fragment',
  userinfo: 'it has a user name or password',
  wildcard: 'it has a wildcard',
  bracket: 'it has brackets (IPv6 addresses are not accepted)',
  colon: 'it has a stray colon',
  port: 'its port is not a whole number from 1 to 65535',
  scheme: 'only http:// may start it',
  empty: 'it has no host',
  host: 'it is not a valid host name',
};

/** Why an entry refused with `word` is not a receiver address, as a clause after a colon. */
export function entryRefusalPhrase(word: EntryRefusalWord): string {
  return PHRASES[word];
}

/**
 * The entry as a refusal quotes it, with its leading space: its text up to the first `/`, `?` or `#`
 * after any `scheme://` prefix, as JSON; nothing at all for `userinfo`, or when that text holds an
 * `@`, so a password or a token typed into the entry never reaches the terminal.
 */
export function quotedEntry(text: string, word?: EntryRefusalWord): string {
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(text)?.[0] ?? '';
  const rest = text.slice(scheme.length);
  const cut =
    scheme + rest.slice(0, rest.search(/[/?#]/) === -1 ? rest.length : rest.search(/[/?#]/));
  return word === 'userinfo' || cut.includes('@') ? '' : ` ${JSON.stringify(cut)}`;
}
