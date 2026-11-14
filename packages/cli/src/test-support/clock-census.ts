// #715 (b) (04 §A.1, §B) — test support: THE clock census, every clock read in the production source
// with its class and reason. Read by the census test (`commands/clock-census-715b.test.ts`, both
// directions) and by the lint's mirror cell (`commands/lint-clock-715b.test.ts`: the clock rule's
// allowed sites are exactly the `outside` rows' functions).
import type { ClockReadClass } from '@sensigo/realm';

export type Entry = readonly [count: number, cls: ClockReadClass, why: string];

const SYSTEM_CLOCK =
  'the system clock itself — the one place a store on an ordinary folder reads the wall';
const REQUEST_START =
  "request_start: minted in the provider, before any store is in scope (the provider bills on its own day); beyond that day, compared only with another request's start (the gap before a missed request, on its stated basis; never a safety fact: nothing destructive or order-bearing gates on it)";
const MONOTONIC = 'a duration on the monotonic clock (elapsed, a budget, a timeout)';

/**
 * THE LIST: every clock read in the production source. A row is
 * `<package path>#<enclosing function>#<kind>`: [how many in that function, class, why].
 */
export const CENSUS: Record<string, Entry> = {
  'cli/src/agent/auto-prices.ts#settleAutoFromPriceFile#new Date()': [
    1,
    'outside',
    'Amendment 6: the price row in force on the UTC day the next request is billed on; reads no RunRecord instant; nothing is stored with it; a price file is a real-world fact',
  ],
  'cli/src/agent/drive-failure.ts#buildEntry#performance.now()': [1, 'duration', MONOTONIC],
  'cli/src/agent/drive-failure.ts#buildEntryUnsafe#performance.now()': [1, 'duration', MONOTONIC],
  'cli/src/agent/earlier-runs.ts#readEarlierRuns#clock.now()': [
    1,
    'read',
    "the start of the read's window, compared with updated_at, the store's own stamp",
  ],
  'cli/src/agent/gate/slack-gate-server.ts#startSlackGateServer#Date.now()': [
    1,
    'outside',
    "Slack's request-signature window (Slack's clock against the host's)",
  ],
  'cli/src/agent/providers/agent-utils.ts#driveCreate#performance.now()': [
    2,
    'duration',
    MONOTONIC,
  ],
  'cli/src/agent/providers/agent-utils.ts#parseRetryAfterMs#Date.now()': [
    1,
    'outside',
    "Retry-After's HTTP date, against the host's clock",
  ],
  'cli/src/agent/providers/anthropic-provider.ts#AnthropicProvider.callStepWithToolsInternal#performance.now()':
    [3, 'duration', MONOTONIC],
  'cli/src/agent/providers/anthropic-provider.ts#bounded#new Date()': [1, 'outside', REQUEST_START],
  'cli/src/agent/providers/anthropic-provider.ts#makeRequest#new Date()': [
    1,
    'outside',
    REQUEST_START,
  ],
  'cli/src/agent/providers/openai-provider.ts#OpenAIProvider.callStepWithToolsInternal#performance.now()':
    [3, 'duration', MONOTONIC],
  'cli/src/agent/providers/openai-provider.ts#bounded#new Date()': [1, 'outside', REQUEST_START],
  'cli/src/agent/providers/openai-provider.ts#makeRequest#new Date()': [
    1,
    'outside',
    REQUEST_START,
  ],
  'cli/src/agent/providers/openai-provider.ts#timedCreate#new Date()': [
    1,
    'outside',
    REQUEST_START,
  ],
  'cli/src/agent/providers/openai-reasoning-provider.ts#makeRequest#new Date()': [
    1,
    'outside',
    REQUEST_START,
  ],
  'cli/src/agent/run-agent.ts#onStep#performance.now()': [1, 'duration', MONOTONIC],
  'cli/src/agent/run-agent.ts#runAgent#performance.now()': [5, 'duration', MONOTONIC],
  'cli/src/agent/run-agent.ts#runAgent#clock.now()': [
    5,
    'event',
    "a drive failure's instant (drive_failures[].at), written with the entry (02 §D.2)",
  ],
  'cli/src/agent/run-agent.ts#sidecarStamp#new Date()': [
    1,
    'outside',
    "the failed-attempt sidecar line's own stamp (a log), compared with nothing on the run",
  ],
  'cli/src/agent/run-agent.ts#validationWedgeEntry#performance.now()': [1, 'duration', MONOTONIC],
  'cli/src/agent/step-cache-choices.ts#chooseStepCaches#Date.now()': [
    1,
    'outside',
    "the end of a step's last gap, standing for the next request's start; compared only with an earlier request's start",
  ],
  'cli/src/commands/drain.ts#runDrainAction#clock.now()': [
    1,
    'event',
    "`drain --void`'s evidence instant, written with the evidence",
  ],
  'cli/src/commands/export.ts#<module>#new Date()': [
    1,
    'outside',
    "the export bundle's own stamp (when it was exported), compared with nothing",
  ],
  'cli/src/commands/export.ts#buildExportBundle#new Date()': [
    1,
    'outside',
    "the export bundle's own stamp (a parameter default kept: an outside instant)",
  ],
  'cli/src/commands/listen.ts#handle#clock.now()': [
    1,
    'event',
    "agent_started_at, on the store's clock (03 §A.4)",
  ],
  'cli/src/commands/run.ts#recordChange#performance.now()': [2, 'duration', MONOTONIC],
  'cli/src/commands/watch.ts#registerFile#new Date()': [1, 'outside', "a watch log line's stamp"],
  'cli/src/commands/watch.ts#renderProfilesGone#new Date()': [
    1,
    'outside',
    "a watch log line's stamp",
  ],
  'cli/src/extensions/extension-identity.ts#computeExtensionIdentity#new Date()': [
    1,
    'outside',
    'captured_at: minted when the project code loads, before any store (D6-67)',
  ],
  'cli/src/extensions/extension-identity.ts#errorExtensionIdentityEntry#new Date()': [
    1,
    'outside',
    'captured_at: minted when the project code loads, before any store (D6-67)',
  ],
  'cli/src/lib/cacheability.ts#buildCacheabilityReport#new Date()': [
    1,
    'outside',
    "validate sizes a step's prompt with no run store; the instant only fills a context snapshot the render discards",
  ],
  'cli/src/lib/dedup-store.ts#FileDedupStore.check#Date.now()': [
    1,
    'outside',
    "the dedup window's bucket and TTL (#177): a delivery's age, no run record",
  ],
  'cli/src/lib/dedup-store.ts#FileDedupStore.cleanup#Date.now()': [
    1,
    'outside',
    "the dedup window's bucket and TTL (#177): a delivery's age, no run record",
  ],
  'cli/src/lib/dedup-store.ts#FileDedupStore.cleanup#performance.now()': [1, 'duration', MONOTONIC],
  'cli/src/lib/dedup-store.ts#FileDedupStore.record#Date.now()': [
    1,
    'outside',
    "the dedup window's bucket and TTL (#177): a delivery's age, no run record",
  ],
  'cli/src/lib/dedup-store.ts#InMemoryDedupStore.check#Date.now()': [
    1,
    'outside',
    "the dedup window's bucket and TTL (#177): a delivery's age, no run record",
  ],
  'cli/src/lib/dedup-store.ts#InMemoryDedupStore.evictExpired#Date.now()': [
    1,
    'outside',
    "the dedup window's bucket and TTL (#177): a delivery's age, no run record",
  ],
  'cli/src/lib/dedup-store.ts#InMemoryDedupStore.record#Date.now()': [
    1,
    'outside',
    "the dedup window's bucket and TTL (#177): a delivery's age, no run record",
  ],
  'cli/src/lib/graceful-stop.ts#armGrace#performance.now()': [1, 'duration', MONOTONIC],
  'cli/src/lib/graceful-stop.ts#armYoung#performance.now()': [1, 'duration', MONOTONIC],
  'cli/src/lib/graceful-stop.ts#onConnection#performance.now()': [1, 'duration', MONOTONIC],
  'cli/src/lib/graceful-stop.ts#stop#performance.now()': [1, 'duration', MONOTONIC],
  // R1.2: a wait's own time, from its start to its end (the `waited_ms` of its line).
  'cli/src/lib/result-wait.ts#finish#performance.now()': [1, 'duration', MONOTONIC],
  'cli/src/lib/result-wait.ts#waitForRun#performance.now()': [1, 'duration', MONOTONIC],
  // R1.1: the read address's 1-second answer of a running or waiting run's phase from memory.
  'cli/src/lib/run-read-address.ts#monotonicNow#performance.now()': [1, 'duration', MONOTONIC],
  'cli/src/lib/webhook-verifiers.ts#verifyHmac#Date.now()': [
    1,
    'outside',
    "a webhook signature's window (the sender's clock against the host's)",
  ],
  'cli/src/lib/webhook-verifiers.ts#verifyStripe#Date.now()': [
    1,
    'outside',
    "a webhook signature's window (the sender's clock against the host's)",
  ],
  'cli/src/store/replay-store.ts#JsonFileReplayStore.save#new Date()': [
    1,
    'outside',
    "a replay file's own stamp",
  ],
  'core/src/adapters/adapter-utils.ts#parseRetryAfterHeader#Date.now()': [
    1,
    'outside',
    "Retry-After's HTTP date, against the host's clock",
  ],
  'core/src/adapters/token-bucket.ts#TokenBucketRateLimiter.constructor#performance.now()': [
    1,
    'duration',
    MONOTONIC,
  ],
  'core/src/engine/execution-loop.ts#advanceLoop#clock.now()': [
    1,
    'event',
    "a guard's evidence instant, read where the guard runs",
  ],
  'core/src/engine/execution-loop.ts#drainFinalizers#clock.now()': [
    4,
    'event',
    "a cleanup step's started/completed instants, written with its evidence",
  ],
  'core/src/engine/execution-loop.ts#elapsedCapMs#performance.now()': [1, 'duration', MONOTONIC],
  'core/src/engine/execution-loop.ts#executeStepBody#clock.now()': [
    7,
    'event',
    "a step's evidence instants (started, completed, settled, the abort, the compensating unclaim, the context's capture), written with them",
  ],
  'core/src/engine/execution-loop.ts#executeStepBody#performance.now()': [1, 'duration', MONOTONIC],
  'core/src/store/take-reading.ts#takeRawReading#clock.now()': [
    1,
    'read',
    "THE store's reading: every write's instant and every read's `at` (01 §B)",
  ],
  'core/src/store/trace-buffer-store.ts#InMemoryTraceBufferStore.appendUnlocked#Date.now()': [
    1,
    'outside',
    'a trace buffer batch stamp (a log), compared with nothing on the run',
  ],
  'core/src/utils/clock.ts#arm#new Date()': [1, 'outside', SYSTEM_CLOCK],
  'core/src/utils/clock.ts#now#new Date()': [1, 'outside', SYSTEM_CLOCK],
  'core/src/utils/clock.ts#tick#new Date()': [1, 'outside', SYSTEM_CLOCK],
  'mcp-server/src/door.ts#McpDoor.constructor#performance.now()': [1, 'duration', MONOTONIC],
  'mcp-server/src/json-trace-buffer-store.ts#JsonTraceBufferStore.appendWithinCS#Date.now()': [
    2,
    'outside',
    'a trace buffer batch stamp (a log), compared with nothing on the run',
  ],
  'mcp-server/src/tools/execute-step.ts#emitFailedAttemptTelemetry#new Date()': [
    1,
    'outside',
    "a telemetry line's stamp",
  ],
  // #616 unit 8: how long the write path has waited for a busy store (its budget).
  'store-sqlite/src/connection.ts#RealmDb.#withLockAndBusyWait#performance.now()': [
    1,
    'duration',
    MONOTONIC,
  ],
  'testing/src/store/run-store-fidelity-contract.ts#run#Date.now()': [
    4,
    'outside',
    "the TCK brackets a system-clock store's stamp with the wall (01 §E)",
  ],
  'testing/src/store/settlement-contract.ts#run#clock.now()': [
    1,
    'read',
    "the TCK reads the store's own clock to state what the store must have read",
  ],
};

/** The `<package path>#<function>` sites of the `outside` rows — the clock rule's allowed sites. */
export function outsideSites(): string[] {
  return [
    ...new Set(
      Object.entries(CENSUS)
        .filter(([, [, cls]]) => cls === 'outside')
        .map(([k]) => k.slice(0, k.lastIndexOf('#'))),
    ),
  ].sort();
}
