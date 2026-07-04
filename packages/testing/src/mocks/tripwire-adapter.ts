// Tripwire adapter — fail-if-unmocked guard for extension-provided adapters in fixture runs.
// Registered under every extension adapter name the fixture does NOT mock, in BOTH leak paths
// (the execution-loop registry lookup and the mock-agent dispatcher fallback), so a fixture
// run can never silently hit a real service through a project extension adapter.
import type { ServiceAdapter, ServiceResponse } from '@sensigo/realm';

/**
 * Creates an adapter whose every method throws with an actionable message. The message also
 * enumerates the fixture's UNMATCHED mock keys (mock entries naming no service in the
 * workflow) — the usual cause is a typo'd service name in the fixture.
 */
export function createTripwireAdapter(name: string, unmatchedMockKeys: string[]): ServiceAdapter {
  const trip = async (): Promise<ServiceResponse> => {
    const unmatched =
      unmatchedMockKeys.length > 0
        ? ` Unmatched fixture mock keys (no matching service in the workflow — check for a ` +
          `typo'd service name): ${unmatchedMockKeys.map((k) => `'${k}'`).join(', ')}.`
        : '';
    throw new Error(
      `Unmocked project adapter '${name}' — mock it in the fixture (it would hit a real service).${unmatched}`,
    );
  };
  return {
    id: name,
    fetch: trip,
    create: trip,
    update: trip,
    delete: trip,
  };
}
