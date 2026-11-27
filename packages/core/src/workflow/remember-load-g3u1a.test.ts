// remember-load-g3u1a.test.ts — gap 3, unit 1a, check 10 (core half): every load refuses a
// `remember:` block that breaks its rules, into the loader's `errors[]`, with its words (Words 1–8
// and MA 4's value-is-not-a-map words), each exact with the key's line. The CLI half
// (`realm workflow validate` and `realm run` alike) is in the CLI's remember-load-g3u1a.test.ts.
//
// Every assertion names (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect } from 'vitest';
import { loadWorkflowFromString } from './yaml-loader.js';

/** A workflow whose step `s` is `kind` (an auto step gets a handler unless `bare`), with `remember`
 *  as written (indented under the step) and `extra` lines before it. */
function doc(remember: string, kind = 'auto', extra = ''): { text: string; line: number } {
  const head = [
    'id: wf',
    'name: WF',
    'version: 1',
    'steps:',
    '  c:',
    '    description: c',
    '    execution: auto',
    '    handler: h',
    '  s:',
    '    description: d',
    `    execution: ${kind}`,
    ...(kind === 'guard' ? ["    abort_unless: 'c.ok == true'"] : []),
    ...(kind === 'finalizer' ? ['    handler: tidy', '    on_outcome: always'] : []),
    ...(extra === '' ? [] : extra.split('\n')),
  ];
  const lines = [...head, ...remember.split('\n').map((l) => `    ${l}`)];
  return { text: lines.join('\n') + '\n', line: head.length + 1 };
}

/** The loader's errors for `text` (none when it loads). */
function errorsOf(text: string): string[] {
  try {
    loadWorkflowFromString(text);
    return [];
  } catch (err) {
    return (err as { errors?: string[] }).errors ?? [(err as Error).message];
  }
}

const HANDLER = '    handler: h';
const GOOD =
  'remember:\n  as: offers\n  key: { email: context.resources.c.email }\n  keep_days: 90';

describe('gap 3 (1a), check 10 — the loader refuses each breach in its words, with the key line', () => {
  it('a good block on an auto step with a handler, and on an agent step, loads', () => {
    // (a) red when a good block is refused; (b) prints the errors.
    expect(errorsOf(doc(GOOD, 'auto', HANDLER).text)).toEqual([]);
    expect(errorsOf(doc(GOOD, 'agent').text)).toEqual([]);
  });

  for (const kind of ['guard', 'finalizer'] as const) {
    it(`Words 1 on a ${kind} step (the registry's form, MA 4's ruling)`, () => {
      const { text, line } = doc(GOOD, kind);
      // (a) red when the mint drops the row or its text drifts; (b) prints the errors.
      expect(errorsOf(text)).toEqual([
        `Step 's': 'remember' is not valid on execution: ${kind} steps — 'remember' goes on an agent step or an auto step with 'handler' or 'uses_service'. (line ${line})`,
      ]);
    });
  }

  it('Words 2 on a bare auto step', () => {
    const { text, line } = doc(GOOD, 'auto');
    // (a) red when the bare-step rule is removed; (b) prints the errors.
    expect(errorsOf(text)).toEqual([
      `Step 's': 'remember' needs a step that makes its own output: an agent step, or an auto step with 'handler' or 'uses_service'. A bare auto step's output depends on what drives the run, so its memory would too. (line ${line})`,
    ]);
  });

  const CASES: Array<[string, string, string]> = [
    [
      'Words 3: keep_days missing',
      'remember:\n  as: offers\n  key: { email: context.resources.c.email }',
      "'remember' needs 'keep_days': how many days to keep each entry, a whole number from 1 to 3650.",
    ],
    [
      'Words 4: keep_days 0',
      'remember:\n  as: offers\n  key: { email: context.resources.c.email }\n  keep_days: 0',
      "'remember.keep_days' is 0; it must be a whole number from 1 to 3650.",
    ],
    [
      'Words 4: keep_days 3651',
      'remember:\n  as: offers\n  key: { email: context.resources.c.email }\n  keep_days: 3651',
      "'remember.keep_days' is 3651; it must be a whole number from 1 to 3650.",
    ],
    [
      'Words 4: keep_days 2.5',
      'remember:\n  as: offers\n  key: { email: context.resources.c.email }\n  keep_days: 2.5',
      "'remember.keep_days' is 2.5; it must be a whole number from 1 to 3650.",
    ],
    [
      'Words 4: keep_days "90" (printed as JSON)',
      'remember:\n  as: offers\n  key: { email: context.resources.c.email }\n  keep_days: "90"',
      '\'remember.keep_days\' is "90"; it must be a whole number from 1 to 3650.',
    ],
    [
      'Words 5: a bad as',
      'remember:\n  as: 9offers\n  key: { email: context.resources.c.email }\n  keep_days: 90',
      "'remember.as' must be a name of letters, digits and underscores that starts with a letter, at most 64 characters.",
    ],
    [
      'Words 5: an as of 65 characters',
      `remember:\n  as: ${'a'.repeat(65)}\n  key: { email: context.resources.c.email }\n  keep_days: 90`,
      "'remember.as' must be a name of letters, digits and underscores that starts with a letter, at most 64 characters.",
    ],
    [
      'Words 5: a bad key name',
      'remember:\n  as: offers\n  key: { e-mail: context.resources.c.email }\n  keep_days: 90',
      "'remember.key.e-mail' must be a name of letters, digits and underscores that starts with a letter, at most 64 characters.",
    ],
    [
      'Words 6: an empty key',
      'remember:\n  as: offers\n  key: {}\n  keep_days: 90',
      "'remember.key' must name at least one part, each a path such as context.resources.<step>.<field>.",
    ],
    [
      'Words 6: a key that is not a map',
      'remember:\n  as: offers\n  key: context.resources.c.email\n  keep_days: 90',
      "'remember.key' must name at least one part, each a path such as context.resources.<step>.<field>.",
    ],
    [
      'Words 6: a key leaf that is not a string',
      'remember:\n  as: offers\n  key: { email: { $literal: x } }\n  keep_days: 90',
      "'remember.key' must name at least one part, each a path such as context.resources.<step>.<field>.",
    ],
    [
      'Words 6: a key leaf that is only whitespace',
      "remember:\n  as: offers\n  key: { email: ' ' }\n  keep_days: 90",
      "'remember.key' must name at least one part, each a path such as context.resources.<step>.<field>.",
    ],
    [
      'Words 6: as missing',
      'remember:\n  key: { email: context.resources.c.email }\n  keep_days: 90',
      "'remember' needs 'as'.",
    ],
    ['Words 6: key missing', 'remember:\n  as: offers\n  keep_days: 90', "'remember' needs 'key'."],
    [
      'Words 6: remember not a map',
      'remember: offers',
      "'remember' must be a map of as, key, value and keep_days.",
    ],
    [
      "Words 6: a value that breaks input_map's form (input_map's words, prefixed)",
      "remember:\n  as: offers\n  key: { email: context.resources.c.email }\n  value: { rung: '' }\n  keep_days: 90",
      'remember.value path "rung": source path must be a non-empty string',
    ],
    [
      "Words 6: a value with an unknown directive (input_map's words, prefixed)",
      'remember:\n  as: offers\n  key: { email: context.resources.c.email }\n  value: { rung: { $lit: x } }\n  keep_days: 90',
      'remember.value path "rung": unknown directive \'$lit\' — supported directives: $literal. To pass literal data containing $-keys, wrap the subtree in $literal. input_map values are context paths, nested maps, or $literal — templated strings are not supported.',
    ],
    [
      "the value is not a map (MA 4's words): a string",
      'remember:\n  as: offers\n  key: { email: context.resources.c.email }\n  value: context.resources.c\n  keep_days: 90',
      "'remember.value' must be a map of names to paths, not a string.",
    ],
    [
      'Words 7: an unknown key',
      'remember:\n  as: offers\n  key: { email: context.resources.c.email }\n  keep_days: 90\n  ttl: 3',
      "'remember' has no 'ttl'. It takes as, key, value and keep_days.",
    ],
  ];
  for (const [name, remember, words] of CASES) {
    it(name, () => {
      const { text, line } = doc(remember, 'auto', HANDLER);
      // (a) red when this rule's check is removed or its words drift; (b) prints the errors.
      expect(errorsOf(text)).toEqual([`Step 's': ${words} (line ${line})`]);
    });
  }

  const VALUE_KINDS: Array<[string, string]> = [
    ['[a, b]', 'a list'],
    ['3', 'a number'],
    ['true', 'true or false'],
    ['null', 'null'],
  ];
  for (const [yaml, kind] of VALUE_KINDS) {
    it(`the value is not a map: ${kind}`, () => {
      const { text, line } = doc(
        `remember:\n  as: offers\n  key: { email: context.resources.c.email }\n  value: ${yaml}\n  keep_days: 90`,
        'auto',
        HANDLER,
      );
      // (a) red when a kind is named wrong; (b) prints the errors.
      expect(errorsOf(text)).toEqual([
        `Step 's': 'remember.value' must be a map of names to paths, not ${kind}. (line ${line})`,
      ]);
    });
  }

  const FAILURE_PATHS = [
    'context.resources.$settlement.c.message',
    'context.resources.$settlement.c',
    'context.resources.$settlement',
  ];
  const failureWords = (path: string, line: number) =>
    `Step 's': 'remember' can't read a step's failure message ('${path}'): a memory outlives the run, and a failure's words can carry anything the failed request echoed back. (line ${line})`;
  for (const path of FAILURE_PATHS) {
    it(`Words 8 in key: ${path}`, () => {
      const { text, line } = doc(
        `remember:\n  as: offers\n  key: { why: ${path} }\n  keep_days: 90`,
        'auto',
        HANDLER,
      );
      // (a) red when the failure-message rule is not applied to key paths; (b) prints the errors.
      expect(errorsOf(text)).toEqual([failureWords(path, line)]);
    });
    it(`Words 8 in value: ${path}`, () => {
      const { text, line } = doc(
        `remember:\n  as: offers\n  key: { email: context.resources.c.email }\n  value: { why: ${path} }\n  keep_days: 90`,
        'auto',
        HANDLER,
      );
      // (a) red when the rule is not applied to value paths; (b) prints the errors.
      expect(errorsOf(text)).toEqual([failureWords(path, line)]);
    });
  }

  it('Words 8 in value: { all: context.resources }', () => {
    const { text, line } = doc(
      'remember:\n  as: offers\n  key: { email: context.resources.c.email }\n  value: { all: context.resources }\n  keep_days: 90',
      'auto',
      HANDLER,
    );
    // (a) red when the rule misses the shorter forms holdsFailureMessages covers; (b) prints them.
    expect(errorsOf(text)).toEqual([failureWords('context.resources', line)]);
  });

  it('failure_kind and failed are allowed in value; a $literal is never read as a path', () => {
    const { text } = doc(
      'remember:\n  as: offers\n  key: { email: context.resources.c.email }\n  value:\n    kind: context.resources.$settlement.c.failure_kind\n    failed: context.resources.$settlement.c.failed\n    note: { $literal: context.resources.$settlement.c.message }\n  keep_days: 90',
      'auto',
      HANDLER,
    );
    // (a) red when the rule refuses a field that is not a message, or reads a $literal; (b) prints.
    expect(errorsOf(text)).toEqual([]);
  });

  it('several breaches in one block are each refused, once', () => {
    const { text, line } = doc(
      'remember:\n  as: 1x\n  key: {}\n  keep_days: 0\n  extra: 1',
      'auto',
      HANDLER,
    );
    // (a) red when the words are collapsed or repeated; (b) prints the errors.
    expect(errorsOf(text)).toEqual(
      [
        "'remember' has no 'extra'. It takes as, key, value and keep_days.",
        "'remember.as' must be a name of letters, digits and underscores that starts with a letter, at most 64 characters.",
        "'remember.key' must name at least one part, each a path such as context.resources.<step>.<field>.",
        "'remember.keep_days' is 0; it must be a whole number from 1 to 3650.",
      ].map((w) => `Step 's': ${w} (line ${line})`),
    );
  });
});
