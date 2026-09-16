/**
 * Issue #586 — SCHEMA ADMISSION. Every authored JSON-Schema block is compiled at load by the same
 * `compileSchema` the run time validates through, so `validate` / `register` / `--registered` /
 * `watch` / `workflow test` / `run` / `agent` / `listen` and both public string loaders refuse a
 * malformed block identically, on the block's own line.
 *
 * Every cell here is red-first: reverting the one hunk it names reds it. The shapes are recorded
 * in the report.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadWorkflowFromString, loadWorkflowFromStringWithDiagnostics } from './yaml-loader.js';
import { WorkflowError } from '../types/workflow-error.js';
import {
  compileSchema,
  validateRunParams,
  validateInputSchema,
  validateOutputSchema,
} from '../validation/input-schema.js';

/** A workflow with one auto step; `extra` is spliced at the top level, `stepExtra` into the step. */
function wf(opts: { extra?: string; stepExtra?: string; second?: string } = {}): string {
  return (
    `id: w\nname: W\nversion: 1\n` +
    (opts.extra ?? '') +
    `steps:\n  s1:\n    description: first\n    execution: auto\n` +
    (opts.stepExtra ?? '') +
    (opts.second ?? '')
  );
}

function refusalOf(yaml: string): { message: string; errors: string[] } {
  try {
    loadWorkflowFromString(yaml);
  } catch (err) {
    const e = err as WorkflowError;
    return {
      message: e.message,
      errors: ((e as unknown as { errors?: string[] }).errors ?? []) as string[],
    };
  }
  throw new Error('expected the load to be REFUSED, but it succeeded');
}

describe('#586 schema admission — the four authored keys', () => {
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // 1. {4 keys} × refusal with the key's OWN line.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  it('params_schema: a block that cannot compile is refused on its own line', () => {
    const { message } = refusalOf(wf({ extra: 'params_schema:\n  type: banana\n' }));
    expect(message).toContain("'params_schema' is not a valid JSON Schema —");
    expect(message).toContain('Every run start would be refused with that error at run time');
    expect(message).toContain("; set 'type' to one of those values.");
    // The OFFENDING KEYWORD's own line (walk #5, T1): `params_schema:` is line 4, `type: banana` is
    // line 5 — the number beside the message is the line the author must edit.
    expect(message).toContain('(line 5)');
  });

  it('input_schema: refused on the key line, consequence names THIS step', () => {
    const { message } = refusalOf(wf({ stepExtra: '    input_schema:\n      type: banana\n' }));
    expect(message).toContain(
      "Step 's1': 'input_schema' is not a valid JSON Schema — 'type' must be one of array, boolean, integer, null, number, object, string ('type: banana' here). Every execute_step submission to this step would be rejected with that error at run time; set 'type' to one of those values.",
    );
    expect(message).toContain(
      'Every execute_step submission to this step would be rejected with that error at run time',
    );
    expect(message).toContain('(line 9)');
  });

  it('output_schema: refused with the agent-submission consequence', () => {
    const { message } = refusalOf(
      wf({
        stepExtra: '    output_schema:\n      type: banana\n',
      }).replace('execution: auto', 'execution: agent'),
    );
    expect(message).toContain("Step 's1': 'output_schema' is not a valid JSON Schema —");
    expect(message).toContain(
      'Every agent submission to this step would be rejected with that error at run time',
    );
    expect(message).toContain('(line 9)');
  });

  it('trace_schema: refused with the trace-submission consequence', () => {
    const { message } = refusalOf(
      wf({
        stepExtra: '    trace_schema:\n      type: banana\n',
      }).replace('execution: auto', 'execution: agent'),
    );
    expect(message).toContain("Step 's1': 'trace_schema' is not a valid JSON Schema —");
    expect(message).toContain(
      'Every trace submission for this step would fail with that error at run time',
    );
    expect(message).toContain('(line 9)');
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // 2. The SIX throw classes, on one key.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  const THROW_CLASSES: Array<[string, string, string]> = [
    [
      'an invalid keyword value',
      '      type: banana\n',
      "'type' must be one of array, boolean, integer, null, number, object, string ('type: banana' here)",
    ],
    [
      'an unknown keyword',
      '      type: object\n      foo: 1\n',
      "'foo' is not a JSON-Schema keyword ('foo: 1' here)",
    ],
    [
      'a non-schema in a schema slot',
      '      type: object\n      properties:\n        a: 1\n',
      "'a' must be a schema — an object, or the boolean true/false ('a: 1' here), at \"input_schema/properties\"",
    ],
    [
      'an unknown format',
      '      type: string\n      format: email\n',
      "the 'format' keyword is unsupported, whatever its value",
    ],
    [
      'a dangling $ref',
      '      $ref: "#/definitions/nope"\n',
      "'$ref' points at a definition this block does not have ('$ref: #/definitions/nope' here)",
    ],
    ['an empty enum', '      enum: []\n', "'enum' must not be empty ('enum: []' here)"],
  ];
  for (const [label, body, needle] of THROW_CLASSES) {
    it(`throw class — ${label} is refused at load, in realm's own sentence`, () => {
      const { message } = refusalOf(wf({ stepExtra: `    input_schema:\n${body}` }));
      // The opener is TRUE per class (walk #11): the two strict-mode rows are valid JSON Schema
      // by the spec, so they open "is refused by realm's validator"; the meta-schema rows keep
      // "is not a valid JSON Schema".
      const strict = /unknown (keyword|format)/.test(label);
      expect(message).toContain(
        strict
          ? "Step 's1': 'input_schema' is refused by realm's validator —"
          : "Step 's1': 'input_schema' is not a valid JSON Schema —",
      );
      if (strict) expect(message).not.toContain('is not a valid JSON Schema');
      expect(message).toContain(needle);
    });
  }

  // The strict-mode unknown-keyword class is the one Ajv reports with no location; realm names
  // the keyword's own path inside the block (walk #3, T4b) — root and nested, per member.
  it('an unknown keyword at the block root is located at the block', () => {
    const { message } = refusalOf(
      wf({ stepExtra: `    input_schema:\n      type: object\n      foo: 1\n` }),
    );
    expect(message).toContain("'foo' is not a JSON-Schema keyword ('foo: 1' here)");
    expect(message).not.toContain('Ajv');
    // No path at the block root (walk #16) — the head token is the location.
    expect(message).not.toContain('at "input_schema"');
    // `foo: 1` is line 10 — the keyword's own line, not the block head's (8).
    expect(message).toContain('(line 10)');
  });
  it('an unknown keyword nested inside the block is located by its path', () => {
    const { message } = refusalOf(
      wf({
        stepExtra:
          `    input_schema:\n      type: object\n      properties:\n        a:\n          type: object\n` +
          `          properties:\n            b:\n              type: string\n              mistake: oops\n`,
      }),
    );
    expect(message).toContain(
      "'mistake' is not a JSON-Schema keyword ('mistake: oops' here), at \"input_schema/properties/a/properties/b\"",
    );
    // Eight lines below the block head: the cite is `mistake:`'s own line (16), not `input_schema:`'s (8).
    expect(message).toContain('(line 16)');
    expect(message).not.toContain('(line 8)');
  });

  // The x- boundary (D8) — the "move it to the top" branch forks on the keyword's spelling
  // (walk #2 F1: followed literally, a capital or reserved spelling was refused AGAIN at the
  // top of the file). Per member: lowercase → plain move; capital → rename to a lowercase name
  // THEN move; reserved (any case) → rename outside the reserved prefix THEN move, reserved-first
  // like the top-level arms. The rename precedes the move and acts on "it" (walk #17: a trailing
  // ", under a lowercase <prefix> name" read as a property of the destination).
  const X_MEMBERS: Array<[string, string, string]> = [
    [
      'x-note',
      "remove it, or move it to the top of the workflow file, where the 'x-' extension namespace lives.",
      'rename it',
    ],
    [
      'X-Note',
      "remove it, or rename it to a lowercase 'x-' name (the extension namespace is lowercase) and move it to the top of the workflow file, where the 'x-' extension namespace lives.",
      'outside the reserved',
    ],
    [
      'x-realm-note',
      "remove it, or rename it to an 'x-' name outside the reserved 'x-realm-' prefix and move it to the top of the workflow file, where the 'x-' extension namespace lives.",
      'lowercase',
    ],
    [
      'X-Realm-Note',
      "remove it, or rename it to a lowercase 'x-' name outside the reserved 'x-realm-' prefix and move it to the top of the workflow file, where the 'x-' extension namespace lives.",
      "an 'x-' name outside",
    ],
  ];
  for (const [spelling, mustHave, mustNot] of X_MEMBERS) {
    it(`an '${spelling}' keyword INSIDE a schema block gets the D8 boundary clause with an EXECUTABLE move`, () => {
      const { message } = refusalOf(
        wf({ stepExtra: `    input_schema:\n      type: object\n      ${spelling}: hi\n` }),
      );
      // TRANSFORM 2 applies to the D8 arm's validity clause too — one sentence, one rule.
      expect(message).toContain(
        `'${spelling}' is not a JSON-Schema keyword ('${spelling}: hi' here)`,
      );
      expect(message).not.toContain('strict mode');
      expect(message).not.toContain('Ajv');
      expect(message).toContain(
        "move it to the top of the workflow file, where the 'x-' extension namespace lives.",
      );
      expect(message).not.toContain(', under ');
      // The rule is said ONCE (walk #16): never "…lives at the top of the workflow file only".
      expect(message).not.toContain('file only');
      expect(message).not.toContain('refused like any unknown keyword');
      expect(message).not.toContain('issue #559');
      expect(message).toContain(mustHave);
      expect(message).not.toContain(mustNot);
    });
  }

  it('an ORDINARY unknown keyword keeps the plain remedy — the D8 clause is scoped', () => {
    const { message } = refusalOf(
      wf({ stepExtra: '    input_schema:\n      type: object\n      custom_flag: hi\n' }),
    );
    expect(message).toContain(
      "'custom_flag' is not a JSON-Schema keyword ('custom_flag: hi' here)",
    );
    expect(message).not.toContain('issue #559');
    expect(message).toContain("; remove 'custom_flag', or correct its spelling.");
    expect(message).not.toContain('if that is what you meant');
    // The misleading-guess control: a three-letter unknown is NEVER handed a random three-letter
    // keyword (`foo` → `not` was two edits — the helper's threshold — on the built CLI).
    const foo = refusalOf(
      wf({ stepExtra: '    input_schema:\n      type: object\n      foo: 1\n' }),
    ).message;
    expect(foo).toContain("; remove 'foo', or correct its spelling.");
    expect(foo).not.toContain("'not'");
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // 3. The edge matrix — presence is `!== undefined`, the runtime guards' own predicate.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  it('a near-miss of a real keyword is handed the keyword — `minlength` → `minLength`', () => {
    const { message } = refusalOf(
      wf({ stepExtra: '    input_schema:\n      type: string\n      minlength: 3\n' }),
    );
    expect(message).toContain("'minlength' is not a JSON-Schema keyword ('minlength: 3' here)");
    expect(message).toContain(
      "; remove 'minlength', or write 'minLength' if that is what you meant.",
    );
    // A one-letter slip with the first letter intact is the other modal typo.
    const tpye = refusalOf(wf({ stepExtra: '    input_schema:\n      tpye: object\n' })).message;
    expect(tpye).toContain("; remove 'tpye', or write 'type' if that is what you meant.");
  });

  it("the 'type' remedy names the value the block's other keywords already imply", () => {
    const { message } = refusalOf(
      wf({ extra: 'params_schema:\n  type: banana\n  properties:\n    a: { type: string }\n' }),
    );
    expect(message).toContain(
      "('type: banana' here; 'object' is the one that fits the 'properties' beside it)",
    );
    expect(message).toContain("; set 'type' to object.");
    // No neighbour that implies a type: the whole set, no preference.
    expect(refusalOf(wf({ extra: 'params_schema:\n  type: banana\n' })).message).toContain(
      "; set 'type' to one of those values.",
    );
  });

  it('null is refused with its own clause and NO consequence clause', () => {
    const { message } = refusalOf(wf({ stepExtra: '    input_schema:\n' }));
    expect(message).toContain(
      "Step 's1': 'input_schema' is null, not a schema (a JSON-Schema block is an object, or the boolean true/false); fix the schema.",
    );
    // No dangling "that error" referent: nothing compiled, so there is no error to refer to.
    expect(message).not.toContain('would be rejected with that error');
    // No keyword to point at: rung 2, the block's own key line.
    expect(message).toContain('(line 8)');
  });

  it('[] and a string get Ajv\u2019s verbatim message, not a bespoke one', () => {
    const arr = refusalOf(wf({ stepExtra: '    input_schema: []\n' })).message;
    expect(arr).toContain(
      "'input_schema' must be a schema — an object, or the boolean true/false ('input_schema: []' here)",
    );
    expect(arr).toContain('; write a schema there.');
    const str = refusalOf(wf({ stepExtra: '    input_schema: "str"\n' })).message;
    expect(str).toContain(
      "'input_schema' must be a schema — an object, or the boolean true/false ('input_schema: str' here)",
    );
    // Neither text carries a pointer, so the cite falls back to the block's key line (rung 2).
    expect(arr).toContain('(line 8)');
    expect(str).toContain('(line 8)');
  });

  it('the cite resolves on all three YAML spellings of the block — block, flow, anchor alias', () => {
    // Block form: the keyword's own line (rung 1).
    expect(refusalOf(wf({ extra: 'params_schema:\n  type: banana\n' })).message).toContain(
      '(line 5)',
    );
    // Flow form: the keyword sits on the key's line, so rung 1 and rung 2 agree.
    expect(refusalOf(wf({ extra: 'params_schema: { type: banana }\n' })).message).toContain(
      '(line 4)',
    );
    // Anchor alias: the expansion has no positions of its own, so rung 2 — the key's line (5) —
    // never the anchor's (4) and never uncited. (`x-s` is a legal #559 extension key.)
    const aliased = refusalOf(
      wf({ extra: 'x-s: &s { type: banana }\nparams_schema: *s\n' }),
    ).message;
    expect(aliased).toContain("'params_schema' is not a valid JSON Schema");
    expect(aliased).toContain(
      '(line 5; the keyword is not written on this line — it sits in a list entry, or in a value declared elsewhere, e.g. at an anchor)',
    );
    // And never that clause where the keyword IS on the cited line.
    expect(refusalOf(wf({ extra: 'params_schema:\n  type: banana\n' })).message).not.toContain(
      'not written on this line',
    );
  });

  it("a dangling $ref cites the `$ref` key's own line and names the site — Ajv names only the target", () => {
    const { message } = refusalOf(
      wf({
        stepExtra:
          '    input_schema:\n      type: object\n      properties:\n        a:\n' +
          '          $ref: "#/definitions/nope"\n',
      }),
    );
    expect(message).toContain(
      "'$ref' points at a definition this block does not have ('$ref: #/definitions/nope' here), at \"input_schema/properties/a\"",
    );
    // `$ref` is the property's ONLY key and `a` the only property: "remove the '$ref'" leaves
    // `a: null`, "remove 'a'" leaves `properties: null` (an emptied YAML mapping is null) — each a
    // second refusal (walk #20). The act climbs to `properties`, whose sibling `type` remains.
    expect(message).toContain("; add that definition, or remove 'properties'.");
    expect(message).not.toContain("remove the '$ref'");
    expect(message).not.toContain("can't resolve reference");
    expect(message).toContain('(line 12)');
  });

  it('a $ref WITH siblings keeps "remove the \'$ref\'" — what remains is a schema', () => {
    const { message } = refusalOf(
      wf({
        stepExtra:
          '    input_schema:\n      type: object\n      properties:\n        a:\n' +
          '          description: the a\n          $ref: "#/definitions/nope"\n',
      }),
    );
    expect(message).toContain("; add that definition, or remove the '$ref'.");
    expect(message).toContain('(line 13)');
  });

  it("a $ref alone inside an anyOf entry names the entry — 'remove that entry from anyOf'", () => {
    const { message } = refusalOf(
      wf({
        stepExtra:
          '    input_schema:\n      type: object\n      properties:\n        a:\n' +
          '          anyOf:\n            - $ref: "#/definitions/nope"\n            - type: string\n',
      }),
    );
    expect(message).toContain(', at "input_schema/properties/a/anyOf/0"');
    expect(message).toContain("; add that definition, or remove that entry from 'anyOf'.");
    // The #392 collector records no positions under sequences (`source-positions.ts`): a keyword
    // inside a list entry has no line of its own, so the cite is the block's key line WITH the
    // clause that says so — and the clause must be TRUE for this population, not only for an alias.
    expect(message).toContain(
      '(line 8; the keyword is not written on this line — it sits in a list entry, or in a value declared elsewhere, e.g. at an anchor)',
    );
  });

  it("a $ref alone under a property that HAS a sibling property → remove 'a' (its parent keeps 'b')", () => {
    const { message } = refusalOf(
      wf({
        stepExtra:
          '    input_schema:\n      type: object\n      properties:\n        a:\n' +
          '          $ref: "#/definitions/nope"\n        b:\n          type: string\n',
      }),
    );
    expect(message).toContain("; add that definition, or remove 'a'.");
    expect(message).toContain('(line 12)');
  });

  it('a remote $ref alone under a property leads with removing the PROPERTY', () => {
    const { message } = refusalOf(
      wf({
        stepExtra:
          '    input_schema:\n      type: object\n      properties:\n        a:\n' +
          '          $ref: https://example.com/x.json\n',
      }),
    );
    expect(message).toContain(
      "; remove 'properties', or paste the schema it points at in its place.",
    );
    expect(message).toContain('(line 12)');
  });

  it('a $ref pointing OUTSIDE the block says realm fetches nothing — no path at the root', () => {
    const { message } = refusalOf(
      wf({ stepExtra: '    input_schema:\n      $ref: https://example.com/x.json\n' }),
    );
    expect(message).toContain(
      "'$ref' points outside this block, and realm fetches no remote schemas ('$ref: https://example.com/x.json' here). Every execute_step",
    );
    // Alone at the block root: removing the `$ref` leaves `input_schema:` = null — the act is the
    // whole block (no schema at all is legal; an emptied YAML mapping is never `{}`).
    expect(message).toContain(
      "; remove the 'input_schema' block, or paste the schema it points at in its place.",
    );
    expect(message).not.toContain('at "input_schema"');
    expect(message).toContain('(line 9)');
  });

  it('true, false and {} are LEGAL schemas and load', () => {
    for (const literal of ['true', 'false', '{}']) {
      expect(() =>
        loadWorkflowFromString(wf({ stepExtra: `    input_schema: ${literal}\n` })),
      ).not.toThrow();
    }
  });

  it('control: a `false` schema loads AND still rejects every value at run time', () => {
    // `false` is a choice, not a defect — the loader must not second-guess the run time.
    expect(() => validateInputSchema({ a: 1 }, false as never, 's1')).toThrow(WorkflowError);
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // 4. Composition, cascade and ordering.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  it('a workflow-level refusal COMPOSES with a step-level one — two errors, not one', () => {
    // The workflow-level compile sits AFTER the early `errors.length > 0` throw and BEFORE the
    // step loop, so both errors reach the one throw and #425 renders them one per line.
    const { errors } = refusalOf(
      wf({
        extra: 'params_schema:\n  type: banana\n',
        stepExtra: '    input_schema:\n      type: banana\n',
      }),
    );
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("'params_schema' is not a valid JSON Schema");
    expect(errors[1]).toContain("Step 's1': 'input_schema' is not a valid JSON Schema");
  });

  it('no cascade: a malformed input_schema on a strict step mints exactly ONE error', () => {
    const { errors } = refusalOf(
      wf({
        stepExtra:
          '    structured_output: strict\n    input_schema:\n      type: object\n      foo: 1\n',
      }).replace('execution: auto', 'execution: agent'),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("'input_schema' is refused by realm's validator");
  });

  it('the consequence names ONLY the offending step — step B is untouched', () => {
    const { errors } = refusalOf(
      wf({
        stepExtra: '    input_schema:\n      type: banana\n',
        second: '  s2:\n    description: second\n    execution: auto\n',
      }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Step 's1':");
    expect(errors[0]).not.toContain("Step 's2'");
  });

  // The consequence clause is keyed on CONSUMPTION, not on prohibition — three populations,
  // executed, each its own cell (the per-member rule for set-keyed changes):
  //   consumed  (input_schema × auto/agent)  → the clause is true, it stays;
  //   prohibited(input_schema × guard, STEP_KEY_REGISTRY) → the registry already refuses the key
  //             saying it "would validate nothing"; a consequence clause would CONTRADICT that
  //             refusal in the same render (the #524 walk's boarded class);
  //   inert     (input_schema × finalizer, `via: {kind:'tracked', issue:'#512'}`) → NOTHING
  //             refuses it, and the clause would be a false claim: the engine never reads it.
  // CONSUMED_HOME (step-key-registry) is the one table that separates the first from the other
  // two, which is why `consumedKindsFor` — not `prohibitedKeysFor` — decides the clause.
  function guardWf(schema: string): string {
    return (
      `id: w\nname: W\nversion: 1\nsteps:\n  s1:\n    description: first\n    execution: auto\n` +
      `  k:\n    description: k\n    execution: guard\n    abort_unless:\n      - "params.a == 1"\n` +
      `    input_schema:\n${schema}\n`
    );
  }

  it('prohibited kind (guard): the compile refusal drops its consequence BESIDE the registry refusal', () => {
    const { errors } = refusalOf(guardWf('      type: banana'));
    const compileError = errors.find((e) => e.includes('is not a valid JSON Schema'));
    expect(compileError).toBeDefined();
    // Clause-less: no run-time claim at all, so it cannot contradict its neighbour.
    expect(compileError).not.toContain('would be rejected');
    expect(compileError).not.toContain('Every');
    expect(compileError).toContain("; set 'type' to one of those values.");
    // The neighbour that DOES make the claim — the #517 registry mint.
    expect(
      errors.some((e) => e.includes("'input_schema' is not valid on execution: guard steps")),
    ).toBe(true);
  });

  it('inert kind (finalizer, #512): clause-less too — nothing else refuses, and the clause would be false', () => {
    const { errors } = refusalOf(
      `id: w\nname: W\nversion: 1\nsteps:\n  s1:\n    description: first\n    execution: auto\n` +
        `  fin:\n    description: cleanup\n    execution: finalizer\n    handler: ./h.js\n` +
        `    on_outcome: complete\n    input_schema:\n      type: banana\n`,
    );
    // The WHOLE refusal set: the compile error alone. There is no registry refusal on this cell
    // (input_schema × finalizer is `inert`, tracked as #512) — which is exactly why the clause
    // must not be minted here either.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Step 'fin': 'input_schema' is not a valid JSON Schema —");
    expect(errors[0]).not.toContain('Every');
    expect(errors[0]).toContain("; set 'type' to one of those values.");
  });

  it('control: on a CONSUMED kind the clause is minted', () => {
    const { errors } = refusalOf(
      wf({ stepExtra: '    input_schema:\n      type: banana\n' }).replace(
        'execution: auto',
        'execution: agent',
      ),
    );
    expect(errors[0]).toContain(
      'Every execute_step submission to this step would be rejected with that error at run time',
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // 5. The LOG class → an advisory the author can see; nothing at run time (D7 revised).
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a union type compiles and yields SCHEMA_STRICT_ADVISORY with the verbatim line and the type line', () => {
    const { definition, warnings } = loadWorkflowFromStringWithDiagnostics(
      wf({
        extra:
          'params_schema:\n  type: object\n  properties:\n    a:\n      type: [string, number]\n',
      }),
    );
    expect(definition.id).toBe('w');
    const advisory = warnings.find((w) => w.code === 'SCHEMA_STRICT_ADVISORY');
    expect(advisory).toBeDefined();
    expect(advisory?.severity).toBe('warn');
    expect(advisory?.scope).toBe('workflow');
    expect(advisory?.key).toBe('params_schema');
    // The union `type:` is line 8 — the advisory points where the fix goes, not at the block head.
    expect(advisory?.line).toBe(8);
    expect(advisory?.message).toContain(
      '\'params_schema\' compiles, but Ajv warns: strict mode: use allowUnionTypes to allow union type keyword at "params_schema/properties/a" (strictTypes)',
    );
    // The remedy is REALM's and it names the ACTUAL declared members, walked out of the block at
    // the pointer Ajv quotes — not a generic pair, and not Ajv's un-performable `allowUnionTypes`.
    expect(advisory?.message).toContain(
      'Remedy: realm does not enable union types — write anyOf: [{type: string}, {type: number}] instead.',
    );
    expect(advisory?.message).toContain(
      'This advisory clears when the schema is fixed; nothing is printed at run time.',
    );
    expect(advisory?.message).not.toContain('compiles, but Ajv strict mode warns');
    expect(advisory?.message).toContain('(line 8)');
  });

  it('D7 revised: the run time prints NOTHING for the strict-mode class', () => {
    // Before #586 Ajv's default logger put this sentence on the console on every compile, on every
    // run, unattributed. The disclosure is the loader advisory now, and only that.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    validateInputSchema(
      { a: 'x' },
      { type: 'object', properties: { a: { type: ['string', 'number'] } } } as never,
      's1',
    );
    expect(warn).toHaveBeenCalledTimes(0);
    expect(log).toHaveBeenCalledTimes(0);
    expect(err).toHaveBeenCalledTimes(0);
  });

  it('a step-level advisory carries scope step, the step name and the union type line', () => {
    const { warnings } = loadWorkflowFromStringWithDiagnostics(
      wf({
        stepExtra:
          '    input_schema:\n      type: object\n      properties:\n        a:\n          type: [string, number]\n',
      }),
    );
    const advisory = warnings.find((w) => w.code === 'SCHEMA_STRICT_ADVISORY');
    expect(advisory?.scope).toBe('step');
    expect(advisory?.step).toBe('s1');
    expect(advisory?.key).toBe('input_schema');
    expect(advisory?.line).toBe(12);
    expect(advisory?.message).toContain("Step 's1': 'input_schema' compiles, but Ajv warns:");
  });

  // The other two members of the LOG class, per the per-member rule. All three arms are reachable
  // from an ordinary authored schema on ajv 8.20.0 (executed).
  it('advisory remedy — the missing-type member names the type and the keyword', () => {
    const { warnings } = loadWorkflowFromStringWithDiagnostics(
      wf({
        extra: 'params_schema:\n  type: object\n  properties:\n    code:\n      minLength: 3\n',
      }),
    );
    const advisory = warnings.find((w) => w.code === 'SCHEMA_STRICT_ADVISORY');
    expect(advisory?.message).toContain(
      'Ajv warns: strict mode: missing type "string" for keyword "minLength"',
    );
    expect(advisory?.message).toContain(
      'Remedy: add type: string beside minLength, or remove minLength.',
    );
  });

  it('advisory remedy — a line realm has no specific remedy for falls through to the generic arm', () => {
    // Ajv's 2-tuple `items` advisory: a real strict-mode line with no realm-side one-line fix.
    const { warnings } = loadWorkflowFromStringWithDiagnostics(
      wf({
        extra:
          'params_schema:\n  type: object\n  properties:\n    pair:\n      type: array\n      items:\n        - type: string\n        - type: number\n',
      }),
    );
    const advisory = warnings.find((w) => w.code === 'SCHEMA_STRICT_ADVISORY');
    expect(advisory?.message).toContain('"items" is 2-tuple');
    expect(advisory?.message).toContain('Remedy: see the Ajv strict-mode message above.');
  });

  it('advisory remedy — the union arm names the DECLARED members, whatever they are', () => {
    // The members are walked out of the block at the pointer Ajv quotes; they are never guessed
    // and never a canned pair — a DIFFERENT declared pair yields a different remedy. (Ajv does not
    // warn at all for ["<t>", "null"]: strictTypes treats that as the nullable shorthand.)
    const { warnings } = loadWorkflowFromStringWithDiagnostics(
      wf({
        extra:
          'params_schema:\n  type: object\n  properties:\n    a:\n      type: [boolean, integer]\n',
      }),
    );
    const advisory = warnings.find((w) => w.code === 'SCHEMA_STRICT_ADVISORY');
    expect(advisory?.message).toContain('write anyOf: [{type: boolean}, {type: integer}] instead');
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // 5b. The three LOAD-ONLY transforms on the refusal clause (#586 walk J1-b / J8-a / J8-b).
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  it('the meta-schema sentence carries NO path at the block root', () => {
    const { message } = refusalOf(wf({ extra: 'params_schema:\n  type: banana\n' }));
    expect(message).toContain(
      "'type' must be one of array, boolean, integer, null, number, object, string ('type: banana' here)",
    );
    expect(message).not.toContain('data/');
  });

  it('the meta-schema sentence names the containing node for a NESTED failure', () => {
    const { message } = refusalOf(
      wf({ stepExtra: '    input_schema:\n      type: object\n      properties:\n        a: 1\n' }),
    );
    expect(message).toContain(
      "'a' must be a schema — an object, or the boolean true/false ('a: 1' here), at \"input_schema/properties\"",
    );
    expect(message).not.toContain('data/');
  });

  it("the unknown-keyword sentence is realm's own — never the vendor's `strict mode:` prefix, never its name", () => {
    const { message } = refusalOf(wf({ extra: 'params_schema:\n  type: object\n  foo: 1\n' }));
    expect(message).toContain(
      "'params_schema' is refused by realm's validator — 'foo' is not a JSON-Schema keyword ('foo: 1' here).",
    );
    expect(message).not.toContain('strict mode');
    expect(message).not.toContain('Ajv');
  });

  for (const fmt of ['email', 'uri']) {
    it(`TRANSFORM 3: the '${fmt}' format refusal states that NO format value is accepted`, () => {
      const { message } = refusalOf(
        wf({
          extra: `params_schema:\n  type: object\n  properties:\n    a:\n      type: string\n      format: ${fmt}\n`,
        }),
      );
      // The validity clause is realm's (walks #5, #6, #8) and its ORDER is the pin: the universal
      // fact FIRST — the keyword is unsupported, every value — then the value as one of many, then
      // the author's path; no "ignored", no "unknown format", no value-first "not accepted (…
      // here" (two walkers executed a second format value on those); the cite is the `format`
      // key's own line (9). The `pattern` hint: this property IS `type: string`.
      expect(message).toContain(
        `'params_schema' is refused by realm's validator — the 'format' keyword is unsupported, whatever its value ('format: ${fmt}' here), at "params_schema/properties/a". Every run start would be refused with that error at run time; remove the 'format' keyword, or replace it with a 'pattern' that expresses the string shape you need.`,
      );
      expect(message).not.toContain('ignored');
      expect(message).not.toContain('unknown format');
      expect(message).not.toContain('not accepted (');
      expect(message).toContain('(line 9)');
      expect(message).toContain(
        "; remove the 'format' keyword, or replace it with a 'pattern' that expresses the string shape you need.",
      );
      // The FAMILY shape (walk #12): the per-key run-time consequence — true for `format`, the
      // compile throws at run time like every class — then the arm's own remedy.
      expect(message).toContain('Every run start would be refused with that error at run time;');
      // The format arm's own remedy IS the remedy — no trailing generic "fix the schema" after it.
      // Each alternative is a whole act (walk #11) and the message ends with it — no trailing
      // generic "; fix the schema" (walk #2); the opener is the strict-class one (walk #11).
      expect(message).toMatch(/string shape you need\. \(line 9\)$/);
      expect(message).not.toContain('is not a valid JSON Schema');
    });
  }

  it("the 'pattern' hint is offered only on a `type: string` property — a pattern on any other type is inert", () => {
    const integer = refusalOf(
      wf({
        extra:
          'params_schema:\n  type: object\n  properties:\n    n:\n      type: integer\n      format: int32\n',
      }),
    ).message;
    expect(integer).toContain(
      `the 'format' keyword is unsupported, whatever its value ('format: int32' here), at "params_schema/properties/n". Every run start would be refused with that error at run time; remove the 'format' keyword.`,
    );
    expect(integer).not.toContain('pattern');
    // A property with NO declared type gets no hint either: a `pattern` there mints the
    // strictTypes advisory on the next validate (walk #8 executed the integer case).
    const untyped = refusalOf(
      wf({ extra: 'params_schema:\n  type: object\n  properties:\n    a:\n      format: email\n' }),
    ).message;
    expect(untyped).toContain("; remove the 'format' keyword.");
    expect(untyped).not.toContain('pattern');
  });

  it('TRANSFORM 3 holds on a NON-consuming kind — a fact about the validator, not a claim about the step', () => {
    const { errors } = refusalOf(
      `id: w\nname: W\nversion: 1\nsteps:\n  s1:\n    description: first\n    execution: auto\n` +
        `  fin:\n    description: cleanup\n    execution: finalizer\n    handler: ./h.js\n` +
        `    on_outcome: complete\n    input_schema:\n      type: object\n      properties:\n` +
        `        a:\n          type: string\n          format: email\n`,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("the 'format' keyword is unsupported, whatever its value");
    expect(errors[0]).not.toContain('Every execute_step submission');
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // 6. `compileSchema` — the equivalence pin and the witness.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  it('equivalence: the capturing and the silent construction give IDENTICAL verdicts', () => {
    const throwers: unknown[] = [
      { type: 'banana' },
      { type: 'object', foo: 1 },
      { type: 'object', properties: { a: 1 } },
      { type: 'string', format: 'email' },
      { $ref: '#/definitions/nope' },
      { enum: [] },
    ];
    for (const schema of throwers) {
      let silent = '';
      let capturing = '';
      try {
        compileSchema(schema as never);
      } catch (e) {
        silent = (e as Error).message;
      }
      try {
        compileSchema(schema as never, { onStrictLog: () => {} });
      } catch (e) {
        capturing = (e as Error).message;
      }
      expect(silent).not.toBe('');
      expect(capturing).toBe(silent);
    }
    // And the LOG class compiles under BOTH — only the side channel differs.
    const logClass = { type: 'object', properties: { a: { type: ['string', 'number'] } } };
    const lines: string[] = [];
    expect(() => compileSchema(logClass as never)).not.toThrow();
    expect(() =>
      compileSchema(logClass as never, { onStrictLog: (l) => lines.push(l) }),
    ).not.toThrow();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('use allowUnionTypes');
  });

  it('witness: ONE Ajv construction for authored blocks, and the loader uses it', () => {
    const src = fileURLToPath(new URL('..', import.meta.url));
    // (a) `input-schema.ts`, COMMENTS STRIPPED, constructs Ajv exactly once. Stripping matters:
    // the module's own prose used to carry the construction's spelling and tripped a raw count.
    const stripped = readFileSync(join(src, 'validation', 'input-schema.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(stripped.split('new Ajv(').length - 1).toBe(1);
    // (b) the loader's admission closure compiles through that helper and constructs nothing. The
    // three pre-existing loader constructions (extensions declaration, adapter config_schema,
    // service entry) compile CODE-declared schemas and are outside this slice by construction.
    const loader = readFileSync(join(src, 'workflow', 'yaml-loader.ts'), 'utf8');
    const start = loader.indexOf('const admitSchemaBlock');
    expect(start).toBeGreaterThan(-1);
    const end = loader.indexOf('\n    };', start);
    expect(end).toBeGreaterThan(start);
    const slice = loader.slice(start, end);
    expect(slice).toContain('compileSchema(');
    expect(slice).not.toContain('new Ajv(');
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // 7. `validateRunParams` — the params voice.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  it('the typed wrap speaks the $ref sentence too — one composer for every door', () => {
    expect(() => validateRunParams({}, { $ref: '#/definitions/nope' } as never, 'w')).toThrow(
      "Workflow 'w' declares a params_schema that is not a valid JSON Schema — '$ref' points at a definition this block does not have ('$ref: #/definitions/nope' here). No run was created.",
    );
  });
  it('validateRunParams names the workflow and the failing path, never a step', () => {
    try {
      validateRunParams(
        { a: 1 },
        { type: 'object', properties: { a: { type: 'string' } } } as never,
        'wf-id',
      );
      throw new Error('expected a refusal');
    } catch (err) {
      const e = err as WorkflowError;
      expect(e).toBeInstanceOf(WorkflowError);
      expect(e.message).toBe("Invalid params for workflow 'wf-id': /a must be string");
      expect(e.code).toBe('VALIDATION_INPUT_SCHEMA');
      expect(e.category).toBe('VALIDATION');
      expect(e.agentAction).toBe('provide_input');
      expect(e.retryable).toBe(false);
      expect((e.details as { errors: unknown[] }).errors).toHaveLength(1);
      // The old call said `Invalid input for step '<id>'` — a false statement about what ran.
      expect(e.message).not.toContain('step');
    }
  });

  it('validateRunParams reports a ROOT failure as (root)', () => {
    try {
      validateRunParams({}, { type: 'object', required: ['a'] } as never, 'wf-id');
      throw new Error('expected a refusal');
    } catch (err) {
      expect((err as WorkflowError).message).toBe(
        "Invalid params for workflow 'wf-id': (root) must have required property 'a'",
      );
    }
  });

  it('validateRunParams wraps a COMPILE failure TYPED — the grandfathered stored copy (walk D2)', () => {
    // `start_run` reads the REGISTERED copy, which the loader never revisits, so a stored
    // `params_schema` this release refuses at load is compiled here for the first time. Bare, it
    // was `ENGINE_INTERNAL` + `agent_action: stop` carrying only the validator's sentence.
    let thrown: WorkflowError | undefined;
    try {
      validateRunParams({ a: 1 }, { type: 'banana' } as never, 'ticket-triage');
    } catch (err) {
      thrown = err as WorkflowError;
    }
    expect(thrown).toBeDefined();
    expect(thrown?.code).toBe('VALIDATION_WORKFLOW_SCHEMA');
    expect(thrown?.category).toBe('VALIDATION');
    expect(thrown?.agentAction).toBe('stop');
    expect(thrown?.retryable).toBe(false);
    expect(thrown?.message).toBe(
      "Workflow 'ticket-triage' declares a params_schema that is not a valid JSON Schema — " +
        "'type' must be one of array, boolean, integer, null, number, object, string ('type: banana' here). No " +
        "run was created. Re-register a fixed file — 'realm workflow validate <file>' shows the " +
        "line; 'realm workflow validate --registered ticket-triage' names the block.",
    );
  });

  it('the THREE step validators keep their bare throw — #556 owns that envelope', () => {
    // Deliberate asymmetry, pinned so nobody "harmonises" it: only the params door is typed here.
    for (const fn of [validateInputSchema, validateOutputSchema]) {
      expect(() => fn({ a: 1 }, { type: 'banana' } as never, 's1')).toThrow();
      try {
        fn({ a: 1 }, { type: 'banana' } as never, 's1');
      } catch (err) {
        expect(err).not.toBeInstanceOf(WorkflowError);
      }
    }
  });

  it('control: conforming params pass silently', () => {
    expect(() =>
      validateRunParams(
        { a: 'x' },
        { type: 'object', properties: { a: { type: 'string' } } } as never,
        'wf-id',
      ),
    ).not.toThrow();
  });
});
