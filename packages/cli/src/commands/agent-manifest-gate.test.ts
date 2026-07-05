// Tests for the manifest-sourced gate wiring (v0.14): buildManifestGateHandler maps the
// secret-resolved `notifiers.slack_gate` config; gate presence = manifest presence; and a
// structural guarantee that the nine SLACK_*/GITHUB_TOKEN env reads are GONE from agent.ts
// (both call sites go through buildManifestGateHandler).
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryStore } from '@sensigo/realm-testing';
import { CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';
import { buildManifestGateHandler } from './agent.js';
import { LlmProvider } from '../agent/providers/llm-provider.js';

const COMMANDS_DIR = dirname(fileURLToPath(import.meta.url));

class NoopProvider extends LlmProvider {
  async callStep(): Promise<Record<string, unknown>> {
    return {};
  }
}

const definition: WorkflowDefinition = {
  id: 'gate-wf',
  name: 'Gate WF',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: { s1: { description: 'step', execution: 'agent' } },
};

describe('buildManifestGateHandler', () => {
  const deps = { store: new InMemoryStore(), definition, provider: new NoopProvider() };

  it('returns undefined when the manifest declares no notifier (terminal fallback)', () => {
    expect(buildManifestGateHandler(undefined, deps)).toBeUndefined();
    expect(buildManifestGateHandler({}, deps)).toBeUndefined();
  });

  it('returns a handler when slack_gate is configured — even with env fully empty', () => {
    vi.stubEnv('SLACK_WEBHOOK_URL', '');
    vi.stubEnv('SLACK_BOT_TOKEN', '');
    const handler = buildManifestGateHandler(
      { slack_gate: { webhook_url: 'https://hooks.example/x', channel_id: 'C0X' } },
      deps,
    );
    expect(typeof handler).toBe('function');
    vi.unstubAllEnvs();
  });
});

describe('agent.ts env reads are gone (structural)', () => {
  const source = readFileSync(join(COMMANDS_DIR, 'agent.ts'), 'utf8');

  it('contains no process.env reads at all (comments may mention the removed names)', () => {
    expect(source).not.toContain('process.env');
  });

  it('both run paths wire the gate through buildManifestGateHandler', () => {
    // One definition + two call sites (fresh and --run-id).
    expect(source.split('buildManifestGateHandler(').length - 1).toBeGreaterThanOrEqual(3);
  });

  it('the legacy tier is gone (no composeAgentRegistry, no adapter imports)', () => {
    expect(source).not.toContain('composeAgentRegistry');
    expect(source).not.toContain('GitHubAdapter');
    expect(source).not.toContain('SlackAdapter');
  });
});
