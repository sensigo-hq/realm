// Tests for realm workflow watch — watchWorkflow function.
import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { mkdirSync, writeFileSync, renameSync, rmSync, rmdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { WorkflowRegistrar, WorkflowDefinition } from '@sensigo/realm';
import { watchWorkflow, makeCoalescedTrigger } from './watch.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_YAML = `
id: watch-test
name: Watch Test
version: 1
steps:
  step-one:
    description: First step
    execution: agent
`;

const INVALID_YAML = `
id: watch-test
name: Watch Test
version: 1
steps:
  step-one:
    description: First step
    execution: invalid_execution_type
`;

/** Creates a temp file with the given content and returns its path. */
function makeTempFile(content: string): string {
  const dir = join(tmpdir(), `realm-watch-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, 'workflow.yaml');
  writeFileSync(filePath, content, 'utf8');
  return filePath;
}

/** Creates a mock WorkflowRegistrar that records registered definitions. */
function makeStore(): WorkflowRegistrar & { registered: WorkflowDefinition[] } {
  const registered: WorkflowDefinition[] = [];
  return {
    registered,
    async register(def) {
      registered.push(def);
    },
    async get(id) {
      // Behaviour-identical to `registered.findLast(...)`; `findLast` needs lib ES2023 and the
      // repo's lib is ES2022 (a lib bump is out of scope for #337).
      const found = [...registered].reverse().find((d) => d.id === id);
      if (!found) throw new Error(`Not found: ${id}`);
      return found;
    },
    async list() {
      return registered;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('watchWorkflow — the issue #170 boundary-reject', () => {
  // watch.ts's rejectOnErrorSeverity branch went live with the #170 flip and had no coverage at
  // all before this cell (#170 AC-2 names watch explicitly). It refuses DIFFERENTLY from
  // validate/register: no process.exit — the watcher stays up so the author can fix the key and
  // get re-registered on the next save.
  const UNKNOWN_KEY_YAML = `
id: watch-unknown-key
name: Watch Unknown Key
version: 1
steps:
  step-one:
    description: First step
    execution: agent
    dependson: [nothing]
`;

  it('refuses to register a workflow with an unknown step key, and keeps watching', async () => {
    const filePath = makeTempFile(UNKNOWN_KEY_YAML);
    const store = makeStore();
    const controller = new AbortController();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const watchPromise = watchWorkflow(filePath, store, controller.signal);
    const errored = (): string => errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    await until(() => errored().includes('refusing to register'));

    // Nothing reached the registrar.
    expect(store.registered).toHaveLength(0);
    // issue #451 — the whole line: watch's timestamp, the escalation grammar validate and register
    // print (the culprit named), and the tail only watch needs — it does not exit, so the line has
    // to say the file was NOT registered. The line this replaced named the id and not the warning.
    expect(errored()).toMatch(
      /^\[[^\]]+\] Invalid: 1 warning, 1 escalated to an error by policy: UNKNOWN_STEP_KEY 'dependson' — refusing to register\.$/m,
    );
    expect(logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).not.toContain(
      'Registered:',
    );
    // The did-you-mean survives, and the false "ignored" claim does not.
    const warned = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(warned).toContain("did you mean 'depends_on'?");
    expect(warned).not.toContain('ignored');

    // "the watcher stays up so the author can fix the key and get re-registered on the next save"
    // — this describe's docstring has said so since the #170 flip, and until issue #451 no cell
    // executed it: the old shape aborted after 50ms. The key is DELETED rather than corrected, for
    // the reason the CONTROL below gives. Vim-style save, the harder case (#449).
    atomicSave(filePath, UNKNOWN_KEY_YAML.replace('    dependson: [nothing]\n', ''));
    await until(() => store.registered.length >= 1);
    expect(store.registered).toHaveLength(1);
    expect(store.registered[0]!.id).toBe('watch-unknown-key');

    controller.abort();
    await watchPromise;
    vi.restoreAllMocks();
  }, 20_000);

  it('CONTROL: the same workflow with the stray key removed registers normally', async () => {
    // The key is DELETED rather than corrected to `depends_on`, because `[nothing]` names no real
    // step — correcting the spelling would trade the policy refusal for a structural one and the
    // control would pass for the wrong reason.
    const filePath = makeTempFile(UNKNOWN_KEY_YAML.replace('    dependson: [nothing]\n', ''));
    const store = makeStore();
    const controller = new AbortController();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const watchPromise = watchWorkflow(filePath, store, controller.signal);
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await watchPromise;

    expect(store.registered).toHaveLength(1);
    vi.restoreAllMocks();
  });
});

describe('watchWorkflow', () => {
  it('registers the workflow immediately on start', async () => {
    const filePath = makeTempFile(VALID_YAML);
    const store = makeStore();
    const controller = new AbortController();

    const watchPromise = watchWorkflow(filePath, store, controller.signal);
    // Initial registration is synchronous before the watch loop starts.
    // Give it a tick to complete.
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await watchPromise;

    expect(store.registered).toHaveLength(1);
    expect(store.registered[0]!.id).toBe('watch-test');
  });

  it('re-registers when the file changes', async () => {
    const filePath = makeTempFile(VALID_YAML);
    const store = makeStore();
    const controller = new AbortController();

    const watchPromise = watchWorkflow(filePath, store, controller.signal);
    // Wait for initial registration.
    await new Promise((r) => setTimeout(r, 100));
    expect(store.registered).toHaveLength(1);

    // Write the file again (same content — triggers a change event).
    writeFileSync(filePath, VALID_YAML, 'utf8');
    // Wait for the fs.watch event and re-registration to propagate.
    await new Promise((r) => setTimeout(r, 300));

    controller.abort();
    await watchPromise;

    expect(store.registered.length).toBeGreaterThanOrEqual(2);
  });

  it('does not register when the YAML is invalid, but does not throw', async () => {
    const filePath = makeTempFile(INVALID_YAML);
    const store = makeStore();
    const controller = new AbortController();

    // Suppress expected error output during this test.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const watchPromise = watchWorkflow(filePath, store, controller.signal);
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();
    await watchPromise;

    spy.mockRestore();
    // Invalid YAML should not be registered.
    expect(store.registered).toHaveLength(0);
  });

  it('resolves cleanly when the signal is aborted immediately after start', async () => {
    const filePath = makeTempFile(VALID_YAML);
    const store = makeStore();
    const controller = new AbortController();

    const watchPromise = watchWorkflow(filePath, store, controller.signal);
    controller.abort();
    // Should resolve without throwing.
    await expect(watchPromise).resolves.toBeUndefined();
  });

  it('re-registers when a profile file changes', async () => {
    // Create a workflow directory with a profiles/ subdirectory and one profile.
    const dir = join(tmpdir(), `realm-watch-test-${randomUUID()}`);
    const profilesDir = join(dir, 'profiles');
    mkdirSync(profilesDir, { recursive: true });
    const filePath = join(dir, 'workflow.yaml');
    writeFileSync(filePath, VALID_YAML, 'utf8');
    const profilePath = join(profilesDir, 'my-agent.md');
    writeFileSync(profilePath, '# Agent profile v1', 'utf8');

    const store = makeStore();
    const controller = new AbortController();

    const watchPromise = watchWorkflow(filePath, store, controller.signal);
    // Wait for initial registration.
    await new Promise((r) => setTimeout(r, 100));
    const countAfterStart = store.registered.length;

    // Edit the profile file — should trigger re-registration.
    writeFileSync(profilePath, '# Agent profile v2', 'utf8');
    await new Promise((r) => setTimeout(r, 300));

    controller.abort();
    await watchPromise;

    expect(store.registered.length).toBeGreaterThan(countAfterStart);
  });

  it('does not throw when the profiles directory does not exist', async () => {
    // Workflow directory has no profiles/ subdirectory.
    const filePath = makeTempFile(VALID_YAML);
    const store = makeStore();
    const controller = new AbortController();

    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const watchPromise = watchWorkflow(filePath, store, controller.signal);
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();
    await expect(watchPromise).resolves.toBeUndefined();

    spy.mockRestore();
    // Initial registration should still have happened.
    expect(store.registered).toHaveLength(1);
  });
});

// issue #425 — watch's own lines carry a timestamp and its warnings block did not, so on a busy
// session the warnings floated free of the save that produced them. A gated header ties them
// together; the clean-save control proves the gate.
describe('watch — the timestamped warnings header (issue #425)', () => {
  const WARNING_YAML = `
id: watch-warn
name: Watch Warn
version: 1
steps:
  step-one:
    description: First step
    execution: agent
    retry:
      max_attempts: 3
`;

  it('heads a non-empty warnings block with a timestamp and a count', async () => {
    const filePath = makeTempFile(WARNING_YAML);
    const store = makeStore();
    const controller = new AbortController();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const watchPromise = watchWorkflow(filePath, store, controller.signal);
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await watchPromise;

    const warned = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(warned[0]).toMatch(/^\[[^\]]+\] 1 warning:$/);
    // Singular, and the registration line below it now agrees with its own count too — watch's
    // first `(1 step)` pin anywhere.
    const logged = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(logged).toContain('Registered: watch-warn v1 (1 step)');
    vi.restoreAllMocks();
  });

  it('a clean save prints NO header — the gate, not just the format', async () => {
    // printLoaderWarnings runs on every successful registration, so an ungated header would
    // print "[iso] 0 warnings:" over nothing each time the file is saved.
    const filePath = makeTempFile(VALID_YAML);
    const store = makeStore();
    const controller = new AbortController();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const watchPromise = watchWorkflow(filePath, store, controller.signal);
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await watchPromise;

    expect(warnSpy.mock.calls).toHaveLength(0);
    expect(store.registered).toHaveLength(1);
    vi.restoreAllMocks();
  });
});

// issue #424 — watch reports the whole defect set on a failing reload, same as validate and
// register. Its render is its own site, so it needs its own cell.
describe('watch — a hard load error carries its warnings (issue #424)', () => {
  const BOTH_YAML = `
id: carry-watch
name: Carry Watch
version: 1
steps:
  classify:
    description: classify
    execution: agent
    dependson: [nowhere]
    timeout_seconds: 60
`;

  it('prints the warning AND the timestamped error in one reload', async () => {
    const filePath = makeTempFile(BOTH_YAML);
    const store = makeStore();
    const controller = new AbortController();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const watchPromise = watchWorkflow(filePath, store, controller.signal);
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await watchPromise;

    const errored = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(errored).toContain("'timeout_seconds' is not valid on execution: agent steps");
    const warned = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(warned).toContain("unknown key 'dependson'");
    expect(warned).toContain("did you mean 'depends_on'?");
    expect(store.registered).toHaveLength(0);
    vi.restoreAllMocks();
  });
});

// issue #417 — watch keeps its timestamp and drops the doubled word. The prefix is checked, not
// just the absence, so the fix cannot be read as having removed it wholesale.
describe('watch — a load failure says "invalid" once (issue #417)', () => {
  const PROHIBITED_KEY_YAML = `
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

  it('prints "[timestamp] Invalid workflow: …", never "Invalid: Invalid workflow:"', async () => {
    const filePath = makeTempFile(PROHIBITED_KEY_YAML);
    const store = makeStore();
    const controller = new AbortController();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const watchPromise = watchWorkflow(filePath, store, controller.signal);
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await watchPromise;

    const errored = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(errored).toMatch(/^\[[^\]]+\] Invalid workflow:/m);
    expect(errored).not.toContain('Invalid: Invalid workflow:');
    expect(store.registered).toHaveLength(0);
    vi.restoreAllMocks();
  });
});

// =================================================================================================
// issue #449 — the watch keeps watching
// =================================================================================================

/** Vim-style save: write a temp file, rename it over the target. Renames the watched inode away. */
function atomicSave(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, filePath);
}

/**
 * Waits until `cond()` holds, polling. Every POSITIVE wait uses this rather than a fixed sleep:
 * a fixed window that is generous locally is a flake under CI starvation (the #371 class), and
 * polling is also faster on the happy path. Fixed windows survive below ONLY where the assertion
 * is NEGATIVE and needs elapsed time to mean anything.
 */
async function until(cond: () => boolean, capMs = 5000): Promise<void> {
  const deadline = Date.now() + capMs;
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

function yamlAt(version: number): string {
  return `
id: watch-test
name: Watch Test
version: ${version}
steps:
  step-one:
    description: First step
    execution: agent
`;
}

describe('watchWorkflow — atomic saves (issue #449)', () => {
  it('(b) survives TWO consecutive atomic saves', async () => {
    // The defect this pins is not "the first atomic save is missed" — it is that the watch DIES
    // during it. Executed on main: v2 still registered (the renamed-away inode's final `change`
    // slipped through the old filter), and then nothing ever did again — v3 and a subsequent
    // in-place write both emitted nothing at all. So one save is not enough to see it; the
    // second is where a file watch is already dead and a directory watch is not.
    const filePath = makeTempFile(VALID_YAML);
    const store = makeStore();
    const controller = new AbortController();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const watchPromise = watchWorkflow(filePath, store, controller.signal);
    await until(() => store.registered.length >= 1);

    atomicSave(filePath, yamlAt(2));
    await until(() => store.registered.at(-1)?.version === 2);

    atomicSave(filePath, yamlAt(3));
    await until(() => store.registered.at(-1)?.version === 3);

    // Version first, deliberately: it is the assertion that says WHICH save was missed. A
    // length check first would red with a count and hide that.
    expect(store.registered.at(-1)!.version).toBe(3);
    expect(store.registered.length).toBeGreaterThanOrEqual(3);

    controller.abort();
    await watchPromise;
    vi.restoreAllMocks();
  }, 20_000);

  it('(c) a sibling file in the same directory does NOT re-register', async () => {
    // The basename filter's pin. The settle gap is load-bearing: without it the coalescer folds
    // the sibling write into the real save's fire, one registration comes out either way, and
    // the filter is untested. Executed both ways — without the gap the filter-drop mutant
    // survives.
    const filePath = makeTempFile(VALID_YAML);
    const dir = dirname(filePath);
    const store = makeStore();
    const controller = new AbortController();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const watchPromise = watchWorkflow(filePath, store, controller.signal);
    await until(() => store.registered.length >= 1);
    const afterStartup = store.registered.length;

    writeFileSync(join(dir, 'notes.txt'), 'not a workflow', 'utf8');
    // NEGATIVE assertion — it needs elapsed time to mean anything, so this one is a fixed wait.
    await new Promise((r) => setTimeout(r, 300));
    expect(store.registered.length).toBe(afterStartup);

    atomicSave(filePath, yamlAt(2));
    await until(() => store.registered.length > afterStartup);

    expect(store.registered.length).toBe(afterStartup + 1);
    expect(store.registered.at(-1)!.version).toBe(2);

    controller.abort();
    await watchPromise;
    vi.restoreAllMocks();
  }, 20_000);

  it('(f) a profiles-file CREATE bursts two events and re-registers exactly once', async () => {
    // THE WIRING CELL. Bypassing the coalescer at the call site survives every other cell in
    // this file, because the YAML path yields exactly one passing event per save — there is
    // nothing to coalesce there. The profiles watcher is the observable burst: creating a file
    // emits `rename` + `change`, two events, so an unwired call site registers twice.
    const filePath = makeTempFile(VALID_YAML);
    const dir = dirname(filePath);
    const profilesDir = join(dir, 'profiles');
    mkdirSync(profilesDir, { recursive: true });
    writeFileSync(join(profilesDir, 'existing.md'), 'seed', 'utf8');

    const store = makeStore();
    const controller = new AbortController();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const watchPromise = watchWorkflow(filePath, store, controller.signal);
    await until(() => store.registered.length >= 1);
    const afterStartup = store.registered.length;

    writeFileSync(join(profilesDir, 'brand-new.md'), 'a new profile', 'utf8');
    await until(() => store.registered.length > afterStartup);
    // Then settle: "exactly one, not two" is a negative claim about the second, so it needs the
    // window to have passed.
    await new Promise((r) => setTimeout(r, 300));

    expect(store.registered.length).toBe(afterStartup + 1);

    controller.abort();
    await watchPromise;
    vi.restoreAllMocks();
  }, 20_000);

  it('(g) a missing workflow file is still refused at startup', async () => {
    // The contract a directory watch would silently lose: `fs.watch` on an absent FILE threw
    // ENOENT, and the action rendered it and exited 1. A directory watch succeeds and would
    // watch nothing, forever, saying nothing — so the guard raises the identical error itself.
    //
    // Driven through watchWorkflow directly, which is this file's universal idiom: the CLI
    // action constructs a JsonWorkflowStore, which mkdirSyncs into the REAL $HOME, and this file
    // has no scratch-HOME harness. The action's catch-render-exit-1 is unchanged pre-existing
    // boilerplate and is not what this cell is about.
    const dir = join(tmpdir(), `realm-watch-missing-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, 'workflow.yaml');
    const store = makeStore();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(watchWorkflow(filePath, store)).rejects.toThrow(
      `ENOENT: no such file or directory, watch '${filePath}'`,
    );

    vi.restoreAllMocks();
  }, 10_000);

  it('(h) a refused watch leaves NO watcher behind', async () => {
    // The guard's POSITION, not its existence — cell (g) passes wherever the throw sits. Thrown
    // after the watcher was created, the rejection reported a failure while a live persistent
    // watcher kept running: executed, a workflow.yaml created afterwards was still registered by
    // the phantom, and a caller that held nothing itself never exited (10s timeout kill) where
    // the fixed version exits in 2ms.
    //
    // The store-empty conjunct is the observable chosen for BOTH symptoms, by entailment: no
    // registration ⟹ nothing fired ⟹ no live watcher. (A handle census via
    // process.getActiveResourcesInfo() would observe the loop half directly, but it is
    // experimental and noisy under a worker pool.)
    const dir = join(tmpdir(), `realm-watch-phantom-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, 'workflow.yaml'); // deliberately never written
    const store = makeStore();
    const controller = new AbortController();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(watchWorkflow(filePath, store, controller.signal)).rejects.toThrow(
        `ENOENT: no such file or directory, watch '${filePath}'`,
      );

      // The file appears AFTER the failure was reported. Nothing should be listening.
      writeFileSync(filePath, VALID_YAML, 'utf8');
      // NEGATIVE assertion: it needs elapsed time to mean anything. The phantom's latency is the
      // fs event plus the 100ms coalesce window, well inside this.
      await new Promise((r) => setTimeout(r, 300));

      expect(store.registered).toEqual([]);
    } finally {
      // Inert on the fixed code — the throw precedes any watcher. It matters during a red-first
      // or mutant run, where it closes the leaked handle so a deliberately-failing cell does not
      // strand a live watcher in the worker.
      controller.abort();
      vi.restoreAllMocks();
    }
  }, 10_000);
});

describe('makeCoalescedTrigger (issue #449)', () => {
  it('(d) collapses a burst into one trailing fire, and cancel() disarms a pending one', () => {
    vi.useFakeTimers();
    let fires = 0;
    const c = makeCoalescedTrigger(() => {
      fires += 1;
    }, 100);

    for (let i = 0; i < 5; i++) c.trigger();
    vi.advanceTimersByTime(99);
    expect(fires).toBe(0); // still inside the window — a burst has not resolved yet
    vi.advanceTimersByTime(1);
    expect(fires).toBe(1); // exactly one, at the trailing edge

    c.trigger();
    vi.advanceTimersByTime(100);
    expect(fires).toBe(2); // a later burst is its own fire, not swallowed

    // The abort case: a pending timer must not survive a cancel, or it fires after the watch
    // resolved and registers into a store whose owner has moved on.
    c.trigger();
    c.cancel();
    vi.advanceTimersByTime(500);
    expect(fires).toBe(2);
    c.cancel(); // idempotent

    vi.useRealTimers();
  });
});

// =================================================================================================
// issue #451 — the extensions sentence at watch's catch
// =================================================================================================

describe('watchWorkflow — `Error loading extensions:` (issue #451)', () => {
  it('a module that cannot be resolved reports `Error loading extensions:`, and the watcher survives', async () => {
    // Red-first on main: `[ts] Error: Cannot resolve extension module '../../dist/does-not-exist.js'
    // of workflow 'watch-test' (resolved: …): ENOENT …` — watch's else arm, the register quote's
    // timestamped twin. The module path resolves against a trust root, so this cell builds the
    // register-extensions.test.ts project tree rather than a bare temp dir.
    const proj = join(tmpdir(), `realm-watch-test-${randomUUID()}`);
    const wfDir = join(proj, 'workflows', 'wf');
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(proj, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    const filePath = join(wfDir, 'workflow.yaml');
    writeFileSync(filePath, `${VALID_YAML}extensions: ../../dist/does-not-exist.js\n`, 'utf8');
    const store = makeStore();
    const controller = new AbortController();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const watchPromise = watchWorkflow(filePath, store, controller.signal);
    const errored = (): string => errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    await until(() => errored().includes('does-not-exist.js'));

    expect(store.registered).toHaveLength(0);
    expect(errored()).toMatch(
      /^\[[^\]]+\] Error loading extensions: Cannot resolve extension module '\.\.\/\.\.\/dist\/does-not-exist\.js' of workflow 'watch-test'/m,
    );
    expect(errored()).not.toMatch(/^\[[^\]]+\] Error: Cannot/m);
    // issue #463 — the ABSENT side of the warnings carry: a clean workflow carries none, so no
    // header and no block — not even an empty one — precede the sentence.
    expect(warnSpy).not.toHaveBeenCalled();

    // Survives — the sentence is a report, not an exit: drop the extensions line, save, and the
    // next pass registers.
    atomicSave(filePath, VALID_YAML);
    await until(() => store.registered.length >= 1);
    expect(store.registered[0]!.id).toBe('watch-test');

    controller.abort();
    await watchPromise;
    vi.restoreAllMocks();
  }, 20_000);

  it("C5 the workflow's own warnings print BEFORE the extensions sentence, and the watcher survives (issue #463)", async () => {
    // Red-first on main: only `[ts] Error loading extensions: …` — the warning swallowed. Now the
    // timestamped header, the PLAIN line, then the sentence; and the watcher keeps running.
    const proj = join(tmpdir(), `realm-watch-test-${randomUUID()}`);
    const wfDir = join(proj, 'workflows', 'wf');
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(proj, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    const filePath = join(wfDir, 'workflow.yaml');
    writeFileSync(
      filePath,
      `${VALID_YAML}    dependson: [nothing]\nextensions: ../../dist/does-not-exist.js\n`,
      'utf8',
    );
    const store = makeStore();
    const controller = new AbortController();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const watchPromise = watchWorkflow(filePath, store, controller.signal);
    const errored = (): string => errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    await until(() => errored().includes('does-not-exist.js'));

    const warned = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(warned[0]).toMatch(/^\[[^\]]+\] 1 warning:$/);
    expect(warned[1]).toContain("⚠ step 'step-one': unknown key 'dependson'");
    expect(warned[1]).toContain("— ignored (did you mean 'depends_on'?)");
    // The PLAIN form — the plain-mode flag's tooth. printLoaderWarnings would write `— REFUSED
    // below` here, and what follows is the extensions error, not this warning's escalation.
    expect(warned.join('\n')).not.toContain('REFUSED below');
    expect(errored()).toMatch(
      /^\[[^\]]+\] Error loading extensions: Cannot resolve extension module '\.\.\/\.\.\/dist\/does-not-exist\.js' of workflow 'watch-test'/m,
    );
    // Block BEFORE the sentence — two channels, vitest's global invocation order.
    expect(Math.max(...warnSpy.mock.invocationCallOrder)).toBeLessThan(
      Math.min(...errSpy.mock.invocationCallOrder),
    );
    expect(store.registered).toHaveLength(0);

    // Survives: drop the typo and the extensions line, save, and the next pass registers.
    atomicSave(filePath, VALID_YAML);
    await until(() => store.registered.length >= 1);
    expect(store.registered[0]!.id).toBe('watch-test');

    controller.abort();
    await watchPromise;
    vi.restoreAllMocks();
  }, 20_000);
});

// =================================================================================================
// issue #453 — the watched directory dies honestly (deleted, or moved out from under the watch),
// and survives a replacement it can observe (self-name event + path present ⇒ re-arm).
//
// `until` never throws — it returns silently at its cap (:413-418) — so every `until` below is
// followed by a stated trailing `expect`. Root vitest `testTimeout` is 5000ms and `until`'s own
// 5000ms default cap exhausts it before any trailing expect runs, so every cell whose red path
// rides a hang or an `until` cap takes the explicit 20_000 third argument.
//
// Verify red-first shapes PER CELL (`vitest -t '<name>'`), never from one full-file run: a
// timed-out cell never reaches its `finally`, and its stranded watcher/spy state contaminates
// later cells in the same run.
// =================================================================================================

const DEATH_PIN = 'The watched directory no longer exists';

describe('watchWorkflow — the directory itself dies or is replaced (issue #453)', () => {
  it('D1 the whole directory rm -rf’d → honest rejection, no further registration', async () => {
    // Red-first on main: the promise never settles — a silent zombie on the dead inode.
    const filePath = makeTempFile(VALID_YAML);
    const dir = dirname(filePath);
    const store = makeStore();
    const controller = new AbortController();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const watchPromise = watchWorkflow(filePath, store, controller.signal);
    await until(() => store.registered.length >= 1);

    rmSync(dir, { recursive: true, force: true });

    await expect(watchPromise).rejects.toThrow(DEATH_PIN);
    expect(store.registered.length).toBe(1);

    controller.abort();
    vi.restoreAllMocks();
  }, 20_000);

  it('D2 the directory moved away, no subsequent activity → honest rejection', async () => {
    // Red-first on main: the promise never settles — the handle follows the inode, silently.
    // The mv member of the self-name trigger is pinned HERE alone (no activity follows).
    const filePath = makeTempFile(VALID_YAML);
    const dir = dirname(filePath);
    const store = makeStore();
    const controller = new AbortController();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const watchPromise = watchWorkflow(filePath, store, controller.signal);
    await until(() => store.registered.length >= 1);

    renameSync(dir, `${dir}-moved`);

    await expect(watchPromise).rejects.toThrow(DEATH_PIN);

    controller.abort();
    vi.restoreAllMocks();
  }, 20_000);

  it('D2b discriminate-first ordering: mv + immediate write into the moved dir never misattributes', async () => {
    // Red-first on main: a MISATTRIBUTED `Invalid: … ENOENT` about the OLD path prints, about a
    // file the operator just correctly saved (E1). The death net must fire BEFORE the
    // fall-through registerFile, even though a self event and a content event can both be
    // pending when the coalesced callback runs.
    const filePath = makeTempFile(VALID_YAML);
    const dir = dirname(filePath);
    const store = makeStore();
    const controller = new AbortController();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const watchPromise = watchWorkflow(filePath, store, controller.signal);
    await until(() => store.registered.length >= 1);

    const moved = `${dir}-moved`;
    renameSync(dir, moved);
    writeFileSync(join(moved, 'workflow.yaml'), yamlAt(2), 'utf8');

    await expect(watchPromise).rejects.toThrow(DEATH_PIN);

    // The settle makes mutant (iii)'s async ENOENT print (executed at ~+102ms) deterministically
    // visible — the file's own negative-assertion idiom (:483-484).
    await new Promise((r) => setTimeout(r, 300));
    const errored = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(errored).not.toContain('Failed to read workflow file');

    controller.abort();
    vi.restoreAllMocks();
  }, 20_000);

  it("D2c the death net's own member: an ancestor move delivers no self event", async () => {
    // Red-first on main: same misattribution shape as D2b. No self event ever reaches this
    // handle for an ancestor move (grounding addendum) — only the existsSync net can catch it,
    // so this cell reds under mutant (ii) regardless of the re-arm catch.
    const parent = join(tmpdir(), `realm-watch-test-${randomUUID()}`);
    const wfDir = join(parent, 'wf');
    mkdirSync(wfDir, { recursive: true });
    const filePath = join(wfDir, 'workflow.yaml');
    writeFileSync(filePath, VALID_YAML, 'utf8');
    const store = makeStore();
    const controller = new AbortController();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const watchPromise = watchWorkflow(filePath, store, controller.signal);
    await until(() => store.registered.length >= 1);

    const movedParent = `${parent}-moved`;
    renameSync(parent, movedParent);
    writeFileSync(join(movedParent, 'wf', 'workflow.yaml'), yamlAt(2), 'utf8');

    await expect(watchPromise).rejects.toThrow(DEATH_PIN);

    await new Promise((r) => setTimeout(r, 300));
    const errored = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(errored).not.toContain('Failed to read workflow file');

    controller.abort();
    vi.restoreAllMocks();
  }, 20_000);

  it('D3 a fast delete+recreate (build steps) is survived: the watch re-arms', async () => {
    // Red-first on main: the FIRST half passes on main already (the dying handle's own
    // fall-through — a control, not this cell's tooth); red arrives at the SECOND half as an
    // assertion failure after `until`'s silent cap — nothing observes the replacement.
    const filePath = makeTempFile(yamlAt(1));
    const dir = dirname(filePath);
    const store = makeStore();
    const controller = new AbortController();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const watchPromise = watchWorkflow(filePath, store, controller.signal);
    await until(() => store.registered.length >= 1);

    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, yamlAt(2), 'utf8');

    // The fall-through half — passes on main too (control, not this cell's tooth).
    await until(() => store.registered.at(-1)?.version === 2, 20_000);
    expect(store.registered.at(-1)!.version).toBe(2);

    // The fresh watcher arms asynchronously across close→loop-iteration and nothing observable
    // signals it — the watch-liveness:145-147 idiom.
    await new Promise((r) => setTimeout(r, 250));

    atomicSave(filePath, yamlAt(3));
    // The liveness-after-re-arm conjunct — this cell's only tooth.
    await until(() => store.registered.at(-1)?.version === 3, 20_000);
    expect(store.registered.at(-1)!.version).toBe(3);

    controller.abort();
    await watchPromise;
    vi.restoreAllMocks();
  }, 20_000);

  it('D4 a same-named sibling file is tolerated: a harmless re-arm, never a false kill', async () => {
    // The sibling-collision case (E2c): a file literally named like the directory's own basename
    // emits the SAME surfaced shape as the directory's own death. Distinct from cell "(c)" above
    // (:465), whose sibling has a DIFFERENT name and stays byte-untouched — its `notes.txt` can
    // never collide with `realm-watch-test-<uuid>`.
    const filePath = makeTempFile(yamlAt(1));
    const dir = dirname(filePath);
    const store = makeStore();
    const controller = new AbortController();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const watchPromise = watchWorkflow(filePath, store, controller.signal);
    await until(() => store.registered.length >= 1);

    writeFileSync(join(dir, basename(dir)), 'not a workflow', 'utf8');

    // Arming settle, same reason as D3.
    await new Promise((r) => setTimeout(r, 250));

    atomicSave(filePath, yamlAt(2));
    await until(() => store.registered.at(-1)?.version === 2, 20_000);
    expect(store.registered.at(-1)!.version).toBe(2);

    controller.abort();
    await watchPromise;
    vi.restoreAllMocks();
  }, 20_000);

  it('D5 staged death: the file dies first (unchanged), then the bare directory dies too', async () => {
    // First half is GREEN ON MAIN — today's behaviour, kept as the control. Second half: a bare
    // rmdirSync after the yaml is already gone emits ONLY self-name events (executed) — red-first
    // on main as a cell timeout, since main drops those events via the basename filter.
    const filePath = makeTempFile(VALID_YAML);
    const dir = dirname(filePath);
    const store = makeStore();
    const controller = new AbortController();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const watchPromise = watchWorkflow(filePath, store, controller.signal);
    await until(() => store.registered.length >= 1);

    rmSync(filePath);
    const errored = (): string => errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    await until(() => errored().includes('Failed to read workflow file'), 20_000);
    expect(errored()).toMatch(/^\[[^\]]+\] Invalid: Failed to read workflow file/m);
    expect(store.registered.length).toBe(1);

    rmdirSync(dir);
    await expect(watchPromise).rejects.toThrow(DEATH_PIN);

    controller.abort();
    vi.restoreAllMocks();
  }, 20_000);

  it('D6 the profiles directory disappearing is disclosed, not silently dead', async () => {
    // Red-first on main: assertion failure — the line does not exist on main.
    const filePath = makeTempFile(yamlAt(1));
    const dir = dirname(filePath);
    const profilesDir = join(dir, 'profiles');
    mkdirSync(profilesDir, { recursive: true });
    writeFileSync(join(profilesDir, 'seed.md'), 'seed', 'utf8');

    const store = makeStore();
    const controller = new AbortController();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const watchPromise = watchWorkflow(filePath, store, controller.signal);
    await until(() => store.registered.length >= 1);

    rmSync(profilesDir, { recursive: true, force: true });

    const errored = (): string => errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    await until(() => errored().includes('The profiles directory is gone'), 20_000);
    // Settle before the exactly-once count: a straggler event on the (now-idle) old profiles
    // watcher must be a no-op, never a second line — the latch's own contract.
    await new Promise((r) => setTimeout(r, 300));

    const goneLines = errSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((l) => l.includes('The profiles directory is gone'));
    expect(goneLines).toHaveLength(1);
    expect(goneLines[0]).toMatch(
      /^\[[^\]]+\] The profiles directory is gone — profile edits are no longer watched\./m,
    );
    expect(goneLines[0]).toContain('Restart watch');

    // Version-keyed, not count-keyed: a count `until` would be satisfied vacuously by the
    // gone-callback's own fall-through v1 bump.
    atomicSave(filePath, yamlAt(2));
    await until(() => store.registered.at(-1)?.version === 2, 20_000);
    expect(store.registered.at(-1)!.version).toBe(2);

    controller.abort();
    await watchPromise;
    vi.restoreAllMocks();
  }, 20_000);

  it('D7 the profiles directory re-arms after a fast delete+recreate', async () => {
    // Red-first on main: the FIRST half passes on main already (the dying watcher's own
    // fall-through bump); red arrives at the SECOND half. Sequenced so the naive same-step
    // construction cannot pass vacuously via the fall-through bump alone (lane-2 F1): settle
    // between the bump and the second write, and use a NEW profiles filename — a pre-existing
    // file emits nothing after arming.
    const filePath = makeTempFile(yamlAt(1));
    const dir = dirname(filePath);
    const profilesDir = join(dir, 'profiles');
    mkdirSync(profilesDir, { recursive: true });
    writeFileSync(join(profilesDir, 'seed.md'), 'seed', 'utf8');

    const store = makeStore();
    const controller = new AbortController();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const watchPromise = watchWorkflow(filePath, store, controller.signal);
    await until(() => store.registered.length >= 1);
    const afterStartup = store.registered.length;

    rmSync(profilesDir, { recursive: true, force: true });
    mkdirSync(profilesDir, { recursive: true });
    writeFileSync(join(profilesDir, 'seed2.md'), 'seed2', 'utf8');

    await until(() => store.registered.length > afterStartup, 20_000);
    expect(store.registered.length).toBeGreaterThan(afterStartup);
    const afterFallThrough = store.registered.length;

    // Arming settle for the re-armed profiles watcher.
    await new Promise((r) => setTimeout(r, 250));

    writeFileSync(join(profilesDir, 'brand-new.md'), 'a new profile', 'utf8');
    await until(() => store.registered.length > afterFallThrough, 20_000);
    expect(store.registered.length).toBeGreaterThan(afterFallThrough);

    controller.abort();
    await watchPromise;
    vi.restoreAllMocks();
  }, 20_000);

  it('D8 (ride-along, #453 comment 5508995297) a registrar-level throw survives the watcher', async () => {
    // GREEN ON MAIN — its tooth is mutant (vii), dropping the `Error: ` prefix at the else arm.
    const filePath = makeTempFile(yamlAt(1));
    let callCount = 0;
    const registered: WorkflowDefinition[] = [];
    const store: WorkflowRegistrar & { registered: WorkflowDefinition[] } = {
      registered,
      async register(def) {
        callCount += 1;
        if (callCount === 1) {
          throw new Error('EACCES: permission denied, open …tmp');
        }
        registered.push(def);
      },
      async get(id) {
        const found = [...registered].reverse().find((d) => d.id === id);
        if (!found) throw new Error(`Not found: ${id}`);
        return found;
      },
      async list() {
        return registered;
      },
    };
    const controller = new AbortController();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const watchPromise = watchWorkflow(filePath, store, controller.signal);
    const errored = (): string => errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    await until(() => errored().includes('EACCES'), 20_000);
    expect(errored()).toMatch(/^\[[^\]]+\] Error: EACCES: permission denied, open …tmp$/m);

    atomicSave(filePath, yamlAt(2));
    await until(() => store.registered.length >= 1, 20_000);
    expect(store.registered).toHaveLength(1);

    controller.abort();
    await watchPromise;
    vi.restoreAllMocks();
  }, 20_000);
});
