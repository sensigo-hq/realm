// option-parsers.ts — Commander value parsers for the options of `realm listen` and `realm serve`
// whose value is a whole number in a range, one of a few fixed words, or a host (issues #944, #949).
// Commander runs a value parser when it reads the command line, before the command's action, so a
// value one of these refuses ends the command there: Commander prints
// `error: option '<flags>' argument '<word>' is invalid. <the parser's sentence>` and exits 1, and
// nothing has been loaded, registered or bound. Each sentence names the flag, in the idiom of the
// repository's other parsers (`parseListenLimit`, `parsePromptCache`).
import { InvalidArgumentError } from 'commander';

/**
 * A whole number from `min` to `max`, written as digits only: no sign, no space, no decimal point,
 * no exponent, no hex prefix and no trailing text (`Number` and `parseInt` each take some of those,
 * so they are not used to decide). `'0'` is accepted when `min` is 0.
 */
export function parseWholeNumber(
  flag: string,
  min: number,
  max: number,
): (value: string) => number {
  return (value: string): number => {
    const n = /^[0-9]+$/.test(value) ? Number(value) : Number.NaN;
    if (!(n >= min && n <= max)) {
      throw new InvalidArgumentError(`${flag} must be a whole number from ${min} to ${max}.`);
    }
    return n;
  };
}

/** Exactly one of `words`, case-sensitive; the sentence lists them as `a, b, c or d`. */
export function parseOneOf(flag: string, words: readonly string[]): (value: string) => string {
  const list =
    words.length < 2
      ? words.join('')
      : `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`;
  return (value: string): string => {
    if (!words.includes(value)) {
      throw new InvalidArgumentError(`${flag} must be ${list}.`);
    }
    return value;
  };
}

/**
 * A host to bind: refused only when no host can be it — the empty string, a value holding any
 * whitespace or control character, or a word that starts with `-` (no host name or address does;
 * this also keeps a following flag, `--host --strict`, from being read as the host). Nothing else
 * is checked: the operating system decides what names an interface (an IPv6 literal with a zone
 * id, a name with an underscore, a trailing dot), and a host that is well formed but names nothing
 * reachable fails when the server binds, which says so in one line.
 */
export function parseHost(flag: string): (value: string) => string {
  return (value: string): string => {
    if (value === '' || value.startsWith('-') || /[\s\p{Cc}]/u.test(value)) {
      throw new InvalidArgumentError(`${flag} must be an IP address or a host name.`);
    }
    return value;
  };
}
