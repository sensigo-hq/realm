// issue #427 — `realm workflow validate --registered <id>`: auditing the STORED copy.
//
// The mechanism is strip-the-stamped-keys and re-serialize through the REAL loader (kubectl's
// server-side dry-run shape), so no rule is duplicated and this surface cannot drift from what
// `register` would accept. These cells pin the four verdict shapes it can reach, the honesty
// line, and the fidelity of the strip.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCommand } from './validate.js';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  RUNTIME_ONLY_WORKFLOW_KEYS,
  WorkflowError,
  storedCopyFaultError,
} from '@sensigo/realm';
import { CONTEXT_DEPENDENT_CHECKS } from '../lib/admission-context.js';
import type { CliHome } from '../lib/home.js';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';
import { plantRegistryRow } from '@sensigo/realm-store-sqlite/test-support';

describe('validate --registered (issue #427)', () => {
  let home: string;
  let h: TempHome;
  let originalHome: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'realm-validate-reg-'));
    h = await makeTempHome({ home: join(home, '.realm') });
    originalHome = process.env['HOME'];
    process.env['HOME'] = home;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    await h.cleanup();
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const out = (): string =>
    [logSpy, warnSpy, errSpy]
      .flatMap((s) => s.mock.calls.map((c: unknown[]) => String(c[0])))
      .join('\n');

  /** A stored shape carrying the keys the file loader stamps — the realistic starting point. */
  function stored(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'stored-wf',
      name: 'Stored WF',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      origin: 'human',
      source_dir: '/somewhere/on/the/registering/machine',
      trust_root: '/somewhere',
      steps: { a: { description: 'a', execution: 'agent' } },
      ...over,
    };
  }

  it("R1 THE CROWN — a stored definition today's loader would refuse", async () => {
    // The whole point of the surface: a workflow that is registered and runs today, whose stored
    // shape the CURRENT loader rejects. On the real registry this is `08-pr-review` and its
    // `auth.token_from` (removed in v0.14.0); the synthetic here uses the #402 prohibition,
    // which is the same class and needs no service block.
    await h.home.workflowStore.register(
      stored({
        steps: { a: { description: 'a', execution: 'agent', timeout_seconds: 60 } },
      }) as never,
    );

    await expect(
      validateCommand.parseAsync(['--registered', 'stored-wf'], { from: 'user' }),
    ).rejects.toThrow('process.exit');

    const text = out();
    expect(text).toContain(
      "Auditing the registered copy of 'stored-wf' (schema_version 1) with realm",
    );
    // issue #508 — the header now narrows the grandfathering claim to LOADER changes (a NEW
    // engine-side dispatch check like the trust-value refusal is NOT grandfathered), so this pin
    // asserts the claim VERBATIM again rather than a substring — a substring would keep passing
    // through a future edit that quietly widened the claim back to something false.
    // issue #508 correction (item 6): "this release's" was version-relative with no anchor on a
    // permanent, unconditional string — replaced with a hard anchor (issue #508, realm 0.42.0).
    // #600 D1 correction (C-1): the first sentence said "this reports what re-registration today
    // would say", false once the folder's files differ from the copy; it now says what the checks read
    // and what the cache lines size (executed in validate-cacheability.test.ts, "G-1 (2)" and
    // "G-1 (6)"). The #508 sentence is unchanged. (a) red when the old words return; (b) prints the
    // output, header line included.
    expect(text).toContain(
      'Registered copies stay grandfathered at runtime against LOADER changes — the checks run ' +
        "today's loader on the copy, as registering the unchanged workflow again would; the " +
        'cache lines size the copy as stored. A NEW engine-side dispatch check (issue #508, ' +
        'realm 0.42.0) is NOT grandfathered: it applies immediately, whatever schema_version ' +
        'is on file.',
    );
    expect(text).toContain("'timeout_seconds' is not valid on execution: agent steps");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("issue #933, T10 — a copy registered before the change, with a precondition on the run's input: the audit prints the refusal without a line, exit 1", async () => {
    // Written straight into the store: the new build will not register it. The stored JSON has no
    // source lines, so the refusal carries no "(step at line N)".
    await h.home.workflowStore.register(
      stored({
        steps: {
          s: { description: 's', execution: 'auto', preconditions: ["run.params.mode == 'go'"] },
        },
      }) as never,
    );

    await expect(
      validateCommand.parseAsync(['--registered', 'stored-wf'], { from: 'user' }),
    ).rejects.toThrow('process.exit');

    const lines = out().split('\n');
    // (a) red when the audit does not show the refusal, shows it with a line, or exits 0;
    //     (b) prints the lines that name the step and the exit.
    expect({
      refusal: lines.filter((l) => l.includes("Step 's':")),
      exit: exitSpy.mock.calls[0]?.[0],
    }).toEqual({
      refusal: [
        "Invalid workflow: Step 's': precondition 'run.params.mode == 'go'' reads 'run.params.mode', " +
          "the run's input. A precondition reads only what the workflow's steps recorded, never the " +
          "run's input, so it could never be true and the step could never run. To refuse a run " +
          'whose input does not fit, declare it in params_schema. Then register the workflow again.',
      ],
      exit: 1,
    });
  });

  it('R2 warnings-only — the header, the warnings, Valid, exit 0', async () => {
    // The fixture's warning MUST be non-escalating. #170 is LIVE: an unknown-key fixture
    // resolves to ERROR under the default policy and refuses, flipping this cell to exit 1 and
    // testing the opposite of what it claims. `retry` on an agent step is inert-and-warned.
    await h.home.workflowStore.register(
      stored({
        steps: { a: { description: 'a', execution: 'agent', retry: { max_attempts: 3 } } },
      }) as never,
    );

    await validateCommand.parseAsync(['--registered', 'stored-wf'], { from: 'user' });

    const text = out();
    expect(text).toContain("Auditing the registered copy of 'stored-wf'");
    expect(text).toContain("'retry' is inert on execution: 'agent' steps");
    expect(text).toContain('Valid: stored-wf');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('R3 --strict flips a warnings-only audit to exit 1, in the singular', async () => {
    await h.home.workflowStore.register(
      stored({
        steps: { a: { description: 'a', execution: 'agent', retry: { max_attempts: 3 } } },
      }) as never,
    );

    await expect(
      validateCommand.parseAsync(['--registered', 'stored-wf', '--strict'], { from: 'user' }),
    ).rejects.toThrow('process.exit');

    expect(out()).toContain('1 warning; failing due to --strict');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("R4 an ancient (schema_version-less) entry gets the LEGACY verdict, not the loader's", async () => {
    // A true sv-less shape, matching the real cohort's topology — no `steps` key at all. Fed to
    // the loader ungated it yields `Missing required field: 'steps'`, which is true of the shape
    // and useless about the cause; the gate is what turns that into the re-register remedy.
    await h.home.workflowStore.register({ id: 'ancient-wf', name: 'Ancient', version: 2 } as never);

    await expect(
      validateCommand.parseAsync(['--registered', 'ancient-wf'], { from: 'user' }),
    ).rejects.toThrow('process.exit');

    const text = out();
    expect(text).toContain("Auditing the registered copy of 'ancient-wf' with realm");
    // ONE clause: no schema_version parenthetical (nothing parsed to read one from) and no
    // grandfathering sentence (false here — every runtime consumer goes through this same gate,
    // so a legacy entry cannot run at all).
    expect(text).not.toContain('schema_version');
    expect(text).not.toContain('stay grandfathered');
    expect(text).toContain('registered with an older version of Realm');
    expect(text).not.toContain("Missing required field: 'steps'");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('R5 an unknown id names the list command', async () => {
    await expect(
      validateCommand.parseAsync(['--registered', 'no-such-wf'], { from: 'user' }),
    ).rejects.toThrow('process.exit');

    const text = out();
    expect(text).toContain('Error: Workflow not found: no-such-wf');
    expect(text).toContain('Registered workflows: realm workflow list');
  });

  it('R6 an extensions-declaring stored copy whose tree is gone: the derived not-run line, and a real verdict', async () => {
    // The from-string loader HARD-THROWS on an `extensions` key with "Register this workflow
    // from its YAML file" — maximally misleading here, where the workflow IS registered. The
    // key is deleted before the parse; the third conjunct pins that. issue #553: the old
    // hand-typed honesty line is gone — this is the line DERIVED from CONTEXT_DEPENDENT_CHECKS,
    // whole-message. The fixture's `trust_root` (/somewhere) does not exist, so the extensions
    // member is declared, not run; no profile ⇒ that member does not apply.
    await h.home.workflowStore.register(stored({ extensions: './dist/registry.js' }) as never);

    await validateCommand.parseAsync(['--registered', 'stored-wf'], { from: 'user' });

    const text = out();
    expect(text).toContain(
      '1 check not run: project extensions (modules, manifest, config_schema) (trust_root /somewhere no longer exists)',
    );
    expect(text).toContain('Valid: stored-wf'); // it reached a verdict
    expect(text).not.toContain('Register this workflow from its YAML file');
    expect(text).not.toContain('Extensions/profiles declared'); // the old line is dead

    // ORDER, per header line. The disclosure line only means anything under the "Auditing…"
    // frame, and nothing else pins that: header-before-VERDICT is true by construction (a
    // refusing parse exits before a late header could print), but header-before-LINE was
    // pinned by nothing — moving the header below it left 12/12 green.
    //
    // Per-member deliberately: a single first-line conjunct would be VACUOUS under header
    // deletion (indexOf's -1 satisfies `< x`) and blind to a line-2-only reorder.
    const honestyAt = text.indexOf('1 check not run');
    const headerAt = text.indexOf("Auditing the registered copy of 'stored-wf'");
    expect(headerAt).toBeGreaterThanOrEqual(0);
    expect(headerAt).toBeLessThan(honestyAt);
    const gfAt = text.indexOf('stay grandfathered at runtime');
    expect(gfAt).toBeGreaterThanOrEqual(0);
    expect(gfAt).toBeLessThan(honestyAt);
  });

  it('R6b a profile-declaring copy whose tree is gone: BOTH members declared, two reasons', async () => {
    // The profile member APPLIES here (a step declares agent_profile) and its `source_dir` is
    // gone, so the line names two checks and two `; `-joined reasons, in member order (issue
    // #553, audit round 2 F3). `existsSync` is what keeps this a declaration rather than the
    // WRONG error (`resolveAgentProfiles` against the dead tree would name a path under it).
    await h.home.workflowStore.register(
      stored({
        steps: { a: { description: 'a', execution: 'agent', agent_profile: 'reviewer' } },
      }) as never,
    );

    await validateCommand.parseAsync(['--registered', 'stored-wf'], { from: 'user' });

    const text = out();
    expect(text).toContain(
      '2 checks not run: agent-profile file resolution (source_dir /somewhere/on/the/registering/machine no longer exists); ' +
        'project extensions (modules, manifest, config_schema) (trust_root /somewhere no longer exists)',
    );
    expect(text).not.toContain("agent_profile 'reviewer' not found");
    expect(text).toContain('Valid: stored-wf');
  });

  it('R7a THE FIDELITY PIN — a realistic stored copy mints no stamped-key warnings', async () => {
    await h.home.workflowStore.register(stored() as never);

    await validateCommand.parseAsync(['--registered', 'stored-wf'], { from: 'user' });

    const text = out();
    for (const key of RUNTIME_ONLY_WORKFLOW_KEYS) {
      expect(text).not.toContain(`unknown key '${key}'`);
    }
    expect(text).toContain('Valid: stored-wf');
  });

  it('R7b every member of the partition is stripped, not just the ones a file load stamps', async () => {
    // The file loader stamps only SOME of the seven, so R7a alone leaves the constant-iterating
    // assertion partly vacuous. Planting all of them directly makes it bite on each — and keeps
    // the pin honest if the partition ever grows a member.
    const withEveryStampedKey: Record<string, unknown> = stored();
    for (const key of RUNTIME_ONLY_WORKFLOW_KEYS) {
      withEveryStampedKey[key] ??= key === 'resolved_profiles' ? {} : 'planted';
    }
    withEveryStampedKey['schema_version'] = CURRENT_WORKFLOW_SCHEMA_VERSION;
    await h.home.workflowStore.register(withEveryStampedKey as never);

    await validateCommand.parseAsync(['--registered', 'stored-wf'], { from: 'user' });

    const text = out();
    for (const key of RUNTIME_ONLY_WORKFLOW_KEYS) {
      expect(text, `stamped key leaked: ${key}`).not.toContain(`unknown key '${key}'`);
    }
    expect(text).toContain('Valid: stored-wf');
  });

  it('R8 neither a path nor --registered is an error that names both routes', async () => {
    await expect(validateCommand.parseAsync([], { from: 'user' })).rejects.toThrow('process.exit');
    expect(out()).toContain(
      'Error: provide a workflow path, or --registered <id> to audit a stored definition.',
    );
  });

  it('R8 both a path and --registered is refused — commander gates neither', async () => {
    await expect(
      validateCommand.parseAsync(['some/path', '--registered', 'stored-wf'], { from: 'user' }),
    ).rejects.toThrow('process.exit');
    expect(out()).toContain(
      'Error: --registered audits the stored copy — it cannot be combined with a path.',
    );
  });

  // -------------------------------------------------------------------------------------------
  // #616 PR-2c c5c — a refusal whose copy has no file (a database's row; injected here through the
  // JSON registry's `get`, as no command reaches one at the base): no file to remove. #616 PR-2c c5a:
  // the registry-entry line again — the SQLite registry's listing counts such a copy under "could not
  // be read", by its workflow id.
  const ENTRY =
    'The registry holds an entry for \'wf\' — realm workflow list counts it under "could not be read" instead of listing it.';
  const REREGISTER =
    're-register the workflow from its source (realm workflow register <path-to-workflow>)';

  it('c5c state 2: a damaged copy with no file prints its error, the registry-entry line and the re-register act alone', async () => {
    const err = storedCopyFaultError('wf', { kind: 'not_a_workflow', fault: 'no_steps' });
    // The prototype the handle's registry instance has: the command opens its own registry through
    // the door, an instance of the same class (c10a-2c-i).
    const proto = Object.getPrototypeOf(h.home.workflowStore) as CliHome['workflowStore'];
    vi.spyOn(proto, 'get').mockRejectedValue(err);
    await expect(
      validateCommand.parseAsync(['--registered', 'wf'], { from: 'user' }),
    ).rejects.toThrow('process.exit');
    // (a) red when the registry-entry line is left out for a refusal with no file (c5a), or when
    //     the pathless branch is removed ("; if it was never registered from a source, remove the
    //     file (rm ) instead."); (b) prints every line.
    expect(out()).toBe(`Error: ${err.message}\n${ENTRY}\nTo repair: ${REREGISTER}.`);
  });

  it('c5c state 3: the damaged pointer (no file, no fault) prints its own words and the registry-entry line, no repair', async () => {
    // A copy of the SQLite registry's `damagedPointerError` (store-sqlite `workflow-store.ts:73-86`,
    // private to its module): its code, details and message.
    const err = new WorkflowError(
      "The registered copy of workflow 'wf' is missing from the store or is not JSON: something " +
        'other than Realm changed the database. Register the workflow again from its source; if ' +
        'this message comes back, restore the database from a backup.',
      {
        code: 'RESOURCE_FORMAT_INVALID',
        category: 'RESOURCE',
        agentAction: 'stop',
        retryable: false,
        details: { workflowId: 'wf' },
      },
    );
    // The prototype the handle's registry instance has: the command opens its own registry through
    // the door, an instance of the same class (c10a-2c-i).
    const proto = Object.getPrototypeOf(h.home.workflowStore) as CliHome['workflowStore'];
    vi.spyOn(proto, 'get').mockRejectedValue(err);
    await expect(
      validateCommand.parseAsync(['--registered', 'wf'], { from: 'user' }),
    ).rejects.toThrow('process.exit');
    // (a) red when the registry-entry line is left out for a refusal with no file (c5a), or when
    //     the pointer gets a repair act (the `fault` condition removed: "To repair: re-register …");
    //     (b) prints every line.
    expect(out()).toBe(`Error: ${err.message}\n${ENTRY}`);
  });

  // #616 PR-2c c10a-4a: the same arms on the real registry, planted on a foreign connection.
  it('the pointer arm: its own sentence and the registry-entry line, exit 1, no repair and no `rm` (R9)', async () => {
    await plantRegistryRow(h.path, { id: 'wf', text: '{ not json' });
    await expect(
      validateCommand.parseAsync(['--registered', 'wf'], { from: 'user' }),
    ).rejects.toThrow('process.exit');
    // (a) red when the pointer gains a repair act, the `rm` clause comes back, or the entry line is
    //     dropped; (b) prints every line and the exit.
    expect({ text: out(), exit: exitSpy.mock.calls[0]?.[0] }).toEqual({
      text:
        "Error: The registered copy of workflow 'wf' is missing from the store or is not JSON: something other than Realm changed the database. Register the workflow again from its source; if this message comes back, restore the database from a backup.\n" +
        ENTRY,
      exit: 1,
    });
  });

  it('the checker arm: a stored copy that is the text null names itself, the entry line and the re-register act (T-U3)', async () => {
    await plantRegistryRow(h.path, { id: 'wf', text: 'null' });
    await expect(
      validateCommand.parseAsync(['--registered', 'wf'], { from: 'user' }),
    ).rejects.toThrow('process.exit');
    // (a) red when `null` crashes the command or reads as another clause, or the act is dropped;
    //     (b) prints every line.
    expect(out()).toBe(
      `Error: the registered copy of 'wf' is JSON but not a workflow object (it is null)\n${ENTRY}\nTo repair: ${REREGISTER}.`,
    );
  });

  // -------------------------------------------------------------------------------------------
  // issue #558 PR-T — the arms re-keyed on CODE. `validate.ts`'s `:581` rethrow is the #123 bug
  // guard ("an unexpected WorkflowError is a bug, and bugs stay loud"); PR-T's two new codes
  // would have fallen into it and printed a STACK TRACE where main printed a clean line.
  it('T-U5 the `:581` rethrow\u2019s population is EMPTY — every WorkflowError code get() can throw is handled above it', () => {
    // Derived from the store\u2019s own table rather than remembered: probeClassToError mints
    // exactly three codes and parseFailureError one, and the legacy mint is the fifth. Each has
    // an arm ABOVE the rethrow, so nothing reaches the bug guard — which STAYS, as armor.
    const FROM_GET = [
      'STATE_WORKFLOW_NOT_FOUND',
      'STATE_WORKFLOW_UNREADABLE',
      'RESOURCE_FORMAT_INVALID',
      'STATE_LEGACY_FORMAT',
    ];
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), 'validate.ts'),
      'utf8',
    );
    const body = src.slice(src.indexOf('async function validateRegistered'));
    const guardAt = body.indexOf('#123');
    expect(guardAt).toBeGreaterThan(-1);
    const aboveGuard = body.slice(0, guardAt);
    for (const code of FROM_GET) {
      expect(aboveGuard, `${code} must be handled above the #123 rethrow`).toContain(code);
    }
  });

  it('C8 (issue #433) a stored copy with gate.choices: [] on a gate-trusted step is refused — message pin only, never a line cite (single-line JSON has none to give)', async () => {
    await h.home.workflowStore.register(
      stored({
        steps: {
          a: {
            description: 'a',
            execution: 'auto',
            trust: 'human_confirmed',
            gate: { choices: [] },
          },
        },
      }) as never,
    );

    await expect(
      validateCommand.parseAsync(['--registered', 'stored-wf'], { from: 'user' }),
    ).rejects.toThrow('process.exit');

    const text = out();
    expect(text).toContain("'gate.choices', when declared, must be non-empty");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('R8 a stored copy carrying an invalid trust value is refused by --registered too (issue #508) — no key-line assertion, deliberately: JSON.stringify(clone) is single-line, so posOf cannot place a meaningful key line in it', async () => {
    await h.home.workflowStore.register(
      stored({
        steps: { a: { description: 'a', execution: 'agent', trust: 'engine_delivered' } },
      }) as never,
    );

    await expect(
      validateCommand.parseAsync(['--registered', 'stored-wf'], { from: 'user' }),
    ).rejects.toThrow('process.exit');

    const text = out();
    expect(text).toContain("is a SERVICE's trust");
    // issue #508 correction (item 1): re-anchored to L1's own PREVENTED-harm consequence
    // clause, distinct from L2's completed-refusal wording (execution-loop.test.ts pins that
    // side) — an earlier draft's "no gate is opened" phrasing was ambiguous about mood.
    expect(text).toContain('cannot create a run while the value is wrong');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// =================================================================================================
// issue #553 — `--registered` SUPPLIES the recorded context or DECLARES the check not run.
// =================================================================================================
//
// Every fixture here is planted with `source_dir`/`trust_root` pointing at a REAL tmpdir tree —
// exactly the JSON `register` writes for a workflow registered from a tmpdir (no package.json or
// .git ancestor ⇒ `trust_root === source_dir`), never under the repo: the worktree's package.json
// would become the trust root and a "tree moved" cell would silently read as "manifest ran"
// (audit round 2 F3). Red-first on `05439cf`: cell 6's profile-less copy said `Valid` with the
// old honesty line; the stored `context_wrapper: bogus` said `Valid` (executed).
describe('validate --registered — supply or declare (issue #553)', () => {
  let home: string;
  let tree: string;
  let h: TempHome;
  let originalHome: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'realm-553-reg-home-'));
    tree = mkdtempSync(join(tmpdir(), 'realm-553-reg-tree-'));
    h = await makeTempHome({ home: join(home, '.realm') });
    mkdirSync(join(tree, 'wf'), { recursive: true });
    originalHome = process.env['HOME'];
    process.env['HOME'] = home;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    await h.cleanup();
    rmSync(home, { recursive: true, force: true });
    rmSync(tree, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const out = (): string =>
    [logSpy, warnSpy, errSpy]
      .flatMap((s) => s.mock.calls.map((c: unknown[]) => String(c[0])))
      .join('\n');
  const parseJson = (): Record<string, unknown> => {
    expect(logSpy.mock.calls).toHaveLength(1);
    return JSON.parse(String(logSpy.mock.calls[0]![0])) as Record<string, unknown>;
  };

  /** A copy registered from `<tree>/wf` (trust root = itself), through the registry's `register()`. */
  async function planted(over: Record<string, unknown> = {}, withProfile = false): Promise<void> {
    await h.home.workflowStore.register({
      id: 'stored-wf',
      name: 'Stored WF',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      origin: 'human',
      source_dir: join(tree, 'wf'),
      trust_root: join(tree, 'wf'),
      steps: {
        a: withProfile
          ? { description: 'a', execution: 'agent', agent_profile: 'reviewer' }
          : { description: 'a', execution: 'agent' },
      },
      ...over,
    } as never);
  }
  const run = (args: string[]): Promise<unknown> =>
    validateCommand.parseAsync(['--registered', 'stored-wf', ...args], { from: 'user' });

  it('cell 6 — tree present, profile file deleted → the profile refusal, checks_not_run: []', async () => {
    await planted({}, true);
    await expect(run([])).rejects.toThrow('process.exit');
    expect(out()).toContain(
      `Invalid workflow: Step 'a': agent_profile 'reviewer' not found. Searched: ${join(tree, 'wf', 'profiles', 'reviewer.md')}`,
    );
    expect(out()).not.toContain('not run');
    vi.clearAllMocks();
    await expect(run(['--json'])).rejects.toThrow('process.exit');
    const j = parseJson();
    expect(j['valid']).toBe(false);
    expect(j['errors']).toEqual([
      `Step 'a': agent_profile 'reviewer' not found. Searched: ${join(tree, 'wf', 'profiles', 'reviewer.md')}`,
    ]);
    expect(j['checks_not_run']).toEqual([]);
  });

  it('cell 6 — tree present, profile file PRESENT → supplied, Valid, no line', async () => {
    mkdirSync(join(tree, 'wf', 'profiles'));
    writeFileSync(join(tree, 'wf', 'profiles', 'reviewer.md'), '# r', 'utf8');
    await planted({}, true);
    await run([]);
    expect(out()).toContain('Valid: stored-wf');
    expect(out()).not.toContain('not run');
  });

  it('cell 6 — a stored context_wrapper: bogus is refused, WITHOUT a cite; --json carries the bare body', async () => {
    await planted({ context_wrapper: 'bogus' });
    await expect(run([])).rejects.toThrow('process.exit');
    expect(out()).toContain(
      "Invalid workflow: 'context_wrapper' must be 'xml', 'brackets', or 'none' (found: 'bogus')",
    );
    expect(out()).not.toContain('(line');
    vi.clearAllMocks();
    await expect(run(['--json'])).rejects.toThrow('process.exit');
    expect(parseJson()['errors']).toEqual([
      "'context_wrapper' must be 'xml', 'brackets', or 'none' (found: 'bogus')",
    ]);
  });

  it('7a — tree moved, no profile → 1 check not run (trust_root …), the structural verdict', async () => {
    await planted();
    rmSync(tree, { recursive: true, force: true });
    await run([]);
    expect(out()).toContain(
      `1 check not run: project extensions (modules, manifest, config_schema) (trust_root ${join(tree, 'wf')} no longer exists)`,
    );
    expect(out()).toContain('Valid: stored-wf');
  });

  it('7a — tree moved, WITH a profile → 2 checks not run, two reasons; never the WRONG profile error', async () => {
    // mutant (v): without the existsSync gate this prints `agent_profile 'reviewer' not found.
    // Searched: <dead tree>/profiles/reviewer.md` — a refusal naming a path under a tree that
    // is gone, which is not what happened.
    await planted({}, true);
    rmSync(tree, { recursive: true, force: true });
    await run([]);
    expect(out()).toContain(
      `2 checks not run: agent-profile file resolution (source_dir ${join(tree, 'wf')} no longer exists); ` +
        `project extensions (modules, manifest, config_schema) (trust_root ${join(tree, 'wf')} no longer exists)`,
    );
    expect(out()).not.toContain("agent_profile 'reviewer' not found");
    expect(out()).toContain('Valid: stored-wf');
  });

  it('7b — a legacy copy (no source_dir/trust_root recorded), no profile', async () => {
    await planted({ source_dir: undefined, trust_root: undefined });
    await run([]);
    expect(out()).toContain(
      '1 check not run: project extensions (modules, manifest, config_schema) (no trust_root recorded (registered before v0.14))',
    );
    expect(out()).toContain('Valid: stored-wf');
  });

  it('7b — a legacy copy WITH a profile: both members, both legacy reasons', async () => {
    await planted({ source_dir: undefined, trust_root: undefined }, true);
    await run([]);
    expect(out()).toContain(
      '2 checks not run: agent-profile file resolution (no source_dir recorded (registered before v0.14)); ' +
        'project extensions (modules, manifest, config_schema) (no trust_root recorded (registered before v0.14))',
    );
  });

  it('7f — a create_workflow copy (origin: agent, no paths): both members declared, both name create_workflow (issue #553 correction C1)', async () => {
    // `create_workflow` stamps `origin: 'agent'` and never records a source tree at all — not
    // "before v0.14", a different mechanism entirely. Both members must name it, not the version.
    await planted({ origin: 'agent', source_dir: undefined, trust_root: undefined }, true);
    await run([]);
    expect(out()).toContain(
      '2 checks not run: agent-profile file resolution ' +
        '(no source_dir recorded (created by create_workflow, which registers without a source tree)); ' +
        'project extensions (modules, manifest, config_schema) ' +
        '(no trust_root recorded (created by create_workflow, which registers without a source tree))',
    );
    expect(out()).toContain('Valid: stored-wf');
  });

  it("7c — parity: JSON length === the human N, AND each JSON id's label appears in the human line, in order", async () => {
    await planted({}, true);
    rmSync(tree, { recursive: true, force: true });
    await run([]);
    const line = out()
      .split('\n')
      .find((l) => l.includes('not run: '));
    expect(line).toBeDefined();
    const n = Number(/^(\d+) checks? not run/.exec(line!)?.[1]);
    vi.clearAllMocks();
    await run(['--json']);
    const j = parseJson();
    const entries = j['checks_not_run'] as Array<{ id: string; reason: string }>;
    expect(entries).toHaveLength(n);
    expect(entries).toEqual([
      { id: 'agent_profile_resolution', reason: `source_dir ${join(tree, 'wf')} no longer exists` },
      { id: 'project_extensions', reason: `trust_root ${join(tree, 'wf')} no longer exists` },
    ]);
    // The label+reason conjunct (audit round 2 F12 / correction C6): each JSON entry's label
    // AND its own reason must appear TOGETHER, in order — a count-only parity cannot see a
    // dropped label or a reason rendered beside the wrong member.
    const partsPart = line!.slice(line!.indexOf('not run: ') + 'not run: '.length);
    let cursor = 0;
    for (const e of entries) {
      const label = CONTEXT_DEPENDENT_CHECKS.find((c) => c.id === e.id)!.label;
      const pair = `${label} (${e.reason})`;
      const at = partsPart.indexOf(pair, cursor);
      expect(at, `${e.id} label+reason in order`).toBeGreaterThanOrEqual(cursor);
      cursor = at + pair.length;
    }
  });

  it('7d — a non-empty checks_not_run does NOT flip --strict (a disclosure, not a warning)', async () => {
    await planted();
    rmSync(tree, { recursive: true, force: true });
    await run(['--strict']);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(out()).toContain('1 check not run: ');
    expect(out()).toContain('Valid: stored-wf');
    expect(out()).not.toContain('failing due to --strict');
    vi.clearAllMocks();
    await run(['--json', '--strict']);
    const j = parseJson();
    expect((j['strict'] as { failed: boolean }).failed).toBe(false);
    expect(j['checks_not_run']).toHaveLength(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('7e — CONTROL: the workflow dir moved but the project root survives → the manifest check RUNS, no line', async () => {
    writeFileSync(join(tree, 'package.json'), '{"type":"module"}', 'utf8');
    await planted({ trust_root: tree });
    rmSync(join(tree, 'wf'), { recursive: true, force: true });
    await run([]);
    expect(out()).not.toContain('not run');
    expect(out()).toContain('Valid: stored-wf');
  });

  it('7e — tree present with an INVALID realm.yaml → `Error loading extensions:` on the stored copy, as register would', async () => {
    writeFileSync(join(tree, 'wf', 'realm.yaml'), 'version: 1\nadapters: [\n', 'utf8');
    await planted();
    await expect(run([])).rejects.toThrow('process.exit');
    expect(out()).toContain(
      `Error loading extensions: Deployment manifest '${join(tree, 'wf', 'realm.yaml')}' is not valid YAML:`,
    );
    expect(out()).not.toContain('not run');
  });

  it("8a — --extensions-module unresolvable, tree present → the file arm's exact message, travels through --registered too (issue #553 correction C2)", async () => {
    await planted();
    await expect(run(['--extensions-module', './nope.mjs'])).rejects.toThrow('process.exit');
    expect(out()).toContain(
      `Error loading extensions: Cannot resolve --extensions-module './nope.mjs': ENOENT: no such file or directory, lstat '${resolve('./nope.mjs')}'`,
    );
  });

  it('8b — tree moved + --extensions-module: the override cannot apply, said so beside the reason, never silently (issue #553 correction C5)', async () => {
    await planted();
    rmSync(tree, { recursive: true, force: true });
    await run(['--extensions-module', './nope.mjs']);
    expect(out()).toContain(
      `1 check not run: project extensions (modules, manifest, config_schema) ` +
        `(trust_root ${join(tree, 'wf')} no longer exists; --extensions-module not applied)`,
    );
    // issue #553 correction C9 — the verdict tail carries the not-run count.
    expect(out()).toContain('Valid: stored-wf v1 (1 step) — 1 check not run');
    expect(exitSpy).not.toHaveBeenCalled();

    vi.clearAllMocks();
    await run(['--json', '--extensions-module', './nope.mjs']);
    const j = parseJson();
    expect((j['checks_not_run'] as Array<{ reason: string }>)[0]!.reason).toBe(
      `trust_root ${join(tree, 'wf')} no longer exists; --extensions-module not applied`,
    );
  });

  it('9 — the verdict tail carries the not-run count: five shapes on --registered (issue #553 correction C9)', async () => {
    const validLine = (): string | undefined =>
      out()
        .split('\n')
        .find((l) => l.startsWith('Valid:'));

    // (1) every check ran → the bare line, no tail.
    await planted();
    await run([]);
    expect(validLine()).toBe('Valid: stored-wf v1 (1 step)');

    // (2) warnings only, no --strict → the same bare line, warnings above.
    vi.clearAllMocks();
    await planted({
      steps: { a: { description: 'a', execution: 'agent', retry: { max_attempts: 3 } } },
    });
    await run([]);
    expect(out()).toContain("'retry' is inert on execution: 'agent' steps");
    expect(validLine()).toBe('Valid: stored-wf v1 (1 step)');

    // (3) not-run only → the tail names it, no warning count.
    vi.clearAllMocks();
    await planted();
    rmSync(tree, { recursive: true, force: true });
    await run([]);
    expect(validLine()).toBe('Valid: stored-wf v1 (1 step) — 1 check not run');
    expect(exitSpy).not.toHaveBeenCalled();

    // (4) warnings + not-run, no --strict → the SAME tail as (3) — no warning count, exit 0.
    vi.clearAllMocks();
    await planted({
      steps: { a: { description: 'a', execution: 'agent', retry: { max_attempts: 3 } } },
    });
    rmSync(tree, { recursive: true, force: true });
    await run([]);
    expect(out()).toContain("'retry' is inert on execution: 'agent' steps");
    expect(validLine()).toBe('Valid: stored-wf v1 (1 step) — 1 check not run');
    expect(exitSpy).not.toHaveBeenCalled();

    // (5) --strict failing + not-run → both clauses, `; `-joined, exit 1.
    vi.clearAllMocks();
    await planted({
      steps: {
        a: { description: 'a', execution: 'agent', retry: { max_attempts: 3 } },
        b: { description: 'b', execution: 'agent', retry: { max_attempts: 3 } },
      },
    });
    rmSync(tree, { recursive: true, force: true });
    await expect(run(['--strict'])).rejects.toThrow('process.exit');
    expect(validLine()).toBe(
      'Valid: stored-wf v1 (2 steps) — 1 check not run; 2 warnings; failing due to --strict',
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('9b — the description line survives a not-run tail; only a failing --strict suppresses it (issue #553 correction C9 — the `!strictFailing` conjunct, MA novel probe)', async () => {
    // (a) not-run tail, no --strict: the description prints right after the verdict line — a moved
    // tree is a disclosure, not a reason to hide what the workflow is for.
    await planted({ description: 'Reviews a change.' });
    rmSync(tree, { recursive: true, force: true });
    await run([]);
    const lines = out().split('\n');
    const at = lines.indexOf('Valid: stored-wf v1 (1 step) — 1 check not run');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(lines[at + 1]).toBe('  Reviews a change.');
    expect(exitSpy).not.toHaveBeenCalled();

    // (b) control — the SAME not-run copy under a failing --strict: the description is suppressed.
    vi.clearAllMocks();
    await planted({
      description: 'Reviews a change.',
      steps: { a: { description: 'a', execution: 'agent', retry: { max_attempts: 3 } } },
    });
    rmSync(tree, { recursive: true, force: true });
    await expect(run(['--strict'])).rejects.toThrow('process.exit');
    expect(out()).toContain('failing due to --strict');
    expect(out()).not.toContain('  Reviews a change.');

    // (c) control — the SAME not-run copy under a PASSING --strict (no warnings): the description
    // prints. The flag alone suppresses nothing; only the failing STATE does — `strictFailing` is
    // `strict && failsStrict(warnings)`, and this half pins its second member (a `!strict` mutant
    // leaves (a) and (b) green).
    vi.clearAllMocks();
    await planted({ description: 'Reviews a change.' });
    rmSync(tree, { recursive: true, force: true });
    await run(['--strict']);
    const strictLines = out().split('\n');
    const strictAt = strictLines.indexOf('Valid: stored-wf v1 (1 step) — 1 check not run');
    expect(strictAt).toBeGreaterThanOrEqual(0);
    expect(strictLines[strictAt + 1]).toBe('  Reviews a change.');
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
