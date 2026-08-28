// Tests for realm workflow watch — watchWorkflow function.
import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { WorkflowRegistrar, WorkflowDefinition } from '@sensigo/realm';
import { watchWorkflow } from './watch.js';

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
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await watchPromise;

    // Nothing reached the registrar.
    expect(store.registered).toHaveLength(0);
    const errored = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(errored).toContain('escalated to an error by policy — refusing to register');
    expect(logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).not.toContain(
      'Registered:',
    );
    // The did-you-mean survives, and the false "ignored" claim does not.
    const warned = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(warned).toContain("did you mean 'depends_on'?");
    expect(warned).not.toContain('ignored');

    vi.restoreAllMocks();
  });

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
