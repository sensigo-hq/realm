// Test runner — drives a workflow to completion per fixture and reports results.
import {
  loadWorkflowFromFile,
  findEligibleSteps,
  ExtensionRegistry,
  createDefaultRegistry,
  executeChain,
  propagateSkips,
  type WorkflowDefinition,
  type ExtensionManifest,
} from '@sensigo/realm';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { InMemoryStore } from '../store/in-memory-store.js';
import { loadFixturesFromDir, type TestFixture } from '../fixtures/fixture-loader.js';
import { MockServiceRecorder } from '../mocks/mock-service.js';
import { createAgentDispatcher } from '../mocks/mock-agent.js';
import { createGateResponder } from '../mocks/mock-gate.js';
import { createTripwireAdapter } from '../mocks/tripwire-adapter.js';
import { assertFinalState } from '../assertions/evidence.js';

/** Result of a single fixture test run. */
export interface TestResult {
  /** Fixture name. */
  name: string;
  passed: boolean;
  /** Error message if passed === false. */
  error?: string;
}

/** Options for runFixtureTests. */
export interface RunFixtureTestsOptions {
  /** Path to workflow.yaml or to the directory containing workflow.yaml. */
  workflowPath: string;
  /** Path to a directory containing *.yaml fixture files. */
  fixturesPath: string;
  /**
   * Optional ExtensionRegistry. If provided, handlers and adapters registered
   * here are available as a fallback in the dispatcher. If omitted, a new empty
   * registry is created per fixture run.
   */
  registry?: ExtensionRegistry;
  /**
   * Project extensions loaded for the workflow (registry + manifest from the CLI loader).
   * Extension HANDLERS and PROCESSORS merge REAL into the fixture registry — testing custom
   * handlers is the point. Extension ADAPTER names the fixture does not mock get a tripwire
   * adapter (throws instead of hitting a real service) in BOTH leak paths: the execution-loop
   * registry lookup and the mock-agent dispatcher fallback.
   */
  extensions?: { registry: ExtensionRegistry; manifest: ExtensionManifest };
}

/**
 * Builds the per-fixture registries. Exported for direct testing of the fail-if-unmocked
 * guarantees — the tripwire must be present in BOTH leak paths.
 *
 * - `fixtureRegistry`: defaults + fixture mocks (+ extension handlers/processors real,
 *   + tripwires for unmocked extension adapters). Used by the execution loop.
 * - `fallbackRegistry`: the mock-agent dispatcher fallback — caller-provided entries plus
 *   the same extension handlers/processors and tripwires.
 * @internal
 */
export function buildFixtureRegistries(
  fixture: TestFixture,
  definition: WorkflowDefinition,
  options: Pick<RunFixtureTestsOptions, 'registry' | 'extensions'>,
): { fixtureRegistry: ExtensionRegistry; fallbackRegistry: ExtensionRegistry | undefined } {
  // Build per-fixture registry: start from built-in adapters, then overlay
  // mock adapters so fixture mocks take precedence over the real ones.
  const fixtureRegistry = createDefaultRegistry();
  const mockedAdapterNames = new Set<string>();
  const unmatchedMockKeys: string[] = [];
  for (const [serviceName, mockOps] of Object.entries(fixture.mocks)) {
    const serviceDef = definition.services?.[serviceName];
    if (serviceDef !== undefined) {
      const recorder = new MockServiceRecorder(serviceDef.adapter, mockOps);
      fixtureRegistry.register('adapter', serviceDef.adapter, recorder);
      mockedAdapterNames.add(serviceDef.adapter);
    } else {
      // A mock naming no service in the workflow — surfaced in the tripwire error.
      unmatchedMockKeys.push(serviceName);
    }
  }

  // Project extensions: real handlers/processors in, tripwires for unmocked adapters.
  let fallbackRegistry = options.registry;
  if (options.extensions !== undefined) {
    const ext = options.extensions;
    // Preserve any caller-provided fallback entries underneath the extension material.
    const extFallback = new ExtensionRegistry();
    if (options.registry !== undefined) {
      const caller = options.registry;
      for (const n of caller.names('adapter'))
        extFallback.register('adapter', n, caller.getAdapter(n)!);
      for (const n of caller.names('handler'))
        extFallback.register('handler', n, caller.getHandler(n)!);
      for (const n of caller.names('processor'))
        extFallback.register('processor', n, caller.getProcessor(n)!);
    }
    // Real extension handlers/processors merge in — testing them is the point.
    for (const name of ext.manifest.handlers) {
      const handler = ext.registry.getHandler(name);
      if (handler !== undefined) {
        fixtureRegistry.register('handler', name, handler);
        extFallback.register('handler', name, handler);
      }
    }
    for (const name of ext.manifest.processors) {
      const processor = ext.registry.getProcessor(name);
      if (processor !== undefined) {
        fixtureRegistry.register('processor', name, processor);
        extFallback.register('processor', name, processor);
      }
    }
    // Fail-if-unmocked: every extension-provided adapter name without a fixture mock trips
    // in BOTH leak paths — never silently real.
    for (const name of ext.manifest.adapters) {
      if (mockedAdapterNames.has(name)) continue;
      const tripwire = createTripwireAdapter(name, unmatchedMockKeys);
      fixtureRegistry.register('adapter', name, tripwire);
      extFallback.register('adapter', name, tripwire);
    }
    fallbackRegistry = extFallback;
  }

  return { fixtureRegistry, fallbackRegistry };
}

async function runSingleFixture(
  fixture: TestFixture,
  definition: WorkflowDefinition,
  options: RunFixtureTestsOptions,
): Promise<TestResult> {
  try {
    const store = new InMemoryStore();

    const { fixtureRegistry, fallbackRegistry } = buildFixtureRegistries(
      fixture,
      definition,
      options,
    );

    const dispatcher = createAgentDispatcher(
      definition,
      fixtureRegistry,
      fixture.agent_responses,
      fallbackRegistry,
      fixture.agent_errors,
    );

    const { run } = await store.create({
      workflowId: definition.id,
      workflowVersion: definition.version,
      params: fixture.params,
    });
    const runId = run.id;

    const maxIterations = Object.keys(definition.steps).length * 2 + 10;
    let iterations = 0;
    let currentRun = run;
    // Tracks how many times each step has been resumed after a mock error.
    const stepResumeCount: Record<string, number> = {};

    while (!currentRun.terminal_state) {
      if (iterations++ >= maxIterations) {
        return {
          name: fixture.name,
          passed: false,
          error: 'Workflow stalled: exceeded maximum loop iterations',
        };
      }

      const eligibleSteps = findEligibleSteps(definition, currentRun);
      if (eligibleSteps.length === 0 && currentRun.pending_gate === undefined) {
        return {
          name: fixture.name,
          passed: false,
          error: `Workflow stalled: no eligible steps in phase '${currentRun.run_phase}'`,
        };
      }

      // If a gate is open, respond to it and continue.
      if (currentRun.pending_gate !== undefined) {
        const gateResult = await createGateResponder(
          store,
          definition,
          runId,
          fixture.gate_responses ?? {},
        );
        if (gateResult.status === 'error') {
          return {
            name: fixture.name,
            passed: false,
            error: gateResult.errors[0] ?? 'Unknown gate response error',
          };
        }
        currentRun = await store.get(runId);
        continue;
      }

      const nextStep = eligibleSteps[0]!;
      const stepDef = definition.steps[nextStep];
      // Agent steps need the fixture's pre-built response as the input so the
      // engine's input_schema validation passes before the dispatcher runs.
      // Auto steps take no caller-provided input — the engine resolves it via
      // input_map or the adapter/handler call.
      const stepInput =
        stepDef?.execution === 'agent'
          ? ((fixture.agent_responses[nextStep] ?? {}) as Record<string, unknown>)
          : {};
      const envelope = await executeChain(store, definition, {
        runId,
        command: nextStep,
        input: stepInput,
        dispatcher,
        registry: fixtureRegistry,
      });

      if (envelope.status === 'error') {
        // If this step has mock errors configured and we haven't exhausted them yet,
        // simulate `realm run resume --from <step>`: remove the step from failed_steps
        // to make it eligible again, then continue the loop.
        const mockErrors = fixture.agent_errors?.[nextStep];
        const resumesDone = stepResumeCount[nextStep] ?? 0;
        if (mockErrors !== undefined && resumesDone < mockErrors.length) {
          stepResumeCount[nextStep] = resumesDone + 1;
          const failedRun = await store.get(runId);
          const { terminal_reason: _tr, ...rest } = failedRun;
          const newFailedSteps = rest.failed_steps.filter((s) => s !== nextStep);
          // Recompute skipped_steps: the old skips were derived with nextStep in
          // failed_steps. Re-derive from scratch so steps that were only skipped
          // because of this failure become eligible again on the retry.
          const tempRun = { ...rest, failed_steps: newFailedSteps, skipped_steps: [] as string[] };
          const newSkippedSteps = propagateSkips(tempRun, definition);
          await store.update({
            ...rest,
            failed_steps: newFailedSteps,
            skipped_steps: newSkippedSteps,
            terminal_state: false,
          });
          currentRun = await store.get(runId);
          continue;
        }
        return {
          name: fixture.name,
          passed: false,
          error: envelope.errors[0] ?? 'Unknown error from step execution',
        };
      }

      currentRun = await store.get(runId);
    }

    // Assert final phase.
    assertFinalState(currentRun, fixture.expected.final_state);

    // Assert skipped_steps when declared — exact set equality.
    if (fixture.expected.skipped_steps !== undefined) {
      const actualSkipped = [...currentRun.skipped_steps].sort();
      const expectedSkipped = [...fixture.expected.skipped_steps].sort();
      if (JSON.stringify(actualSkipped) !== JSON.stringify(expectedSkipped)) {
        throw new Error(
          `Expected skipped_steps ${JSON.stringify(expectedSkipped)} but got ${JSON.stringify(actualSkipped)}`,
        );
      }
    }

    // Assert expected evidence entries if provided.
    if (fixture.expected.evidence !== undefined) {
      for (const expected of fixture.expected.evidence) {
        const snap = currentRun.evidence.find(
          (e) =>
            e.step_id === expected.step_id &&
            e.kind !== 'gate_response' &&
            (expected.status === undefined || e.status === expected.status),
        );
        if (snap === undefined) {
          const statusClause =
            expected.status !== undefined ? ` with status '${expected.status}'` : '';
          throw new Error(
            `Expected evidence for step '${expected.step_id}'${statusClause} not found`,
          );
        }
      }
    }

    return { name: fixture.name, passed: true };
  } catch (err) {
    return {
      name: fixture.name,
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Runs all fixture tests for the workflow.
 * Returns TestResult[] (one per fixture).
 */
export async function runFixtureTests(options: RunFixtureTestsOptions): Promise<TestResult[]> {
  const workflowFilePath =
    options.workflowPath.endsWith('.yaml') || options.workflowPath.endsWith('.yml')
      ? options.workflowPath
      : existsSync(join(options.workflowPath, 'workflow.yaml'))
        ? join(options.workflowPath, 'workflow.yaml')
        : options.workflowPath;

  const definition = loadWorkflowFromFile(workflowFilePath);
  const fixtures = loadFixturesFromDir(options.fixturesPath);

  return Promise.all(fixtures.map((fixture) => runSingleFixture(fixture, definition, options)));
}

/** Result of a single fixture test run. */
