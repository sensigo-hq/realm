// result-map-r11.test.ts — R1.1 (the read side of `realm listen`): `trigger.result_map`, what a
// caller may read of a finished run, at load. The author writes it in the workflow file; the loader
// refuses it on every `auth.mode` but `shared_secret`, refuses a name the disclosure walk would hide,
// and refuses a path that names no step of this workflow. Each cell loads a real workflow text through
// `loadWorkflowFromString` (the loader `register`, `validate` and `validate --registered` share; the
// three CLI surfaces have their own cells in the CLI package) and reads the lines it refuses with.
// On a failing host a cell prints the case and the lines it got.
import { describe, expect, it } from 'vitest';
import { loadWorkflowFromString } from './yaml-loader.js';
import { WorkflowError } from '../types/workflow-error.js';
import { isCredentialName } from '../utils/redaction.js';

const AUTH: Record<string, string> = {
  shared_secret: '    mode: shared_secret\n    header: X-Token\n    secret_from: TOK\n',
  hmac: '    mode: hmac\n    header: X-Sig\n    secret_from: TOK\n',
  stripe: '    mode: stripe\n    secret_from: TOK\n',
  github: '    mode: github\n    secret_from: TOK\n',
  none: '    mode: none\n',
};

/** A workflow with the steps `review` and `classify`, and a trigger in `mode` with `resultMap`. */
function workflow(mode: string, resultMap: string): string {
  return (
    `id: refunds\nname: refunds\nversion: 1\ntrigger:\n  type: webhook\n  path: /refunds\n  auth:\n${AUTH[mode]}` +
    `${resultMap}steps:\n  classify:\n    description: Classify.\n    execution: agent\n` +
    `  review:\n    description: Review.\n    execution: agent\n    depends_on: [classify]\n`
  );
}

/** The lines the loader refuses `text` with, or `[]` when it loads. */
function refusals(text: string): string[] {
  try {
    loadWorkflowFromString(text);
    return [];
  } catch (err) {
    if (!(err instanceof WorkflowError)) throw err;
    return [...(err.errors ?? [err.message])];
  }
}

const MODE_REFUSAL = (mode: string): string =>
  `trigger.result_map is allowed only with auth.mode 'shared_secret'; this trigger uses '${mode}'. A caller reads a run with a code worked out from the shared secret, and only a request that carries the secret in a header is handed it: with a signed body the code would go to anyone who replays a captured signed request, and 'none' has no secret. Remove result_map, or use shared_secret.`;
const NAME_REFUSAL = (name: string): string =>
  `trigger.result_map: '${name}' reads as a credential's name, so Realm may hide its value in the reply. Rename it.`;
const ROOT_REFUSAL = (name: string, path: string): string =>
  `trigger.result_map.${name}: '${path}' must start with 'context.resources.' and a step of this workflow, as in context.resources.review.approved.`;
const NOT_A_STEP = (name: string, step: string, closest?: string): string =>
  `trigger.result_map.${name}: '${step}' is not a step of this workflow.` +
  (closest === undefined ? '' : ` Did you mean '${closest}'?`) +
  ' Name a step of this workflow.';

/** A refusal line without the `(line N)` the loader appends. */
const bare = (line: string): string => line.replace(/ \(line \d+\)$/, '');

describe('R1.1 — trigger.result_map at load', () => {
  it.each(['hmac', 'stripe', 'github', 'none'])(
    'L1: on auth.mode %s the key is refused with the sentence naming the mode',
    (mode) => {
      // (a) red when the mode check is removed (the map then loads) or names another mode; (b)
      //     prints the mode and the lines the loader gave.
      expect({ mode, lines: refusals(workflow(mode, '  result_map: {}\n')).map(bare) }).toEqual({
        mode,
        lines: [MODE_REFUSAL(mode)],
      });
    },
  );

  it('L1: on shared_secret the key loads, a map and the empty map alike', () => {
    // (a) red when the mode check refuses shared_secret too, or the empty map; (b) prints the lines.
    expect({
      map: refusals(
        workflow(
          'shared_secret',
          '  result_map:\n    approved: context.resources.review.approved\n',
        ),
      ),
      empty: refusals(workflow('shared_secret', '  result_map: {}\n')),
    }).toEqual({ map: [], empty: [] });
  });

  it("L2: a name the disclosure walk would hide is refused; the loader's verdict is the walk's", () => {
    const names = ['token', 'api_key', 'password', 'pwd', 'client_secret', 'my_token'];
    const kept = ['approved', 'tokens', 'secret_x'];
    const map =
      '  result_map:\n' +
      [...names, ...kept].map((n) => `    ${n}: context.resources.review.${n}\n`).join('');
    const lines = refusals(workflow('shared_secret', map)).map(bare);
    // (a) red when the name check is removed (no line for the six), or when it uses a test other
    //     than the walk's own (`tokens` and `secret_x` refused, or one of the six let through); (b)
    //     prints each name with the walk's verdict and whether the loader refused it.
    expect(
      [...names, ...kept].map((n) => ({
        name: n,
        walk: isCredentialName(n, ''),
        refused: lines.includes(NAME_REFUSAL(n)),
      })),
    ).toEqual([
      ...names.map((n) => ({ name: n, walk: true, refused: true })),
      ...kept.map((n) => ({ name: n, walk: false, refused: false })),
    ]);
    // (a) red when a kept name gets any line; (b) prints the lines.
    expect(lines).toHaveLength(names.length);
  });

  it("L2: an empty name is refused by the schema's own line", () => {
    // (a) red when the schema's `propertyNames` rule is dropped (the empty name then loads); (b)
    //     prints the lines.
    expect(
      refusals(workflow('shared_secret', '  result_map:\n    "": context.resources.review.x\n')),
    ).toEqual([
      'trigger/result_map must NOT have fewer than 1 characters',
      'trigger/result_map property name must be valid',
    ]);
  });

  it('L3: a path that does not start with context.resources.<step> is refused', () => {
    const lines = refusals(
      workflow(
        'shared_secret',
        "  result_map:\n    a: review.approved\n    b: 'context.resources.'\n    c: run.params.x\n",
      ),
    ).map(bare);
    // (a) red when the root check is removed or lets one of the three through; (b) prints the lines.
    expect(lines).toEqual([
      ROOT_REFUSAL('a', 'review.approved'),
      ROOT_REFUSAL('b', 'context.resources.'),
      ROOT_REFUSAL('c', 'run.params.x'),
    ]);
  });

  it("L3: a step that is not this workflow's is refused, with a did-you-mean only when one is close", () => {
    const lines = refusals(
      workflow(
        'shared_secret',
        '  result_map:\n    a: context.resources.reveiw.x\n    b: context.resources.nope.x\n    c: context.resources.$settlement.x\n',
      ),
    ).map(bare);
    // (a) red when the step check is removed, when the did-you-mean is always or never added, or
    //     when `$settlement` passes as a step; (b) prints the lines.
    expect(lines).toEqual([
      NOT_A_STEP('a', 'reveiw', 'review'),
      NOT_A_STEP('b', 'nope'),
      NOT_A_STEP('c', '$settlement'),
    ]);
  });

  it("L3: a value that is a number or empty is refused by the schema's own line", () => {
    // (a) red when the schema's value rule is dropped; (b) prints the lines.
    expect({
      number: refusals(workflow('shared_secret', '  result_map:\n    a: 5\n')),
      empty: refusals(workflow('shared_secret', "  result_map:\n    a: ''\n")),
    }).toEqual({
      number: ['trigger/result_map/a must be string'],
      empty: ['trigger/result_map/a must NOT have fewer than 1 characters'],
    });
  });

  it('L3: a field of a step, and the whole step, load', () => {
    // (a) red when the root check refuses the whole step, or a field of it; (b) prints the lines.
    expect(
      refusals(
        workflow(
          'shared_secret',
          '  result_map:\n    approved: context.resources.review.approved\n    review: context.resources.review\n',
        ),
      ),
    ).toEqual([]);
  });

  it('L4: the loaded definition carries the map as written; an unknown key beside it is still refused', () => {
    const map =
      '  result_map:\n    approved: context.resources.review.approved\n    kind: context.resources.classify.kind\n';
    const definition = loadWorkflowFromString(workflow('shared_secret', map));
    // (a) red when the schema or the type drops the key on its way into the definition, or reorders
    //     it; (b) prints the map the definition carries.
    expect(Object.entries(definition.trigger?.result_map ?? {})).toEqual([
      ['approved', 'context.resources.review.approved'],
      ['kind', 'context.resources.classify.kind'],
    ]);
    // (a) red when the trigger block stops being closed (`additionalProperties: false`); (b) prints
    //     the lines.
    expect(refusals(workflow('shared_secret', `${map}  results_map: {}\n`))).toEqual([
      "trigger: unknown property 'results_map'",
    ]);
  });
});
