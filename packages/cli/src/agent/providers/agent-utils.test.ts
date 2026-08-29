// agent-utils.test.ts — Tests for shared agent utility functions.
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  classBError,
  CLASS_B_NO_TEXT_MARKER,
  buildSystemPrompt,
  sanitizeError,
  serializeToolResult,
  setAdditionalRedactionValues,
  extractJsonObject,
} from './agent-utils.js';

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
    // account ids, which are exactly the kind of value the sweep exists for.
    vi.stubEnv('AGENT_UTILS_TEST_PIN', '483921');
    const out = sanitizeError(new Error('pin 483921 rejected'));
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('483921');
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

  it('a path under HOME keeps its tail; the home prefix is stripped', () => {
    // The informative half of a require stack is the tail. Redacting the whole path told an
    // operator nothing; stripping only the home prefix keeps the file and loses the username.
    vi.stubEnv('HOME', '/home/testuser');
    vi.stubEnv('INIT_CWD', '/home/testuser/proj');
    const out = sanitizeError(new Error('Require stack: /home/testuser/proj/x.js'));
    expect(out).toBe('Require stack: [REDACTED]/proj/x.js');
  });

  it('SHADOW CLOSURE — a second key carrying the SAME value cannot reopen the leak', () => {
    // The rule is VALUE-level, not key-level. `npm_config_local_prefix` carries the identical
    // string as `INIT_CWD`; under a key-level exclusion this exact case no-oped, because the
    // shadow key was still in the sweep and redacted the prefix anyway.
    vi.stubEnv('HOME', '/home/testuser');
    vi.stubEnv('INIT_CWD', '/home/testuser/proj');
    vi.stubEnv('npm_config_local_prefix', '/home/testuser/proj');
    expect(sanitizeError(new Error('Require stack: /home/testuser/proj/x.js'))).toBe(
      'Require stack: [REDACTED]/proj/x.js',
    );
  });

  it('PRIVACY — a path NOT under HOME is redacted wholesale', () => {
    // The WSL shape: `/mnt/c/Users/<Name>` carries the username in the tail, so the home-prefix
    // strip cannot help. Full redaction is the right answer there, and stays.
    vi.stubEnv('HOME', '/home/testuser');
    vi.stubEnv('PWD', '/mnt/c/Users/Test User/proj');
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

  it('npm_package_json under HOME keeps its tail', () => {
    // Path-valued on every launcher that sets it, so it belongs to the value-level rule rather
    // than the exact-key set — keeping it key-excluded would ship a non-HOME checkout's full
    // path, which is the very privacy trade rule 1c exists to make.
    vi.stubEnv('HOME', '/home/testuser');
    vi.stubEnv('npm_package_json', '/home/testuser/proj/package.json');
    expect(sanitizeError(new Error('read /home/testuser/proj/package.json'))).toBe(
      'read [REDACTED]/proj/package.json',
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
