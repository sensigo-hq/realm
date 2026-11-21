// entry-words.ts — callback K2a-2 (R1.3; the owner's K2 page: eaa442b9): the phrase that says why a
// receiver address an operator typed is not one, for each of C1's closed refusal words. One function,
// so every command that refuses an entry (`realm callback key --host`, C2c's allow-list flags) says the
// same thing.
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
