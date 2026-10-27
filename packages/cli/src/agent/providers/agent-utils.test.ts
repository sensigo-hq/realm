// agent-utils.test.ts — Tests for shared agent utility functions.
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import {
  classBError,
  CLASS_B_NO_TEXT_MARKER,
  buildSystemPrompt,
  discloseForAgent,
  sanitizeError,
  serializeToolResult,
  setAdditionalRedactionValues,
  extractJsonObject,
  renderSubmissionProblems,
} from './agent-utils.js';
import { createHash } from 'node:crypto';
import { leakedForms, type LeakedForm } from '../test-support/redaction-oracle.js';
import { compileDisclosure, disclose, validateAgentSubmission } from '@sensigo/realm';

// #729 PR-3: the composer moved into core's law (`disclose`). These cells drive it with the members
// they name, as declared values (every form, its parts too), with no environment swept.
const sanitizeText = (text: string, members: readonly string[]): string =>
  disclose(
    text,
    compileDisclosure(
      members.map((value, i) => ({ value, source: `declared:M${i}` as const })),
      { declared: 'resolved', audience: 'agent', environment: 'not_swept' },
    ).set,
    'all',
  ).text;

// #729 PR-3: the vitest setup pins every inherited environment variable as not secret (so no other
// test's text depends on the machine); this file's cells sweep the environment on purpose.
beforeEach(() => {
  vi.stubEnv('REALM_NOT_SECRET', '');
});

describe('buildSystemPrompt', () => {
  it('returns base prompt when no schema given', () => {
    const result = buildSystemPrompt();
    expect(result).toContain('AI agent executing a step');
    expect(result).toContain('Respond with a JSON object only');
  });

  it('includes schema JSON when schema is provided', () => {
    const schema = { required: ['answer', 'confidence'] };
    const result = buildSystemPrompt(schema);
    expect(result).toContain('AI agent executing a step');
    expect(result).toContain(JSON.stringify(schema));
  });

  it('prepends agent profile instructions before the base prompt', () => {
    const result = buildSystemPrompt(undefined, 'You are a ticket classifier.');
    expect(result).toMatch(/^You are a ticket classifier\./);
    expect(result).toContain('AI agent executing a step');
  });

  it('prepends agent profile and includes schema when both are provided', () => {
    const schema = { required: ['category'] };
    const result = buildSystemPrompt(schema, 'You are a ticket classifier.');
    expect(result).toMatch(/^You are a ticket classifier\./);
    expect(result).toContain('AI agent executing a step');
    expect(result).toContain(JSON.stringify(schema));
  });

  it('structuredToolOffered absent/false → byte-identical to the default (no schema)', () => {
    expect(buildSystemPrompt(undefined, undefined, false)).toBe(buildSystemPrompt());
    expect(buildSystemPrompt(undefined, undefined, undefined)).toBe(buildSystemPrompt());
  });

  it('structuredToolOffered absent/false → byte-identical to the default (with a schema)', () => {
    const schema = { required: ['category'] };
    expect(buildSystemPrompt(schema, 'profile', false)).toBe(buildSystemPrompt(schema, 'profile'));
  });

  it('structuredToolOffered: true mentions the __realm_submit__ tool, not the plain JSON-only line', () => {
    const result = buildSystemPrompt(undefined, undefined, true);
    expect(result).toContain('__realm_submit__');
    expect(result).toContain('AI agent executing a step');
    expect(result).not.toBe(buildSystemPrompt());
  });

  it('structuredToolOffered: true still prepends the agent profile and includes the schema', () => {
    const schema = { required: ['category'] };
    const result = buildSystemPrompt(schema, 'You are a ticket classifier.', true);
    expect(result).toMatch(/^You are a ticket classifier\./);
    expect(result).toContain('__realm_submit__');
    expect(result).toContain(JSON.stringify(schema));
  });
});

describe('manifest-secret redaction (setAdditionalRedactionValues)', () => {
  afterEach(() => {
    setAdditionalRedactionValues([]);
    vi.unstubAllEnvs();
  });

  it('a tool result echoing a manifest-bound secret is masked; empty list is a no-op', () => {
    const secret = 'manifest-secret-value-123';
    expect(serializeToolResult(`token is ${secret}`)).toContain(secret); // not set yet
    setAdditionalRedactionValues(Object.freeze([secret]));
    const out = serializeToolResult({ echoed: `token is ${secret}` });
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain(secret);
    setAdditionalRedactionValues([]);
    expect(serializeToolResult(`token is ${secret}`)).toContain(secret); // no-op again
  });

  it('env redaction is unchanged (env values still masked without any additional values)', () => {
    vi.stubEnv('AGENT_UTILS_TEST_SECRET', 'env-secret-value-987');
    expect(sanitizeError('leak env-secret-value-987 here')).toBe('leak [REDACTED] here');
  });

  it('combined pass is LONGEST-FIRST: a short env value inside a longer manifest value leaves no fragments', () => {
    vi.stubEnv('AGENT_UTILS_SHORT', 'abcdef');
    setAdditionalRedactionValues(['abcdef-with-suffix-xyz']);
    const out = sanitizeError('value=abcdef-with-suffix-xyz end');
    expect(out).toBe('value=[REDACTED] end');
    expect(out).not.toContain('with-suffix');
  });
});

describe('sanitizeError — the redaction boundary (issue #407)', () => {
  afterEach(() => {
    setAdditionalRedactionValues([]);
    vi.unstubAllEnvs();
  });

  // The redaction set is built from EVERY `process.env` value over four characters, regardless of
  // key. Under npm, `npm_package_name` is the product's own name — so realm redacted the word
  // "realm" out of its own error messages. Harmless-looking until issue #401 started PERSISTING
  // those messages in the run record, at which point the mangling became durable evidence.
  //
  // The first fix excluded `npm_package_*` (minus `config_`) BY PREFIX, on the premise that
  // `npm_package_*` is public manifest metadata. That premise is launcher-dependent and FALSE
  // under yarn classic, which flattens the ENTIRE package.json into that namespace — so an
  // author's `npm_package_deploy_apiKey` was excluded from redaction. The boundary is now three
  // bounded rules instead: an exact-key allowlist, a public-value-shape filter, and an
  // under-HOME value rule.

  it('the product name survives — npm_package_name is public manifest metadata', () => {
    vi.stubEnv('npm_package_name', 'realm');
    expect(sanitizeError(new Error('realm agent requires the openai package'))).toBe(
      'realm agent requires the openai package',
    );
  });

  it('a version string survives too', () => {
    // Now true for TWO independent reasons: the exact key is excluded, AND the value matches the
    // public-value shape. Either alone would carry this cell.
    vi.stubEnv('npm_package_version', '0.39.0');
    expect(sanitizeError(new Error('upgrade to 0.39.0 first'))).toContain('0.39.0');
  });

  it('the lifecycle EVENT survives — the third exact key', () => {
    vi.stubEnv('npm_lifecycle_event', 'build');
    expect(sanitizeError(new Error('the build step failed'))).toContain('the build step failed');
  });

  it('CONTROL — an ordinary env value over four characters still redacts', () => {
    vi.stubEnv('AGENT_UTILS_TEST_SECRET', 'env-secret-value-987');
    const out = sanitizeError(new Error('leaked env-secret-value-987 here'));
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('env-secret-value-987');
  });

  it('CONTROL — a manifest secret still redacts', () => {
    setAdditionalRedactionValues(Object.freeze(['manifest-secret-value-123']));
    const out = sanitizeError(new Error('token is manifest-secret-value-123'));
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('manifest-secret-value-123');
  });

  it('CONTROL — npm_package_config_* STAYS redacted: it is user-authored, not metadata', () => {
    // The boundary the exclusion must not cross. A package.json `config` block holds values the
    // author put there, and npm exports them verbatim into the environment — a probe on this
    // repo's own npm produced `npm_package_config_apitoken=SUPERSECRETVALUE123`.
    // This now holds by ABSENCE from an exact-key set rather than by a lookahead: with three
    // named keys excluded, everything else — including every `config_` field and every yarn1
    // flattened field — is swept by default. Fail-closed by construction rather than by a regex
    // that has to anticipate the shapes.
    vi.stubEnv('npm_package_config_apitoken', 'cfg-secret-value-1');
    const out = sanitizeError(new Error('sent cfg-secret-value-1 upstream'));
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('cfg-secret-value-1');
  });

  // ---------------------------------------------------------------------------------------
  // Rule 1a — the exact-key allowlist, and the channel it closes
  // ---------------------------------------------------------------------------------------

  it('SECURITY — a yarn1-flattened manifest field is redacted', () => {
    // Yarn classic flattens the ENTIRE package.json into `npm_package_*`, so a deploy block's
    // apiKey arrives as `npm_package_deploy_apiKey`. Under the prefix exclusion that key was
    // EXCLUDED from redaction — a secret channel opened by the very fix that stopped the
    // mangling. Three exact keys close it: everything else is swept, whatever the launcher
    // invents.
    vi.stubEnv('npm_package_deploy_apiKey', 'yarn1-nested-secret-1');
    const out = sanitizeError(new Error('posted yarn1-nested-secret-1 to the deploy hook'));
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('yarn1-nested-secret-1');
  });

  it('SECURITY — npm_lifecycle_script returns to the sweep', () => {
    // Author-written script text, which can carry an inline token — and a spawn failure echoes
    // the whole line. Excluded by the prefix form; swept again now. A tightening of 0.40.0.
    vi.stubEnv('npm_lifecycle_script', 'TOKEN=inline-tok-99 node ship.js');
    const out = sanitizeError(new Error('spawn failed: TOKEN=inline-tok-99 node ship.js'));
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('inline-tok-99');
  });

  // ---------------------------------------------------------------------------------------
  // Rule 1b — the public-value shape
  // ---------------------------------------------------------------------------------------

  it('the word "false" survives — launcher booleans mangled every message', () => {
    // pnpm injects `pnpm_config_verify_deps_before_run=false` and yarn1 `YARN_WRAP_OUTPUT=false`,
    // so under either launcher the word "false" was redacted out of every message and every
    // recorded tool result.
    vi.stubEnv('AGENT_UTILS_TEST_BOOL', 'false');
    expect(sanitizeError(new Error('the model received "false" for that field'))).toContain(
      '"false"',
    );
  });

  it('a dotted version survives — npm mangled version strings with its own', () => {
    vi.stubEnv('AGENT_UTILS_TEST_VER', '11.8.0');
    expect(sanitizeError(new Error('needs 11.8.0 or newer'))).toContain('11.8.0');
  });

  it('BOUNDARY — a bare integer stays redacted (a PIN is not a version)', () => {
    // The shape is deliberately narrow: `\d+(\.\d+)*` would have admitted numeric PINs and
    // account ids, which are exactly the kind of value the sweep exists for. #729 PR-3: the
    // environment floor is 8 characters (the owner's Q2), so the PIN here has 8 digits.
    vi.stubEnv('AGENT_UTILS_TEST_PIN', '48392177');
    const out = sanitizeError(new Error('pin 48392177 rejected'));
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('48392177');
  });

  it('#729 PR-3 — FLOOR — an environment value under 8 characters is not swept', () => {
    // (a) red when the floor drops back below 8; (b) prints the text, a fake 6-digit number.
    vi.stubEnv('AGENT_UTILS_TEST_SHORT_PIN', '483921');
    expect(sanitizeError(new Error('pin 483921 rejected'))).toBe('pin 483921 rejected');
  });

  it('BOUNDARY — a dotted quad stays redacted (an IPv4 is not a version)', () => {
    vi.stubEnv('AGENT_UTILS_TEST_IP', '10.20.30.40');
    const out = sanitizeError(new Error('connect 10.20.30.40 refused'));
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('10.20.30.40');
  });

  it('BOUNDARY — a value that merely CONTAINS a shaped prefix still redacts', () => {
    vi.stubEnv('AGENT_UTILS_TEST_MIX', 'false-positive-x');
    const out = sanitizeError(new Error('saw false-positive-x'));
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('false-positive-x');
  });

  // ---------------------------------------------------------------------------------------
  // Rule 1c — the under-HOME value rule
  // ---------------------------------------------------------------------------------------

  it('#729 PR-3 — a value under HOME is hidden whole on the agent audience', () => {
    // RECORD 05 "HOME prefix": values under HOME are exempt only on private and file surfaces; what
    // a model and the run record are given hides them. (a) red when the under-HOME rule exempts
    // them here; (b) prints the text, fake paths only.
    vi.stubEnv('HOME', '/home/testuser');
    vi.stubEnv('INIT_CWD', '/home/testuser/proj');
    const out = sanitizeError(new Error('Require stack: /home/testuser/proj/x.js'));
    expect(out).toBe('Require stack: [REDACTED]/x.js');
  });

  it('SHADOW CLOSURE — a second key carrying the SAME value cannot reopen the leak', () => {
    // The rule is VALUE-level, not key-level. `npm_config_local_prefix` carries the identical
    // string as `INIT_CWD`; under a key-level exclusion this exact case no-oped, because the
    // shadow key was still in the sweep and redacted the prefix anyway.
    vi.stubEnv('HOME', '/home/testuser');
    vi.stubEnv('INIT_CWD', '/home/testuser/proj');
    vi.stubEnv('npm_config_local_prefix', '/home/testuser/proj');
    // #729 PR-3: one key is named not secret; the other, unlisted, holds the same value, so the
    // value stays hidden (whole, on the agent audience). (a) red when a value an exempt name holds
    // is skipped although an unlisted variable holds it too; (b) prints the text (fake path).
    vi.stubEnv('REALM_NOT_SECRET', 'INIT_CWD');
    expect(sanitizeError(new Error('Require stack: /home/testuser/proj/x.js'))).toBe(
      'Require stack: [REDACTED]/x.js',
    );
  });

  it('PRIVACY — a path NOT under HOME is redacted wholesale', () => {
    // The WSL shape: `/mnt/c/Users/<Name>` carries the username in the tail, so the home-prefix
    // strip cannot help. Full redaction is the right answer there, and stays.
    vi.stubEnv('HOME', '/home/testuser');
    // #729 PR-3 correction 1 (D-6): PWD is the shell's metadata, excluded by name; a project
    // directory held in an ordinary variable is the environment value this cell sweeps.
    vi.stubEnv('AGENT_UTILS_PROJECT_DIR', '/mnt/c/Users/Test User/proj');
    const out = sanitizeError(new Error('cwd /mnt/c/Users/Test User/proj missing'));
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('Test User');
  });

  it('BOUNDARY — HOME itself, standalone, stays redacted', () => {
    vi.stubEnv('HOME', '/home/testuser');
    const out = sanitizeError(new Error('base is /home/testuser'));
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('testuser');
  });

  it('SUB-CONJUNCT — a short HOME does not open the rule', () => {
    // `/srv` is four characters, so it is itself outside the sweep — nothing would redact the
    // prefix. Dropping the length guard would ship the full path with no redaction at all.
    vi.stubEnv('HOME', '/srv');
    vi.stubEnv('AGENT_UTILS_TEST_PATH', '/srv/data/secret-x');
    const out = sanitizeError(new Error('read /srv/data/secret-x'));
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('/srv/data/secret-x');
  });

  it('SUB-CONJUNCT — CONTAINING the home prefix is not STARTING with it', () => {
    // An `includes` mutant is strictly looser, and asserting it EXACTLY is what catches it:
    // under `startsWith` the whole value is swept and the line reads `read [REDACTED]`, while
    // under `includes` the value leaves the sweep and only HOME's own redaction lands inside it,
    // leaving `read /opt[REDACTED]/thing`. A `toContain('[REDACTED]')` pair passes BOTH — the
    // looser reading still contains the marker and still loses the whole string. Probed: with
    // the weaker assertions the mutant survived every cell in this file.
    vi.stubEnv('HOME', '/home/testuser');
    vi.stubEnv('AGENT_UTILS_TEST_NESTED', '/opt/home/testuser/thing');
    expect(sanitizeError(new Error('read /opt/home/testuser/thing'))).toBe('read [REDACTED]');
  });

  it('npm_package_json under HOME is hidden whole on the agent audience (#729 PR-3)', () => {
    // Path-valued on every launcher that sets it, so it belongs to the value-level rule rather
    // than the exact-key set — keeping it key-excluded would ship a non-HOME checkout's full
    // path, which is the very privacy trade rule 1c exists to make.
    vi.stubEnv('HOME', '/home/testuser');
    vi.stubEnv('npm_package_json', '/home/testuser/proj/package.json');
    expect(sanitizeError(new Error('read /home/testuser/proj/package.json'))).toBe(
      'read [REDACTED]',
    );
  });

  it('npm_package_json NOT under HOME is redacted wholesale', () => {
    vi.stubEnv('HOME', '/home/testuser');
    vi.stubEnv('npm_package_json', '/mnt/c/Users/Test User/proj/package.json');
    const out = sanitizeError(new Error('read /mnt/c/Users/Test User/proj/package.json'));
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('Test User');
  });

  // ---------------------------------------------------------------------------------------
  // The exemption — both filters apply to the ENV sweep only
  // ---------------------------------------------------------------------------------------

  it('EXEMPTION — a declared secret that LOOKS public still redacts', () => {
    vi.stubEnv('AGENT_UTILS_TEST_SHAPED', '1.2.3');
    setAdditionalRedactionValues(Object.freeze(['1.2.3']));
    const out = sanitizeError(new Error('version 1.2.3 leaked'));
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('1.2.3');
  });

  it('EXEMPTION — a declared secret UNDER HOME redacts whole, no tail', () => {
    // HOME is stubbed deliberately: without it the fixture path is not under the ambient home,
    // and the combined-list mutant this cell exists to catch would survive.
    vi.stubEnv('HOME', '/home/testuser');
    setAdditionalRedactionValues(Object.freeze(['/home/testuser/declared-secret']));
    const out = sanitizeError(new Error('key at /home/testuser/declared-secret'));
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('declared-secret');
  });
});

describe('extractJsonObject (mandate test 3 — the P1 robust extractor)', () => {
  it('plain JSON object (no fences/preamble) — same as the naive-parse fast path', () => {
    expect(extractJsonObject('{"result":"ok"}')).toEqual({ result: 'ok' });
  });

  it('braces inside a string value do not terminate the object early', () => {
    expect(extractJsonObject('{"a":"}"}')).toEqual({ a: '}' });
  });

  it('an escaped quote inside a string value does not terminate the string early', () => {
    // Runtime text: {"a":"\""}  — a value that is a single literal double-quote character.
    expect(extractJsonObject('{"a":"\\""}')).toEqual({ a: '"' });
  });

  it('an escaped backslash inside a string value is not mistaken for an escaped quote', () => {
    // Runtime text: {"a":"\\"}  — a value that is a single literal backslash character.
    expect(extractJsonObject('{"a":"\\\\"}')).toEqual({ a: '\\' });
  });

  it('strips a ```json fenced code block and parses its content', () => {
    const text = '```json\n{"result":"ok"}\n```';
    expect(extractJsonObject(text)).toEqual({ result: 'ok' });
  });

  it('strips a fenced code block with no language tag', () => {
    const text = '```\n{"result":"ok"}\n```';
    expect(extractJsonObject(text)).toEqual({ result: 'ok' });
  });

  it('finds the object past a preamble (no fences)', () => {
    expect(extractJsonObject('Sure, the result is: {"a":1}')).toEqual({ a: 1 });
  });

  it('finds the object before a postamble', () => {
    expect(extractJsonObject('{"a":1} — that is my final answer.')).toEqual({ a: 1 });
  });

  it('a top-level array is rejected (object-only)', () => {
    expect(extractJsonObject('[1,2,3]')).toBeNull();
  });

  it('prose with no braces at all returns null', () => {
    expect(extractJsonObject('I was unable to determine a final answer.')).toBeNull();
  });

  it('preamble-example-then-answer: prefers the LAST candidate, not the illustrative example', () => {
    const text = 'For example {"a":1}. Answer: {"b":2}';
    expect(extractJsonObject(text)).toEqual({ b: 2 });
  });

  it('preamble-example-then-answer inside a fenced block: still prefers the last candidate', () => {
    const text = '```json\nFor example {"a":1}. Answer: {"b":2}\n```';
    expect(extractJsonObject(text)).toEqual({ b: 2 });
  });

  it('falls back to the raw text when a fenced block contains no usable object', () => {
    const text = '```\nno object in here\n```\nBut the answer is {"c":3}';
    expect(extractJsonObject(text)).toEqual({ c: 3 });
  });
});

// =========================================================================
// issue #345 — classBError: the helper both providers mint through
//
// One helper rather than two hand-rolled copies, because two copies is how one of them drifts.
// These cells drive it directly; the provider files carry the end-to-end mint cells.
// =========================================================================
describe('classBError (issue #345)', () => {
  it('joins multiple text blocks with a newline', () => {
    // The separator is specified, not incidental: two providers mint through this, and a
    // different join would make the same failure read differently depending on which one ran.
    expect(
      classBError({
        content: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ],
        isError: true,
      }),
    ).toBe('first\nsecond');
  });

  it('skips non-text blocks rather than stringifying them into the error', () => {
    expect(
      classBError({
        content: [
          { type: 'text', text: 'kept' },
          { type: 'image', data: 'x', mimeType: 'image/png' },
        ],
        isError: true,
      }),
    ).toBe('kept');
  });

  it('returns undefined for everything that is not a Class-B result', () => {
    expect(classBError({ content: [{ type: 'text', text: 'ok' }] })).toBeUndefined();
    expect(classBError({ isError: false, content: [] })).toBeUndefined();
    expect(classBError('a bare string result')).toBeUndefined();
    expect(classBError(null)).toBeUndefined();
    expect(classBError(undefined)).toBeUndefined();
    expect(classBError(42)).toBeUndefined();
  });

  it('tolerates a missing or non-array content field', () => {
    expect(classBError({ isError: true })).toBe(CLASS_B_NO_TEXT_MARKER);
    expect(classBError({ isError: true, content: 'not an array' })).toBe(CLASS_B_NO_TEXT_MARKER);
  });

  it('the marker fires on whitespace-only joined text, not just on the empty string', () => {
    // The case that caught a real defect in the first implementation: TWO empty blocks join to
    // '\n', which is length 1 — so a `length === 0` check passed it through and produced an
    // `error` that is truthy and visually nothing. Same invisible failure, different hat.
    expect(classBError({ content: [{ type: 'text', text: '' }], isError: true })).toBe(
      CLASS_B_NO_TEXT_MARKER,
    );
    expect(
      classBError({
        content: [
          { type: 'text', text: '' },
          { type: 'text', text: '' },
        ],
        isError: true,
      }),
    ).toBe(CLASS_B_NO_TEXT_MARKER);
    expect(classBError({ content: [{ type: 'text', text: '   ' }], isError: true })).toBe(
      CLASS_B_NO_TEXT_MARKER,
    );
  });

  it('does NOT trim a real error — only the emptiness question is trimmed', () => {
    expect(
      classBError({ content: [{ type: 'text', text: '  real failure  ' }], isError: true }),
    ).toBe('  real failure  ');
  });
});

// =================================================================================================
// hide before encoding (GHSA-gxfq): every listed form of a declared or environment value is hidden
// from a tool result before it is encoded, and from the result's encoded text after.
//
// Every value here is a FAKE written in this file. The oracle (`leakedForms`) never reads the
// production forms: it decodes the output (JSON at every level, URL, base64) and searches for the
// raw secret and the lines listed by hand. A failure prints only the oracle's `{ path, decoders }`
// pairs, booleans or counts — never a secret, never the redaction set, never an environment.
//
// Each cell names (a) its break — the one change that turns it red — and (b) what it prints.
// =================================================================================================
/**
 * Stubs every environment key except HOME to `undefined` (restored by `vi.unstubAllEnvs()`), so a
 * host's environment cannot change a cell's redaction set, and a failure cannot show which of a
 * cell's fixed words the host holds.
 */
function isolateEnv(): void {
  for (const key of Object.keys(process.env)) if (key !== 'HOME') vi.stubEnv(key, undefined);
}

describe('hide before encoding (GHSA-gxfq)', () => {
  /** The standard fake secret: a `"`, a `\`, a newline; every line shorter than 8 characters. */
  const STD = 'fk"1\\2\n3z';
  /** Body lines that begin with no DER header, so no secret scanner reads them as a key. */
  const PEM_BODY = [
    'FAKEbodyLineOne0123456789abcdefFAKEbodyLineOne0123456789abcd',
    'Zm9vYmFyYmF6cXV4ZmFrZWZha2VmYWtlZmFrZWZha2VmYWtlZmFrZWZha2VmYWtl',
  ];
  /** A fake PEM-shaped secret: multi-line, no `"` or `\`, a FAKE armour. */
  const PEM = ['-----BEGIN FAKE KEY-----', ...PEM_BODY, '-----END FAKE KEY-----'].join('\n');

  afterEach(() => {
    setAdditionalRedactionValues([]);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /** Declares the fake secrets, as `runAgent` does with the manifest's values. */
  const declare = (...values: string[]): void => setAdditionalRedactionValues(values);

  /** The oracle's findings over each output, labelled by case — what a failing cell prints. */
  const findings = (
    cases: Array<[label: string, output: string]>,
    secret: string,
    lines: readonly string[] = [],
  ): Array<{ case: string; found: LeakedForm[] }> =>
    cases
      .map(([label, output]) => ({ case: label, found: leakedForms(output, secret, lines) }))
      .filter((f) => f.found.length > 0);

  it('1. a PEM-shaped secret inside an object result is hidden', () => {
    declare(PEM);
    const out = serializeToolResult({ content: [{ type: 'text', text: 'x' }], data: PEM });
    // (a) red when the walk is skipped (stringify, then the last pass only): the PEM is escaped in
    //     the JSON text, so the plain value never matches. (b) prints the oracle's findings.
    expect(findings([['object', out]], PEM, PEM_BODY)).toEqual([]);
  });

  it('1b. one PEM body line alone, and the PEM with CRLF line endings, are hidden', () => {
    declare(PEM);
    const out = serializeToolResult([
      { t: `unrelated ${PEM_BODY[0]!} tail` },
      { t: PEM.replace(/\n/g, '\r\n') },
    ]);
    // (a) red when LINES is removed: a body line on its own matches no other form.
    //     (b) prints the oracle's findings.
    expect(findings([['lines', out]], PEM, PEM_BODY)).toEqual([]);
  });

  it('2. the standard secret in a top-level field is hidden', () => {
    declare(STD);
    // (a) red when the walk is skipped. (b) prints the oracle's findings.
    expect(findings([['field', serializeToolResult({ a: STD })]], STD)).toEqual([]);
  });

  it('3. the standard secret nested in an array is hidden', () => {
    declare(STD);
    // (a) red when arrays are left unmapped. (b) prints the oracle's findings.
    expect(findings([['array', serializeToolResult({ a: [1, [STD]] })]], STD)).toEqual([]);
  });

  it('4. the standard secret as an object key is hidden', () => {
    declare(STD);
    // (a) red when keys are left unredacted. (b) prints the oracle's findings.
    expect(findings([['key', serializeToolResult({ [STD]: 1 })]], STD)).toEqual([]);
  });

  it('5. a "__proto__" key keeps its place and its subtree, with the secret hidden inside', () => {
    declare(STD);
    const result = JSON.parse(`{"__proto__":{"k":${JSON.stringify(STD)}}}`) as unknown;
    const parsed = JSON.parse(serializeToolResult(result)) as Record<string, unknown>;
    const own = Object.hasOwn(parsed, '__proto__');
    const k = own ? (parsed['__proto__'] as Record<string, unknown>)['k'] : undefined;
    // (a) red when the walk copies by assignment (it drops the key and its subtree), and today,
    //     when the escaped secret stays in the subtree. (b) prints whether the key is own and
    //     whether `k` is the marker.
    expect({ own, kIsMarker: k === '[REDACTED]' }).toEqual({ own: true, kIsMarker: true });
  });

  it('6a. JSON text holding the secret (one level), as a leaf and as a string result, is hidden', () => {
    declare(STD);
    const text = JSON.stringify({ k: STD });
    // (a) preservation guard since the correction; each member's own discrimination is its P2 row:
    //     E1, J3, J4a, J5–J9, J11, Q6, Q7, Q7b, Q8, Q8L, Q9, Q9b, Q10, Q11, R1. (b) prints the
    //     oracle's findings per case.
    expect(
      findings(
        [
          ['leaf', serializeToolResult({ text })],
          ['string result', serializeToolResult(text)],
        ],
        STD,
      ),
    ).toEqual([]);
  });

  it('6b. JSON text holding JSON text holding the secret (two levels) is hidden', () => {
    declare(STD);
    const text = JSON.stringify({ t: JSON.stringify({ k: STD }) });
    // (a) preservation guard since the correction; each member's own discrimination is its P2 row:
    //     E2, and E1 over each of 6a's members. Red when E1 and E2 are removed together. (b) prints
    //     the oracle's findings.
    expect(
      findings(
        [
          ['leaf', serializeToolResult({ text })],
          ['string result', serializeToolResult(text)],
        ],
        STD,
      ),
    ).toEqual([]);
  });

  it("7. Go's HTML-safe JSON of the secret is hidden", () => {
    const secret = `${STD}&<>\u2028`;
    declare(secret);
    // What Go's encoding/json Marshal writes for {"k": secret}, by hand, lowercase hex.
    const goText = '{"k":"fk\\"1\\\\2\\n3z\\u0026\\u003c\\u003e\\u2028"}';
    // Witness: the hand-written text decodes to the secret. (b) prints a boolean.
    expect((JSON.parse(goText) as { k: string }).k === secret).toBe(true);
    // (a) preservation guard since the correction; each member's own discrimination is its P2 row:
    //     J3, J9. (b) prints the oracle's findings per case.
    expect(
      findings(
        [
          ['text result', serializeToolResult(goText)],
          ['object leaf', serializeToolResult({ text: goText })],
        ],
        secret,
      ),
    ).toEqual([]);
  });

  it("8. PHP's escaped slash, alone and with non-ASCII, is hidden", () => {
    // Captured: python3 -c 'import json,sys; print(json.dumps(sys.argv[1]).replace("/", "\\/"))' "$(printf 'fk"1\\2\n3z/')"
    const PHP_A = '"fk\\"1\\\\2\\n3z\\/"';
    // Captured: python3 -c 'import json,sys; print(json.dumps(sys.argv[1]).replace("/", "\\/"))' "$(printf 'fk"1\\2\n3z/\xc3\xa9')"
    const PHP_B = '"fk\\"1\\\\2\\n3z\\/\\u00e9"';
    const cases: Array<[string, string, string]> = [
      ['8a', `${STD}/`, PHP_A],
      ['8b', `${STD}/\u00e9`, PHP_B],
    ];
    const found: Array<{ case: string; found: LeakedForm[] }> = [];
    for (const [label, secret, literal] of cases) {
      declare(secret);
      // Witness: the captured literal decodes to the secret. (b) prints which case is wrong.
      expect(JSON.parse(literal) === secret, `${label}: the literal decodes to its secret`).toBe(
        true,
      );
      const text = `{"k":${literal}}`;
      found.push(
        ...findings(
          [
            [`${label} text result`, serializeToolResult(text)],
            [`${label} object leaf`, serializeToolResult({ text })],
          ],
          secret,
        ),
      );
    }
    // (a) red when J4a and J5 are removed together (J5 alone turns 8b red). (b) prints the
    //     oracle's findings per case.
    expect(found).toEqual([]);
  });

  it("9. Python's ASCII-only JSON (lowercase hex, surrogate pairs) is hidden", () => {
    const secret = `${STD}\u00e9\u{1f600}`;
    declare(secret);
    // Captured: python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$(printf 'fk"1\\2\n3z\xc3\xa9\xf0\x9f\x98\x80')"
    const PY = '"fk\\"1\\\\2\\n3z\\u00e9\\ud83d\\ude00"';
    // Witness: the captured literal decodes to the secret. (b) prints a boolean.
    expect(JSON.parse(PY) === secret).toBe(true);
    const text = `{"k":${PY}}`;
    // (a) preservation guard since the correction; each member's own discrimination is its P2 row:
    //     E1, J5, J6. (b) prints the oracle's findings per case.
    expect(
      findings(
        [
          ['text result', serializeToolResult(text)],
          ['object leaf', serializeToolResult({ text })],
        ],
        secret,
      ),
    ).toEqual([]);
  });

  it('10. base64 of a 10- and an 11-byte secret is hidden alone and after 1, 2 and 3 bytes', () => {
    const secrets: Array<[string, string]> = [
      ['10-byte', 'Ab1"x\\9Qz#'],
      ['11-byte', 'Ab1"x\\9Qz#k'],
    ];
    const found: Array<{ case: string; found: LeakedForm[] }> = [];
    for (const [name, secret] of secrets) {
      declare(secret);
      const encodings: Array<[string, string]> = [
        [`${name} alone`, Buffer.from(secret).toString('base64')],
        ...['a', 'ab', 'abc'].map((prefix): [string, string] => [
          `${name} after ${prefix.length} byte(s)`,
          Buffer.from(`${prefix}${secret}}`).toString('base64'),
        ]),
      ];
      found.push(
        ...findings(
          encodings.map(([label, encoded]): [string, string] => [
            label,
            serializeToolResult({ text: `payload ${encoded} end` }),
          ]),
          secret,
        ),
      );
    }
    // (a) red when: B1 and B2 are removed together → every case; the shift-1 forms (trimmed and
    //     untrimmed) are dropped from B1 and B2 → the 2-byte-prefix cases; the shift-2 forms →
    //     the 1-byte-prefix cases; the trim is dropped from B1 and B2 → the 10-byte secret after 1
    //     and 3 bytes and the 11-byte one after 2 and 3 bytes. The `}` after each secret keeps the
    //     trim's cases able to fail: after `\n` the padding-free form already matches. (b) prints
    //     the cases found.
    expect(found).toEqual([]);
  });

  it('11. the URL-encoded secret in a query string is hidden', () => {
    declare(STD);
    const url = `https://x.test/?q=${encodeURIComponent(STD)}`;
    // (a) preservation guard since the correction; each member's own discrimination is its P2 row:
    //     U1–U10. (b) prints the oracle's findings per case.
    expect(
      findings(
        [
          ['text result', serializeToolResult(url)],
          ['text block', serializeToolResult({ content: [{ type: 'text', text: url }] })],
        ],
        STD,
      ),
    ).toEqual([]);
  });

  it('12. (regression guard) a Bearer token and a token= value inside an object result are hidden', () => {
    declare();
    const out = serializeToolResult({
      content: [
        { type: 'text', text: 'Authorization: Bearer fakeTok.abc-123 and ?token=fakeQ1 end' },
      ],
    });
    // (a) red when the walk's name and token rules AND the last pass over the encoded output are
    //     both removed from the object branch: either one alone hides both tokens. (b) prints
    //     which of the four facts fails. #729 PR-3 (RECORD 05 "the name rule"): `Authorization`
    //     hides its scheme word and the credential together.
    expect({
      bearerMarked: out.includes('Authorization: [REDACTED] and'),
      tokenMarked: out.includes('token=[REDACTED]'),
      bearerGone: !out.includes('fakeTok.abc-123'),
      tokenGone: !out.includes('fakeQ1'),
    }).toEqual({ bearerMarked: true, tokenMarked: true, bearerGone: true, tokenGone: true });
  });

  it('13. a declared secret returned as a number becomes the string marker, and the output parses', () => {
    declare('48213977');
    const out = serializeToolResult({ pin: 48213977 });
    let parses = true;
    let pin: unknown;
    try {
      pin = (JSON.parse(out) as { pin?: unknown }).pin;
    } catch {
      parses = false;
    }
    // (a) red when the scalar rule is deleted (the last pass still hides the PIN, but the output
    //     no longer parses), and today. (b) prints whether it parses and whether `pin` is the marker.
    expect({ parses, pinIsMarker: pin === '[REDACTED]' }).toEqual({
      parses: true,
      pinIsMarker: true,
    });
  });

  it('14. (regression guard) an undefined result reads "undefined", as before', () => {
    // (a) red when the `undefined` guard is removed (`JSON.parse` throws). (b) prints the output
    //     or the error.
    expect(serializeToolResult(undefined)).toBe('undefined');
  });

  it('20. (preservation) a result with no secrets is byte-identical to its JSON', () => {
    isolateEnv();
    declare(STD);
    const result = { a: 'hello', n: [1, 2.5, true, null], o: { 'k-y': 'v/w&x' } };
    // (a) red when anything but a listed form is changed. (b) prints the output.
    expect(serializeToolResult(result)).toBe(JSON.stringify(result));
  });

  it('21. (preservation) a kubeconfig-shaped secret leaves config lines and a PEM armour line alone', () => {
    isolateEnv();
    declare(
      'apiVersion: v1\nkind: Config\nusers:\n- name: default\n  user:\n    token: fakeKubeTokenABCDEFGH\n    insecure: false,',
    );
    const other = {
      t: 'apiVersion: v1 name: default false, -----BEGIN FAKE KEY----- users:',
    };
    // #729 PR-3 correction 1 (D-5): what follows a BEGIN armour line with no END, to the end of its
    // string, is a PEM body and hidden; the armour line itself, the config lines and the JSON stay.
    // (a) red when a line shorter than 8 characters, or one holding a space, is hidden on its own,
    //     or the PEM body runs past its string's closing quote; (b) prints the output.
    expect(serializeToolResult(other)).toBe(
      JSON.stringify({
        t: 'apiVersion: v1 name: default false, -----BEGIN FAKE KEY----- [REDACTED]',
      }),
    );
  });

  it('22. (preservation) a 4-character secret leaves 200 SHA-1 strings and 200 UUIDs byte-identical', () => {
    declare('pass');
    const shas = Array.from({ length: 200 }, (_, i) =>
      createHash('sha1').update(String(i)).digest('hex'),
    );
    const uuids = shas.map(
      (h) =>
        `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`,
    );
    const out = JSON.parse(serializeToolResult({ shas, uuids })) as {
      shas: string[];
      uuids: string[];
    };
    const changed =
      out.shas.filter((s, i) => s !== shas[i]).length +
      out.uuids.filter((u, i) => u !== uuids[i]).length;
    // (a) red when the 8-character floor on base64 forms is removed. (b) prints the count changed.
    expect(changed).toBe(0);
  });

  it('23. (preservation) true, false and version-shaped environment values are not redacted', () => {
    isolateEnv();
    declare();
    vi.stubEnv('AGENT_UTILS_GHSA_FALSE', 'false');
    vi.stubEnv('AGENT_UTILS_GHSA_TRUE', 'true');
    vi.stubEnv('AGENT_UTILS_GHSA_VERSION', '11.8.0');
    const result = { text: 'received false, true and 11.8.0', ok: false, done: true };
    // (a) red when public-shaped environment values enter the set. (b) prints the output.
    expect(serializeToolResult(result)).toBe(JSON.stringify(result));
  });
});

describe('the release correction (GHSA-gxfq): one cell per fix', () => {
  const BS = '\\';
  beforeEach(() => isolateEnv());
  afterEach(() => {
    setAdditionalRedactionValues([]);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('A1. a 1,000-row tool result with 80 environment values is hidden within 12× the time it takes with none', () => {
    // A budget cell (#729 PR-3 correction 2, C7): it measures `serializeToolResult`, which hides
    // values through core's `disclose`, on a 1,000-row result — once with no environment values (the
    // baseline, measured in this same process) and once with 80 (1,678 forms) — and bounds the
    // ratio, never a number of milliseconds, so a loaded machine slows both alike. Measured here: the
    // ratio is about 6× (39 ms and 245 ms); the CLI's earlier pass, which split and joined every form
    // whatever the text held, took about 35× its fast form's time on this input.
    const fake = (i: number): string =>
      i % 4 === 0
        ? `/opt/fake/proj${i}/sub dir/file.txt`
        : i % 4 === 1
          ? 'fK' + 'q7Zp2LmN9xR4vT1nB8cL3wE6yH0pS5dG2aJ9uK4'.slice(i % 7) + i
          : i % 4 === 2
            ? `https://fake.example/api?k=${i}&t=fake token`
            : `fakeword${i}`;
    const result = {
      rows: Array.from({ length: 1000 }, (_, i) => ({
        id: i,
        name: `item-${i}`,
        path: `/srv/data/item-${i}.json`,
        note: `ordinary text ${i}`,
        tag: 'plain',
      })),
    };
    const median = (): number => {
      serializeToolResult(result);
      const times: number[] = [];
      for (let run = 0; run < 3; run++) {
        const t0 = performance.now();
        serializeToolResult(result);
        times.push(performance.now() - t0);
      }
      return times.sort((a, b) => a - b)[1]!;
    };
    const baseline = median();
    for (let i = 0; i < 80; i++) vi.stubEnv(`GHSA_A1_FAKE_${i}`, fake(i));
    const loaded = median();
    // (a) red when hiding costs more than 12× the baseline (every form split and joined whatever the
    //     text holds); (b) prints whether the ratio is under the bound.
    expect({ under12x: loaded < 12 * Math.max(baseline, 1) }).toEqual({ under12x: true });
  });

  it('A2. a value holding token= and a Bearer token carrying a value are hidden whole', () => {
    // Fakes built from parts, so no secret scanner reads a connection string or a token here.
    const DSN =
      ['postgres', '://', 'fakeuser:FAKEpass9xyz', '@db.fake.example/app'].join('') +
      '?token=abc123&sslmode=require';
    const CLIENT = 'fakeclient0042';
    const seg = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
    const JWT = [
      seg('{"alg":"none"}'),
      seg(`{"client_id":"${CLIENT}","iat":1}`),
      'FAKEsig' + 'TAILzz9',
    ].join('.');
    const AUTH = 'Authorization: ' + 'Bearer ' + JWT;
    // The same token under no credential name: only the `Bearer` rule hides it (under
    // `Authorization:` the name rule hides it too).
    const BARE = 'sent ' + 'Bearer ' + JWT;
    const text = `connect failed: ${DSN}; ${AUTH}; ${BARE} end`;
    const whole = (out: string) => ({
      dsnGone:
        !out.includes('FAKEpass9xyz') && !out.includes('sslmode') && !out.includes('fakeuser'),
      tokenGone: !out.includes('TAILzz9') && !out.includes(JWT.split('.')[1]!.slice(-8)),
    });
    const surfaces = () => ({
      error: whole(sanitizeError(new Error(text))),
      stringResult: whole(serializeToolResult(text)),
      // The prompt is hidden by this call, once (run-agent.ts, `promptForAttempt`).
      prompt: whole(discloseForAgent(text)),
      objectResult: whole(serializeToolResult({ dsn: DSN, auth: AUTH, bare: BARE })),
    });
    vi.stubEnv('GHSA_A2_DSN', DSN);
    vi.stubEnv('GHSA_A2_CLIENT', CLIENT);
    const envOnly = surfaces();
    vi.unstubAllEnvs();
    isolateEnv();
    setAdditionalRedactionValues([DSN, CLIENT]);
    const declared = surfaces();
    const all = { dsnGone: true, tokenGone: true };
    const each = { error: all, stringResult: all, prompt: all, objectResult: all };
    // (a) red when the `Bearer`/`token=` patterns run before the forms (the DSN's password and the
    //     rest after `token=` shown), or when the patterns stop at a marker (the token's tail after
    //     the form of `CLIENT` shown). (b) prints, per source and surface, the two facts.
    expect({ envOnly, declared }).toEqual({ envOnly: each, declared: each });
  });

  it('A3. base64 of a value after a prefix of 1 or 2 bytes (mod 3) leaves no character of the value alone', () => {
    const V = 'FAKEpw12xyz9';
    setAdditionalRedactionValues([V]);
    /** How many characters left in `out` carry bits of the value's bytes alone. */
    const valueOnlyLeft = (prefix: string, suffix: string, url: boolean): number => {
      const bytes = Buffer.from(prefix + V + suffix, 'utf8');
      const encoded = bytes.toString(url ? 'base64url' : 'base64');
      const out = sanitizeError(new Error(encoded));
      if (!out.includes('[REDACTED]')) return -1;
      const head = out.slice(0, out.indexOf('[REDACTED]'));
      const tail = out.slice(out.lastIndexOf('[REDACTED]') + '[REDACTED]'.length);
      const start = Buffer.byteLength(prefix);
      const end = start + Buffer.byteLength(V);
      const valueOnly = (i: number): boolean => {
        const lo = Math.floor((6 * i) / 8);
        const hi = Math.floor((6 * i + 5) / 8);
        return lo >= start && hi < end;
      };
      let left = 0;
      for (let i = 0; i < head.length; i++) if (valueOnly(i)) left++;
      for (let j = 0; j < tail.length; j++) if (valueOnly(encoded.length - tail.length + j)) left++;
      return left;
    };
    const cells: Record<string, number> = {};
    for (const prefix of ['u', 'user', 'us']) {
      for (const suffix of ['', '}', '@host']) {
        for (const url of [false, true]) {
          cells[`${prefix}|${suffix}|${url ? 'url' : 'b64'}`] = valueOnlyLeft(prefix, suffix, url);
        }
      }
    }
    // (a) red when Jenkins' `a` form is removed (the 1-mod-3 prefixes `u`, `user` leave a character),
    //     or the `aa` form (the 2-mod-3 prefix `us`). (b) prints, per prefix, suffix and alphabet,
    //     how many characters of the value alone are left (-1: no marker at all).
    expect(cells).toEqual(Object.fromEntries(Object.keys(cells).map((k) => [k, 0])));
  });

  it('A4. base64url of a 4- and a 5-byte declared value encoded alone is hidden', () => {
    setAdditionalRedactionValues(['q7z2', 'q7z2x']);
    const out = serializeToolResult({ a: 'cTd6Mg', b: 'cTd6Mng' });
    // (a) red when the floor is applied after the padding is stripped (the base64url form of the
    //     value alone is 6 or 7 characters). (b) prints the output (fixed fake text).
    expect(out).toBe(JSON.stringify({ a: '[REDACTED]', b: '[REDACTED]' }));
  });

  it('A5. a line holding a NEL keeps its whole text: the union of both splits', () => {
    const NEL = String.fromCharCode(0x85);
    setAdditionalRedactionValues(['AAAAAAAA' + NEL + 'BBB' + '\n' + 'CCCCCCCC']);
    const out = sanitizeError(new Error(`line: AAAAAAAA${NEL}BBB end`));
    // (a) red when the split at CR LF, CR and LF alone is dropped (the line is cut at the NEL, and
    //     `BBB` is left). (b) prints the output (fixed fake text).
    expect(out).toBe('line: [REDACTED] end');
  });

  it('A7. a key written on one line with \\n is hidden after a program reads it, whole and per line', () => {
    const BODY = ['FAKEbodyLineOne0123456789abcdef', 'FAKEbodyLineTwo0123456789abcdef'];
    const ONE_LINE = ['-----BEGIN FAKE KEY-----', ...BODY, '-----END FAKE KEY-----'].join(BS + 'n');
    const READ = ONE_LINE.split(BS + 'n').join('\n');
    // PHP's `json_encode` writes each `/` as `\/`; the program reads it back as `/`.
    const SLASHED = ONE_LINE.replace('Two', 'T' + BS + '/wo');
    const SLASHED_READ = READ.replace('Two', 'T/wo');
    // An escape JSON does not have (`\d`) is kept as written beside the `\n` that is read.
    const UNKNOWN = ONE_LINE.replace('One', 'O' + BS + 'dne');
    const UNKNOWN_READ = READ.replace('One', 'O' + BS + 'dne');
    // Each key is an ENVIRONMENT value (no parts): D is then the only reader of its escapes (with
    // parts, I3 dropping each backslash would also read `\\/` as `/`).
    const hidden = (key: string, printed: string): boolean => {
      vi.unstubAllEnvs();
      isolateEnv();
      vi.stubEnv('GHSA_A7_KEY', key);
      const out = sanitizeError(new Error(`key: ${printed}`));
      // Each body line ends with this run, whichever spelling of the line was printed.
      return !out.includes('0123456789abcdef') && out.includes('[REDACTED]');
    };
    const facts = {
      wholeHidden: hidden(ONE_LINE, READ),
      lineHidden: hidden(ONE_LINE, `x ${BODY[1]!} y`),
      slashHidden: hidden(SLASHED, SLASHED_READ),
      unknownKeptHidden: hidden(UNKNOWN, UNKNOWN_READ),
    };
    // Two escaped spaces in an environment value read as two spaces: under the floor, no form.
    vi.unstubAllEnvs();
    isolateEnv();
    vi.stubEnv('GHSA_A7_SPACES', BS + 'u' + '0020' + BS + 'u' + '0020');
    const spaces = serializeToolResult({ t: 'a  b %20%20 ++' });
    // (a) red when the D layer is removed (all four), when `\/` is not read (`slashHidden`), when an
    //     unknown escape gives no reading (`unknownKeptHidden`), or when the 8-character floor is
    //     removed (`spacesKept`). (b) prints the facts.
    expect({ ...facts, spacesKept: spaces === JSON.stringify({ t: 'a  b %20%20 ++' }) }).toEqual({
      wholeHidden: true,
      lineHidden: true,
      slashHidden: true,
      unknownKeptHidden: true,
      spacesKept: true,
    });
  });
});

describe("the release build's correction (GHSA-gxfq): read the token rules off the original text", () => {
  const BS = '\\';
  beforeEach(() => isolateEnv());
  afterEach(() => {
    setAdditionalRedactionValues([]);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /**
   * The anchor-word cases: a value that IS the anchor word (or covers it and the token's head), and
   * a text where a fake token follows that anchor. `tail` is what must never show.
   */
  const ANCHOR_CASES: Array<[name: string, value: string, text: string, tail: string[]]> = [
    [
      'Bearer',
      'Bearer',
      'Authorization: ' + 'Bearer ' + 'FAKEtokAbc123xyz.FAKEpayload9QZ.FAKEsigTAIL77',
      ['FAKEpayload9QZ', 'TAIL77'],
    ],
    ['token', 'token', 'GET /x?' + 'token=' + 'FAKEq9tokVAL&x=1', ['FAKEq9tokVAL']],
    [
      'refresh_token',
      'refresh_token',
      'grant_type=refresh_token&' + 'refresh_token=' + 'FAKErtVAL9abc',
      ['FAKErtVAL9abc'],
    ],
    [
      'Bearer FAKEtok',
      'Bearer ' + 'FAKEtok',
      'auth: ' + 'Bearer ' + 'FAKEtokAbc123xyzTAIL77',
      ['Abc123xyzTAIL77'],
    ],
  ];
  /** Runs `check` once with the value only in the environment and once declared only. */
  const bothSources = <T>(value: string, check: () => T): { env: T; declared: T } => {
    vi.unstubAllEnvs();
    isolateEnv();
    setAdditionalRedactionValues([]);
    vi.stubEnv('GHSA_IR2_ANCHOR', value);
    const env = check();
    vi.unstubAllEnvs();
    isolateEnv();
    setAdditionalRedactionValues([value]);
    const declared = check();
    return { env, declared };
  };
  const shows = (out: string, tail: string[]): boolean => tail.some((t) => out.includes(t));

  it('A1. a value equal to the anchor word leaves no token shown on the error, string, prompt and Class-B surfaces', () => {
    const cases = ANCHOR_CASES.map(([name, value, text, tail]) => ({
      name,
      ...bothSources(value, () => ({
        error: shows(sanitizeError(new Error(text)), tail),
        stringResult: shows(serializeToolResult(text), tail),
        prompt: shows(discloseForAgent(text), tail),
        classB: shows(classBError({ isError: true, content: [{ type: 'text', text }] })!, tail),
      })),
    }));
    const none = { error: false, stringResult: false, prompt: false, classB: false };
    // (a) red when the `Bearer` / `token=` rules read the text AFTER the forms replaced it (the
    //     anchor word is gone, so the token after it is shown); (b) prints, per value, source and
    //     surface, whether the token shows.
    expect(cases).toEqual(ANCHOR_CASES.map(([name]) => ({ name, env: none, declared: none })));
  });

  it('A1. a value equal to the anchor word leaves no token shown in an object result, as a value or as a key', () => {
    const cases = ANCHOR_CASES.map(([name, value, text, tail]) => ({
      name,
      ...bothSources(value, () => ({
        objectValue: shows(serializeToolResult({ content: [{ type: 'text', text }] }), tail),
        objectKey: shows(serializeToolResult({ [text]: 1 }), tail),
      })),
    }));
    const none = { objectValue: false, objectKey: false };
    // (a) red when the walk hides its strings and keys with the forms alone (no `Bearer` /
    //     `token=` rules there): the anchor word is replaced before the last pass can find it;
    //     (b) prints, per value, source and surface, whether the token shows.
    expect(cases).toEqual(ANCHOR_CASES.map(([name]) => ({ name, env: none, declared: none })));
  });

  it('A1. a form with + or / inside a token leaves no part of the token shown', () => {
    const FORM = 'q+w/e=';
    // (a) red when the run after `Bearer ` takes only `[A-Za-z0-9._-]` and not positions a member
    //     already covers (the rest of the token after the form is shown); (b) prints the output.
    expect(sanitizeText('Bearer abc' + FORM + 'xyz', [FORM])).toBe('Bearer [REDACTED]');
  });

  it('A1. a value holding token= (a connection string) is hidden whole', () => {
    const DSN =
      ['postgres', '://', 'u:p', '@h/app'].join('') + '?' + 'token=' + 'abc123&sslmode=require';
    // (a) red when the `Bearer` / `token=` rules run before the members (an earlier build's
    //     order: the value's `token=` part is cut first, and the rest of it is shown); (b) prints
    //     the output.
    expect(sanitizeText(`connect ${DSN} failed`, [DSN])).toBe('connect [REDACTED] failed');
  });

  it('A1. a plain Bearer token keeps its anchor word: Bearer [REDACTED]', () => {
    // (a) red when the anchor word is marked together with its run (`[REDACTED]` alone); (b)
    //     prints the output.
    // #729 PR-3 correction 1 (D-4): the anchor fires before a token-shaped run (8+ characters with
    // a digit, a capital, `+`, `/` or `=`).
    expect(sanitizeText('auth: ' + 'Bearer ' + 'abc.def9X', [])).toBe('auth: Bearer [REDACTED]');
  });

  it('A1. (preservation) a JWT carrying a value in base64url is hidden whole after Bearer', () => {
    const seg = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
    const carried = seg('{"sub":"' + 'FAKEval9QZ' + '"}');
    const jwt = [seg('{"alg":"none"}'), carried, 'FAKE' + 'sig'].join('.');
    // A preservation pin: its base64url segment is made only of run characters, so no single
    // break turns it red (the run covers it with or without the member). (b) prints the output.
    expect(sanitizeText('Bearer ' + jwt, [carried])).toBe('Bearer [REDACTED]');
  });

  it('A1. the last pass over the encoded object still hides a value only the encoded text spells', () => {
    // A value written with a literal `\n` that ends in a lone `\`: it has no escapes-read form, so
    // the walk cannot read it; printed with its `\n` read, inside an object result.
    const VALUE = 'FAKEtb' + BS + 'n' + 'line2x9' + BS;
    const PRINTED = 'FAKEtb' + '\n' + 'line2x9' + BS;
    const result = bothSources(VALUE, () =>
      serializeToolResult({ content: [{ type: 'text', text: PRINTED }] }).includes('line2x9'),
    );
    // (a) red when the last `sanitizeText` pass over the encoded output is removed; (b) prints,
    //     per source, whether the value shows.
    expect(result).toEqual({ env: false, declared: false });
  });

  it('A2. a declared value with 54 two-meaning \\xHH escapes, printed after reading as bytes, is hidden', () => {
    const ESCAPES = (BS + 'x' + 'e4' + BS + 'x' + 'b8' + BS + 'x' + 'ad').repeat(18);
    const VALUE = 'FAKEzh' + ESCAPES + 'END';
    const READ = 'FAKEzh' + String.fromCodePoint(0x4e2d).repeat(18) + 'END';
    setAdditionalRedactionValues([VALUE]);
    // (a) red when the two whole readings of more than 3 such escapes come from a `2 ** n - 1` mask
    //     read with `>>` (at 54 it is 0, so the all-bytes reading is lost); (b) prints the escape
    //     count and whether the value is hidden.
    expect({
      escapes: ESCAPES.split(BS + 'x').length - 1,
      hidden: sanitizeError(new Error(`see ${READ} here`)) === 'see [REDACTED] here',
    }).toEqual({ escapes: 54, hidden: true });
  });

  it('C3. a value of 200,000 characters holding a backslash escape builds its forms: no call throws, and the value and its escapes-read form are hidden', () => {
    const FILL = Array.from({ length: 40_000 }, (_, i) => i.toString(36).padStart(5, '0')).join('');
    const VALUE = 'FAKEbig' + BS + 'n' + FILL; // as configured: a literal backslash-n
    const READ = 'FAKEbig' + '\n' + FILL; // with its escape read
    const TEXT = `see ${VALUE} and ${READ} here`;
    const HIDDEN = 'see [REDACTED] and [REDACTED] here';
    const attempt = (fn: () => boolean): boolean | string => {
      try {
        return fn();
      } catch (e) {
        return 'THROW ' + (e instanceof Error ? e.constructor.name : typeof e);
      }
    };
    const result = bothSources(VALUE, () => ({
      error: attempt(() => sanitizeError(new Error(TEXT)) === HIDDEN),
      prompt: attempt(() => discloseForAgent(TEXT) === HIDDEN),
      object: attempt(() => serializeToolResult({ a: TEXT }) === JSON.stringify({ a: HIDDEN })),
    }));
    // (a) red when `decodedReadings` spreads a segment's bytes into `push` (each result
    //     `THROW RangeError`); (b) prints, per source and surface, `true`, `false` or the thrown
    //     class.
    expect(result).toEqual({
      env: { error: true, prompt: true, object: true },
      declared: { error: true, prompt: true, object: true },
    });
  }, 60_000);
});

// issue #759 (Part F): the providers' in-conversation correction trailer is core's LINES rendering
// over the verdict's capped rows — the schema's own allowed values for `enum`/`const`, never a
// submitted value — and ends with `and N more` from the verdict's carried total. A failure prints
// the trailer: key names, rules and the schema's values only.
describe('#729 PR-3 correction 1 (F26) — the provider edge', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('removes span marks before the law reads the text', () => {
    vi.stubEnv('REALM_NOT_SECRET', '');
    vi.stubEnv('AGENT_FAKE_ENV_729', 'FAKE-AGENT-ENV-0729');
    // (a) red when the marks are removed after masking (the mark parts the value, so the law
    //     misses it); (b) prints the text given to the model (fake values).
    expect(discloseForAgent('key FAKE-AGENT\uE001-ENV-0729 end')).toBe('key [REDACTED] end');
  });
});

describe('issue #759 — renderSubmissionProblems (the providers’ trailer)', () => {
  const fields = Array.from({ length: 13 }, (_, i) => `f${String(i + 1).padStart(2, '0')}`);

  it('13 problems → ten LINES and `and 3 more` (red: the trailer’s own cap of ten with no remainder)', () => {
    const verdict = validateAgentSubmission(
      {},
      { outputSchema: { type: 'object', required: fields } },
      's',
    );
    const lines = renderSubmissionProblems(verdict).split('\n');
    expect({ count: lines.length, first: lines[0], last: lines.at(-1) }).toEqual({
      count: 11,
      first: "- (root): must have required property 'f01' [required] (missing property: 'f01')",
      last: 'and 3 more',
    });
  });

  it('`enum` renders its values, `const` its ONE value (`params.allowedValue`), and no submitted value appears (red: the plural key for `const`)', () => {
    const verdict = validateAgentSubmission(
      { kind: 'SUBMITTED-VALUE-9Z', mode: 'SUBMITTED-VALUE-9Z' },
      {
        outputSchema: {
          type: 'object',
          properties: { kind: { enum: ['alpha', 'beta'] }, mode: { const: 'gamma' } },
        },
      },
      's',
    );
    const trailer = renderSubmissionProblems(verdict);
    expect({
      lines: trailer.split('\n'),
      valueShown: trailer.includes('SUBMITTED'),
    }).toEqual({
      lines: [
        '- /kind: must be equal to one of the allowed values [enum] (allowed values: ["alpha","beta"])',
        '- /mode: must be equal to constant [const] (allowed values: ["gamma"])',
      ],
      valueShown: false,
    });
  });
});

// F2 (B2): the agent set a library caller gets (no writer) passes the working directory.
describe('F2 — the working directory (B2, agent-utils agentDisclosureSet)', () => {
  const F2_CWD = '/srv/fake-f2-project-01';
  it('what a model is given shows a path under the working directory whole', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(F2_CWD);
    vi.stubEnv('REALM_NOT_SECRET', '');
    vi.stubEnv('INIT_CWD', F2_CWD);
    vi.stubEnv('npm_config_local_prefix', F2_CWD);
    const text = `read ${F2_CWD}/notes.md`;
    // (a) red when agentDisclosureSet builds its set without `cwd`; (b) prints the fake text.
    expect(discloseForAgent(text)).toBe(text);
  });
});

// F2 (D2, commit 2): what `realm agent` gives a model hides a declared secret in the spelling a
// program prints after reading its escapes twice — the spelling the MCP door already hid.
describe('F2 — realm agent hides a declared secret in the spellings the door hid (D2)', () => {
  it('a declared value stored with `\\\\n` is hidden on the agent path in its twice-read spelling', () => {
    const BS = '\\';
    const declared = `pa${BS}${BS}nss-word1`; // fake; two literal backslashes
    setAdditionalRedactionValues([declared]);
    try {
      // (a) red when D2 is removed (the newline spelling reaches the model); (b) prints the text.
      expect(discloseForAgent('key pa\nss-word1 end')).toBe('key [REDACTED] end');
    } finally {
      setAdditionalRedactionValues([]);
    }
  });
});
