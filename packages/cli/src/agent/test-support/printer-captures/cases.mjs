// cases.mjs — the FAKE values the printer captures run on, with the anchors and lines each row is
// checked by. One source for every capture script and for the generator.
//
// Every value here is FAKE, written in this file or in cases.json. None carries a real provider's
// token shape.
/* global URL */
import { readFileSync } from 'node:fs';

const here = new URL('.', import.meta.url);
const ch = (cp) => String.fromCodePoint(cp);
const E_ACUTE = ch(0xe9);
const NBSP = ch(0xa0);
const DEL = ch(0x7f);
const NEL = ch(0x85);
const BACKTICK = '`';

/** The anchors of a class case: the text around the class characters. */
export const ANCHORS = ['FAKEhd7Q', 'Z9tlFAKE'];
const anchored = (middle) => ANCHORS[0] + middle + ANCHORS[1];

/** The lane's class cases (`ab<c>cd`) and whole values, FAKE. */
const lane = JSON.parse(readFileSync(new URL('cases.json', here), 'utf8'));

/**
 * The structural cases, rewritten as whole fake values of 17 or more characters that keep their
 * structure, each with two hand-written anchors from its own text that every printer writes raw.
 */
const STRUCTURAL = {
  tdq: ['"fakeSecretValue9x"', ['fakeSecr', 'tValue9x']],
  ps_amp: ['fakepart1&fakepart2', ['fakepart', 'akepart2']],
  ps_ampplus: ['fakepart1&+fakepart2', ['fakepart', 'akepart2']],
  bs_escapes: ['fakeHead\\\\tok\\"en\\tfakeTail', ['fakeHead', 'fakeTail']],
  dollar_only: ['fakeHead$ecretValue99', ['fakeHead', 'tValue99']],
  caret_esc: ['fakeHead^^sec^retValue9', ['fakeHead', 'etValue9']],
};

/**
 * The four whole values keep their text. Their anchors are runs of letters and digits only, so no
 * printer rewrites them: `mixed` holds no such run of 4, so its anchor is `p@ss` (the oracle
 * URL-decodes `@`), beside P1's marker check; `pem3` is checked by its body line instead.
 */
const WHOLE = {
  tok40: (v) => [v.slice(0, 8), v.slice(-8)],
  awsish40: () => ['0123456789abcdef', 'GHIJKLmn'],
  mixed: () => ['p@ss'],
};

/**
 * The multi-line case: three lines, 82 characters, so Node's `util.inspect` splits it. Its middle
 * line holds `"`, `\` and U+0001 around the escape-free fragment its `lines` entry names: a printer
 * escapes the rest of that line, and the oracle does not read string literals.
 */
const MULTI =
  'FAKElineOne0123456789abcdef\n' +
  'fakeLi"\\' +
  ch(1) +
  'neTwo0123456789ab\n' +
  'fakeLineThree0123456789FAKE';

/**
 * Every case the printers run on: `{ case, value, anchors, lines? }`. The `lone_hi` case is left
 * out (problem 11: a lone surrogate cannot reach the CLI; values come from the environment and from
 * UTF-8 files).
 */
export function fixtureCases() {
  const cases = [];
  for (const [id, raw] of Object.entries(lane)) {
    if (id.startsWith('_') || id === 'lone_hi') continue;
    if (STRUCTURAL[id] !== undefined) {
      const [value, anchors] = STRUCTURAL[id];
      cases.push({ case: id, value, anchors });
    } else if (id === 'pem3') {
      cases.push({ case: id, value: raw, anchors: [], lines: [raw.split('\n')[1]] });
    } else if (WHOLE[id] !== undefined) {
      cases.push({ case: id, value: raw, anchors: WHOLE[id](raw) });
    } else {
      // A class case is `ab<c>cd`: its class characters, between the anchors. One that does not
      // fit (`a'b"cd`) takes its characters between the first `a` and the last `d`.
      const middle =
        raw.startsWith('ab') && raw.endsWith('cd') && raw.length > 4
          ? raw.slice(2, -2)
          : raw.slice(raw.indexOf('a') + 1, raw.lastIndexOf('d'));
      cases.push({ case: id, value: anchored(middle), anchors: ANCHORS });
    }
  }
  cases.push({
    case: 'multi',
    value: MULTI,
    anchors: [MULTI.slice(0, 8), MULTI.slice(-8)],
    lines: ['neTwo0123456789ab'],
  });
  return cases;
}

/**
 * The YAML dumpers' own cases: values that force YAML's quoting, `'` in single quotes among them.
 * Each anchor is a part of its value that both dumpers write raw.
 */
export const YAML_CASES = {
  colon_sq: ["ab: c'd", ['ab: c']],
  colon_dq_bs: ['ab: c"d\\e', ['ab: c']],
  ctl_dq_bs: ['ab"c\\d' + ch(1) + 'e', ['ab']],
  lead_sq: ["'abcdefgh", ['abcdefgh']],
  lead_amp: ['&abcdefgh', ['abcdefgh']],
  lead_star: ['*abcdefgh', ['abcdefgh']],
  lead_bang: ['!abcdefgh', ['abcdefgh']],
  lead_pct: ['%abcdefgh', ['abcdefgh']],
  lead_at: ['@abcdefgh', ['abcdefgh']],
  lead_bt: [BACKTICK + 'abcdefgh', ['abcdefgh']],
  hash_sp: ['abcd #efgh', ['abcd', 'efgh']],
  numlike: ['12345678', ['12345678']],
  boollike: ['yes', ['yes']],
  // Excluded from the fixture by name (problem 10: YAML folds a long spaced value across lines).
  long_spaces: ['fake ' + 'word0123 '.repeat(12) + 'end', ['word0123']],
};

/** A separating row's value: the middle between the anchors, or a whole value with its own anchors. */
const sep = (member, printer, runtime, middle, anchors) => ({
  member,
  printer,
  runtime,
  value: anchors === undefined ? anchored(middle) : middle,
  anchors: anchors ?? ANCHORS,
});
const ESCAPED_WHOLE = 'fake\\"esc\\\\aped\\tval';
const BS = '\\';
/**
 * I1's own value: `\'` is read by I1 and kept as written by D (the JSON-style escapes read), so only I1
 * writes its form; on {@link ESCAPED_WHOLE} D writes I1's form too.
 */
const ESCAPED_I1 = 'fake' + BS + "'esc" + BS + BS + 'aped' + BS + 'tval';
/**
 * Q13's own value: a `"` after an escaped backslash, beside `\'`; on {@link ESCAPED_WHOLE} D's reading
 * expanded by the members writes Windows argv's form too.
 */
const ESCAPED_Q13 = 'fake' + BS + "'esc" + BS + BS + '"aped';

/**
 * One SEPARATING row per member and per structural part: the member's P2 printer run on its
 * separating value. `runtime` names the capture that writes the printer: `local` (this machine's
 * python3, node, bash, jq, perl) or a container key of `runtimes/`.
 */
export const SEPARATING = [
  sep('J3', 'go.json.Marshal', 'go', "'&"),
  sep('J4a', 'php.json_encode_UU_ULT', 'php', E_ACUTE + '/'),
  sep('J5', 'php.json_encode', 'php', E_ACUTE + '/'),
  sep('J6', 'perl.JSON::PP_ascii', 'local', '/' + DEL + E_ACUTE),
  sep('J7', 'jq.tojson', 'local', E_ACUTE + DEL),
  sep('J8', 'gh.JsonStringEscape', 'dotnet', 'fake val' + DEL + NEL + E_ACUTE + ' two', [
    'fake val',
    E_ACUTE + ' two',
  ]),
  sep('J9', 'gson.toJson', 'java', '='),
  sep('J10', 'stj.Serialize', 'dotnet', '"'),
  sep('J11', 'jackson2.writeValueAsString', 'java', E_ACUTE + ch(0x0b)),
  sep('Q1', 'py.repr', 'local', E_ACUTE + NBSP),
  sep('Q1a', 'py.ascii', 'local', '\'"' + E_ACUTE),
  // Q2's value holds both quotes: on `é` alone, Q1a (`ascii()`) writes Q2's form too.
  sep('Q2', 'py.unicode_escape', 'local', '"\'' + E_ACUTE),
  sep('Q3', 'py.repr_bytes', 'local', E_ACUTE),
  sep('Q4', 'node.inspect_str', 'local', ch(0x0b)),
  sep('Q5', 'perl.Dumper', 'local', "'" + ch(0)),
  sep('Q6', 'perl.Dumper_Useqq', 'local', E_ACUTE),
  sep('Q7', 'go.fmt.q', 'go', E_ACUTE + NBSP),
  sep('Q7b', 'go.fmt.plusq', 'go', E_ACUTE + DEL),
  // Q8's and Q8L's values hold `é` beside the code point where the two differ: on that code point
  // alone R1 (`escape_default()`) writes their form, but R1 escapes `é`, which `{:?}` prints raw.
  sep('Q8', 'rust.debug_str', 'rust', E_ACUTE + ch(0x3164)),
  sep('Q8L', 'rust.debug_str@1.81', 'rust181', E_ACUTE + ch(0xff9e)),
  sep('Q9', 'ruby.inspect', 'ruby', E_ACUTE + DEL),
  sep('Q9b', 'ruby.inspect@C', 'ruby', '"' + E_ACUTE),
  sep('Q10', 'py.yaml_safe_dump_dict', 'local', E_ACUTE),
  sep('Q11', 'node.jsyaml_dump_obj', 'local', E_ACUTE + NBSP),
  sep('Q12', 'gh.CommandLineArgumentEscape', 'dotnet', ESCAPED_WHOLE, ['fake', 'aped']),
  sep('Q13', 'py.list2cmdline', 'local', ESCAPED_Q13, ['fake', 'aped']),
  sep('Q14', 'bash.declare_p', 'local', "'" + BACKTICK),
  sep('Q15', 'php.addslashes', 'php', NBSP + ch(0)),
  sep('R1', 'rust.str.escape_default', 'rust', ch(0)),
  sep('S1', 'bash.xtrace', 'local', "'"),
  sep('S2', 'py.shlex_quote', 'local', "''"),
  sep('S3', 'busybox.ash_xtrace', 'busybox', "''"),
  sep('S4', 'bash.printf_q', 'local', '&'),
  sep('S5', 'py.yaml_safe_dump_dict', 'local', "': x"),
  sep('S6', 'py.csv', 'local', '"'),
  sep('X1', 'py.sax_escape', 'local', '"\'<'),
  sep('X2', 'jq.@html', 'local', "'"),
  sep('X3', 'py.html_escape', 'local', "'"),
  sep('X4', 'ruby.CGI.escapeHTML', 'ruby', '"\''),
  sep('X5', 'go.html.EscapeString', 'go', '"'),
  sep('X6', 'php.htmlspecialchars', 'php', "'"),
  sep('X7', 'py.sax_quoteattr', 'local', '\t'),
  sep('U1', 'node.encodeURIComponent', 'local', "'&"),
  sep('U2', 'py.quote_safe_empty', 'local', "'/ ="),
  sep('U3', 'py.quote', 'local', "'/"),
  sep('U4', 'py.quote_plus', 'local', '~ '),
  sep('U5', 'node.URLSearchParams', 'local', '~*'),
  sep('U6', 'php.urlencode', 'php', '~*'),
  sep('U7', 'node.URL.password.href', 'local', '&='),
  sep('U8', 'go.url.UserPassword', 'go', "';"),
  sep('U9', 'node.encodeURI', 'local', '#{'),
  sep('U10', 'go.url.PathEscape', 'go', "':"),
  sep('B1', 'py.b64', 'local', '~'),
  sep('B2', 'node.b64url', 'local', '~'),
  sep('B3', 'py.hex', 'local', '~'),
  sep('B4', 'go.fmt.X_bytes', 'go', '~'),
  sep('G1', 'gh.TrimDoubleQuotes', 'dotnet', '"fake-dq-wrapped-value"', ['fake-dq-', '-value']),
  sep('G2', 'gh.PowerShellPreAmpersandEscape', 'dotnet', '&'),
  sep('G3', 'gh.PowerShellPostAmpersandEscape', 'dotnet', '&'),
  sep('I1', 'msu.UnescapeBackslashes', 'dotnet', ESCAPED_I1, ['fake', 'aped']),
  sep('I2', 'jenkins.Dollar', 'java', '$'),
  sep('I3', 'jenkins.Bash.unquoted', 'java', '\\'),
  sep('I4', 'jenkins.Batch', 'java', '^'),
  sep('E1', 'py.json_of_repr', 'local', '"\\'),
  sep('E2', 'py.json_dumps_twice', 'local', E_ACUTE + DEL),
  sep('LINES', 'py.yaml_safe_dump_dict_unicode', 'local', NEL),
  // D: a value written with `\n` and `\/`, printed after a program reads its escapes (JSON.parse).
  sep('D', 'node.JSON.parse_str', 'local', BS + 'n' + BS + '/'),
];

/**
 * `x_all_mix`: every ASCII punctuation character, the controls and separators Python escapes, and
 * non-ASCII characters, between the anchors (the residue Q1a closes; fake).
 */
const X_ALL_MIX = anchored(
  '"\'\\/<>&=+`$#{@%~*!();:,? ' +
    [0x09, 0x0a, 0x0d, 0x00, 0x1f, 0x7f, 0x85, 0xa0, 0xad, 0xe9, 0x2028, 0x2029, 0xfeff, 0x1f600]
      .map(ch)
      .join(''),
);

/** Single rows: one printer run on one stress value, kept like a separating row (no member). */
export const SINGLE = [
  { case: 'x_all_mix', printer: 'py.ascii', runtime: 'local', value: X_ALL_MIX, anchors: ANCHORS },
];

/** The JWT-like row's text: a 19-byte value inside a JSON object, so base64url's trim falls inside it. */
export const JWT_VALUE = anchored('~~~');
export const JWT_TEXT = `{"k":"${JWT_VALUE}"}`;

/** Every value the captures run on, by id: the cases and the separating values (`sep_<member>`). */
export function captureInputs() {
  const inputs = {};
  for (const c of fixtureCases()) inputs[c.case] = c.value;
  for (const s of SEPARATING) inputs[`sep_${s.member}`] = s.value;
  for (const s of SINGLE) inputs[s.case] = s.value;
  return inputs;
}
