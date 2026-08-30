// enforcement-journeys.test.ts — the loader-enforcement trio (#170 + #369 + #338) walked the way
// an author meets it: broken workflow in, refusal out, fix applied, workflow passes.
//
// Each refusal in this PR is only as good as the sentence it prints, because the author's next
// move is decided entirely by that sentence. A cell that asserts "it threw" would pass for a
// message that says nothing useful. So each journey below asserts the REMEDY the message gives,
// then applies exactly that remedy and shows the workflow now loads.
//
// J-D is the odd one out and the most important: it proves the asymmetry the changelog claims.
// #170 refuses at validate/register/watch and NOT on the execution path, so a workflow already
// deployed with an unknown key keeps running. If that ever stops being true, this PR's release
// notes become false.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkflowFromFile, loadWorkflowFromString, WorkflowError } from '@sensigo/realm';
import { validateCommand } from './validate.js';

let dir: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'realm-journey-'));
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
    throw new Error('process.exit');
  }) as never);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Writes `content` to the scratch workflow file and returns its path. */
function write(content: string): string {
  const p = join(dir, 'workflow.yaml');
  writeFileSync(p, content, 'utf8');
  return p;
}

/** Runs `realm workflow validate` and reports whether it refused, plus what it said. */
async function validate(path: string): Promise<{ refused: boolean; out: string }> {
  logSpy.mockClear();
  warnSpy.mockClear();
  errorSpy.mockClear();
  exitSpy.mockClear();
  let refused = false;
  try {
    await validateCommand.parseAsync([path], { from: 'user' });
  } catch {
    refused = true;
  }
  const all = [logSpy, warnSpy, errorSpy]
    .flatMap((spy) => spy.mock.calls.map((c: unknown[]) => String(c[0])))
    .join('\n');
  return { refused: refused || exitSpy.mock.calls.length > 0, out: all };
}

describe('J-A — an author mistypes a step key (#170)', () => {
  const withTypo = `
id: journey-a
name: Journey A
version: 1
steps:
  step_one:
    description: First step
    execution: auto
  step_two:
    description: Second step
    execution: auto
    dependson: [step_one]
`;

  it('validate refuses, names the key, and suggests the right one — then the fix passes', async () => {
    const first = await validate(write(withTypo));
    expect(first.refused).toBe(true);
    expect(first.out).toContain("unknown key 'dependson'");
    // The suggestion is the whole reason this is a one-edit fix rather than a doc hunt.
    expect(first.out).toContain("did you mean 'depends_on'?");
    // And it must not tell the author the key was ignored, one line above refusing over it.
    expect(first.out).not.toContain('ignored');

    // Apply exactly what the message suggested.
    const second = await validate(write(withTypo.replace('dependson', 'depends_on')));
    expect(second.refused).toBe(false);
    expect(second.out).toContain('Valid: journey-a v1 (2 steps)');
  });
});

describe('J-A2 — the same typo, one level up: a workflow-level key (#170)', () => {
  // #170 flipped TWO codes, and J-A above only ever drives one of them. The step-level and
  // workflow-level unknown-key paths are separate `findUnknownKeys` call sites feeding separate
  // scopes, so a change that reached one and not the other would be invisible: reverting
  // UNKNOWN_WORKFLOW_KEY alone to 'warn' left every cli cell green before this one existed.
  //
  // One cell, three layers for the twin: the boundary refuses, the render corrects its own
  // "— ignored" claim, and the author gets the suggestion that makes it a one-edit fix.
  const withTypo = `
id: journey-a2
name: Journey A2
version: 1
descriptoin: what this workflow does
steps:
  step_one:
    description: First step
    execution: auto
`;

  it('validate refuses a top-level typo, suggests the real key, and does not call it ignored', async () => {
    const first = await validate(write(withTypo));
    expect(first.refused).toBe(true);
    expect(first.out).toContain('escalated to an error by policy');
    expect(first.out).toContain("unknown key 'descriptoin'");
    expect(first.out).toContain("did you mean 'description'?");
    expect(first.out).not.toContain('ignored');
    expect(first.out).toContain('REFUSED below');
    // The scope is named too — "workflow 'journey-a2'", not a step — so the author knows which
    // level to look at. A step-scoped message here would send them hunting in the wrong place.
    expect(first.out).toContain("workflow 'journey-a2': unknown key 'descriptoin'");

    const second = await validate(write(withTypo.replace('descriptoin', 'description')));
    expect(second.refused).toBe(false);
    expect(second.out).toContain('Valid: journey-a2 v1 (1 steps)');
  });
});

describe('J-B — an author puts `preconditions` on a guard (#369)', () => {
  const guardWith = (extra: string): string => `
id: journey-b
name: Journey B
version: 1
steps:
  work:
    description: Do the work
    execution: agent
    depends_on: []
  gate:
    description: Guard step
    execution: guard
    depends_on: [work]
${extra}
`;

  it('the refusal names abort_unless, and the moved condition then loads AND evaluates', async () => {
    const bad = guardWith(
      `    abort_unless: "work.result.ok == true"\n    preconditions:\n      - "work.result.count > 0"`,
    );
    const first = await validate(write(bad));
    expect(first.refused).toBe(true);
    // The CAUSE clause is what this journey anchors — the author has to understand WHY before the
    // remedy means anything. (The remedy clause has its own pin in yaml-loader.test.ts.)
    expect(first.out).toContain("'preconditions' is not valid on execution: guard steps");
    expect(first.out).toContain("a guard's execution evaluates only 'abort_unless'");

    // Move the condition where the message says to put it — as a second abort_unless leaf.
    const fixed = guardWith(
      `    abort_unless:\n      - "work.result.ok == true"\n      - "work.result.count > 0"`,
    );
    const second = await validate(write(fixed));
    expect(second.refused).toBe(false);
    expect(second.out).toContain('Valid: journey-b v1 (2 steps)');

    // And the moved form is not merely accepted — it is a real guard condition the engine reads.
    const def = loadWorkflowFromFile(write(fixed));
    expect(def.steps['gate']?.abort_unless).toEqual([
      'work.result.ok == true',
      'work.result.count > 0',
    ]);
  });

  it('VARIANT: a FAILURE-shaped precondition moved to abort_unless is refused AGAIN, by #362', async () => {
    // The two-hop case. #369 says "move it to abort_unless" without inspecting the condition, so
    // an author whose condition tests for FAILURE follows that advice into #362's dead-condition
    // check — which refuses it too, and points at finalizers. Pinning the convergence here rather
    // than growing the #369 message: the second message is already correct and already specific,
    // and #369's job is not to pre-empt every condition an author might be moving.
    const hop1 = guardWith(
      `    abort_unless: "work.settled_by_default == false"\n    preconditions:\n      - "$settlement.work.failed == true"`,
    );
    const first = await validate(write(hop1));
    expect(first.refused).toBe(true);
    expect(first.out).toContain("'preconditions' is not valid on execution: guard steps");

    const hop2 = guardWith(
      `    abort_unless:\n      - "work.settled_by_default == false"\n      - "$settlement.work.failed == true"`,
    );
    const second = await validate(write(hop2));
    expect(second.refused).toBe(true);
    expect(second.out).toContain('can never be true');
    // The second message hands the author the actually-correct destination.
    expect(second.out).toContain("'execution: finalizer' step");
  });
});

describe('J-C — an author declares tools with no mcp_servers (#338)', () => {
  const base = (servers: string): string => `
id: journey-c
name: Journey C
version: 1
${servers}steps:
  ask:
    description: Ask something
    execution: agent
    depends_on: []
    input_schema:
      type: object
      properties:
        q:
          type: string
      required: [q]
    tools:
      - github:get_pull_request
`;

  it('the refusal says what to add — and adding it, or removing the tools, both work', async () => {
    const first = await validate(write(base('')));
    expect(first.refused).toBe(true);
    expect(first.out).toContain('declares tools but the workflow defines no mcp_servers');
    expect(first.out).toContain("Define an mcp_servers block, or remove 'tools'");

    // Remedy 1, as printed: define the block.
    const withServers = await validate(
      write(
        base(`mcp_servers:
  - id: github
    command: npx
    args: [-y, '@modelcontextprotocol/server-github']
`),
      ),
    );
    expect(withServers.refused).toBe(false);
    expect(withServers.out).toContain('Valid: journey-c v1 (1 steps)');

    // Remedy 2, also as printed: drop the declaration.
    const withoutTools = await validate(
      write(base('').replace('    tools:\n      - github:get_pull_request\n', '')),
    );
    expect(withoutTools.refused).toBe(false);
  });
});

describe('J-E — the author is told WHICH LINE (#392)', () => {
  // The trio refuses three things. This is the loop that closes each one: the message names a
  // line, that line genuinely holds the offending text, the author edits there, it passes.
  //
  // Every cell asserts the fixture's own text at the line the message claims. Without that, a
  // template literal's leading newline shifts every count by one and the cell would happily
  // agree with a number that points one line off.

  it('#170 — the unknown-key refusal names the line, and that line holds the key', async () => {
    const withTypo = `
id: journey-e1
name: Journey E1
version: 1
steps:
  step_one:
    description: First step
    execution: auto
  step_two:
    description: Second step
    execution: auto
    dependson: [step_one]
`;
    const first = await validate(write(withTypo));
    expect(first.refused).toBe(true);
    expect(first.out).toContain("unknown key 'dependson' (line 12)");
    // The claim is checked against the file, not against my arithmetic.
    expect(withTypo.split('\n')[12 - 1]).toContain('dependson:');

    const second = await validate(write(withTypo.replace('dependson', 'depends_on')));
    expect(second.refused).toBe(false);
    expect(second.out).toContain('Valid: journey-e1 v1 (2 steps)');
  });

  it('#170 TWIN — a workflow-level key gets a line too', async () => {
    const withTypo = `
id: journey-e2
name: Journey E2
version: 1
descriptoin: a top-level typo
steps:
  step_one:
    description: First step
    execution: auto
`;
    const first = await validate(write(withTypo));
    expect(first.refused).toBe(true);
    expect(first.out).toContain("unknown key 'descriptoin' (line 5)");
    expect(withTypo.split('\n')[5 - 1]).toContain('descriptoin:');

    const second = await validate(write(withTypo.replace('descriptoin', 'description')));
    expect(second.refused).toBe(false);
  });

  it('#369 — the guard-preconditions refusal names the guard step line', async () => {
    const bad = `
id: journey-e3
name: Journey E3
version: 1
steps:
  work:
    description: Do the work
    execution: agent
    depends_on: []
  gate:
    description: Guard step
    execution: guard
    depends_on: [work]
    abort_unless: "work.result.ok == true"
    preconditions:
      - "work.result.count > 0"
`;
    const first = await validate(write(bad));
    expect(first.refused).toBe(true);
    // The offending KEY's own line (issue #417), not the step's. `gate:` is on line 10 and
    // `preconditions:` is five lines below it — on a long step that is the difference between
    // being sent to the field and being sent to the declaration above it.
    expect(first.out).toContain('(line 15)');
    expect(bad.split('\n')[15 - 1]).toContain('preconditions:');

    const fixed = bad.replace('    preconditions:\n      - "work.result.count > 0"\n', '');
    expect((await validate(write(fixed))).refused).toBe(false);
  });

  it('#338 — the tools-without-servers refusal names the step line', async () => {
    const bad = `
id: journey-e4
name: Journey E4
version: 1
steps:
  ask:
    description: Ask something
    execution: agent
    depends_on: []
    input_schema:
      type: object
      properties:
        q:
          type: string
      required: [q]
    tools:
      - github:get_pull_request
`;
    const first = await validate(write(bad));
    expect(first.refused).toBe(true);
    expect(first.out).toContain('declares tools but the workflow defines no mcp_servers');
    expect(first.out).toContain('(step at line 6)');
    expect(bad.split('\n')[6 - 1]).toContain('ask:');

    const fixed = bad.replace('    tools:\n      - github:get_pull_request\n', '');
    expect((await validate(write(fixed))).refused).toBe(false);
  });
});

describe('J-D — the grandfathering journey: a deployed workflow keeps running (#170)', () => {
  it('the EXECUTION loader still loads a workflow with an unknown key, and still warns', () => {
    // This is the cell that makes the changelog's asymmetry sentence true. run/agent/listen load
    // through `loadWorkflowFromFile`, which never consults the policy — so an unknown key that
    // now blocks validate does NOT strand a workflow already in production.
    const deployed = `
id: journey-d
name: Journey D
version: 1
steps:
  step_one:
    description: First step
    execution: auto
    dependson: [nothing]
`;
    const path = write(deployed);
    const def = loadWorkflowFromFile(path);
    expect(def.id).toBe('journey-d');

    // And it still SAYS so — grandfathering is not silence.
    const warned = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(warned).toContain("unknown key 'dependson'");
    // On this path "— ignored" is TRUE and is deliberately kept: the key really is ignored here.
    expect(warned).toContain('— ignored');
    expect(warned).not.toContain('REFUSED below');
  });

  it('CONTRAST: the #369 and #338 refusals are NOT boundary-gated — they refuse on this path too', () => {
    // The other half of the asymmetry, and the reason the changelog must not say "boundary-gated"
    // about all three. These are loader-level errors: every YAML load path refuses them, execution
    // included. Only definitions that never re-parse YAML (store-registered, inline) are exempt.
    const guardPrecond = `
id: journey-d2
name: Journey D2
version: 1
steps:
  work:
    description: Work
    execution: agent
    depends_on: []
  gate:
    description: Guard
    execution: guard
    depends_on: [work]
    abort_unless: "work.result.ok == true"
    preconditions:
      - "work.result.count > 0"
`;
    expect(() => loadWorkflowFromString(guardPrecond)).toThrow(WorkflowError);

    const toolsNoServers = `
id: journey-d3
name: Journey D3
version: 1
steps:
  ask:
    description: Ask
    execution: agent
    depends_on: []
    input_schema:
      type: object
      properties:
        q:
          type: string
      required: [q]
    tools:
      - github:get_pull_request
`;
    expect(() => loadWorkflowFromString(toolsNoServers)).toThrow(WorkflowError);
  });
});

// =================================================================================================
// issue #417 — the double prefix, per COMMAND
//
// The predicate is unit-pinned beside its definition; these prove each command actually WIRES it.
// A shared helper nothing calls is the same defect as no helper — and both renders reach an author
// on the path they use, not through the function.
// =================================================================================================
// =================================================================================================
// issue #424 — a hard load error carries the warnings channel
//
// A workflow can be wrong in two ways at once: a key the loader REFUSES and a key it only warns
// about. The refusal threw, the warnings array unwound with the stack, and the author saw only the
// error — fixed it, re-ran, and only then met the typo. One defect per round trip.
// =================================================================================================
describe('#424 — one run reports the whole defect set', () => {
  /** A prohibited key (throws) AND a typo (warns) in the same file. */
  const BOTH = `
id: carry-424
name: Carry 424
version: 1
steps:
  classify:
    description: classify
    execution: agent
    dependson: [nowhere]
    timeout_seconds: 60
`;

  it('validate renders the warning AND the error in one pass (extension-free)', async () => {
    const result = await validate(write(BOTH));
    expect(result.refused).toBe(true);
    // The error, unchanged.
    expect(result.out).toContain("'timeout_seconds' is not valid on execution: agent steps");
    // And the warning that used to unwind with it — in its SUBSTITUTED form, because
    // printLoaderWarnings rewrites "— ignored" to "— REFUSED below" for a code this boundary
    // refuses, and that claim is true here: the line below it IS the refusal.
    expect(result.out).toContain("unknown key 'dependson'");
    expect(result.out).toContain('— REFUSED below');
    expect(result.out).toContain("did you mean 'depends_on'?");
  });

  it('the EXTENSIONS path carries them too — the second render, separately wired', async () => {
    // Same fork the #417 cell below documents: validate has two independent catches, and the
    // adjacent comment records that reverting one alone left the whole cli suite green.
    //
    // The `extensions:` VALUE has to be well-formed, not merely present. A malformed one throws
    // its own shape error first and the cell would then pass on the wrong error entirely — the
    // module never has to resolve, because the prohibition throws in pass 1, before extension
    // resolution runs.
    const withExtensions = `
id: carry-424-ext
name: Carry 424 Ext
version: 1
extensions: ./dist/registry.js
steps:
  classify:
    description: classify
    execution: agent
    dependson: [nowhere]
    timeout_seconds: 60
`;
    const result = await validate(write(withExtensions));
    expect(result.refused).toBe(true);
    expect(result.out).toContain("'timeout_seconds' is not valid on execution: agent steps");
    expect(result.out).toContain("unknown key 'dependson'");
    expect(result.out).toContain("did you mean 'depends_on'?");
  });

  it('the warning prints BEFORE the error', async () => {
    // The `validate` helper above concatenates per-spy groups, so its output is order-blind and a
    // pin over it would be vacuously green. This cell captures into ONE shared sink instead, so
    // the indices below are real emission order. (Standing instrument caveat — do not "fix" the
    // helper; this is the pattern for any cross-channel order pin.)
    const emitted: string[] = [];
    const sink = (...args: unknown[]): void => void emitted.push(String(args[0]));
    warnSpy.mockImplementation(sink);
    errorSpy.mockImplementation(sink);
    logSpy.mockImplementation(sink);

    try {
      await validateCommand.parseAsync([write(BOTH)], { from: 'user' });
    } catch {
      /* process.exit throws in this harness */
    }

    const warningAt = emitted.findIndex((l) => l.includes("unknown key 'dependson'"));
    const errorAt = emitted.findIndex((l) => l.includes('Invalid workflow:'));
    // Non-vacuity first: an order comparison between two -1s would pass for a run that printed
    // neither.
    expect(warningAt).toBeGreaterThanOrEqual(0);
    expect(errorAt).toBeGreaterThanOrEqual(0);
    expect(warningAt).toBeLessThan(errorAt);
  });

  it('--strict changes nothing: same output, same exit', async () => {
    logSpy.mockClear();
    warnSpy.mockClear();
    errorSpy.mockClear();
    exitSpy.mockClear();
    await expect(
      validateCommand.parseAsync([write(BOTH), '--strict'], { from: 'user' }),
    ).rejects.toThrow('process.exit');

    const all = [logSpy, warnSpy, errorSpy]
      .flatMap((spy) => spy.mock.calls.map((c: unknown[]) => String(c[0])))
      .join('\n');
    expect(all).toContain("unknown key 'dependson'");
    expect(all).toContain("'timeout_seconds' is not valid on execution: agent steps");
    expect(exitSpy).toHaveBeenCalledWith(1);
    // Exactly one render of each — throw-path warnings never reach the --strict accumulator, so
    // nothing double-prints.
    const warningLines = all.split('\n').filter((l) => l.includes("unknown key 'dependson'"));
    expect(warningLines).toHaveLength(1);
  });

  it('an unparseable file degrades to the error alone — warnings ABSENT, not empty', async () => {
    // The YAML parse throws before the warnings array exists, so there is nothing to attach and
    // the field stays absent. "This error carried no warnings" and "nobody looked" are different
    // facts, and ABSENT is the honest one.
    const unparseable = 'id: broken\n  bad: [indentation\n   nope\n';
    const result = await validate(write(unparseable));
    expect(result.refused).toBe(true);
    expect(result.out).toContain('YAML parse error');
    expect(result.out).not.toContain('⚠');

    let caught: unknown;
    try {
      loadWorkflowFromString(unparseable);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkflowError);
    expect((caught as WorkflowError).warnings).toBeUndefined();
  });
});

describe('#417 — a load failure says "invalid" once, per command', () => {
  const BAD = `
id: prefix-demo
name: Prefix Demo
version: 1
steps:
  first:
    description: First step
    execution: auto
    depends_on: []
  subject:
    description: A step with a key that does nothing here
    execution: auto
    depends_on: [first]
    agent_profile: reviewer
`;

  it('validate prints the loader message verbatim, with no added prefix', async () => {
    const result = await validate(write(BAD));
    expect(result.refused).toBe(true);
    expect(result.out).toContain('Invalid workflow:');
    expect(result.out).not.toContain('Invalid: Invalid workflow:');
  });

  it('the EXTENSIONS path renders it the same way — the third site, separately wired', async () => {
    // validate forks on whether the file declares `extensions:` (validate.ts:247), and the two
    // arms print through different lines. Reverting the extensions-path one alone left the whole
    // cli suite green — proven by probe — so the fork needs a cell of its own.
    //
    // No real extensions module is needed: a family prohibition throws in pass 1, before
    // extension resolution runs, so the `extensions:` block only has to exist to choose the arm.
    const withExtensions = `
id: prefix-demo-ext
name: Prefix Demo Ext
version: 1
extensions:
  modules: []
steps:
  first:
    description: First step
    execution: auto
    depends_on: []
  subject:
    description: A step with a key that does nothing here
    execution: auto
    depends_on: [first]
    agent_profile: reviewer
`;
    const result = await validate(write(withExtensions));
    expect(result.refused).toBe(true);
    expect(result.out).toContain('Invalid workflow:');
    expect(result.out).not.toContain('Invalid: Invalid workflow:');
  });
});
