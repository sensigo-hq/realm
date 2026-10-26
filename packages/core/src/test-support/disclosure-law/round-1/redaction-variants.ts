// FROZEN REFERENCE (test support; not part of the package). This file is
// packages/core/src/utils/redaction-variants.ts exactly as it stood at commit a3bf69b1 (round 1),
// below this header. The disclosure differential cell compares the current law
// against it. Never edit it: a change here changes what the cell guards.

// redaction-variants.ts — the forms a secret value takes in printed text.
//
// One pure function, no I/O. `variantsOf` is the ONE list of the forms a value can take once a
// program has printed it. The disclosure law (`redaction.ts`: `compileDisclosure`, `disclose`) expands
// every member of a set through it, marks every form on the original text and replaces each marked
// run once.
//
// THE LIST IS GENERATED, family by family, from the printers that write each form:
//   - JSON:      the escapers of Go, PHP, Perl, jq, Newtonsoft, Gson, System.Text.Json and Jackson
//                ({@link MEMBERS} J3–J11), beside the two JSON layers below;
//   - quoting:   the string printers of Python (`repr`, `ascii`, `unicode_escape`,
//                `repr(bytes)`), Node (`util.inspect`), PHP and Perl, Go (`%q`, `%+q`), Rust
//                (`{:?}`, `escape_default()`), Ruby (`inspect`), YAML double-quoted strings, Windows
//                argv, bash `declare -p` and PHP `addslashes` (Q1–Q15, R1);
//   - shells:    shell single quotes as bash, Python's `shlex`, BusyBox ash and bash `printf %q`
//                write them, and doubled quotes (YAML, SQL, CSV) (S1–S6);
//   - entities:  XML and HTML escapers (X1–X7);
//   - URLs:      each percent-encoding keep-set (U1–U10);
//   - bytes:     base64, base64url and hex (B1–B4), with Jenkins' prefixed base64 forms;
//   - dollars:   Jenkins' `$$` (I2), applied to every value;
//   - parts:     GitHub's structural forms of a registered secret and the inverse (unescaped) forms
//                Azure Pipelines and Jenkins mask (G1–G3, I1, I3, I4), applied only with `parts`.
//
// Each value, and each qualifying line of it, is expanded the same way:
//   E0  the value and every member's form of it;
//   E1  one JSON level over every E0 form — a tool's JSON text carrying Python's `repr`, for one;
//   E2  two JSON levels over the value itself — JSON inside JSON, as `json.dumps(json.dumps(v))`.
// Each JSON level writes the form both as JavaScript's `JSON.stringify` does and with every non-ASCII
// character (and DEL) as `\uXXXX`, as Python's `json.dumps` does. The two layers are not members: on
// their own they cannot be told apart from the members' forms.
//
// D, the value with its JSON- and JavaScript-style escapes read ({@link decodedReadings}): a value
// holding a backslash (a key written on one line with `\n`, say) is also read the way a program reads
// it before printing it, and each reading is expanded as the value is, lines included. D is a layer,
// like E1 and E2, applied once per value: never to its own output or to a line.
//
// `variantsOf` is pure for a value and its options, so its lists are kept in a least-recently-used
// map.
//
// They move into core unchanged with #729's disclosure step.

const BACKSLASH = '\\';

/**
 * The floor of every form that can be SHORTER than the value: base64 and base64url forms, the
 * unescaped forms (I1, I3, I4), and a multi-line value's lines. A shorter base64 form of a short
 * value is a fragment that also occurs inside ordinary hashes, UUIDs and encoded images; a shorter
 * line (`false,`, `users:`) occurs in ordinary text. Escaping members never shorten a value, so
 * their forms have no floor. GitHub's structural forms keep GitHub's own floors (G1–G3).
 */
const MIN_FORM_LENGTH = 8;

/** The line breaks a multi-line value is split at: CR LF, CR, LF, NEL, LS and PS (PyYAML's too). */
const LINE_BREAK = /\r\n|\r|\n|\u0085|\u2028|\u2029/;

/** One member: its form (or forms) of a value; `''` (or an empty list) when it has none. */
type Member = (value: string) => string | readonly string[];

/** `n` in hexadecimal, padded to `width` digits. */
function hex(n: number, width: number, upper = false): string {
  const digits = n.toString(16).padStart(width, '0');
  return upper ? digits.toUpperCase() : digits;
}

/** A form, or `''` when it is shorter than {@link MIN_FORM_LENGTH}. */
function atFloor(form: string): string {
  return form.length >= MIN_FORM_LENGTH ? form : '';
}

/**
 * The UTF-8 bytes of `value`, a lone surrogate written as its own three bytes (Python's
 * `surrogatepass`), so a percent-encoder's form of such a value is the one Python writes.
 */
function utf8Bytes(value: string): number[] {
  const bytes: number[] = [];
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else {
      bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63));
      bytes.push(0x80 | (cp & 63));
    }
  }
  return bytes;
}

// ── JSON ───────────────────────────────────────────────────────────────────────────────────────

/** What a JSON escaper writes beyond `"`, `\` and the C0 controls (see {@link jsonEscape}). */
interface JsonOptions {
  /** ASCII characters written as `\u00XX`. */
  readonly extra?: string;
  /** `"` written as the six-character escape: backslash, `u`, `0022` (not `\"`). */
  readonly quoteU?: boolean;
  /** DEL written as `\u007f`. */
  readonly del?: boolean;
  /** Every UTF-16 unit of 0x80 or more written as `\uXXXX` (an astral character as two). */
  readonly nonAscii?: boolean;
  /** These code units of 0x80 or more written as `\uXXXX`. */
  readonly seps?: readonly number[];
  /** `/` written as `\/`. */
  readonly slash?: boolean;
  /** Upper-case hex digits. */
  readonly upper?: boolean;
}

const JSON_NAMED: Readonly<Record<number, string>> = {
  8: '\\b',
  9: '\\t',
  10: '\\n',
  12: '\\f',
  13: '\\r',
};

/**
 * A JSON string's inside as an escaper writes it: `"` and `\` backslashed, `\b \t \n \f \r` named,
 * every other C0 control as `\u00XX`, a lone surrogate as `\uXXXX`, plus what `options` adds.
 */
function jsonEscape(value: string, options: JsonOptions = {}): string {
  const unit = (c: number): string => `${BACKSLASH}u${hex(c, 4, options.upper === true)}`;
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    const ch = value.charAt(i);
    if (ch === '"') out += options.quoteU === true ? unit(c) : '\\"';
    else if (ch === BACKSLASH) out += '\\\\';
    else if (JSON_NAMED[c] !== undefined) out += JSON_NAMED[c];
    else if (c < 0x20) out += unit(c);
    else if (c === 0x7f) out += options.del === true ? unit(c) : ch;
    else if (options.extra?.includes(ch) === true) out += unit(c);
    else if (ch === '/' && options.slash === true) out += '\\/';
    else if (c >= 0xd800 && c <= 0xdfff) {
      const next = value.charCodeAt(i + 1);
      if (c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        out += options.nonAscii === true ? unit(c) + unit(next) : ch + value.charAt(i + 1);
        i++;
      } else out += unit(c);
    } else if (c >= 0x80 && (options.nonAscii === true || options.seps?.includes(c) === true)) {
      out += unit(c);
    } else out += ch;
  }
  return out;
}

/** The first JSON layer: the value inside a JSON string, as `JSON.stringify` writes it. */
function jsonInner(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

/** The second JSON layer: {@link jsonInner} with DEL and every non-ASCII unit as `\uXXXX`. */
function jsonAscii(value: string): string {
  return jsonEscape(value, { del: true, nonAscii: true });
}

/** J3 — Go's `json.Marshal`: also `<`, `>`, `&`, U+2028 and U+2029, lower-case hex. */
const jsonGo: Member = (v) => jsonEscape(v, { extra: '<>&', seps: [0x2028, 0x2029] });
/** J4a — PHP's `json_encode` with `JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_LINE_TERMINATORS`. */
const jsonPhpUnicode: Member = (v) => jsonInner(v).replace(/\//g, '\\/');
/** J5 — PHP's `json_encode` default: `\/`, every non-ASCII unit escaped, DEL raw. */
const jsonPhp: Member = (v) => jsonEscape(v, { slash: true, nonAscii: true });
/** J6 — Perl JSON::PP with `ascii`: every non-ASCII unit escaped, DEL raw. */
const jsonPerlAscii: Member = (v) => jsonEscape(v, { nonAscii: true });
/** J7 — jq `tojson`: DEL escaped, non-ASCII raw. */
const jsonJq: Member = (v) => jsonEscape(v, { del: true });
/** J8 — Newtonsoft (GitHub's `JsonStringEscape`): also NEL, U+2028 and U+2029. */
const jsonNewtonsoft: Member = (v) => jsonEscape(v, { seps: [0x85, 0x2028, 0x2029] });
/** J9 — Gson's default: also `<>&='`, U+2028 and U+2029. */
const jsonGson: Member = (v) => jsonEscape(v, { extra: "<>&='", seps: [0x2028, 0x2029] });
/** J10 — System.Text.Json's default: `"` as `\u0022`, `<>&'+` and backtick, DEL, all non-ASCII, upper-case. */
const jsonSystemText: Member = (v) =>
  jsonEscape(v, { extra: "<>&'+`", quoteU: true, del: true, nonAscii: true, upper: true });
/** J11 — Jackson's default: upper-case hex. */
const jsonJackson: Member = (v) => jsonEscape(v, { upper: true });

// ── Quoting printers ───────────────────────────────────────────────────────────────────────────

/** Python's `str.isprintable()` is false for these (a space aside). */
const PY_NOT_PRINTABLE = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]$/u;

/** Python's escape of one code point: `\xhh`, `\uhhhh` or `\Uhhhhhhhh`. */
function pythonEscape(cp: number): string {
  if (cp <= 0xff) return `${BACKSLASH}x${hex(cp, 2)}`;
  return cp <= 0xffff ? `${BACKSLASH}u${hex(cp, 4)}` : `${BACKSLASH}U${hex(cp, 8)}`;
}

/** Python's quote: `"` when the value holds `'` and no `"`, otherwise `'`. */
function pythonQuote(hasSingle: boolean, hasDouble: boolean): string {
  return hasSingle && !hasDouble ? '"' : "'";
}

/** Q1 — Python's `repr()` inside its quotes (also `%r`, `!r`, `str(dict)`, logging, `pprint`). */
function pythonRepr(v: string): string {
  const quote = pythonQuote(v.includes("'"), v.includes('"'));
  let out = '';
  for (const ch of v) {
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === quote || ch === BACKSLASH) out += BACKSLASH + ch;
    else if (ch === '\t') out += '\\t';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (cp < 0x20 || cp === 0x7f) out += `${BACKSLASH}x${hex(cp, 2)}`;
    else if (cp < 0x7f) out += ch;
    else if (ch !== ' ' && PY_NOT_PRINTABLE.test(ch)) out += pythonEscape(cp);
    else out += ch;
  }
  return out;
}

/**
 * Q1a — Python's `ascii()` inside its quotes (also `%a`, `!a`): `repr()` with every code point of
 * 0x80 or more written `\xhh`, `\uhhhh` or `\Uhhhhhhhh`.
 */
const pythonAscii: Member = (v) => {
  let out = '';
  for (const ch of pythonRepr(v)) {
    const cp = ch.codePointAt(0) ?? 0;
    out += cp < 0x80 ? ch : pythonEscape(cp);
  }
  return out;
};

/** Q2 — Python's `str.encode('unicode_escape')`: every non-ASCII character escaped. */
const pythonUnicodeEscape: Member = (v) => {
  let out = '';
  for (const ch of v) {
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === BACKSLASH) out += '\\\\';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (cp < 0x20 || cp >= 0x7f) out += pythonEscape(cp);
    else out += ch;
  }
  return out;
};

/** Q3 — Python's `repr()` of the value's UTF-8 bytes, inside its quotes. */
const pythonReprBytes: Member = (v) => {
  const bytes = utf8Bytes(v);
  const quote = pythonQuote(bytes.includes(0x27), bytes.includes(0x22));
  let out = '';
  for (const b of bytes) {
    const ch = String.fromCharCode(b);
    if (ch === quote || b === 0x5c) out += BACKSLASH + ch;
    else if (b === 9) out += '\\t';
    else if (b === 10) out += '\\n';
    else if (b === 13) out += '\\r';
    else if (b < 0x20 || b >= 0x7f) out += `${BACKSLASH}x${hex(b, 2)}`;
    else out += ch;
  }
  return out;
};

/** Q4 — Node's `util.inspect` of a string inside its quotes (`console.log` of an object, `%o`). */
const nodeInspect: Member = (v) => {
  let escapeSingle = true;
  if (v.includes("'") && (!v.includes('"') || (!v.includes('`') && !v.includes('${')))) {
    escapeSingle = false;
  }
  let out = '';
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    const ch = v.charAt(i);
    if (ch === "'" && escapeSingle) out += "\\'";
    else if (ch === BACKSLASH) out += '\\\\';
    else if (JSON_NAMED[c] !== undefined) out += JSON_NAMED[c];
    else if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) out += `${BACKSLASH}x${hex(c, 2, true)}`;
    else if (c >= 0xd800 && c <= 0xdfff) {
      const next = v.charCodeAt(i + 1);
      if (c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        out += ch + v.charAt(i + 1);
        i++;
      } else out += `${BACKSLASH}u${hex(c, 4)}`;
    } else out += ch;
  }
  return out;
};

/** Q5 — single quotes with `\` and `'` backslashed: PHP's `var_export`, Perl's `Data::Dumper`. */
const singleQuoteBackslash: Member = (v) => v.replace(/[\\']/g, (m) => BACKSLASH + m);

const PERL_NAMED: Readonly<Record<number, string>> = {
  7: '\\a',
  8: '\\b',
  9: '\\t',
  10: '\\n',
  12: '\\f',
  13: '\\r',
  27: '\\e',
};

/** Q6 — Perl's `Data::Dumper` with `Useqq`, inside its quotes. */
const perlQquote: Member = (v) => {
  const chars = Array.from(v);
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] ?? '';
    const cp = ch.codePointAt(0) ?? 0;
    if ('\\"$@'.includes(ch)) out += BACKSLASH + ch;
    else if (PERL_NAMED[cp] !== undefined) out += PERL_NAMED[cp];
    else if (cp < 0x20 || cp === 0x7f) {
      const octal = cp.toString(8);
      out += BACKSLASH + (/\d/.test(chars[i + 1] ?? '') ? octal.padStart(3, '0') : octal);
    } else if (cp >= 0x80) out += `${BACKSLASH}x{${cp.toString(16)}}`;
    else out += ch;
  }
  return out;
};

const GO_NAMED: Readonly<Record<number, string>> = {
  7: '\\a',
  8: '\\b',
  12: '\\f',
  10: '\\n',
  13: '\\r',
  9: '\\t',
  11: '\\v',
};

/** Go's printable runes (`unicode.IsPrint`, a space aside): letters, marks, numbers, punctuation, symbols. */
const GO_PRINTABLE = /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u;

/** Go's `strconv.Quote` inside its quotes; `asciiOnly` gives `%+q` (`strconv.QuoteToASCII`). */
function goQuote(v: string, asciiOnly: boolean): string {
  let out = '';
  for (const ch of v) {
    const cp = ch.codePointAt(0) ?? 0;
    const printable = cp < 0x80 ? cp >= 0x20 && cp < 0x7f : !asciiOnly && GO_PRINTABLE.test(ch);
    if (ch === '"' || ch === BACKSLASH) out += BACKSLASH + ch;
    else if (printable) out += ch;
    else if (GO_NAMED[cp] !== undefined) out += GO_NAMED[cp];
    else if (cp < 0x20 || cp === 0x7f) out += `${BACKSLASH}x${hex(cp, 2)}`;
    else if (cp >= 0xd800 && cp <= 0xdfff) out += '\\ufffd';
    else if (cp < 0x10000) out += `${BACKSLASH}u${hex(cp, 4)}`;
    else out += `${BACKSLASH}U${hex(cp, 8)}`;
  }
  return out;
}

/** Q7 — Go's `%q` and `%#v` (Buildkite masks this form). */
const goQuoted: Member = (v) => goQuote(v, false);
/** Q7b — Go's `%+q`: Q7 with every rune of 0x80 or more as `\u%04x` / `\U%08x`. */
const goQuotedAscii: Member = (v) => goQuote(v, true);

/** Rust's `{:?}` of a string, by which characters it escapes and which it keeps raw. */
function rustDebug(v: string, escapes: RegExp, keepRaw: readonly number[]): string {
  let out = '';
  for (const ch of v) {
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === '"' || ch === BACKSLASH) out += BACKSLASH + ch;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else if (cp === 0) out += '\\0';
    else if ((cp >= 0x20 && cp <= 0x7e) || keepRaw.includes(cp)) out += ch;
    else if (escapes.test(ch)) out += `${BACKSLASH}u{${cp.toString(16)}}`;
    else out += ch;
  }
  return out;
}

/** Q8 — Rust 1.99's `{:?}`: control, private use, White_Space, Grapheme_Extend, Default_Ignorable,
 *  format and unassigned escaped; U+FF9E and U+FF9F raw. */
const rustDebugCurrent: Member = (v) =>
  rustDebug(
    v,
    /^[\p{Cc}\p{Co}\p{White_Space}\p{Grapheme_Extend}\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cn}\p{Cs}]$/u,
    [0xff9e, 0xff9f],
  );
/** Q8L — Rust 1.97's and earlier `{:?}`: the general categories Cc Cf Cs Co Cn Zs Zl Zp, plus Grapheme_Extend. */
const rustDebugLegacy: Member = (v) =>
  rustDebug(v, /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zs}\p{Zl}\p{Zp}\p{Grapheme_Extend}]$/u, []);

const RUBY_NAMED: Readonly<Record<number, string>> = {
  10: 'n',
  13: 'r',
  9: 't',
  12: 'f',
  11: 'v',
  8: 'b',
  7: 'a',
  27: 'e',
};

/** Ruby's `String#inspect` inside its quotes; `asciiLocale` for LANG=C or LANG unset. */
function rubyInspect(v: string, asciiLocale: boolean): string {
  const chars = Array.from(v);
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] ?? '';
    const cp = ch.codePointAt(0) ?? 0;
    const escaped =
      cp < 0x10000 ? `${BACKSLASH}u${hex(cp, 4, true)}` : `${BACKSLASH}u{${hex(cp, 1, true)}}`;
    if (ch === '"' || ch === BACKSLASH) out += BACKSLASH + ch;
    else if (ch === '#' && '$@{'.includes(chars[i + 1] ?? 'x')) out += '\\#';
    else if (RUBY_NAMED[cp] !== undefined) out += BACKSLASH + (RUBY_NAMED[cp] ?? '');
    else if (cp >= 0x20 && cp < 0x7f) out += ch;
    else if (asciiLocale) out += escaped;
    else if (cp < 0x80 || cp === 0x85 || /^[\p{Cc}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]$/u.test(ch)) {
      out += escaped;
    } else out += ch;
  }
  return out;
}

/** Q9 — Ruby's `inspect` under a UTF-8 locale. */
const rubyInspectUtf8: Member = (v) => rubyInspect(v, false);
/** Q9b — Ruby's `inspect` under LANG=C or with LANG unset: every character of 0x80 or more escaped. */
const rubyInspectAscii: Member = (v) => rubyInspect(v, true);

const YAML_NAMED: Readonly<Record<number, string>> = {
  0: '0',
  7: 'a',
  8: 'b',
  9: 't',
  10: 'n',
  11: 'v',
  12: 'f',
  13: 'r',
  27: 'e',
  0x22: '"',
  0x5c: '\\',
  0x85: 'N',
  0xa0: '_',
  0x2028: 'L',
  0x2029: 'P',
};

/** A YAML double-quoted string's inside; `allowUnicode` keeps printable non-ASCII raw (js-yaml). */
function yamlDoubleQuoted(v: string, allowUnicode: boolean): string {
  let out = '';
  for (const ch of v) {
    const cp = ch.codePointAt(0) ?? 0;
    const named = YAML_NAMED[cp];
    if (named !== undefined) out += BACKSLASH + named;
    else if (
      cp < 0x20 ||
      cp === 0x7f ||
      (cp >= 0x80 && (!allowUnicode || /^[\p{Cc}\p{Cs}\p{Zl}\p{Zp}\p{Co}\p{Cn}]$/u.test(ch)))
    ) {
      if (cp <= 0xff) out += `${BACKSLASH}x${hex(cp, 2, true)}`;
      else if (cp <= 0xffff) out += `${BACKSLASH}u${hex(cp, 4, true)}`;
      else out += `${BACKSLASH}U${hex(cp, 8, true)}`;
    } else out += ch;
  }
  return out;
}

/** Q10 — PyYAML's double-quoted string. */
const yamlPython: Member = (v) => yamlDoubleQuoted(v, false);
/** Q11 — js-yaml's double-quoted string. */
const yamlJs: Member = (v) => yamlDoubleQuoted(v, true);
/** Q12 — GitHub's `CommandLineArgumentEscape`: `"` written `\"`, nothing else. */
const doubleQuoteBackslash: Member = (v) => v.replace(/"/g, '\\"');

/** Q13 — Windows argv quoting (Python's `subprocess.list2cmdline`), inside its quotes. */
const windowsArgv: Member = (v) => {
  let out = '';
  let backslashes = 0;
  for (const ch of v) {
    if (ch === BACKSLASH) {
      backslashes++;
      continue;
    }
    if (ch === '"') {
      out += `${BACKSLASH.repeat(backslashes * 2)}\\"`;
      backslashes = 0;
      continue;
    }
    out += BACKSLASH.repeat(backslashes) + ch;
    backslashes = 0;
  }
  const quoted = /[ \t]/.test(v) || v === '';
  return out + BACKSLASH.repeat(quoted ? backslashes * 2 : backslashes);
};

/** Q14 — bash `declare -p` / `export -p`: a backslash before each `\`, `"`, `$` and backtick. */
const bashDeclare: Member = (v) => v.replace(/[\\"$`]/g, (m) => BACKSLASH + m);

/** Q15 — PHP's `addslashes`: a backslash before each `'`, `"` and `\`; NUL written `\0`. */
const phpAddslashes: Member = (v) => {
  let out = '';
  for (const ch of v) {
    if (ch === "'" || ch === '"' || ch === BACKSLASH) out += BACKSLASH + ch;
    else if (ch.charCodeAt(0) === 0) out += '\\0';
    else out += ch;
  }
  return out;
};

/** R1 — Rust's `str::escape_default()`: `\t \r \n` named, `\ ' "` backslashed, printable ASCII
 *  raw, every other character `\u{hex}`. */
const rustEscapeDefault: Member = (v) => {
  let out = '';
  for (const ch of v) {
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\n') out += '\\n';
    else if (ch === BACKSLASH || ch === "'" || ch === '"') out += BACKSLASH + ch;
    else if (cp >= 0x20 && cp < 0x7f) out += ch;
    else out += `${BACKSLASH}u{${cp.toString(16)}}`;
  }
  return out;
};

// ── Shells and quote doubling ──────────────────────────────────────────────────────────────────

/** S1 — bash xtrace, `${v@Q}`, jq `@sh` (Jenkins' Bash form): each `'` written `'\''`. */
const shellQuoteBash: Member = (v) => v.replace(/'/g, "'\\''");
/** S2 — Python's `shlex.quote`: each `'` written `'"'"'`. */
const shellQuotePython: Member = (v) => v.replace(/'/g, `'"'"'`);
/** S3 — BusyBox ash xtrace (Jenkins' Almquist shell form): a run of `'` written `'"<run>"'`. */
const shellQuoteAsh: Member = (v) => v.replace(/'+/g, (run) => `'"${run}"'`);

/** The characters bash `printf %q` backslashes when it does not use `$'…'`. */
const BASH_SPECIAL = new Set(Array.from(' \t\n\'"\\|&;()<>!{}*[]?^$`,'));

const BASH_NAMED: Readonly<Record<number, string>> = {
  9: '\\t',
  10: '\\n',
  13: '\\r',
  8: '\\b',
  11: '\\v',
  12: '\\f',
  27: '\\E',
  7: '\\a',
};

/** Whether bash `printf %q` writes the value as `$'…'`: a control character, or a C1/LS/PS one. */
function needsAnsiC(v: string): boolean {
  for (const ch of v) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029) return true;
  }
  return false;
}

/** S4 — bash `printf %q` (C.UTF-8 locale). */
const bashPrintfQ: Member = (v) => {
  let out = '';
  if (needsAnsiC(v)) {
    for (const ch of v) {
      const cp = ch.codePointAt(0) ?? 0;
      if (ch === "'" || ch === BACKSLASH) out += BACKSLASH + ch;
      else if (BASH_NAMED[cp] !== undefined) out += BASH_NAMED[cp];
      else if (cp < 0x20 || cp === 0x7f) out += BACKSLASH + cp.toString(8).padStart(3, '0');
      else if ((cp >= 0x80 && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029) {
        out += utf8Bytes(ch)
          .map((b) => BACKSLASH + b.toString(8).padStart(3, '0'))
          .join('');
      } else out += ch;
    }
    return `$'${out}'`;
  }
  Array.from(v).forEach((ch, i) => {
    out += BASH_SPECIAL.has(ch) || (i === 0 && (ch === '~' || ch === '#')) ? BACKSLASH + ch : ch;
  });
  return out;
};

/** S5 — `'` doubled: GitHub's `ExpressionStringEscape`, YAML single-quoted, SQL. */
const doubleSingleQuotes: Member = (v) => v.replace(/'/g, "''");
/** S6 — `"` doubled: CSV. */
const doubleDoubleQuotes: Member = (v) => v.replace(/"/g, '""');

// ── XML and HTML entities ──────────────────────────────────────────────────────────────────────

/** `&`, `<` and `>` as entities; `"` and `'` as given (raw when not given). */
function entities(v: string, doubleQuote = '"', singleQuote = "'"): string {
  return v.replace(/[&<>"']/g, (m) => {
    if (m === '&') return '&amp;';
    if (m === '<') return '&lt;';
    if (m === '>') return '&gt;';
    return m === '"' ? doubleQuote : singleQuote;
  });
}

/** X1 — Python's `xml.sax.saxutils.escape`, `html.escape(quote=False)`. */
const xmlMinimal: Member = (v) => entities(v);
/** X2 — GitHub's `XmlDataEscape` (`SecurityElement.Escape`), jq `@html`. */
const xmlSecurityElement: Member = (v) => entities(v, '&quot;', '&apos;');
/** X3 — Python's `html.escape`. */
const htmlPython: Member = (v) => entities(v, '&quot;', '&#x27;');
/** X4 — lodash's `_.escape`, Ruby's `CGI.escapeHTML`. */
const htmlLodash: Member = (v) => entities(v, '&quot;', '&#39;');
/** X5 — Go's `html.EscapeString`. */
const htmlGo: Member = (v) => entities(v, '&#34;', '&#39;');
/** X6 — PHP's `htmlspecialchars`. */
const htmlPhp: Member = (v) => entities(v, '&quot;', '&#039;');

/** X7 — Python's `xml.sax.saxutils.quoteattr`, inside its quotes. */
const xmlQuoteAttr: Member = (v) => {
  let out = v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\t/g, '&#9;')
    .replace(/\n/g, '&#10;')
    .replace(/\r/g, '&#13;');
  if (out.includes('"') && out.includes("'")) out = out.replace(/"/g, '&quot;');
  return out;
};

// ── Percent-encoding ───────────────────────────────────────────────────────────────────────────

/** The value percent-encoded (UTF-8, upper-case hex), keeping ASCII letters, digits and `keep`. */
function percentEncode(v: string, keep: string, plusForSpace = false): string {
  let out = '';
  for (const ch of v) {
    if (/[A-Za-z0-9]/.test(ch) || keep.includes(ch)) out += ch;
    else if (ch === ' ' && plusForSpace) out += '+';
    else {
      out += utf8Bytes(ch)
        .map((b) => `%${hex(b, 2, true)}`)
        .join('');
    }
  }
  return out;
}

/** U1 — JavaScript's `encodeURIComponent`, Node's `querystring.escape`. A value holding a lone
 *  surrogate has no form: `encodeURIComponent` throws on it. */
const urlComponent: Member = (v) => {
  try {
    return encodeURIComponent(v);
  } catch {
    return '';
  }
};
/** U2 — RFC 3986: GitHub's `UriDataEscape`, Python's `quote(safe='')`, jq `@uri`. */
const urlRfc3986: Member = (v) => percentEncode(v, '-_.~');
/** U3 — Python's `urllib.parse.quote` default (keeps `/`). */
const urlPythonQuote: Member = (v) => percentEncode(v, '-_.~/');
/** U4 — Python's `quote_plus` and `urlencode`, Go's `url.QueryEscape`. */
const urlFormPython: Member = (v) => percentEncode(v, '-_.~', true);
/** U5 — Node's `URLSearchParams`, Java's `URLEncoder`. */
const urlFormWhatwg: Member = (v) => percentEncode(v, '-_.*', true);
/** U6 — PHP's `urlencode`. */
const urlFormPhp: Member = (v) => percentEncode(v, '-_.', true);
/** U7 — Node's `URL` password, as `href` writes it. */
const urlUserinfoWhatwg: Member = (v) => percentEncode(v, "!$%&'()*+,-._~");
/** U8 — Go's `url.UserPassword`, the password part. */
const urlUserinfoGo: Member = (v) => percentEncode(v, '-_.~$&+,;=');
/** U9 — JavaScript's `encodeURI`. */
const urlEncodeUri: Member = (v) => percentEncode(v, "-_.!~*'();/?:@&=+$,#");
/** U10 — Go's `url.PathEscape`. */
const urlPathGo: Member = (v) => percentEncode(v, '-_.~$&+:=@');

// ── Bytes: base64, base64url, hex ──────────────────────────────────────────────────────────────

/** A base64 form with its padding removed and, when there was padding, the character before it. */
function trimBase64(text: string): string {
  return text.endsWith('=') ? text.replace(/=+$/, '').slice(0, -1) : text;
}

/** A base64 form in base64url: `+` → `-`, `/` → `_`, no `=`. */
function toBase64Url(form: string): string {
  return form.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Jenkins' prefixed forms (credentials-binding's `Base64SecretPatternFactory`): the value encoded
 * after `a`, from its 3rd character, as Jenkins writes it; and, beyond Jenkins, after `aa`, from its
 * 4th character (that character depends on the value's first byte alone).
 */
const JENKINS_PREFIXES: ReadonlyArray<readonly [string, number]> = [
  ['a', 2],
  ['aa', 3],
];

/**
 * B1 — the base64 forms of the value's UTF-8 bytes, each of {@link MIN_FORM_LENGTH} characters or
 * more: encoded whole, and after skipping 1 and 2 bytes, untrimmed — the three forms GitHub's runner
 * masks (`Base64StringEscape`, `Base64StringEscapeShift1` and `Shift2` in actions/runner
 * `src/Sdk/DTLogging/Logging/ValueEncoders.cs`) — and the same three trimmed. A value encoded after
 * a prefix (`user:password`) lines up again at a shift of 0, 1 or 2 bytes, since base64 maps 3 bytes
 * to 4 characters; a value encoded with something after it ends in a character that depends on what
 * follows, which the trimmed forms leave out. GitHub does not trim (its trim was reverted,
 * actions/runner #330); the trimmed forms go beyond it, as Jenkins' trimmed forms do. Jenkins'
 * prefixed forms ({@link JENKINS_PREFIXES}), each trimmed too, hide the characters before the shift
 * that depend on the value alone: after a prefix of 1 or 2 bytes (mod 3), one or two of them.
 */
function base64Forms(v: string): string[] {
  const bytes = Buffer.from(v, 'utf8');
  const shifts = [0, 1, 2].filter((shift) => bytes.length > shift);
  const untrimmed = [
    ...shifts.map((shift) => bytes.subarray(shift).toString('base64')),
    ...JENKINS_PREFIXES.map(([prefix, cut]) =>
      Buffer.concat([Buffer.from(prefix), bytes])
        .toString('base64')
        .slice(cut),
    ),
  ];
  const trimmed = untrimmed.map(trimBase64);
  return [...untrimmed, ...trimmed].filter((form) => form.length >= MIN_FORM_LENGTH);
}

/**
 * B2 — B1's forms in base64url ({@link toBase64Url}): Node's `base64url`, Python's
 * `urlsafe_b64encode`, JWT segments; and the value encoded alone in base64url, at the floor of its
 * PADDED length, so a 4- or 5-byte value encoded alone (`cTd6Mg`) is hidden as its base64 form is.
 */
const base64UrlForms: Member = (v) => {
  const whole = Buffer.from(v, 'utf8').toString('base64');
  return [
    ...base64Forms(v)
      .map(toBase64Url)
      .filter((form) => form.length >= MIN_FORM_LENGTH),
    whole.length >= MIN_FORM_LENGTH ? toBase64Url(whole) : '',
  ];
};
/** B3 — lower-case hex of the UTF-8 bytes: Python's `bytes.hex()`, Node's `Buffer`, Go's `%x`. */
const hexLower: Member = (v) => Buffer.from(v, 'utf8').toString('hex');
/** B4 — upper-case hex: Go's `%X`. */
const hexUpper: Member = (v) => Buffer.from(v, 'utf8').toString('hex').toUpperCase();

// ── Parts and inverse forms ────────────────────────────────────────────────────────────────────

/** G1 — GitHub's `TrimDoubleQuotes`: the value without its double quotes, when the quoted value is
 *  longer than 8 characters. */
const trimDoubleQuotes: Member = (v) =>
  v.length > 8 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : '';

/** G2 — GitHub's `PowerShellPreAmpersandEscape`: up to and including the last `&` (or through the
 *  first `&+`), at 6 characters or more. Ordinal search, as a runner without ICU does. */
const beforeAmpersand: Member = (v) => {
  if (!v.includes('&')) return '';
  const section = v.includes('&+')
    ? v.slice(0, v.indexOf('&+') + 2)
    : v.slice(0, v.lastIndexOf('&') + 1);
  return section.length >= 6 ? section : '';
};

/** G3 — GitHub's `PowerShellPostAmpersandEscape`: after the last `&` (or after `&+` and one more
 *  character), at 6 characters or more. */
const afterAmpersand: Member = (v) => {
  if (!v.includes('&')) return '';
  let section = '';
  if (v.includes('&+')) {
    if (v.length > v.indexOf('&+') + 3) section = v.slice(v.indexOf('&+') + 3);
  } else section = v.slice(v.lastIndexOf('&') + 1);
  return section.length >= 6 ? section : '';
};

/** I1 — microsoft/security-utilities' `UnescapeBackslashes` (Azure Pipelines): `\\ \' \" \t` read. */
const unescapeBackslashes: Member = (v) =>
  atFloor(
    v.replace(/\\\\/g, BACKSLASH).replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\t/g, '\t'),
  );
/** I2 — Jenkins: each `$` doubled (Makefile, Compose), when the value holds one. */
const dollarDoubled: Member = (v) => (v.includes('$') ? v.replace(/\$/g, '$$$$') : '');
/** I3 — Jenkins' Bash "unquoted" form: each `\` dropped, `\\` read as `\`. */
const unescapeBash: Member = (v) => atFloor(v.replace(/\\(\\?)/g, '$1'));
/** I4 — Jenkins' Batch form: each `^` dropped, `^^` read as `^`, when the value holds one. */
const unescapeBatch: Member = (v) => (v.includes('^') ? atFloor(v.replace(/\^(\^?)/g, '$1')) : '');

/**
 * Every member, in the order its forms are listed. One line per member: removing a line removes
 * exactly that member.
 */
const MEMBERS: Readonly<Record<string, Member>> = {
  J3: jsonGo,
  J4a: jsonPhpUnicode,
  J5: jsonPhp,
  J6: jsonPerlAscii,
  J7: jsonJq,
  J8: jsonNewtonsoft,
  J9: jsonGson,
  J10: jsonSystemText,
  J11: jsonJackson,
  Q1: pythonRepr,
  Q1a: pythonAscii,
  Q2: pythonUnicodeEscape,
  Q3: pythonReprBytes,
  Q4: nodeInspect,
  Q5: singleQuoteBackslash,
  Q6: perlQquote,
  Q7: goQuoted,
  Q7b: goQuotedAscii,
  Q8: rustDebugCurrent,
  Q8L: rustDebugLegacy,
  Q9: rubyInspectUtf8,
  Q9b: rubyInspectAscii,
  Q10: yamlPython,
  Q11: yamlJs,
  Q12: doubleQuoteBackslash,
  Q13: windowsArgv,
  Q14: bashDeclare,
  Q15: phpAddslashes,
  R1: rustEscapeDefault,
  S1: shellQuoteBash,
  S2: shellQuotePython,
  S3: shellQuoteAsh,
  S4: bashPrintfQ,
  S5: doubleSingleQuotes,
  S6: doubleDoubleQuotes,
  X1: xmlMinimal,
  X2: xmlSecurityElement,
  X3: htmlPython,
  X4: htmlLodash,
  X5: htmlGo,
  X6: htmlPhp,
  X7: xmlQuoteAttr,
  U1: urlComponent,
  U2: urlRfc3986,
  U3: urlPythonQuote,
  U4: urlFormPython,
  U5: urlFormWhatwg,
  U6: urlFormPhp,
  U7: urlUserinfoWhatwg,
  U8: urlUserinfoGo,
  U9: urlEncodeUri,
  U10: urlPathGo,
  B1: base64Forms,
  B2: base64UrlForms,
  B3: hexLower,
  B4: hexUpper,
  G1: trimDoubleQuotes,
  G2: beforeAmpersand,
  G3: afterAmpersand,
  I1: unescapeBackslashes,
  I2: dollarDoubled,
  I3: unescapeBash,
  I4: unescapeBatch,
};

/**
 * The members that hide a PART of a value (G1–G3, I1, I3, I4): applied only with `parts`. A part is
 * hidden on its own, everywhere, so it is applied only to a declared secret, as GitHub applies its
 * structural encoders only to registered secrets; on the environment sweep a part would hide, for
 * example, the last query parameter of every URL in the environment.
 */
const PART_MEMBERS: ReadonlySet<string> = new Set(['G1', 'G2', 'G3', 'I1', 'I3', 'I4']);

/** The line breaks the earlier list split at: CR LF, CR and LF alone. */
const CRLF_BREAK = /\r\n|\r|\n/;

/**
 * Each line of a multi-line value, of {@link MIN_FORM_LENGTH} characters or more with no whitespace:
 * the union of the split at the six breaks ({@link LINE_BREAK}) and the split at CR LF, CR and LF
 * alone, each trimmed, so a line holding a NEL, LS or PS keeps its whole text too. A value with no
 * break has no lines.
 */
function linesOf(value: string): string[] {
  const split = (breaks: RegExp): string[] => (breaks.test(value) ? value.split(breaks) : []);
  return [
    ...new Set([...split(LINE_BREAK), ...split(CRLF_BREAK)].map((line) => line.trim())),
  ].filter((line) => line.length >= MIN_FORM_LENGTH && !/\s/.test(line));
}

/** The one-character escapes D reads: JSON's (`\n \r \t \b \f \/ \\ \"`). */
const D_NAMED: Readonly<Record<string, string>> = {
  n: String.fromCharCode(10),
  r: String.fromCharCode(13),
  t: String.fromCharCode(9),
  b: String.fromCharCode(8),
  f: String.fromCharCode(12),
  '/': '/',
  [BACKSLASH]: BACKSLASH,
  '"': '"',
};
const HEX4 = /^[0-9A-Fa-f]{4}$/;
const HEX2 = /^[0-9A-Fa-f]{2}$/;
/** Strict UTF-8: a reading whose bytes are not UTF-8 gives no form. */
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * D — the value with the JSON- and JavaScript-style escapes it HOLDS read, as a program reads them
 * before printing it (a key written on one line with `\n`): `\n`, `\r`, `\t`, `\b`, `\f`, `\/`,
 * `\\`, `\"`, `\uXXXX` (a surrogate pair joined) and `\xHH`. A `\xHH` of 0x80 or more means a code
 * point or a byte (UTF-8 together with its neighbours): with 3 or fewer of them every combination is
 * read; with more, two readings of the whole value (every one a code point; every one a byte). Any
 * other backslash escape, and a malformed one (a backslash-u without four hex digits, a backslash-x
 * without two), is kept as written. A trailing lone backslash gives no reading; so does a reading
 * whose bytes are not UTF-8. Each reading is kept at {@link MIN_FORM_LENGTH} characters or more and
 * when it differs from the value.
 */
function decodedReadings(value: string): string[] {
  if (!value.includes(BACKSLASH)) return [];
  // The value as runs of read text, and between them each `\xHH` of 0x80 or more (two meanings).
  const segments: Array<string | number> = [];
  let text = '';
  let twoMeanings = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value.charAt(i);
    if (ch !== BACKSLASH) {
      text += ch;
      continue;
    }
    if (i + 1 >= value.length) return []; // a trailing lone backslash
    const next = value.charAt(i + 1);
    const named = D_NAMED[next];
    if (named !== undefined) {
      text += named;
      i++;
    } else if (next === 'u' && HEX4.test(value.slice(i + 2, i + 6))) {
      // A surrogate pair's two escapes join by themselves: their units sit side by side.
      text += String.fromCharCode(parseInt(value.slice(i + 2, i + 6), 16));
      i += 5;
    } else if (next === 'x' && HEX2.test(value.slice(i + 2, i + 4))) {
      const byte = parseInt(value.slice(i + 2, i + 4), 16);
      i += 3;
      if (byte < 0x80) text += String.fromCharCode(byte);
      else {
        segments.push(text, byte);
        text = '';
        twoMeanings++;
      }
    } else text += ch; // kept as written: the backslash, then its characters as text
  }
  segments.push(text);
  // Which meaning each two-meaning escape takes, by its index: every combination with 3 or fewer;
  // with more, the two whole readings, each built explicitly (a `2 ** n - 1` mask read with `>>`
  // collapses to 0 at 54 or more escapes, and the all-bytes reading would be lost).
  const choices: Array<(k: number) => boolean> =
    twoMeanings <= 3
      ? Array.from(
          { length: 2 ** twoMeanings },
          (_, mask) => (k: number) => ((mask >> k) & 1) === 1,
        )
      : [() => false, () => true];
  const readings = new Set<string>();
  for (const asByte of choices) {
    const bytes: number[] = [];
    let k = 0;
    for (const seg of segments) {
      // One push per byte: a spread passes each of a long segment's bytes as an argument of
      // `push`, which overflows the stack at about 125,000 bytes.
      if (typeof seg === 'string') for (const b of utf8Bytes(seg)) bytes.push(b);
      else bytes.push(...(asByte(k++) ? [seg] : utf8Bytes(String.fromCharCode(seg))));
    }
    let reading: string;
    try {
      reading = STRICT_UTF8.decode(Uint8Array.from(bytes));
    } catch {
      continue;
    }
    if (reading.length >= MIN_FORM_LENGTH && reading !== value) readings.add(reading);
  }
  return [...readings];
}

/** The options of {@link variantsOf}. */
interface VariantsOptions {
  /** Add the PART members ({@link PART_MEMBERS}): for a declared secret, never an environment value. */
  readonly parts?: boolean;
  /**
   * Test seam: leave out one member (its id), or the layer `D`, `E1`, `E2` or `LINES`. This module is
   * internal to the CLI and not exported from the package.
   */
  readonly omit?: string;
}

/** How many lists {@link variantsOf} keeps, least recently used dropped first. */
const VARIANTS_MEMO_SIZE = 4096;
const VARIANTS_MEMO = new Map<string, readonly string[]>();

/**
 * Every listed form of `value`, deduplicated: E0–E2 over the value, then E0–E2 over each line of it
 * ({@link linesOf}: split at CR LF, CR, LF, NEL, LS and PS, and at CR LF, CR and LF alone, trimmed;
 * 8 characters or more with no whitespace), as GitHub's runner registers each line of a secret as a
 * secret of its own; then the same over each reading of D ({@link decodedReadings}). The line floor
 * keeps every PEM body line and never a PEM boundary line (it holds spaces) or a short config line
 * (`apiVersion: v1`, `false,`).
 *
 * E0 is the string and each member's form of it ({@link MEMBERS}); a form is added when it is not
 * empty and differs from the string. E1 is one JSON level over every E0 form, E2 two JSON levels over
 * the string itself; each level writes {@link jsonInner} and {@link jsonAscii}. The list never holds
 * an empty string.
 *
 * `parts` (default `false`) adds the PART members ({@link PART_MEMBERS}): pass it for a declared
 * secret, never for an environment value. The list is a pure function of the value and the options,
 * so it is kept per (value, `parts`, `omit`) in a least-recently-used map of
 * {@link VARIANTS_MEMO_SIZE} lists; each call returns its own copy.
 */
export function variantsOf(value: string, options: VariantsOptions = {}): string[] {
  const parts = options.parts === true;
  const key = JSON.stringify([value, parts, options.omit ?? null]);
  let list = VARIANTS_MEMO.get(key);
  if (list !== undefined) VARIANTS_MEMO.delete(key);
  else list = buildVariants(value, parts, options.omit);
  VARIANTS_MEMO.set(key, list);
  if (VARIANTS_MEMO.size > VARIANTS_MEMO_SIZE) {
    VARIANTS_MEMO.delete(VARIANTS_MEMO.keys().next().value as string);
  }
  return [...list];
}

/** {@link variantsOf}'s list, built. */
function buildVariants(value: string, parts: boolean, omit: string | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (form: string): void => {
    if (form === '' || seen.has(form)) return;
    seen.add(form);
    out.push(form);
  };
  const addJsonLevel = (form: string): void => {
    add(jsonInner(form));
    add(jsonAscii(form));
  };
  const level = (s: string): void => {
    const firstLevel = [s];
    for (const [id, member] of Object.entries(MEMBERS)) {
      if (id === omit || (!parts && PART_MEMBERS.has(id))) continue;
      for (const form of [member(s)].flat()) {
        if (form !== '' && form !== s && !firstLevel.includes(form)) firstLevel.push(form);
      }
    }
    firstLevel.forEach(add);
    if (omit !== 'E1') firstLevel.forEach(addJsonLevel); // E1: one JSON level over every form
    if (omit !== 'E2') [jsonInner(s), jsonAscii(s)].forEach(addJsonLevel); // E2: two levels
  };
  const withLines = (s: string): void => {
    level(s);
    if (omit !== 'LINES') linesOf(s).forEach(level); // LINES: each qualifying line, as the value
  };
  withLines(value);
  if (omit !== 'D') decodedReadings(value).forEach(withLines); // D: the value's escapes read
  return out;
}
