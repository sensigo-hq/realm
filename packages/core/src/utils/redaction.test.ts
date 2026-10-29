// Unit tests for the shared redaction/bounding primitives (issue #111 extraction).
// redactErrorBody's own behavior-unchanged coverage lives in adapter-utils.test.ts — unmodified
// by this extraction, and still green, which is the proof of byte-identical behavior.
import { describe, it, expect } from 'vitest';
import {
  scrubEmail,
  capText,
  boundResolvedValue,
  boundWhole,
  escapedBoundedValue,
  REDACTION_CHAR_CAP,
  compileDisclosure,
  buildDisclosureSet,
  disclose,
  weakestDeclared,
  environmentEntries,
  isCredentialName,
  notSecretIntersection,
  unmaskableWarning,
  DISCLOSURE_FLOORS,
  markersIn,
  inboundMarkerWarning,
  NOT_SECRET_ENV,
  REALM_CREDENTIAL_VARIABLES,
  REALM_SETTING_VARIABLES,
  type DisclosureEntry,
} from './redaction.js';
import { discloseByTable } from './disclosure-walk.js';
import { discloseGate } from './disclosure-tables.js';
import * as round1 from '../test-support/disclosure-law/round-1/redaction.js';

describe('scrubEmail', () => {
  it('replaces an email address with [REDACTED_EMAIL]', () => {
    expect(scrubEmail('contact jane.doe@example.com for help')).toBe(
      'contact [REDACTED_EMAIL] for help',
    );
  });

  it('leaves a string with no email unchanged', () => {
    expect(scrubEmail('no email here')).toBe('no email here');
  });
});

describe('capText', () => {
  it('leaves a short string unchanged', () => {
    expect(capText('short')).toBe('short');
  });

  // #729 PR-3 B0: (a) red when the cut returns or the cap moves; (b) prints `x` runs or the marker.
  it('replaces an over-limit string whole with its marker; one at the cap is kept whole (B0)', () => {
    expect(capText('x'.repeat(600))).toBe('‹600 characters, not kept›');
    expect(capText('x'.repeat(REDACTION_CHAR_CAP))).toBe('x'.repeat(REDACTION_CHAR_CAP));
  });
});

describe('boundResolvedValue (issue #111)', () => {
  it('passes null through verbatim', () => {
    expect(boundResolvedValue(null)).toBeNull();
  });

  it('passes undefined through verbatim', () => {
    expect(boundResolvedValue(undefined)).toBeUndefined();
  });

  it('passes booleans through verbatim', () => {
    expect(boundResolvedValue(true)).toBe(true);
    expect(boundResolvedValue(false)).toBe(false);
  });

  it('passes numbers through verbatim (including 0 and negative)', () => {
    expect(boundResolvedValue(0)).toBe(0);
    expect(boundResolvedValue(-5)).toBe(-5);
    expect(boundResolvedValue(3.14)).toBe(3.14);
  });

  it('passes a short string through, scrubbed of email addresses', () => {
    expect(boundResolvedValue('jane.doe@example.com')).toBe('[REDACTED_EMAIL]');
    expect(boundResolvedValue('plain string')).toBe('plain string');
  });

  // #729 PR-3 B0: (a) red when the cut returns; (b) prints the marker or a run of `x`.
  it('replaces a long string whole with its marker (B0)', () => {
    expect(boundResolvedValue('x'.repeat(600))).toBe('‹600 characters, not kept›');
  });

  // (a) red when the cut returns (the address would lead the kept start, scrubbed); (b) prints the
  //     marker, which holds no address.
  it('replaces a long string holding an email whole with its marker — no start of it is kept', () => {
    const long = `jane.doe@example.com${'x'.repeat(600)}`;
    expect(boundResolvedValue(long)).toBe('‹620 characters, not kept›');
  });

  it('stringifies, caps, and scrubs an object', () => {
    const result = boundResolvedValue({ email: 'jane.doe@example.com', ok: true }) as string;
    expect(result).toContain('[REDACTED_EMAIL]');
    expect(result).not.toContain('jane.doe@example.com');
    expect(result).toContain('"ok":true');
  });

  // (a) red when the cut returns; (b) prints the marker. `[0,…,199]` is 691 characters:
  //     2 brackets + 490 digits + 199 commas.
  it('stringifies a large array and replaces it whole with its marker (B0)', () => {
    const arr = Array.from({ length: 200 }, (_, i) => i);
    expect(boundResolvedValue(arr)).toBe('‹691 characters, not kept›');
  });

  it('falls back to <unserializable> for a circular object (JSON.stringify throws)', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(boundResolvedValue(circular)).toBe('<unserializable>');
  });
});

// ── #729 PR-3: the disclosure law (RECORD 01 #3–#5; D3/04; D3/07 R3-1; D3/08 S3) ──────────────
// Every value here is fake. Each assertion names (a) the change that turns it red and (b) what it
// prints on failure: the shown text is made of fake values and markers only.

const ENV_VALUE = 'FAKE-ENV-VALUE-0001';
const DECLARED_VALUE = 'FAKE-DECLARED-0002';

function setOf(entries: DisclosureEntry[], audience: 'agent' | 'private' | 'broadcast' = 'agent') {
  return compileDisclosure(entries, { declared: 'resolved', audience, environment: 'swept' }).set;
}

describe('#729 PR-3 — the law: kinds, precedence, idempotence, tiers', () => {
  it('a value both declared and in the environment is ONE member, counted as declared', () => {
    const set = setOf([
      { value: DECLARED_VALUE, source: 'env:SOME_VAR' },
      { value: DECLARED_VALUE, source: 'declared:SOME_SECRET' },
    ]);
    // (a) red when an entry is kept per source (two members) or the environment kind wins;
    // (b) prints the counts and the source list (names only).
    expect(disclose(`x ${DECLARED_VALUE} y`, set, 'all').hidden).toEqual({
      declared: 1,
      environment: 0,
      pattern: 0,
    });
    expect(set.sources).toEqual(['declared:SOME_SECRET']);
  });

  it('kind precedence: a run covering an environment member and a declared one counts as declared; pattern < environment', () => {
    const set = setOf([
      { value: ENV_VALUE, source: 'env:A' },
      { value: DECLARED_VALUE, source: 'declared:B' },
    ]);
    // Side by side: one marked run, the higher kind.
    // (a) red when runs are counted by the first or lowest kind; (b) prints the text and counts.
    const adjacent = disclose(`${ENV_VALUE}${DECLARED_VALUE}`, set, 'all');
    expect(adjacent.text).toBe('[REDACTED]');
    expect(adjacent.hidden).toEqual({ declared: 1, environment: 0, pattern: 0 });
    // An environment member after `token=` (a pattern run): environment wins over pattern.
    const anchored = disclose(`token=${ENV_VALUE}`, set, 'all');
    expect(anchored.text).toBe('token=[REDACTED]');
    expect(anchored.hidden).toEqual({ declared: 0, environment: 1, pattern: 0 });
  });

  it("tier 'declared' hides declared members only: an environment member and the patterns stay whole", () => {
    const set = setOf([
      { value: ENV_VALUE, source: 'env:A' },
      { value: DECLARED_VALUE, source: 'declared:B' },
    ]);
    // (a) red when the declared tier applies environment members or anchors; (b) prints the text.
    expect(disclose(`${ENV_VALUE} ${DECLARED_VALUE} password=abc`, set, 'declared').text).toBe(
      `${ENV_VALUE} [REDACTED] password=abc`,
    );
  });

  it('is idempotent over every named marker and shape: disclosing twice changes nothing (I11)', () => {
    // Members that occur INSIDE the markers' own words.
    const set = setOf([
      { value: 'characters', source: 'env:A' },
      { value: 'REDACTED', source: 'declared:B' },
      { value: 'redacted-live-claim', source: 'env:C' },
    ]);
    const markers = [
      '[REDACTED]',
      '[REDACTED_EMAIL]',
      '[REDACTED: not checked]',
      '[redacted-live-claim]',
      '‹12 characters, not kept›',
      '‹string, 12 characters›',
      '‹object, 3 keys›',
      '‹cycle›',
    ];
    for (const marker of markers) {
      const once = disclose(`a ${marker} b`, set, 'all');
      // (a) red when `disclose` matches inside a marker; (b) prints the marker and the text.
      expect({ marker, text: once.text }).toEqual({ marker, text: `a ${marker} b` });
      expect(disclose(once.text, set, 'all').text).toBe(once.text);
    }
    const text = `password=FAKE-1 ${ENV_VALUE} Authorization: Bearer FAKE-2 characters`;
    const envSet = setOf([
      { value: ENV_VALUE, source: 'env:A' },
      { value: 'characters', source: 'env:B' },
    ]);
    const first = disclose(text, envSet, 'all').text;
    // (a) red when a second pass re-marks a marker or the run after it; (b) prints both texts.
    expect(disclose(first, envSet, 'all').text).toBe(first);
  });

  it('`members` names the sources only on a private audience', () => {
    const entries: DisclosureEntry[] = [{ value: DECLARED_VALUE, source: 'declared:B' }];
    // (a) red when names reach a shared audience, or a private one loses them; (b) prints the lists.
    expect(disclose(DECLARED_VALUE, setOf(entries, 'private'), 'declared').members).toEqual([
      'declared:B',
    ]);
    expect(disclose(DECLARED_VALUE, setOf(entries, 'agent'), 'all').members).toBeUndefined();
  });

  it('`unchecked` is 0 until PR-M1', () => {
    // (a) red when the field is dropped; (b) prints the number.
    expect(disclose('x', setOf([]), 'all').unchecked).toBe(0);
  });
});

describe('#729 PR-3 — the floors and unmaskable (I8)', () => {
  it('an environment value under 8 characters is not a member; one of 8 is', () => {
    const entries = environmentEntries(
      { SEVEN: 'FAKE-07', EIGHT: 'FAKE-008' },
      { audience: 'agent' },
    );
    // (a) red when the floor moves; (b) prints the source names.
    expect(entries.map((e) => e.source)).toEqual(['env:EIGHT']);
    expect(DISCLOSURE_FLOORS).toEqual({ environment: 8, declared: 4 });
  });

  it('a declared value under 4 is returned in `unmaskable`, never dropped silently; one of 4 is a member', () => {
    const { set, unmaskable } = compileDisclosure(
      [
        { value: 'abc', source: 'declared:SHORT' },
        { value: 'abcd', source: 'declared:FOUR' },
      ],
      { declared: 'resolved', audience: 'agent', environment: 'swept' },
    );
    // (a) red when a short value is dropped or masked, or the floor moves; (b) prints names and counts.
    expect(unmaskable).toEqual(['declared:SHORT']);
    expect(set.unmaskable).toBe(1);
    expect(set.sources).toEqual(['declared:FOUR']);
  });

  it('the load warning has the four clauses and names the secret, never its value', () => {
    const warning = unmaskableWarning('declared:SHORT_ONE');
    // (a) red when a clause is dropped or the value printed; (b) prints booleans.
    expect({
      names: warning.includes("Secret 'SHORT_ONE'"),
      validity: warning.includes('shorter than 4 characters'),
      consequence: warning.includes('It shows wherever it appears outside a credential'),
      remedy: warning.includes('Fix: give it a value of at least 4 characters'),
      readmission: warning.includes('hidden again from the next load'),
    }).toEqual({ names: true, validity: true, consequence: true, remedy: true, readmission: true });
  });
});

describe('#729 PR-3 — the environment filter (one filter, RECORD 01 #5)', () => {
  const env = {
    HOME: '/home/fakeuser',
    USER: 'fakeuser9',
    // PWD is shell metadata, excluded by name (D-6): a value under HOME under another name.
    PROJECT_DIR: '/home/fakeuser/project',
    SHORTUSER: 'fakeu',
    API: 'FAKE-API-VALUE-01',
    npm_package_name: 'some-package',
    FLAG: 'false',
    // 8+ characters, so only the public-shape rule (not the floor) keeps it out.
    VERSION: '10.20.300',
  };
  it('HOME, USER and values under HOME are members on agent, broadcast and log; exempt on private and file', () => {
    const names = (audience: 'agent' | 'broadcast' | 'log' | 'private' | 'file') =>
      environmentEntries(env, { audience }).map((e) => e.source);
    // (a) red when the audience stops deciding the personal values; (b) prints source names.
    for (const audience of ['agent', 'broadcast', 'log'] as const) {
      expect({ audience, names: names(audience) }).toEqual({
        audience,
        names: ['env:HOME', 'env:USER', 'env:PROJECT_DIR', 'env:API'],
      });
    }
    for (const audience of ['private', 'file'] as const) {
      expect({ audience, names: names(audience) }).toEqual({ audience, names: ['env:API'] });
    }
  });

  it('a USER of 5 characters is shown (under the floor); one of 9 is hidden on agent', () => {
    const set = buildDisclosureSet({
      env: { USER: 'fakeu', OTHER_USER: 'fakeuser9' },
      declared: {},
      declaredState: 'resolved',
      audience: 'agent',
    }).set;
    // (a) red when the floor stops applying to USER, or USER stops being a member; (b) prints text.
    expect(disclose('fakeu and fakeuser9', set, 'all').text).toBe('fakeu and [REDACTED]');
  });

  it('the #407 rules stay: launcher metadata by exact name, and public shapes (booleans, versions)', () => {
    const names = environmentEntries(env, { audience: 'agent' }).map((e) => e.source);
    // (a) red when a rule is lost; (b) prints source names.
    expect(names.includes('env:npm_package_name')).toBe(false);
    expect(names.includes('env:FLAG')).toBe(false);
    expect(names.includes('env:VERSION')).toBe(false);
  });

  it("exempt names: REALM_NOT_SECRET ∪ the manifests' intersection, unless an unlisted variable holds the same value", () => {
    const both = {
      SHOWN_A: 'FAKE-SHOWN-VALUE-A',
      SHOWN_B: 'FAKE-SHOWN-VALUE-B',
      REALM_NOT_SECRET: 'SHOWN_A',
    };
    const names = (e: Record<string, string>, notSecret?: string[]) =>
      environmentEntries(e, { audience: 'agent', ...(notSecret ? { notSecret } : {}) }).map(
        (x) => x.source,
      );
    // (a) red when REALM_NOT_SECRET or the manifests' list stops exempting; (b) prints names.
    expect(names(both)).toEqual(['env:SHOWN_B']);
    expect(names(both, ['SHOWN_B'])).toEqual([]);
    // The same value under an unlisted name keeps it hidden.
    // (a) red when an exempt name's value is shown although another variable holds it; (b) names.
    expect(names({ ...both, COPY: 'FAKE-SHOWN-VALUE-A' })).toEqual(['env:SHOWN_B', 'env:COPY']);
    // The manifests' lists combine by intersection: a name every manifest lists.
    // (a) red when they combine by union; (b) prints the names.
    expect(notSecretIntersection([['A', 'B'], ['B', 'C'], undefined])).toEqual([]);
    expect(
      notSecretIntersection([
        ['A', 'B'],
        ['B', 'C'],
      ]),
    ).toEqual(['B']);
    expect(notSecretIntersection([])).toEqual([]);
  });
});

describe('F2 — the working directory is never a member (option B)', () => {
  // Fakes only: no real home, no real project. The three names are the class's members: npm's two
  // and one invented launcher name — the rule is by VALUE, so every name holding the cwd is skipped.
  const HOME_DIR = '/home/fakeuser-f2';
  const CWD = '/srv/fake-project-0001';
  const SIBLING = '/srv/fake-project-0002';
  const NAMES = ['INIT_CWD', 'npm_config_local_prefix', 'FAKE_LAUNCHER_CWD'] as const;
  const holding = (value: string): Record<string, string> => ({
    HOME: HOME_DIR,
    API: 'FAKE-API-VALUE-F2-01',
    ...Object.fromEntries(NAMES.map((n) => [n, value])),
  });
  const names = (
    env: Record<string, string>,
    audience: 'agent' | 'broadcast' | 'log' | 'private' | 'file',
    cwd?: string,
  ) =>
    environmentEntries(env, { audience, ...(cwd !== undefined ? { cwd } : {}) }).map(
      (e) => e.source,
    );

  for (const audience of ['log', 'agent', 'broadcast'] as const) {
    it(`F2-1 (${audience}): a variable whose value is the cwd is not a member, whatever its name`, () => {
      // (a) red when the value rule is removed (the three names are members again); (b) prints the
      //     member names (no value).
      expect(names(holding(CWD), audience, CWD)).toEqual(['env:HOME', 'env:API']);
    });
  }

  it('F2-2: the same names holding a SIBLING folder stay members (the rule is by value, not name)', () => {
    // (a) red when a name list replaces the value rule (the sibling is exempted by name); (b) prints
    //     the member names.
    expect(names(holding(SIBLING), 'log', CWD)).toEqual([
      'env:HOME',
      'env:API',
      'env:INIT_CWD',
      'env:npm_config_local_prefix',
      'env:FAKE_LAUNCHER_CWD',
    ]);
  });

  it('F2-3a: the cwd spelled with a trailing slash is the cwd', () => {
    // (a) red when one trailing slash is no longer removed before comparing; (b) prints names.
    expect(names({ HOME: HOME_DIR, INIT_CWD: `${CWD}/` }, 'log', CWD)).toEqual(['env:HOME']);
  });

  it('F2-3b: a folder under the cwd is not the cwd', () => {
    // (a) red when the rule matches by prefix instead of the folder itself; (b) prints names.
    expect(names({ HOME: HOME_DIR, INIT_CWD: `${CWD}/sub` }, 'log', CWD)).toEqual([
      'env:HOME',
      'env:INIT_CWD',
    ]);
  });

  it('F2-4: the home folder as the cwd stays a member on a log, and exempt on private (D-7)', () => {
    // (a) red when the HOME-value guard is dropped (HOME exempted on a log because it is the cwd);
    //     (b) prints the member names per audience.
    expect({
      log: names({ HOME: HOME_DIR }, 'log', HOME_DIR),
      private: names({ HOME: HOME_DIR }, 'private', HOME_DIR),
    }).toEqual({ log: ['env:HOME'], private: [] });
  });

  it("F2-5: INIT_CWD holding the home folder, which is the cwd, stays a member (HOME's shadow; a control)", () => {
    // (a) red when the guard compares anything but HOME's value; (b) prints the member names.
    expect(names({ HOME: HOME_DIR, INIT_CWD: HOME_DIR }, 'log', HOME_DIR)).toEqual([
      'env:HOME',
      'env:INIT_CWD',
    ]);
  });

  it("F2-6: the cwd UNDER the home folder — INIT_CWD skipped, HOME still a member (the walker's case)", () => {
    const cwd = `${HOME_DIR}/code/x`;
    // (a) red when the guard is the `personal` predicate instead of HOME's value (every folder under
    //     home would stay a member); (b) prints the member names.
    expect(names({ HOME: HOME_DIR, INIT_CWD: cwd }, 'log', cwd)).toEqual(['env:HOME']);
    // What a log shows of a path in that folder: only the home folder's part.
    const set = buildDisclosureSet({
      env: { HOME: HOME_DIR, INIT_CWD: cwd },
      declared: {},
      declaredState: 'resolved',
      audience: 'log',
      cwd,
    }).set;
    // (a) red when INIT_CWD is a member again (the whole folder hidden); (b) prints the fake text.
    expect(disclose(`${cwd}/realm.yaml`, set, 'all').text).toBe('[REDACTED]/code/x/realm.yaml');
  });

  it('F2-7: a DECLARED secret equal to the cwd is still hidden (declared members are not environment entries; a control)', () => {
    const set = buildDisclosureSet({
      env: holding(CWD),
      declared: { PROJECT_PATH_SECRET: CWD },
      declaredState: 'resolved',
      audience: 'log',
      cwd: CWD,
    }).set;
    // (a) red when the cwd rule reaches declared values; (b) prints the fake text.
    expect(disclose(`${CWD}/realm.yaml`, set, 'all').text).toBe('[REDACTED]/realm.yaml');
  });

  it('F2-8: no cwd passed — the members are exactly as before (an embedder; a control)', () => {
    // (a) red when the rule applies without a cwd; (b) prints the member names.
    expect(names(holding(CWD), 'log')).toEqual([
      'env:HOME',
      'env:API',
      'env:INIT_CWD',
      'env:npm_config_local_prefix',
      'env:FAKE_LAUNCHER_CWD',
    ]);
  });
});

describe('#729 PR-3 — the credential-name rule, both readers (D3/04; D3/07 R3-1; D3/08 S3)', () => {
  const positives = [
    'clientSecret',
    'APIKey',
    'apiKey',
    'password',
    'passwd',
    'DB_PASSWORD',
    'GITHUB_TOKEN',
    'x-api-key',
    'client_token',
    'my_service_secret',
    'Set-Cookie',
    'secretAccessKey',
    'Authorization',
    'refresh_token',
    // Joined, these two are in no list entry: only the camelCase split ('my service secret') and the
    // acronym split ('API secret key') make them credential names.
    'myServiceSecret',
    'APISecretKey',
  ];
  const negatives = ['token_count', 'max_tokens', 'token_type', 'ack_token_present', 'tokenizer'];

  it('the name rule: trailing segments joined, matched against one list', () => {
    // (a) red when a spelling stops splitting (camelCase, acronym, -, _), or a negative matches;
    // (b) prints each name with its verdict.
    expect(positives.map((name) => [name, isCredentialName(name)])).toEqual(
      positives.map((name) => [name, true]),
    );
    expect(negatives.map((name) => [name, isCredentialName(name)])).toEqual(
      negatives.map((name) => [name, false]),
    );
  });

  it('the text reader: `<name>=`, `<name>:` and `"<name>": "…"`, each spelling; the negatives untouched', () => {
    const empty = setOf([]);
    const shown = (text: string) => disclose(text, empty, 'all').text;
    // (a) red when an anchor form stops matching or a value end moves; (b) prints the texts.
    expect(shown('DB_PASSWORD=FAKE-PW-1 next')).toBe('DB_PASSWORD=[REDACTED] next');
    expect(shown('GITHUB_TOKEN=FAKE-GH-1&x=1')).toBe('GITHUB_TOKEN=[REDACTED]&x=1');
    expect(shown('{"my_service_secret": "FAKE-S-1", "a": 1}')).toBe(
      '{"my_service_secret": "[REDACTED]", "a": 1}',
    );
    expect(shown('{\n  "client_token": "FAKE-T-1"\n}')).toBe(
      '{\n  "client_token": "[REDACTED]"\n}',
    );
    expect(shown('x-api-key: FAKE-K-1;')).toBe('x-api-key: [REDACTED];');
    expect(shown('APIKey=FAKE-K-2,')).toBe('APIKey=[REDACTED],');
    expect(shown('clientSecret: FAKE-C-1 rest')).toBe('clientSecret: [REDACTED] rest');
    expect(shown('Set-Cookie: FAKE-COOKIE-1; Path=/')).toBe('Set-Cookie: [REDACTED]; Path=/');
    expect(shown('db.password=FAKE-PW-2')).toBe('db.password=[REDACTED]');
    for (const name of negatives) {
      expect(shown(`${name}=5`)).toBe(`${name}=5`);
    }
  });

  it('the fixed anchors: Bearer, Basic, token=, a URL user part; Authorization hides its scheme and credential', () => {
    const shown = (text: string) => disclose(text, setOf([]), 'all').text;
    // (a) red when an anchor is dropped; (b) prints the texts.
    expect(shown('Bearer FAKE.TOKEN-1 end')).toBe('Bearer [REDACTED] end');
    expect(shown('Basic RkFLRTpGQUtF== end')).toBe('Basic [REDACTED] end');
    expect(shown('?token=FAKE-Q-1&a=b')).toBe('?token=[REDACTED]&a=b');
    expect(shown('https://someone:FAKE-URL-PW@example.test/x')).toBe(
      'https://someone:[REDACTED]@example.test/x',
    );
    expect(shown('Authorization: Digest FAKE-D-1 rest')).toBe('Authorization: [REDACTED] rest');
  });

  it('a JSON value runs to its first UNESCAPED quote', () => {
    // (a) red when the value stops at the escaped quote (a fragment would show); (b) prints the text.
    expect(disclose('{"password": "FAKE\\"PW-3", "a": 1}', setOf([]), 'all').text).toBe(
      '{"password": "[REDACTED]", "a": 1}',
    );
  });

  it('the value reader: a value at a credential key is hidden whatever its length; the negatives untouched', () => {
    const value = Object.fromEntries([
      ...positives.map((name) => [name, 'x']),
      ...negatives.map((name) => [name, 5]),
    ]);
    const walked = discloseByTable({ v: value }, { v: 'value' }, setOf([]), 'agent').value as {
      v: Record<string, unknown>;
    };
    // (a) red when the walk stops reading names, or a negative is hidden; (b) prints each key's
    //     shown value (`x`, `5` or the marker).
    expect(Object.fromEntries(positives.map((name) => [name, walked.v[name]]))).toEqual(
      Object.fromEntries(positives.map((name) => [name, '[REDACTED]'])),
    );
    expect(Object.fromEntries(negatives.map((name) => [name, walked.v[name]]))).toEqual(
      Object.fromEntries(negatives.map((name) => [name, 5])),
    );
  });
});

describe('#729 PR-3 — B0: no fragment across a cut point (D3/08 S2)', () => {
  it('a secret across the 500 cut leaves no fragment at the core helpers', () => {
    const value = `${'o'.repeat(490)}FAKE-ACROSS-CUT-0001`;
    // (a) red when any helper cuts (the secret's start would be kept); (b) prints booleans.
    for (const shown of [
      capText(value),
      boundResolvedValue(value) as string,
      escapedBoundedValue(value),
      boundWhole(value, REDACTION_CHAR_CAP),
    ]) {
      expect({
        fragment: shown.includes('FAKE'),
        marker: /^‹\d+ characters, not kept›$/.test(shown),
      }).toEqual({
        fragment: false,
        marker: true,
      });
    }
  });
});

describe('#729 PR-3 — an inbound value carrying a marker (D1 D5)', () => {
  it('markersIn finds every named marker in strings and keys, once each', () => {
    // (a) red when a marker kind is missed, keys are not read, or a cycle recurses; (b) prints the list.
    const cyclic: Record<string, unknown> = { a: '[REDACTED_EMAIL]' };
    cyclic['self'] = cyclic;
    expect(
      markersIn({
        answer: 'x [REDACTED] y [REDACTED]',
        nested: ['‹12 characters, not kept›', { '[redacted-live-claim]': 1 }],
        cyclic,
        plain: 'nothing here',
      }).sort(),
    ).toEqual([
      '[REDACTED]',
      '[REDACTED_EMAIL]',
      '[redacted-live-claim]',
      '‹12 characters, not kept›',
    ]);
    expect(markersIn({ plain: 'none', n: 3 })).toEqual([]);
  });

  it('the warning names the markers and says what was recorded, never a value', () => {
    const w = inboundMarkerWarning(['[REDACTED]']);
    // (a) red when a clause is dropped; (b) prints booleans.
    expect({
      names: w.includes("holds '[REDACTED]'"),
      consequence: w.includes('the run now holds the marker, not the value'),
      remedy: w.includes('Send the value itself, or leave the field out.'),
      readmission: w.includes('An answer with no marker is recorded as sent.'),
    }).toEqual({ names: true, consequence: true, remedy: true, readmission: true });
  });

  it('the zod 4 unit’s reply bounds (M6): the first ten markers named, then the count', () => {
    const markers = (n: number) => Array.from({ length: n }, (_, i) => `[REDACTED]#${i}`);
    const tail =
      ': a value Realm hid when it showed it, sent back. ' +
      'Realm records what was sent, the marker included, so the run now holds the marker, not the value. ' +
      'Send the value itself, or leave the field out. ' +
      'An answer with no marker is recorded as sent.';
    const named = (n: number) =>
      markers(n)
        .map((m) => `'${m}'`)
        .join(', ');
    // (a) red when the sentence names every marker (40,000 → 789 KB), the count clause appears at
    //     ten, or its singular reads as the plural; (b) prints the sentences (ten markers at most)
    //     and a length check — never the 40,000.
    expect({
      ten: inboundMarkerWarning(markers(10)),
      eleven: inboundMarkerWarning(markers(11)),
      twelve: inboundMarkerWarning(markers(12)).slice(0, 200),
      big: inboundMarkerWarning(markers(40_000)).length < 1500,
    }).toEqual({
      ten: `This answer holds ${named(10)}${tail}`,
      eleven: `This answer holds ${named(10)}, and 1 more marker (11 in all)${tail}`,
      twelve: `This answer holds ${named(10)}, and 2 more markers (12 in all)${tail}`.slice(0, 200),
      big: true,
    });
  });
});

describe('#729 PR-3 — the pattern pass is linear in the text', () => {
  it('a 200,000-character text with long name-like runs is passed in well under a second', () => {
    // A quadratic scan (a pattern tried at every position over a long run) took 35–52 seconds on
    // this text; the separator scans take milliseconds.
    const FILL = Array.from({ length: 40_000 }, (_, i) => i.toString(36).padStart(5, '0')).join('');
    const text = `see FAKEbig${FILL} and ${FILL}:x here`;
    const set = compileDisclosure([], {
      declared: 'resolved',
      audience: 'agent',
      environment: 'swept',
    }).set;
    const t0 = performance.now();
    disclose(text, set, 'all');
    const ms = performance.now() - t0;
    // (a) red when a name or URL anchor is matched by a regex tried at every position; (b) prints
    //     a boolean.
    expect({ underOneSecond: ms < 1000 }).toEqual({ underOneSecond: true });
  });
});

// ── #729 PR-3 correction 1: the law's RECORD 08 rules ──────────────────────────────────────────
// Every value is fake. Each assertion names (a) the change that turns it red and (b) what it prints:
// fake text, counts and booleans.
const NONE = compileDisclosure([], {
  declared: 'resolved',
  audience: 'agent',
  environment: 'swept',
}).set;
const law = (text: string, set = NONE): string => disclose(text, set, 'all').text;
const parses = (text: string): boolean => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};
const MEMBER = 'FAKEmember0729';
const WITH_MEMBER = compileDisclosure([{ value: MEMBER, source: 'declared:M' }], {
  declared: 'resolved',
  audience: 'agent',
  environment: 'swept',
}).set;

describe('#729 PR-3 correction 1 — D-1: a quote that closes a value ends it (F17)', () => {
  const inputs = [
    '{"h":"token=FAKEq0729v","x":1}',
    '{"a":"Authorization: Bearer FAKEtok9abc"}',
    '-H "Authorization: Bearer FAKEtok9abc" url',
  ];

  it('F17-a: the closing quote stays, so JSON still parses and a command keeps its quotes', () => {
    // (a) red when a value runs through its closing quote (the quote end removed); (b) prints the
    //     shown texts and whether the first parses.
    expect({ shown: inputs.map((t) => law(t)), parses: parses(law(inputs[0]!)) }).toEqual({
      shown: [
        '{"h":"token=[REDACTED]","x":1}',
        '{"a":"Authorization: [REDACTED]"}',
        '-H "Authorization: [REDACTED]" url',
      ],
      parses: true,
    });
  });

  it('F17-b: no loosening — a quote inside a word, a quoted value and a member with a tail', () => {
    // (a) red when a quote ends EVERY value (the rule widened: `ab'cd…` would show its tail) or a
    //     member's tail is cut off its name's value; (b) prints the shown texts.
    expect([
      law(`password=${MEMBER}-tailFAKE`, WITH_MEMBER),
      law("password='v-canaryFAKE'"),
      law("password=ab'cd-canaryFAKE"),
    ]).toEqual(['password=[REDACTED]', "password='[REDACTED]'", 'password=[REDACTED]']);
  });

  it('F17-c: a second pass over the outputs changes nothing (I11 after a quote)', () => {
    // The outputs as F17-a pins them, passed again: a marker before its closing quote stays.
    const once = [
      '{"h":"token=[REDACTED]","x":1}',
      '{"a":"Authorization: [REDACTED]"}',
      '-H "Authorization: [REDACTED]" url',
    ];
    // (a) red when the quote end is removed (the marker's closing quote is read into a new value);
    //     (b) prints booleans.
    expect(once.map((t) => law(t) === t)).toEqual([true, true, true]);
  });

  it('F17-d: the name read back stops at a member, so `x<member>password: v` hides v on the first pass', () => {
    // (a) red when the read-back runs across the member (the name becomes `x…password`, no
    //     credential); (b) prints the shown text.
    expect(law(`x${MEMBER}password: v-canaryFAKE`, WITH_MEMBER)).toBe(
      'x[REDACTED]password: [REDACTED]',
    );
  });

  it('a value at an escaped closing quote leaves the escape: JSON inside a JSON string still parses', () => {
    const inner = JSON.stringify({
      h: 'token=FAKEvalue123',
      p: 'password=FAKEpw99x',
      password: 'FAKEpwq0729',
      x: 1,
    });
    const outer = law(JSON.stringify({ o: inner }));
    // (a) red when the value takes the backslash of its closing `\"` (the outer text then holds an
    //     unescaped quote); (b) prints whether both levels parse and whether a value shows.
    expect({
      outer: parses(outer),
      inner: parses(outer) && parses((JSON.parse(outer) as { o: string }).o),
      shows: /FAKEvalue123|FAKEpw99x|FAKEpwq0729/.test(outer),
    }).toEqual({ outer: true, inner: true, shows: false });
  });
});

describe('#729 PR-3 correction 1 — D-2, D-3, D-4: comparisons, references and scheme words', () => {
  it('F18: a comparison is not a separator', () => {
    // (a) red when `==`, `!=` or `>=` reads as `=` (the right side would be hidden); (b) prints the
    //     shown texts.
    expect([law('x.token == true'), law('a.password != "x"'), law('a.secret >= 3')]).toEqual([
      'x.token == true',
      'a.password != "x"',
      'a.secret >= 3',
    ]);
  });

  it('F19: `${secret:NAME}` keeps its name; any other text after `secret:` keeps the old treatment', () => {
    // (a) red when the reference form is widened to any text (the second would show) or removed
    //     (the first would lose its name); (b) prints the shown texts.
    expect([
      law('missing ${secret:FAKE_NAME_0729} in config'),
      law('${secret:FAKE value 0729}'),
      law('secret: FAKEsecretvalue0729'),
    ]).toEqual([
      'missing ${secret:FAKE_NAME_0729} in config',
      '${secret:[REDACTED] value 0729}',
      'secret: [REDACTED]',
    ]);
  });

  it('F20: `Basic` and `Bearer` fire only before a token-shaped run', () => {
    // (a) red when the shape check is removed (an ordinary word after them is hidden) or the
    //     anchor stops firing (the token shows); (b) prints the shown texts.
    expect([
      law('Basic authentication'),
      law('Upgrade from Basic to Pro'),
      law('Bearer of the news'),
      law('sent Bearer FAKEtok9abc now'),
    ]).toEqual([
      'Basic authentication',
      'Upgrade from Basic to Pro',
      'Bearer of the news',
      'sent Bearer [REDACTED] now',
    ]);
  });
});

describe('#729 PR-3 correction 1 — F21: the high-water mark', () => {
  it('repeated separators stay linear: an 8× input takes under 22× the time (10,000 → 80,000 characters)', () => {
    // The linear pass costs about 8× on an 8× input (6.3–8.1× measured as the minimum of several
    // samples); the pass the mark replaced — each separator's value read from its own start again
    // — about 70× (0.3 s at 10,000 and 23 s at 80,000 characters here; 64× in theory). The bound 22
    // is the geometric midpoint of 8 and 64. The estimator is the minimum, because noise only ever adds time: seven
    // samples at the small size, whose single samples are a few milliseconds, three at the large.
    const time = (n: number, samples: number): number => {
      const text = 'token:'.repeat(Math.ceil(n / 6));
      let min = Infinity;
      for (let i = 0; i < samples; i++) {
        const t0 = performance.now();
        disclose(text, NONE, 'all');
        min = Math.min(min, performance.now() - t0);
      }
      return min;
    };
    time(10_000, 3);
    const small = Math.max(time(10_000, 7), 1);
    const large = time(80_000, 3);
    // (a) red when each separator's value is read from its own start again (`start = from` in
    //     place of the mark: quadratic, about 70× here); (b) prints the two times and the ratio.
    expect(
      large,
      `small ${small.toFixed(1)} ms, large ${large.toFixed(1)} ms, ratio ${(large / small).toFixed(1)} (bound 22)`,
    ).toBeLessThan(22 * small);
  }, 240_000);

  it('a value that runs past the previous value is still hidden whole: a quoted value, an Authorization value', () => {
    // The second credential name sits inside the first value's run; its value ends past that run.
    // (a) red when a value starting inside the last run is skipped or reuses that run's end (the
    //     tail past it would show); (b) prints the shown texts.
    expect([
      law('token=x:password="FAKE QUOTED TAIL0729"'),
      law('token=x:Authorization:Digest fakecredtail0729 end'),
    ]).toEqual(['token=[REDACTED]"', 'token=[REDACTED] end']);
  });
});

describe('#729 PR-3 correction 1 — D-5: the forms the name rule reads (F9)', () => {
  it('URL userinfo: a password, an empty user, a colon-less token of 8+, a short user kept', () => {
    // (a) red when the URL anchor is removed; (b) prints the shown texts.
    expect([
      law('see https://user:FAKEpw0729@host/path and x@y'),
      law('https://:FAKEpw0729@h'),
      law('https://FAKEtoken0729@h'),
      law('https://git@h'),
    ]).toEqual([
      'see https://user:[REDACTED]@host/path and x@y',
      'https://:[REDACTED]@h',
      'https://[REDACTED]@h',
      'https://git@h',
    ]);
  });

  it("a single-quoted key: 'password': 'v'", () => {
    // (a) red when a single-quoted name is not read; (b) prints the shown text.
    expect(law("{'password': 'FAKEsq0729'}")).toBe("{'password': '[REDACTED]'}");
  });

  it('an escaped JSON key: \\"password\\":\\"v\\"', () => {
    // (a) red when an escaped key is not read; (b) prints the shown text.
    expect(law('{\\"password\\":\\"FAKEesc0729\\"}')).toBe('{\\"password\\":\\"[REDACTED]\\"}');
  });

  it('a dotted name: "db.password":"v"', () => {
    // (a) red when `.` is not a segment break (`db.password` is no credential); (b) prints it.
    expect(law('{"db.password":"FAKEdot0729"}')).toBe('{"db.password":"[REDACTED]"}');
  });

  it('a flag: --token v', () => {
    // (a) red when the `--name value` reader is removed; (b) prints the shown text.
    expect(law('run --token FAKEflag0729 --verbose')).toBe('run --token [REDACTED] --verbose');
  });

  it('a PEM block: the body hidden, the armour lines kept, at every encoding level', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEFAKEbody0729\nmoreFAKE0729==\n-----END RSA PRIVATE KEY-----';
    const once = law(JSON.stringify({ k: pem, x: 1 }));
    const twice = law(JSON.stringify({ o: JSON.stringify({ k: pem, x: 1 }) }));
    const noEnd = law(
      JSON.stringify({ a: '-----BEGIN X-----\nFAKEbody0729', b: '-----END X-----' }),
    );
    // (a) red when the PEM reader is removed (the body shows), a body with no END runs past its
    //     string's closing quote (the JSON breaks), or an edge splits an escape (the inner JSON
    //     breaks); (b) prints the shown plain text and booleans.
    expect({
      plain: law(pem),
      once: [parses(once), once.includes('FAKE')],
      twice: [
        parses(twice) && parses((JSON.parse(twice) as { o: string }).o),
        twice.includes('FAKE'),
      ],
      noEnd: [parses(noEnd), noEnd.includes('FAKE'), noEnd.includes('"b":"-----END X-----"')],
    }).toEqual({
      plain: '-----BEGIN RSA PRIVATE KEY-----\n[REDACTED]\n-----END RSA PRIVATE KEY-----',
      once: [true, false],
      twice: [true, false],
      noEnd: [true, false, true],
    });
  });

  it('PEM bodies are read once each: 20,000 BEGIN lines with no END pass in well under a second', () => {
    const text = JSON.stringify({ b: '-----BEGIN X----- '.repeat(20_000) });
    const t0 = performance.now();
    disclose(text, NONE, 'all');
    // (a) red when each BEGIN searches the rest of the text again; (b) prints a boolean.
    expect(performance.now() - t0 < 1000).toBe(true);
  });

  it('the new names; `db_pwd` is a credential and `PWD` alone is not', () => {
    // (a) red when a new name is dropped, or `pwd` alone becomes a credential (every `PWD=` path
    //     would hide); (b) prints the shown texts.
    expect([
      law('passphrase=FAKEn0729a pwd_hash=x'),
      law('secret_key_base=FAKEn0729b'),
      law('encryption_key=FAKEn0729c'),
      law('master_key=FAKEn0729d'),
      law('secrets=FAKEn0729e'),
      law('db_pwd=FAKEn0729f'),
      law('PWD=/srv/x'),
    ]).toEqual([
      'passphrase=[REDACTED] pwd_hash=x',
      'secret_key_base=[REDACTED]',
      'encryption_key=[REDACTED]',
      'master_key=[REDACTED]',
      'secrets=[REDACTED]',
      'db_pwd=[REDACTED]',
      'PWD=/srv/x',
    ]);
  });
});

describe('#729 PR-3 correction 1 — kinds and personal names (F15, F23; D-6, D-7)', () => {
  it('F15 (re-aimed, PR3-R2-L1-18): a credential name hiding a subtree that holds a declared value counts as declared', () => {
    const set = compileDisclosure([{ value: DECLARED_VALUE, source: 'declared:D' }], {
      declared: 'resolved',
      audience: 'agent',
      environment: 'swept',
    }).set;
    // The walk hides the subtree whole under the name; its count is the highest kind its text
    // held. Round 1 counted every such hide as a pattern.
    const { tally } = discloseByTable(
      { v: { password: { inner: `x${DECLARED_VALUE}`, n: 1 } } },
      { v: 'value' },
      set,
      'agent',
    );
    // (a) red when the name rule's hide counts as a pattern whatever it hid; (b) prints the counts.
    expect(tally.hidden).toEqual({ declared: 1, environment: 0, pattern: 0 });
  });

  it('F23: on file, a user name held by HOME, USER and LOGNAME is personal; a password equal to it is not', () => {
    const user = 'fakeuser9x';
    const home = `/home/${user}`;
    const shown = (env: Record<string, string>) =>
      disclose(
        `${home}/project`,
        buildDisclosureSet({ env, declared: {}, declaredState: 'resolved', audience: 'file' }).set,
        'all',
      ).text;
    // (a) red when LOGNAME is not personal (the user name inside the path hides), or personal is
    //     widened to any value equal to USER's (the password shows); (b) prints the shown texts.
    expect([
      shown({ HOME: home, USER: user, LOGNAME: user, USERNAME: user }),
      shown({ HOME: home, USER: user, POSTGRES_PASSWORD: user }),
    ]).toEqual([`${home}/project`, '/home/[REDACTED]/project']);
  });

  it('D-6 no loosening: a path PWD holds stays hidden when another variable holds it too', () => {
    const names = environmentEntries(
      { PWD: '/srv/fake-work-0729', WORK_DIR: '/srv/fake-work-0729' },
      { audience: 'agent' },
    ).map((e) => e.source);
    // (a) red when the shell-metadata exclusion drops the value for every variable; (b) prints the
    //     source names.
    expect(names).toEqual(['env:WORK_DIR']);
  });
});

describe("#729 PR-3 correction 1 — D-14: realm's own settings are not secrets; its one credential is", () => {
  const shownOnLog = (env: Record<string, string>, text: string): string =>
    disclose(
      text,
      buildDisclosureSet({ env, declared: {}, declaredState: 'resolved', audience: 'log' }).set,
      'all',
    ).text;

  it('a setting shows on a log (`withheld`, an operator name); REALM_SERVE_TOKEN stays hidden', () => {
    // (a) red when realm's settings are swept like any variable (`withheld` would be hidden), or
    //     REALM_SERVE_TOKEN is treated as a setting (the token would show); (b) prints the texts.
    expect([
      shownOnLog(
        { REALM_MCP_GATE_ANSWERS: 'withheld', REALM_OPERATOR: 'fake-operator-0729' },
        'answers withheld, operator fake-operator-0729',
      ),
      shownOnLog({ REALM_SERVE_TOKEN: 'FAKEservetoken0729' }, 'serve FAKEservetoken0729'),
    ]).toEqual(['answers withheld, operator fake-operator-0729', 'serve [REDACTED]']);
  });

  it("the two lists are exactly the REALM_* variables realm's code reads from the environment", async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const PACKAGES = join(__dirname, '..', '..', '..');
    const sources: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(path);
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          sources.push(path);
        }
      }
    };
    for (const pkg of readdirSync(PACKAGES)) {
      try {
        walk(join(PACKAGES, pkg, 'src'));
      } catch {
        // A folder with no src.
      }
    }
    const texts = sources.map((path) => readFileSync(path, 'utf8'));
    // A name held in a constant (`const GATE_ANSWERS_ENV = 'REALM_…'`) and read through it.
    const constants = new Map<string, string>();
    for (const text of texts)
      for (const m of text.matchAll(/\bconst ([A-Z][A-Z0-9_]*) = ['"](REALM_[A-Z0-9_]+)['"]/g))
        constants.set(m[1]!, m[2]!);
    const read = new Set<string>();
    const quoted = new Set<string>();
    for (const text of texts) {
      for (const m of text.matchAll(/\b(?:process\.env|env)(?:\?\.|\.|\[['"])(REALM_[A-Z0-9_]+)/g))
        read.add(m[1]!);
      for (const m of text.matchAll(/\b(?:process\.env|env)\[([A-Z][A-Z0-9_]*)\]/g)) {
        const name = constants.get(m[1]!);
        if (name !== undefined) read.add(name);
      }
      for (const m of text.matchAll(/['"](REALM_[A-Z0-9_]+)['"]/g)) quoted.add(m[1]!);
    }
    // Every quoted REALM_* name is a variable read above, or a diagnostic code: the scan accounts
    // for every name it saw.
    const NOT_VARIABLES = new Set(['REALM_RELEASE_LINE_MISMATCH']);
    const unaccounted = [...quoted].filter((n) => !read.has(n) && !NOT_VARIABLES.has(n));
    // (a) red when a REALM_* variable is read and in neither list (a new setting would be swept,
    //     a new credential shown), a listed name is no longer read, or a name is read some way the
    //     scan cannot see; (b) prints the names (never values) and whether 200+ files were read.
    // REALM_NOT_SECRET names other variables; the walk exempts it by name.
    const classified = [
      ...REALM_SETTING_VARIABLES,
      ...REALM_CREDENTIAL_VARIABLES,
      NOT_SECRET_ENV,
    ].sort();
    expect({ read: [...read].sort(), unaccounted, scanned: sources.length > 200 }).toEqual({
      read: classified,
      unaccounted: [],
      scanned: true,
    });
  });
});

// ── #729 PR-3 correction 2: RECORD 09's rules ───────────────────────────────────────────────────
// Every value is fake. Each assertion names (a) the change that turns it red and (b) what it prints:
// fake text, counts and booleans.
const ROUND1_NONE = round1.compileDisclosure([], { declared: 'resolved', audience: 'agent' }).set;
const round1Law = (text: string): string => round1.disclose(text, ROUND1_NONE, 'all').text;
const withMembers = (entries: DisclosureEntry[]) =>
  compileDisclosure(entries, { declared: 'resolved', audience: 'agent', environment: 'swept' }).set;

describe('#729 PR-3 correction 2 — the allowed differences (E-1’’): the current law shows what round 1 hid, by rule', () => {
  it('D-4: an ordinary word after a scheme word is shown (round 1 hid it)', () => {
    // (a) red when the token-shape test is removed (the word is hidden again); (b) prints texts.
    expect([law('Bearer abcdefghijklmn'), round1Law('Bearer abcdefghijklmn')]).toEqual([
      'Bearer abcdefghijklmn',
      'Bearer [REDACTED]',
    ]);
  });

  it('E-4: `${secret:IDENT}` keeps its identifier (round 1 hid it)', () => {
    // (a) red when the reference form is no longer recognised (the identifier is hidden); (b)
    //     prints texts.
    expect([law('${secret:FAKE_REF_0729}'), round1Law('${secret:FAKE_REF_0729}')]).toEqual([
      '${secret:FAKE_REF_0729}',
      '${secret:[REDACTED]',
    ]);
  });

  it('E-2 narrowed (correction 7): a quote glued to more text is part of the value — the tail is hidden, as round 1 hid it', () => {
    const text = "echo 'run password=Xk9'}qFAKEtail0729";
    // (a) red when the closing test is dropped (the base's cut before any character: the tail
    //     shows); (b) prints texts.
    expect([law(text), round1Law(text)]).toEqual([
      "echo 'run password=[REDACTED]",
      "echo 'run password=[REDACTED]",
    ]);
  });

  it('R30: a URL password holding a raw `"` is not read (round 1 hid it)', () => {
    const text = 'dsn postgres://u:pa"FAKEpw0729@host/db';
    // (a) red when the userinfo region no longer stops at `"` (round 1's behaviour: hidden); (b)
    //     prints texts.
    expect([law(text), round1Law(text)]).toEqual([text, 'dsn postgres://u:[REDACTED]@host/db']);
  });

  it('R29: a quoted key written as a JSON string twice is not read; its value shows, a member is still hidden', () => {
    // The object's text written as a JSON string twice: its keys read `\\\"password\\\"`.
    const twice = JSON.stringify(JSON.stringify(JSON.stringify({ password: 'FAKEr29value0729' })));
    const member = withMembers([{ value: 'FAKEr29value0729', source: 'declared:R' }]);
    // (a) red when the name rule reads a key at the third escape level (the value is hidden), or
    //     members stop covering it; (b) prints two booleans.
    expect({
      shownByName: law(twice).includes('FAKEr29value0729'),
      hiddenAsMember: !law(twice, member).includes('FAKEr29value0729'),
    }).toEqual({ shownByName: true, hiddenAsMember: true });
  });
});

describe('#729 PR-3 correction 2 — the anchors (E-2’, E-2’’, E-3, E-3’, E-4, E-5, E-6’)', () => {
  it("E-2': an apostrophe before a credential pair opens no quote, so the value is hidden whole", () => {
    // (a) red when every `'` opens a quote (the value ends at its inner quote; the tail shows);
    //     (b) prints the shown text.
    expect(law("it's set: password=Xk9')FAKEtail0729")).toBe("it's set: password=[REDACTED]");
  });

  it("E-2'': an escape's letter beside a quote is not a letter, so an encoded line's quotes still pair", () => {
    const text = JSON.stringify("x\n'Password': 'FAKEpw0729abc' | refreshToken=Xk9'}qFAKEtail0729");
    // (a) red when the letter of `\n` makes the quote after it an apostrophe (the quote count is
    //     off and the later tail shows); (b) prints two booleans.
    expect({
      passwordHidden: !law(text).includes('FAKEpw0729abc'),
      tailHidden: !law(text).includes('FAKEtail0729'),
    }).toEqual({ passwordHidden: true, tailHidden: true });
  });

  it('E-3: a name is read again through a member that spells part of it (R2-L1-08)', () => {
    const declared = withMembers([{ value: 'secret', source: 'declared:S' }]);
    const env = withMembers([{ value: 'db_password', source: 'env:E' }]);
    // (a) red when the name is read only up to the member (`client_` / nothing: the value shows);
    //     (b) prints the shown texts.
    expect([
      law('client_secret: FAKEcsvalue9', declared),
      law('db_password=FAKEhunter9', env),
    ]).toEqual(['client_[REDACTED]: [REDACTED]', '[REDACTED]=[REDACTED]']);
  });

  it("E-3': a lowercase credential pair right after an encoded line break or tab is read whole", () => {
    // (a) red when the name reader takes the escape's letter (`npassphrase`, `tpasswd`: the values
    //     show); (b) prints the shown texts.
    expect([
      law(JSON.stringify({ log: 'connect failed\npassphrase=FAKEpp0729abc' })),
      law(JSON.stringify({ log: 'ok\tpasswd=FAKEpd0729abc' })),
    ]).toEqual([
      '{"log":"connect failed\\npassphrase=[REDACTED]"}',
      '{"log":"ok\\tpasswd=[REDACTED]"}',
    ]);
  });

  it('E-4: only `${secret:IDENT}` (IDENT in A–Z 0–9 _) is a reference; a default after another name is a value (R2-L1-07)', () => {
    // (a) red when any `${NAME:IDENT}` is read as a reference (the default shows) or a lower-case
    //     identifier counts (it shows); (b) prints the shown texts.
    expect([
      law('url=${DB_PASSWORD:FAKEdefault9}'),
      law('${secret:fakeRef0729}'),
      law('${secret:DB_PASS_0729}'),
    ]).toEqual(['url=${DB_PASSWORD:[REDACTED]', '${secret:[REDACTED]', '${secret:DB_PASS_0729}']);
  });

  it('E-5: a comparison needs white space on both sides; `password==v` is a value starting with `=` (R2-L1-10)', () => {
    // (a) red when `==` with no white space reads as a comparison (the value shows), or a spaced
    //     comparison reads as a separator (the right side is hidden); (b) prints the shown texts.
    expect([
      law('password==FAKEeqStart9'),
      law('x.token == true'),
      law('a.secret != null'),
    ]).toEqual(['password=[REDACTED]', 'x.token == true', 'a.secret != null']);
  });

  it("E-6': a key named `pwd` alone is the working folder only when its value is a path", () => {
    // (a) red when the value is not read for `pwd` (the ODBC password shows); (b) prints the shown
    //     texts.
    expect([
      law('Server=db;Database=app;Uid=sa;Pwd=FAKEodbc9;'),
      law('PWD=/srv/app OLDPWD=~/x'),
      law('pwd: "FAKEodbc9q"'),
    ]).toEqual([
      'Server=db;Database=app;Uid=sa;Pwd=[REDACTED];',
      'PWD=/srv/app OLDPWD=~/x',
      'pwd: "[REDACTED]"',
    ]);
    expect([
      isCredentialName('pwd'),
      isCredentialName('pwd', '/srv'),
      isCredentialName('Pwd', 'x9'),
    ]).toEqual([false, false, true]);
  });
});

describe('#729 PR-3 correction 2 — E-7: speed without loosening', () => {
  it('the flag pass starts its own mark: a flag value inside an earlier value’s run is still hidden (R2-L1-03)', () => {
    const json = JSON.stringify({ cmd: 'curl --password FAKEpw1230729 -d secret=x' });
    // (a) red when the mark carried from the name pass makes the flag value resume past itself
    //     (it shows); (b) prints the shown text and a boolean.
    expect({
      text: law('curl --password FAKEpw1230729 -d secret=x'),
      parses: parses(law(json)),
    }).toEqual({
      text: 'curl --password [REDACTED] -d secret=[REDACTED]',
      parses: true,
    });
  });

  it('a quoted value inside an earlier run is read from its own start: nothing past it is eaten, JSON stays JSON, I11 holds (R2-L1-04)', () => {
    const shell = `secret='a "token":"b" c', next="visible"`;
    const json = `{"password":"abc token:\\"zz\\" q","y":"visible"}`;
    // (a) red when a quoted value resumes at the earlier run's end (it runs past its closing quote:
    //     `visible` is eaten, the JSON breaks, a second pass changes the text); (b) prints texts and
    //     booleans.
    expect({
      shell: law(shell),
      json: law(json),
      parses: parses(law(json)),
      i11: law(law(shell)) === law(shell) && law(law(json)) === law(json),
    }).toEqual({
      shell: `secret='[REDACTED]', next="visible"`,
      json: `{"password":"[REDACTED]","y":"visible"}`,
      parses: true,
      i11: true,
    });
  });

  // The cell's own timeout: the red run scans quadratically for about 25 s, and the clock must not
  // be what fails it.
  it('the URL rule is linear: an 8× input takes under 22× the time (R2-L1-06)', () => {
    // A timing threshold, so the two hypotheses are kept far apart and the estimator is the
    // minimum (noise only ever adds time): an 8× input costs the linear rule about 8× (8.4–8.9×
    // measured, the whole pass at 40k being about 40 ms) and the quadratic scan it replaced 64×;
    // the bound is their geometric midpoint. The first form of this cell (2× input, bound 3×, the
    // median of three) went red on CI twice with the rule linear (2026-10-27, 2026-10-28): its
    // margin was 1.5× and seven samples here spread 1.7×.
    const time = (n: number): number => {
      const text = 'a://'.repeat(Math.ceil(n / 4));
      let least = Infinity;
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        disclose(text, NONE, 'all');
        least = Math.min(least, performance.now() - t0);
      }
      return least;
    };
    time(40_000);
    // A floor on the baseline, for a machine where the small pass is within the timer's grain.
    const small = Math.max(time(40_000), 5);
    const large = time(320_000);
    // (a) red when the last `@` is looked for backwards over the whole text from every `://`
    //     (`text.lastIndexOf('@', regionStop)` in place of the pass's own `regionLastAt`: 64× in
    //     theory, 47× measured, the large pass about 5 s a sample); (b) prints the large time
    //     against its bound, and the two times with their ratio in the message (a matched object
    //     elides them).
    expect(
      large,
      `small ${small.toFixed(1)} ms, large ${large.toFixed(1)} ms, ratio ${(large / small).toFixed(1)} (bound 22)`,
    ).toBeLessThan(22 * small);
  }, 60_000);
});

describe('#729 PR-3 correction 3 — the law (H-1’’, H-2, H-4, H-6)', () => {
  const hidden = (text: string, ...canaries: string[]): boolean[] =>
    canaries.map((c) => !law(text).includes(c));
  const i11 = (text: string): boolean => law(law(text)) === law(text);

  it('H-1: a value opened by an escaped quote is hidden whole when that quote is already open on its line (R3-L1-08)', () => {
    const shapes = [
      // Level 1 `'`, after a non-apostrophe `\'` and after a contraction; and once more encoded.
      "note \\'x export PASSWORD=\\'FAKEsq0729bcd\\' && go",
      "echo can\\'t connect; export PASSWORD=\\'FAKEsq0729bcf\\' && go",
      JSON.stringify({ log: "note \\'x export PASSWORD=\\'FAKEsq0729bcg\\' && go" }),
      // Level 2 `"`, raw; level 3 `"`, a JSON log written as a JSON string once more.
      'x \\\\"q password=\\\\"FAKEl2q0729bc\\\\" y',
      JSON.stringify({ out: '{"msg":"say \\"hi password=\\"FAKEdk0729bcf\\" x"}' }),
    ];
    const canaries = [
      'FAKEsq0729bcd',
      'FAKEsq0729bcf',
      'FAKEsq0729bcg',
      'FAKEl2q0729bc',
      'FAKEdk0729bcf',
    ];
    // (a) red when a backslash-opened value takes the unquoted path from its opening (its quote is
    //     open, so nothing is marked); (b) prints booleans.
    expect({
      hidden: shapes.map((s, i) => hidden(s, canaries[i]!)[0]),
      i11: shapes.map(i11),
    }).toEqual({ hidden: [true, true, true, true, true], i11: [true, true, true, true, true] });
  });

  it("H-1: with no closing quote on its line, the next line's same-token quote closes the value — one line, bounded (PR3-C3AUD-03; correction 5, J-1)", () => {
    const lines = "password=\\'FAKEnc0729bcd x\ntoken=\\'FAKEnc0729bcf\\' y";
    const log = '{"log":"password=\\\\\'FAKEnc0729bcg\' x","y":"visible"}';
    // Correction 5 (J-1, H-1''''): the value runs to the closer on the NEXT line — line 2's opening
    // quote, the cost the record accepts (the text up to it is hidden, one line, never more); the
    // line break stays. (a) red when the next line is not looked at (`x` and `token=` shown), or the
    // line break is hidden; (b) prints the shown texts and a boolean.
    expect({ lines: law(lines), log: law(log), parses: parses(law(log)) }).toEqual({
      lines: "password=\\'[REDACTED]\n[REDACTED]\\'[REDACTED] y",
      log: '{"log":"password=\\\\\'[REDACTED] x","y":"visible"}',
      parses: true,
    });
  });

  it('H-1: two escaped-quoted values glued, either quote, raw and in a JSON log: both hidden (PR3-C3AUD2-05)', () => {
    const shapes: Array<[string, string, string]> = [
      ['password=\\"FAKEgp0729bcd\\"\\"FAKEgp0729bcf\\" next', 'FAKEgp0729bcd', 'FAKEgp0729bcf'],
      ["password=\\'FAKEgp0729bcg\\'\\'FAKEgp0729bch\\' next", 'FAKEgp0729bcg', 'FAKEgp0729bch'],
      [
        JSON.stringify({ log: 'password="FAKEgp0729bcj""FAKEgp0729bck"', n: 1 }),
        'FAKEgp0729bcj',
        'FAKEgp0729bck',
      ],
      [
        JSON.stringify({ log: "password=\\'FAKEgp0729bcl\\'\\'FAKEgp0729bcm\\'", n: 1 }),
        'FAKEgp0729bcl',
        'FAKEgp0729bcm',
      ],
    ];
    // (a) red when an escaped quote right after the closing quote closes the value (the second
    //     shows), or D-5's `\"`-only block decides `\"` values first (its exclusion shows the
    //     second), or (correction 4, I-10) the value runs past its tail to the end of the text (the
    //     word after it is hidden); (b) prints booleans.
    expect({
      hidden: shapes.map(([s, a, b]) => hidden(s, a, b)),
      i11: shapes.map(([s]) => i11(s)),
      logParses: [parses(law(shapes[2]![0])), parses(law(shapes[3]![0]))],
      nextShown: [law(shapes[0]![0]).endsWith(' next'), law(shapes[1]![0]).endsWith(' next')],
    }).toEqual({
      hidden: [
        [true, true],
        [true, true],
        [true, true],
        [true, true],
      ],
      i11: [true, true, true, true],
      logParses: [true, true],
      nextShown: [true, true],
    });
  });

  it('H-2: a credential name right after a literal backslash is read through the escape letter (R3-L1-10); S-1 still holds', () => {
    // (a) red when the bare name is read only up to the escape letter (`oken`: the values show);
    //     (b) prints the shown texts.
    expect([
      law('C:\\app\\token: FAKEev0729bcf'),
      law('\\\\token==FAKEev0729bcd x'),
      law(JSON.stringify({ p: 'C:\\app\\token: FAKEev0729bcg' })),
      law(JSON.stringify({ log: 'connect failed\npassphrase=FAKEpp0729bcd' })),
    ]).toEqual([
      'C:\\app\\token: [REDACTED]',
      '\\\\token=[REDACTED] x',
      '{"p":"C:\\\\app\\\\token: [REDACTED]"}',
      '{"log":"connect failed\\npassphrase=[REDACTED]"}',
    ]);
  });

  it("H-4: `it\\'s` is an apostrophe, so a later `\\'` inside a value does not end it (R3-L1-12)", () => {
    // (a) red when the letter before the quote's backslash run is not read (`it\'s` opens a quote;
    //     the value ends at its own `\'` and `cdFAKE…` shows); (b) prints the shown text.
    expect(law("it\\'s set DB_PASSWORD=ab\\'cdFAKEap0729bcd")).toBe(
      "it\\'s set DB_PASSWORD=[REDACTED]",
    );
  });

  it('H-6: a quote under more than fifteen backslashes never ends a value (PR3-C3AUD-04)', () => {
    const text = `"open password=FAKEcp0729bcd${'\\'.repeat(16)}"FAKEcp0729bcf rest`;
    // (a) red when a quote's level is not capped (level 16 wraps onto the level-0 `"` that is open,
    //     so the value ends there and the second canary shows), or (correction 4, I-10) the value
    //     runs to the end of the text (`rest` is hidden); (b) prints booleans.
    expect({
      hidden: hidden(text, 'FAKEcp0729bcd', 'FAKEcp0729bcf'),
      restShown: law(text).endsWith(' rest'),
    }).toEqual({ hidden: [true, true], restShown: true });
  });
});

describe('#729 PR-3 correction 4 — the law (I-1, I-2, I-3)', () => {
  const i11 = (text: string): boolean => law(law(text)) === law(text);

  it('I-1: an escaped-quote value with no closer on its line is read past a leading blank or tab; the rest shows (PR3-R4-R-01)', () => {
    const shapes = [
      'password=\\" FAKEh1c40729bcd\nnext line',
      '{"log":"password=\\" FAKEh2c40729bcd","next":"field"}',
      'password=\\"\tFAKEh3c40729bcd\nnext line',
    ];
    const empty = 'password=\\"   \nnext line';
    // (a) red when the fallback reads from the character right after the opening quote (a blank
    //     or a tab ends the run at once, so the canary shows), or when it reads past the line
    //     break (the empty value's next line is hidden); (b) prints the shown texts and booleans.
    expect({
      shown: shapes.map((t) => law(t)),
      i11: shapes.map(i11),
      parses: parses(law(shapes[1]!)),
      emptyUnchanged: law(empty) === empty,
    }).toEqual({
      shown: [
        'password=\\" [REDACTED]\nnext line',
        '{"log":"password=\\" [REDACTED]","next":"field"}',
        'password=\\"\t[REDACTED]\nnext line',
      ],
      i11: [true, true, true],
      parses: true,
      emptyUnchanged: true,
    });
  });

  it('I-2: a quote of the same character right after a level-0 closer glues a tail: both halves hidden, `rest` shown (PR3-R4-R-03)', () => {
    const shapes = [
      "password='FAKEi1c40729bcd''FAKEi2c40729bcd' rest",
      'password="FAKEi3c40729bcd""FAKEi4c40729bcd" rest',
      // Each quote inside a log line quoted with the other character, so it stays at level 0.
      JSON.stringify({ log: "password='FAKEi5c40729bcd''FAKEi6c40729bcd' rest" }),
      "{'log': 'password=\"FAKEi7c40729bcd\"\"FAKEi8c40729bcd\" rest', 'n': 1}",
    ];
    // (a) red when a quote after the closer ends the value whatever its character (the second
    //     half shows), or when the glued tail runs to the end of the text (`rest` is hidden);
    //     (b) prints the shown texts and booleans.
    expect({
      shown: shapes.map((t) => law(t)),
      i11: shapes.map(i11),
      parses: parses(law(shapes[2]!)),
    }).toEqual({
      shown: [
        "password='[REDACTED]'[REDACTED] rest",
        'password="[REDACTED]"[REDACTED] rest',
        JSON.stringify({ log: "password='[REDACTED]'[REDACTED] rest" }),
        "{'log': 'password=\"[REDACTED]\"[REDACTED] rest', 'n': 1}",
      ],
      i11: [true, true, true, true],
      parses: true,
    });
  });

  it('I-2 control (re-pinned at correction 7, correction 1, C1-5): a quote of the other character after the closer ends the value only where it closes; glued to more text it is part of the value, hidden', () => {
    const shapes = [
      `"password='FAKEv1c40729bcd'" next`,
      `password='FAKEv2c40729bcd'"x" next`,
      `password="FAKEv3c40729bcd"'x' next`,
    ];
    // Correction 7, correction 1 hides `"x"` and `'x'` (corrections 2–7 showed them; round 1 hid
    // the first): the bar's "hides more" side. (a) red when the closer closes before any quote of
    // the other character again (the single-character test: `"x"` / `'x'` shown); (b) prints the
    // shown texts.
    expect(shapes.map((t) => law(t))).toEqual([
      `"password='[REDACTED]'" next`,
      `password='[REDACTED]'[REDACTED] next`,
      `password="[REDACTED]"[REDACTED] next`,
    ]);
  });

  it("I-3: several standings are named by the weakest one's own cause (PR3-R4-R-07)", () => {
    // (a) red when the cause is taken from the first standing that is not resolved (`partial`'s
    //     `manifest_changed` beside `unknown`); (b) prints the standings.
    expect(
      weakestDeclared([
        { declared: 'partial', declaredCause: 'manifest_changed' },
        { declared: 'unknown', declaredCause: 'load_failed' },
      ]),
    ).toEqual({ declared: 'unknown', declaredCause: 'load_failed' });
  });

  it('I-3 controls: the reversed pair, and a resolved standing beside a partial one, keep their names', () => {
    // (a) red when the cause is taken from a standing that is not the weakest (the reversed
    //     pair) or from a resolved one; (b) prints the standings.
    expect([
      weakestDeclared([
        { declared: 'unknown', declaredCause: 'load_failed' },
        { declared: 'partial', declaredCause: 'manifest_changed' },
      ]),
      weakestDeclared([
        { declared: 'resolved' },
        { declared: 'partial', declaredCause: 'manifest_changed' },
      ]),
    ]).toEqual([
      { declared: 'unknown', declaredCause: 'load_failed' },
      { declared: 'partial', declaredCause: 'manifest_changed' },
    ]);
  });
});

describe('#729 PR-3 correction 5 — J-1: a quoted value continues onto the next line only when that line holds its closer', () => {
  const i11 = (text: string): boolean => law(law(text)) === law(text);
  const shown = (texts: string[]) => ({
    shown: texts.map((t) => law(t)),
    i11: texts.map(i11),
  });

  it('the backslash path, closer on line 2: both halves hidden, the line break kept, `rest` shown (PR3-R4-R-04)', () => {
    const texts = [
      'password=\\"FAKEj30729bcd\nFAKEj40729bcd\\" rest',
      "password=\\'FAKEj30729bcf\nFAKEj40729bcf\\' rest",
    ];
    // (a) red when the next line is not looked at (the second half shows); (b) prints the shown
    //     texts and booleans.
    expect(shown(texts)).toEqual({
      shown: [
        'password=\\"[REDACTED]\n[REDACTED]\\" rest',
        "password=\\'[REDACTED]\n[REDACTED]\\' rest",
      ],
      i11: [true, true],
    });
  });

  it("the backslash path, closer on line 2, inside a '-quoted log line", () => {
    const texts = [
      "{'log': 'password=\\\\\"FAKEj30729bcg\nFAKEj40729bcg\\\\\" rest'}",
      "{'log': 'password=\\\\'FAKEj30729bch\nFAKEj40729bch\\\\' rest'}",
    ];
    // (a) red when the next line is not looked at (the second half shows); (b) prints the shown
    //     texts and booleans.
    expect(shown(texts)).toEqual({
      shown: [
        "{'log': 'password=\\\\\"[REDACTED]\n[REDACTED]\\\\\" rest'}",
        "{'log': 'password=\\\\'[REDACTED]\n[REDACTED]\\\\' rest'}",
      ],
      i11: [true, true],
    });
  });

  it('control, the backslash path, no closer on line 2: the value ends on its line; line 2 is read on its own', () => {
    // (a) red when any next line is taken (`token=` and `x` are swallowed — an over-hide); (b)
    //     prints the shown text and a boolean.
    expect(shown(['password=\\"FAKEj50729bcd\ntoken=FAKEj60729bcd x'])).toEqual({
      shown: ['password=\\"[REDACTED]\ntoken=[REDACTED] x'],
      i11: [true],
    });
  });

  it('control, the backslash path, two breaks: the closer two lines on is never taken', () => {
    // (a) red when the look-ahead goes past the second line (`middle` is hidden); (b) prints the
    //     shown text and a boolean.
    expect(shown(['password=\\"FAKEj70729bcd\nmiddle\nFAKEj80729bcd\\" rest'])).toEqual({
      shown: ['password=\\"[REDACTED]\nmiddle\nFAKEj80729bcd\\" rest'],
      i11: [true],
    });
  });

  it('level 0, closer on line 2: both halves hidden, the line break kept, `rest` shown', () => {
    // (a) red when the next line is not looked at (the second half shows); (b) prints the shown
    //     text and a boolean.
    expect(shown(['password="FAKEj10729bcd\nFAKEj20729bcd" rest'])).toEqual({
      shown: ['password="[REDACTED]\n[REDACTED]" rest'],
      i11: [true],
    });
  });

  it('level 0, two breaks: line 1 hidden; `middle` and the line after it shown (every earlier law hid them; the owner’s word)', () => {
    // (a) red when the look-ahead goes past the second line (`middle` is hidden); (b) prints the
    //     shown text and a boolean.
    expect(shown(['password="FAKEj70729bcf\nmiddle\nFAKEj80729bcf" rest'])).toEqual({
      shown: ['password="[REDACTED]\nmiddle\nFAKEj80729bcf" rest'],
      i11: [true],
    });
  });

  it('level 0, no closer anywhere: the value ends on its own line; the lines after it shown (never to the end of the text)', () => {
    // (a) red when the line bound is removed (the value runs to the end of the text, the following
    //     lines gone); (b) prints the shown texts and booleans.
    expect(
      shown([
        'password="FAKEj90729bcd\nCompleted: (none)\nCreated: 2026',
        'password=" FAKEj100729bcd',
      ]),
    ).toEqual({
      shown: ['password="[REDACTED]\nCompleted: (none)\nCreated: 2026', 'password=" [REDACTED]'],
      i11: [true, true],
    });
  });
});

describe('#729 PR-3 correction 6 — J-1 backslash continuation: a backslash before a raw line break continues the level-0 value, LF or CRLF alike', () => {
  const i11 = (text: string): boolean => law(law(text)) === law(text);
  const shown = (texts: string[]) => ({
    shown: texts.map((t) => law(t)),
    i11: texts.map(i11),
  });

  it('CRLF: the closer on the third physical line — the three parts hidden, every break kept (correction 5 showed the second and third)', () => {
    // (a) red when only the `\r` is stepped over (correction 5's law: the second and third parts
    //     show); (b) prints the shown text (fake canaries, markers) and a boolean.
    expect(shown(['password="FAKEc6j1a\\\r\nFAKEc6j1b\r\nFAKEc6j1c" rest'])).toEqual({
      shown: ['password="[REDACTED]\r\n[REDACTED]\r\n[REDACTED]" rest'],
      i11: [true],
    });
  });

  it('control, LF: the same three parts hidden, as before', () => {
    // (a) red when a backslash ends the line's scan instead of continuing it (the second and third
    //     parts show); (b) prints the shown text and a boolean.
    expect(shown(['password="FAKEc6j2a\\\nFAKEc6j2b\nFAKEc6j2c" rest'])).toEqual({
      shown: ['password="[REDACTED]\n[REDACTED]\n[REDACTED]" rest'],
      i11: [true],
    });
  });

  it('control: an escaped quote on one line is stepped over; the value runs to the closer after it', () => {
    // (a) red when a backslash no longer steps over the character after it (the value ends at the
    //     escaped quote, `still` shows); (b) prints the shown text and a boolean.
    expect(shown(['password="FAKEc6j3a\\"still" rest'])).toEqual({
      shown: ['password="[REDACTED]" rest'],
      i11: [true],
    });
  });

  it('control: a backslash-ended line whose closer stands on the next line — both parts hidden through the break', () => {
    // Two mechanisms hide the second part here: the continuation (the next line is part of the
    // value's logical line) and the next-line look-ahead. (a) red only when neither takes the closer
    // (a backslash ends the line AND the look-ahead is removed: the second part shows); either alone
    // keeps it green; (b) prints the shown texts and booleans.
    expect(
      shown(['password="FAKEc6j4a\\\nFAKEc6j4b" rest', 'password="FAKEc6j4c\\\r\nFAKEc6j4d" rest']),
    ).toEqual({
      shown: ['password="[REDACTED]\n[REDACTED]" rest', 'password="[REDACTED]\r\n[REDACTED]" rest'],
      i11: [true, true],
    });
  });

  it('control (the fallback): continued lines with no closer anywhere — the value ends on its first physical line, the rest shown', () => {
    // (a) red when the no-closer fallback hides past the first physical line (`middle\`, `tail` and
    //     `other` gone); (b) prints the shown texts and booleans.
    expect(
      shown([
        'password="FAKEc6j5a\\\nmiddle\\\ntail\nother',
        'password="FAKEc6j5b\\\r\nmiddle\\\r\ntail\r\nother',
      ]),
    ).toEqual({
      shown: [
        'password="[REDACTED]\nmiddle\\\ntail\nother',
        'password="[REDACTED]\r\nmiddle\\\r\ntail\r\nother',
      ],
      i11: [true, true],
    });
  });
});

describe('#729 PR-3 correction 7 — the quote closer, E-2’s terminator and the scheme word’s extend (C7-1, C7-2, C7-2b)', () => {
  const i11 = (text: string): boolean => law(law(text)) === law(text);
  const shown = (texts: string[]) => ({
    shown: texts.map((t) => law(t)),
    i11: texts.map(i11),
  });
  const parses = (text: string): boolean => {
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  };

  it('C7-1 + C7-2, the lane’s shape: after a continued quoted value, a glued tail is hidden — LF and CRLF', () => {
    // Two mechanisms hide the tail: the next line's quote is the quoted value's closer (C7-1, so no
    // quote is open at `refreshToken=`), and a glued quote is part of the value (C7-2); cells below
    // isolate each. (a) red when both are reverted (the pass resets at every line break and E-2 cuts
    // before any character: `[REDACTED]'}qFAKEc7a4`); (b) prints the shown texts (fakes, markers)
    // and booleans.
    expect(
      shown([
        "token='FAKEc7a1\\\nFAKEc7a2\nFAKEc7a3' rest  refreshToken=Xk9'}qFAKEc7a4",
        "token='FAKEc7a1\\\r\nFAKEc7a2\r\nFAKEc7a3' rest  refreshToken=Xk9'}qFAKEc7a4",
      ]),
    ).toEqual({
      shown: [
        "token='[REDACTED]\n[REDACTED]\n[REDACTED]' rest  refreshToken=[REDACTED]",
        "token='[REDACTED]\r\n[REDACTED]\r\n[REDACTED]' rest  refreshToken=[REDACTED]",
      ],
      i11: [true, true],
    });
  });

  it('C7-1 alone: the closer on the next line is a closer — a later quote before a blank is inside the value, as round 1 read it', () => {
    // (a) red when the pass is the base's (it resets at every line break and is told no closer:
    //     the quote opens, E-2 cuts before the blank, `[REDACTED]' next`); C7-2 cannot save it, a
    //     blank follows the quote; (b) prints the shown texts and booleans.
    expect(
      shown([
        "token='FAKEc7b1\\\nFAKEc7b2\nFAKEc7b3' rest  refreshToken=Xk9' next",
        "token='FAKEc7b1\\\r\nFAKEc7b2\r\nFAKEc7b3' rest  refreshToken=Xk9' next",
      ]),
    ).toEqual({
      shown: [
        "token='[REDACTED]\n[REDACTED]\n[REDACTED]' rest  refreshToken=[REDACTED] next",
        "token='[REDACTED]\r\n[REDACTED]\r\n[REDACTED]' rest  refreshToken=[REDACTED] next",
      ],
      i11: [true, true],
    });
  });

  it('C7-2 alone: a quote glued to more text is part of the value — one line, each glue round 1 hid', () => {
    // (a) red when the closing test is dropped (the base's cut before any character: each tail
    //     shows); (b) prints the shown texts and booleans.
    expect(
      shown([
        "echo 'run password=Xk9'}qFAKEc7c1",
        '"note password=Xk9"FAKEc7c2',
        "'x password=Xk9'FAKEc7c3",
        "echo 'run password=Xk9')FAKEc7c4",
        "echo 'run password=ab']FAKEc7c5",
        "note \\'x password=ab\\'cdFAKEc7c6",
      ]),
    ).toEqual({
      shown: [
        "echo 'run password=[REDACTED]",
        '"note password=[REDACTED]',
        "'x password=[REDACTED]",
        "echo 'run password=[REDACTED]",
        "echo 'run password=[REDACTED]",
        "note \\'x password=[REDACTED]",
      ],
      i11: [true, true, true, true, true, true],
    });
  });

  it('C7-2, the JSON closer run: a quote before closing brackets and quotes and then the end closes — the JSON still parses', () => {
    const texts = [
      '{"a":"Authorization: Bearer FAKEc7j1"}',
      '{"log":"connect failed\\npassphrase=FAKEc7j2"}',
      '{"p":"C:\\\\app\\\\token: FAKEc7j3"}',
      JSON.stringify('{"p":"password=FAKEc7j4"}'),
      '["password=FAKEc7j5"]',
    ];
    const out = texts.map((t) => law(t));
    // (a) red when the closing run is dropped from the closing test (the terminator alone: the
    //     `"}` is swallowed into the value and the JSON no longer parses); (b) prints the shown
    //     texts and booleans.
    expect({
      ...shown(texts),
      parses: out.map(parses),
      innerParses: parses(out[3]!) && parses(JSON.parse(out[3]!) as string),
    }).toEqual({
      shown: [
        '{"a":"Authorization: [REDACTED]"}',
        '{"log":"connect failed\\npassphrase=[REDACTED]"}',
        '{"p":"C:\\\\app\\\\token: [REDACTED]"}',
        '"{\\"p\\":\\"password=[REDACTED]\\"}"',
        '["password=[REDACTED]"]',
      ],
      i11: [true, true, true, true, true],
      parses: [true, true, true, true, true],
      innerParses: true,
    });
  });

  it('C1 soup: after a continued quoted value, a bracketed name’s glued tail is hidden — LF and CRLF', () => {
    // (a) red when both rules are reverted (`[passwd: [REDACTED]"FAKEc7d4' y`); (b) prints the
    //     shown texts and booleans.
    expect(
      shown([
        'refreshToken="FAKEc7d1\\\nFAKEc7d2\nFAKEc7d3"  [passwd: ab"FAKEc7d4\' y',
        'refreshToken="FAKEc7d1\\\r\nFAKEc7d2\r\nFAKEc7d3"  [passwd: ab"FAKEc7d4\' y',
      ]),
    ).toEqual({
      shown: [
        'refreshToken="[REDACTED]\n[REDACTED]\n[REDACTED]"  [passwd: [REDACTED] y',
        'refreshToken="[REDACTED]\r\n[REDACTED]\r\n[REDACTED]"  [passwd: [REDACTED] y',
      ],
      i11: [true, true],
    });
  });

  it('C1b: the names round 1 did not read (`db_pwd`, `passphrase`, `Pwd`) — their glued tails hidden, LF and CRLF', () => {
    // No frozen reference hides these tails (round 1 does not read the names; corrections 2–6 cut
    // at the glued quote): this cell is their guard until correction 7's own reference. (a) red
    // when both rules are reverted (each `[REDACTED]'}qFAKEc7e4` tail shows); (b) prints the shown
    // texts and booleans.
    const texts = ['db_pwd', 'passphrase', 'Pwd'].flatMap((name) => [
      `Password='FAKEc7e1\\\nFAKEc7e2\nFAKEc7e3' rest & ${name}=Xk9'}qFAKEc7e4`,
      `Password='FAKEc7e1\\\r\nFAKEc7e2\r\nFAKEc7e3' rest & ${name}=Xk9'}qFAKEc7e4`,
    ]);
    expect(shown(texts)).toEqual({
      shown: ['db_pwd', 'passphrase', 'Pwd'].flatMap((name) => [
        `Password='[REDACTED]\n[REDACTED]\n[REDACTED]' rest & ${name}=[REDACTED]`,
        `Password='[REDACTED]\r\n[REDACTED]\r\n[REDACTED]' rest & ${name}=[REDACTED]`,
      ]),
      i11: [true, true, true, true, true, true],
    });
  });

  it('C1c: after an earlier unclosed quote, a later glued tail is hidden (LF; correction 5’s bound shows the two lines after `TOKEN=`)', () => {
    // (a) red when both rules are reverted (`db.password=[REDACTED]")qFAKEc7f8 next`); (b) prints
    //     the shown text and a boolean.
    expect(
      shown([
        'TOKEN=\'FAKEc7f1\nmiddle FAKEc7f2\nend FAKEc7f3\taccess_token=FAKEc7f4&  credentials="FAKEc7f5\\\nFAKEc7f6\nFAKEc7f7" rest  db.password=Xk9")qFAKEc7f8 next',
      ]),
    ).toEqual({
      shown: [
        'TOKEN=\'[REDACTED]\nmiddle FAKEc7f2\nend FAKEc7f3\taccess_token=[REDACTED]&  credentials="[REDACTED]\n[REDACTED]\n[REDACTED]" rest  db.password=[REDACTED] next',
      ],
      i11: [true],
    });
  });

  it('control: E-2’s designed cut stands on one line — before every terminator and at the text’s end, the closing quote shown', () => {
    // (a) red when E-2 is removed outright (the value runs to its terminator: each quote hidden);
    //     (b) prints the shown texts and booleans.
    expect(
      shown([
        "echo 'run password=Xk9' next",
        "echo 'run password=Xk9'; next",
        "echo 'run password=Xk9'&next",
        "echo 'run password=Xk9',next",
        "echo 'run password=Xk9'\tnext",
        "echo 'run password=Xk9'",
      ]),
    ).toEqual({
      shown: [
        "echo 'run password=[REDACTED]' next",
        "echo 'run password=[REDACTED]'; next",
        "echo 'run password=[REDACTED]'&next",
        "echo 'run password=[REDACTED]',next",
        "echo 'run password=[REDACTED]'\tnext",
        "echo 'run password=[REDACTED]'",
      ],
      i11: [true, true, true, true, true, true],
    });
  });

  it('C7-2, the encoded one-line form: a JSON string’s written line breaks keep one line, and the glued tail is hidden', () => {
    const text = JSON.stringify(
      "it x' passwd='FAKEc7g1\\\nFAKEc7g2\nFAKEc7g3' go  refreshToken=Xk9'}qFAKEc7g4",
    );
    // (a) red when the closing test is dropped (the base's cut: `'}qFAKEc7g4` shows); (b) prints
    //     the shown text and booleans.
    expect({ ...shown([text]), parses: parses(law(text)) }).toEqual({
      shown: ["\"it x' passwd='[REDACTED]' go  refreshToken=[REDACTED]\""],
      i11: [true],
      parses: true,
    });
  });

  it('control: the two-line form of the designed cut — the closing quote shown, as the one-line form shows it', () => {
    // A quote character, not a value: the one character correction 7 shows that the base hid.
    // (a) red when the pass resets at a continuation break (`[REDACTED] next`); (b) prints the
    //     shown texts and booleans.
    expect(
      shown(["echo 'run \\\npassword=Xk9' next", "echo 'run \\\r\npassword=Xk9' next"]),
    ).toEqual({
      shown: [
        "echo 'run \\\npassword=[REDACTED]' next",
        "echo 'run \\\r\npassword=[REDACTED]' next",
      ],
      i11: [true, true],
    });
  });

  it('control: the pass looks one logical line ahead, as the scan does — a quote two lines on opens (LF)', () => {
    // No closer on the logical line or the next: correction 5's fallback hides the first physical
    // line, and line 4's quote is not the scan's closer, so it opens and E-2's designed cut stands
    // before the blank. (a) red when the pending token is carried past one logical line
    // (`password=[REDACTED] next`); (b) prints the shown text and a boolean.
    expect(
      shown(["token='FAKEc7h1\\\nFAKEc7h2\nFAKEc7h3\nFAKEc7h4' rest password=Xk9' next"]),
    ).toEqual({
      shown: ["token='[REDACTED]\nFAKEc7h2\nFAKEc7h3\nFAKEc7h4' rest password=[REDACTED]' next"],
      i11: [true],
    });
  });

  it('C7-2b: after a scheme word whose run ends at a cut quote, the credential after the blank is hidden, as round 1 hid it', () => {
    // (A) a continued line, LF and CRLF; (B) after a continued quoted value; (C) one line, shown
    // by corrections 2–6. (a) red when the extend reads its blank at the cut itself (the base's
    // extend: each credential shows); (b) prints the shown texts and booleans.
    expect(
      shown([
        "echo 'run \\\nAuthorization: Bearer' FAKEc7i1",
        "echo 'run \\\r\nAuthorization: Bearer' FAKEc7i1",
        "token='FAKEc7i2\\\nFAKEc7i3\nFAKEc7i4' rest 'x Authorization: Bearer' FAKEc7i5",
        "token='FAKEc7i2\\\r\nFAKEc7i3\r\nFAKEc7i4' rest 'x Authorization: Bearer' FAKEc7i5",
        "-H 'Authorization: Bearer' FAKEc7i6",
      ]),
    ).toEqual({
      shown: [
        "echo 'run \\\nAuthorization: [REDACTED]",
        "echo 'run \\\r\nAuthorization: [REDACTED]",
        "token='[REDACTED]\n[REDACTED]\n[REDACTED]' rest 'x Authorization: [REDACTED]",
        "token='[REDACTED]\r\n[REDACTED]\r\n[REDACTED]' rest 'x Authorization: [REDACTED]",
        "-H 'Authorization: [REDACTED]",
      ],
      i11: [true, true, true, true, true],
    });
  });

  it("C7-2b, the escaped run (D): the credential after `Bearer\\'` is hidden — every reference showed it (hides more)", () => {
    // Every frozen reference shows `FAKEc7i7`; correction 7 hides it: the bar's "hides more" side.
    // (a) red when the extend reads its blank at the cut itself (the credential shows); (b) prints
    //     the shown text and a boolean.
    expect(shown(["-H \\'Authorization: Bearer\\' FAKEc7i7"])).toEqual({
      shown: ["-H \\'Authorization: [REDACTED]"],
      i11: [true],
    });
  });

  it("C7-2b, the closing run (E–G): after `Bearer''` the blank is read past the whole run, as round 1 read `Bearer''`", () => {
    // (a) red when the extend steps past the cut quote alone (the second quote stands where the
    //     blank is read: each credential shows); (b) prints the shown texts and booleans.
    expect(
      shown([
        "'x Authorization: Bearer'' FAKEc7k1",
        "'x Authorization: Bearer''' FAKEc7k2",
        "-H 'Authorization: Bearer'' FAKEc7k4",
      ]),
    ).toEqual({
      shown: [
        "'x Authorization: [REDACTED]",
        "'x Authorization: [REDACTED]",
        "-H 'Authorization: [REDACTED]",
      ],
      i11: [true, true, true],
    });
  });

  it("C7-2b, control (H) (correction 1, G-2): after `Bearer'}` the credential is shown and the `}` kept — the base's output, as every reference shows it", () => {
    // A bracket in the cut quote's closing run leaves the quote and the run outside the mark, so the
    // extend does not read past it. (a) red when the gap is the closing run's end whatever it holds
    // (correction 7's gap: the credential hidden and the `}` gone); (b) prints the shown text and a
    // boolean.
    expect(shown(["'x Authorization: Bearer'} FAKEc7k5"])).toEqual({
      shown: ["'x Authorization: [REDACTED]'} FAKEc7k5"],
      i11: [true],
    });
  });

  it("C7-2b, control (I) (correction 1, G-1): before a written `\\n` the quote glues — `Bearer'\\n` is hidden whole and is no scheme word, so the credential is shown, as round 1 shows it", () => {
    // The quote glues before the written `\n`; the first run `Bearer'\n` ends at the blank;
    // `Bearer'\n` is no scheme word, so the extend does not fire. (a) red when the closing test
    // takes a written line break as a terminator again (`'\n` outside the marker); (b) prints the
    // shown text and a boolean.
    expect(shown(["'x Authorization: Bearer'\\n FAKEc7k6"])).toEqual({
      shown: ["'x Authorization: [REDACTED] FAKEc7k6"],
      i11: [true],
    });
  });

  it('C7-2, correction 1 (G-1, I′): a quote before a written `\\n` glues — the value runs to its terminator, as round 1 read it', () => {
    const texts = [
      "'x password=Xk9'\\nFAKEc7n1",
      "'x Authorization: Bearer'\\nFAKEc7n2",
      "note \\'x password=ab\\'\\ncdFAKEh5",
      `{"log":"it said 'password=Xk9'\\nmore"}`,
    ];
    // (a) red when the closing test takes a written line break as a terminator again (each fake
    //     shown; `'\nmore` outside the marker); (b) prints the shown texts and booleans.
    expect({ ...shown(texts), parses: parses(law(texts[3]!)) }).toEqual({
      shown: [
        "'x password=[REDACTED]",
        "'x Authorization: [REDACTED]",
        "note \\'x password=[REDACTED]",
        `{"log":"it said 'password=[REDACTED]"}`,
      ],
      i11: [true, true, true, true],
      parses: true,
    });
  });

  it('C7-2, correction 1 (I″), control: an escaped quote inside the closing run continues it — a twice-encoded JSON string keeps every closer and parses at all three depths', () => {
    const text = JSON.stringify(JSON.stringify('{"p":"password=FAKEc7n5"}'));
    const out = law(text);
    const depth = (t: string): number => {
      let d = 0;
      let v: unknown = t;
      while (typeof v === 'string' && parses(v)) {
        v = JSON.parse(v);
        d++;
      }
      return d;
    };
    // (a) red when an escaped quote ends the closing run (the inner `\\\"}` swallowed, the inner
    //     parse fails); (b) prints the shown text and booleans.
    expect({ ...shown([text]), depth: depth(out), hidden: !out.includes('FAKEc7n5') }).toEqual({
      shown: [JSON.stringify(JSON.stringify('{"p":"password=[REDACTED]"}'))],
      i11: [true],
      depth: 3,
      hidden: true,
    });
  });

  it("C7-2b, correction 1 (G-2, H′ a): a bracket in the closing run stops the extend — a JSON string's closers stay and the JSON parses", () => {
    const text = `{"a":"'x Authorization: Bearer'"} FAKEc7n3`;
    const out = law(text);
    // A word follows the JSON, so the whole line parses on no law; the JSON part, up to and
    // including its last `}`, is the test.
    // (a) red when the gap is read past a closing run that holds a bracket (the `'"}` swallowed into
    //     the mark, the JSON no longer parses); (b) prints the shown text and booleans.
    expect({ ...shown([text]), parses: parses(out.slice(0, out.lastIndexOf('}') + 1)) }).toEqual({
      shown: [`{"a":"'x Authorization: [REDACTED]'"} FAKEc7n3`],
      i11: [true],
      parses: true,
    });
  });

  it('C7-2b, correction 1 (G-2, H′ b): a second run that begins with structure but holds more is still the credential — hidden, as every law hides it', () => {
    // The whole second run is the test, never its first character. (a) red when the extend is
    //     stopped by the first character after the blank alone (each credential shown); (b) prints
    //     the shown texts and booleans.
    expect(
      shown([
        'Authorization: Bearer }FAKEc7n9',
        'Authorization: Bearer :FAKEc7n10',
        "'x Authorization: Bearer' }FAKEc7n11",
      ]),
    ).toEqual({
      shown: [
        'Authorization: [REDACTED]',
        'Authorization: [REDACTED]',
        "'x Authorization: [REDACTED]",
      ],
      i11: [true, true, true],
    });
  });

  it('C7-2b, correction 1 (G-2, H′ c): structure alone after the blank is never a credential — `\'" }` and `\'" ]` kept, both parse', () => {
    const texts = [`{"a":"'x Authorization: Bearer'" }`, `["'x Authorization: Bearer'" ]`];
    // A lone `}` or `]` after `Bearer'` and a blank stays shown: round 1 hid that brace — a
    // character, never a value. (a) red when structure alone after the blank is read as the
    //     credential (the brace or bracket hidden, the JSON no longer parses); (b) prints the shown
    //     texts and booleans.
    expect({ ...shown(texts), parses: texts.map((t) => parses(law(t))) }).toEqual({
      shown: [`{"a":"'x Authorization: [REDACTED]'" }`, `["'x Authorization: [REDACTED]'" ]`],
      i11: [true, true],
      parses: [true, true],
    });
  });

  it('C7-2b, correction 1 (G-2, H′ d): a closing run of quotes of either character is read past — the credential after `Bearer\'"` and `Bearer"\'` hidden (no reference hid it)', () => {
    // Round 1 and corrections 2–6 show `FAKEc7n7` and `FAKEc7n8` (round 1's scheme word admits no
    // `"`); correction 7 hides them: the bar's "hides more" side. `Bearer''` stands with (E)–(G).
    // (a) red when only quotes of the cut's own character are read past (`FAKEc7n7`, `FAKEc7n8`
    //     shown); (b) prints the shown texts and booleans.
    expect(
      shown([
        `'x Authorization: Bearer'" FAKEc7n7`,
        `"x Authorization: Bearer"' FAKEc7n8`,
        "-H 'Authorization: Bearer'' FAKEc7n4",
      ]),
    ).toEqual({
      shown: [
        `'x Authorization: [REDACTED]`,
        `"x Authorization: [REDACTED]`,
        "-H 'Authorization: [REDACTED]",
      ],
      i11: [true, true, true],
    });
  });

  it("C7-2, correction 1 (C1-5, J): a value's own closing quote closes only where a foreign quote would — a glued tail is hidden, as round 1 hid it", () => {
    // Corrections 2–7 closed the value at one following character of a fixed set, so these tails
    // showed (`token=''}FAKE…` whole). (a) red when the own closer closes before any one character
    //     of that set again (each fake shown); (b) prints the shown texts and booleans.
    expect(
      shown([
        "token=''}FAKEc7p1",
        "token='FAKEc7p2'}FAKEc7p3",
        `token=''"FAKEc7q1`,
        "token='']FAKEc7q2",
        "token='')FAKEc7q3",
        `token='"'}FAKEc7q4`,
      ]),
    ).toEqual({
      shown: [
        "token=''[REDACTED]",
        "token='[REDACTED]'[REDACTED]",
        "token=''[REDACTED]",
        "token=''[REDACTED]",
        "token=''[REDACTED]",
        "token='[REDACTED]'[REDACTED]",
      ],
      i11: [true, true, true, true, true, true],
    });
  });

  it("C7-2, correction 1 (C1-5, J′), controls: a closing run before a blank or the end closes the value — the `}` and a JSON string's closer kept; the SQL doubled quote one value", () => {
    const texts = ["token='abc'} rest", '{"client_token": "FAKEc7p4"}', "password='a''b' rest"];
    // (a) red when the own closer closes only before a terminator (`}` glued and hidden, the JSON
    //     no longer parses); (b) prints the shown texts and booleans.
    expect({ ...shown(texts), parses: parses(law(texts[1]!)) }).toEqual({
      shown: [
        "token='[REDACTED]'} rest",
        '{"client_token": "[REDACTED]"}',
        "password='[REDACTED]'[REDACTED] rest",
      ],
      i11: [true, true, true],
      parses: true,
    });
  });

  it("C7-2, correction 1 (C1-5, J″): at the escaped level the own closer glues `}x` — hidden, the string's own closer kept, the JSON parses", () => {
    const text = '{"log":"password=\\"FAKEc7p5\\"}x"}';
    // (a) red when the escaped closer closes before any one character of the old set again (`}x`
    //     shown); (b) prints the shown text and booleans.
    expect({ ...shown([text]), parses: parses(law(text)) }).toEqual({
      shown: ['{"log":"password=\\"[REDACTED]\\"[REDACTED]"}'],
      i11: [true],
      parses: true,
    });
  });
});

describe('F2 — the second decoded reading (D2, commit 2): disclose reaches what the door reached', () => {
  const BS = '\\';
  const DECLARED = `pa${BS}${BS}nss-word1`; // 13 characters, two literal backslashes (probe3's; fake)
  const ONCE = JSON.parse(`"${DECLARED}"`) as string; // one backslash
  const TWICE = JSON.parse(`"${ONCE}"`) as string; // a newline
  const CONTROL = 'pa\nss-OTHER9'; // twice-shaped, not declared
  const setOf = (value: string) =>
    buildDisclosureSet({
      env: {},
      declared: { FAKE_SECRET: value },
      declaredState: 'resolved',
      audience: 'agent',
    }).set;
  const text = (t: string) => `before ${t} after`;
  const gate = (v: string) =>
    ({
      gate_id: 'g1',
      step: 's1',
      choices: ['yes', 'no'],
      resolved_message: 'q',
      opened_at: '2026-10-27T10:00:00.000Z',
      preview: { v },
    }) as never;
  it('D2-4: the twice-decoded spelling of a declared value is hidden by disclose, at `all` and at `declared`', () => {
    const set = setOf(DECLARED);
    // (a) red when D2 is removed (the newline spelling passes disclose); (b) prints the fake texts.
    expect({
      all: disclose(text(TWICE), set, 'all').text,
      declared: disclose(text(TWICE), set, 'declared').text,
    }).toEqual({ all: 'before [REDACTED] after', declared: 'before [REDACTED] after' });
  });
  it('D2-5 (control): the declared and once-decoded spellings stay hidden; a non-declared twice-shaped text stays shown', () => {
    const set = setOf(DECLARED);
    // (b) prints the fake texts.
    expect([DECLARED, ONCE, CONTROL].map((t) => disclose(text(t), set, 'all').text)).toEqual([
      'before [REDACTED] after',
      'before [REDACTED] after',
      text(CONTROL),
    ]);
  });
  it('D2-6: the bound — four backslashes: the thrice-decoded spelling is shown by disclose (recorded) and hidden by the walk', () => {
    const four = `pa${BS}${BS}${BS}${BS}nss-word1`;
    const thrice = JSON.parse(
      `"${JSON.parse(`"${JSON.parse(`"${four}"`) as string}"`) as string}"`,
    ) as string;
    const set = setOf(four);
    const walked = (discloseGate(gate(text(thrice)), set, 'agent') as { preview: { v: string } })
      .preview.v;
    // (a) red when disclose reaches a third level (the recorded bound moved), or the walk's one
    //     re-escape stops reaching D2; (b) prints the fake texts.
    expect({
      disclose: disclose(text(thrice), set, 'all').text,
      walkHides: walked.includes('[REDACTED]'),
    }).toEqual({
      disclose: text(thrice),
      walkHides: true,
    });
  });
  it("D2-7: the walk over probe3's four leaves — the twice-read leaf is now hidden in place, as the others are", () => {
    const set = setOf(DECLARED);
    const walk = (t: string) =>
      (discloseGate(gate(text(t)), set, 'agent') as { preview: { v: string } }).preview.v;
    // Before D2 the twice-read leaf was hidden WHOLE ('[REDACTED]'): only the escaped-spelling rule
    // reached it. With D2 the leaf's own pass finds the spelling, so it is hidden where it stands, as
    // the declared and once-read leaves are; the secret is hidden either way (pinned as the code does
    // it — the prompt expected the walk byte-identical; a numbered divergence in the report).
    // (a) red when D2 is removed (the leaf reads '[REDACTED]' again) or the walk stops hiding a
    //     spelling; (b) prints the four walked texts (fake).
    expect([DECLARED, ONCE, TWICE, CONTROL].map(walk)).toEqual([
      'before [REDACTED] after',
      'before [REDACTED] after',
      'before [REDACTED] after',
      text(CONTROL),
    ]);
  });
});
