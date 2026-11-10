// run-store-fidelity-contract.ts — framework-agnostic Test Compatibility Kit (TCK) for RunStore
// field-fidelity honesty + claimStep single-owner conformance (issue #188, PR-2).
//
// Pure case descriptors, NOT describe/it/expect — mirrors per-run-artifact-store-contract.ts's
// own precedent (issue #183) and its rationale: importing vitest here would make it a runtime
// dependency of this published package (this module ships in @sensigo/realm-testing's dist).
// Each calling test file supplies an adapter and wires the returned descriptors into ITS OWN test
// framework.
//
// This is "the forcing part" (issue #188): FIDELITY_HONESTY does not just check that a store
// SAYS it persists a field — it writes a real sample value through create/update and reads it
// back, so a store that DECLARES `persistedRunRecordFields` dishonestly (claims a field, drops it
// on write) fails conformance here, before it ever ships. A store that declares NOTHING gets one
// case of this law: the identity entry a run is created with (`extension_identity`) must not come
// back, since the store does not list that field (J-5) — see `runStoreFidelityContract`'s own doc.
import { isDeepStrictEqual } from 'node:util';
import { crossCopyNote } from './cross-copy-note.js';
import { storeReleaseLineLaw } from './store-release-line-law.js';
import {
  WorkflowError,
  SCAN_MAX_PAGE_SIZE,
  type Attributed,
  type EvidenceSnapshot,
  type CreateResult,
  type PurgedItem,
  type RunStore,
  type RunRecord,
  type LoadBearingRunRecordField,
  type CacheDiagnostics,
  type CacheReference,
  type ScanFilter,
  type ScanOptions,
  type UsageRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';

/**
 * The laws every `RunStore` implementation should be run against — EXPORTED as a const so a wiring
 * file can derive the list it runs from it (issue #625): a law added here then runs everywhere the
 * contract is wired, or is named, with a reason, in that file's `NOT_RUN` list. The members, in
 * order: `FIDELITY_HONESTY` and `CLAIM_SINGLE_OWNER` (issue #188), `SEALED_BY_ROUNDTRIP` (issue
 * #367 — the seal arm survives a proper terminal write byte-for-byte), `CLAIM_NAMES_HOLDER` (issue
 * #625 — a claim reads back with the program that took the step and when),
 * `EVIDENCE_KEEPS_DRIVER_AND_PROOF` (issue #625 — the program that did a step's work and the proof
 * on an answer's entry survive a round trip), `STORE_RELEASE_LINE_TRUE` (issue #620 PR-C — the
 * store's declared release line is its errors' line) and `USAGE_RECORD_ROUNDTRIP` (issue #600 PR 2 —
 * a request record's facts, the model and what realm asked to cache among them, survive a round trip
 * in a step's evidence and in a failed drive's usage) and `SUPPLIER_ROUND_TRIPS` (issue #729 PR-0,
 * T-17 (iv), §5 E1 (iv) — the supplier's role an evidence entry records survives a round trip, and
 * an entry written without one reads back without one, never a role the store made up) and
 * `EVIDENCE_KEEPS_ANSWER_FACTS` (issue #627 W, §5.8 — how an answer arrived: the route its door
 * declared with what showed the question, the program that recorded it, whether the door asked the
 * user's app to ask the person, and the transport's principal, each read back exactly, typed
 * absences included) and `EVIDENCE_WRITE_ORDER` (#872 (b1) — a run's evidence reads back in the
 * order it was written: `get_run_state` pages a run's steps in that order, by a step's place in it)
 * and `DRIVE_FAILURE_KEEPS_ITS_FENCE` (#715 (b), 02 §D.2 — a failed drive's entry reads back with the
 * evidence count and the open question's id it was appended at, and one written without them reads
 * back without them: the `drive_failing` finding tells a legacy entry by their absence) and
 * `CREATE_REPORTS_CREATED` (#616 PR-1a unit 16a — a create says whether it made a new run:
 * `created: true` for an unkeyed create, a keyed create on a fresh key and a keyed `rerun` over a
 * finished run, which makes a new run, with a different id, whose `rerun_of` names the run it
 * replaces, in the create's result and as `get` returns it; `created: false`, with the live run's
 * id, for a keyed create that reuses that run; and a create resolves `{ record, at, created }`).
 * #616 PR-2c c4-i adds six: `SCAN_PAGES_EVERY_RECORD_ONCE` and `SCAN_FILTERS_HOLD` (a scan's pages
 * and filters), `KEY_RESOLVES_THREE_WAYS` (who holds a key: held, purged or unseen),
 * `PURGED_RUNS_SCAN_AS_TOMBSTONES` and `HORIZON_BELOW_TOMBSTONES` (a deleted run's tombstone and the
 * horizon below it), and `PURGE_CAPABILITY_WIRED` (the store's `purgesRuns` agrees with the adapter's
 * `purge`); the three purge laws' cases are skipped for a store that never deletes a run.
 */
export const RUN_STORE_FIDELITY_LAWS = [
  'FIDELITY_HONESTY',
  'CLAIM_SINGLE_OWNER',
  'SEALED_BY_ROUNDTRIP',
  'CLAIM_NAMES_HOLDER',
  'EVIDENCE_KEEPS_DRIVER_AND_PROOF',
  'STORE_RELEASE_LINE_TRUE',
  'USAGE_RECORD_ROUNDTRIP',
  'SUPPLIER_ROUND_TRIPS',
  'EVIDENCE_KEEPS_ANSWER_FACTS',
  'EVIDENCE_WRITE_ORDER',
  'DRIVE_FAILURE_KEEPS_ITS_FENCE',
  'CREATE_REPORTS_CREATED',
  'SCAN_PAGES_EVERY_RECORD_ONCE',
  'SCAN_FILTERS_HOLD',
  'KEY_RESOLVES_THREE_WAYS',
  'PURGED_RUNS_SCAN_AS_TOMBSTONES',
  'HORIZON_BELOW_TOMBSTONES',
  'PURGE_CAPABILITY_WIRED',
] as const;

export type RunStoreFidelityLaw = (typeof RUN_STORE_FIDELITY_LAWS)[number];

/**
 * A single, framework-agnostic contract case. `run()` throws (rejects) on failure — any test
 * framework's `await run()` (rejecting fails the test) or `expect(run()).resolves...` /
 * `expect(run()).rejects...` maps directly onto this.
 */
export interface RunStoreFidelityContractCase {
  law: RunStoreFidelityLaw;
  name: string;
  run: () => Promise<void>;
  /** Set on a case this store cannot run (issue #616 PR-1b B5): its `name` says why, and its `run`
   *  does nothing. Register it with your test runner's own skip. */
  skipped?: true;
}

/** Adapter a calling test file supplies to parameterize the contract against one concrete store. */
export interface RunStoreFidelityContractAdapter {
  /** The store under test. */
  store: RunStore;
  /**
   * Deletes one ENDED run by id and leaves its tombstone (#616 PR-2c c4-i): supply it for a store
   * with `purgesRuns: true`, whose purge laws then run; leave it out for a store that never deletes
   * a run, whose purge laws' cases are then skipped. The contract ends the run before it calls it.
   */
  purge?: (runId: string) => Promise<void>;
  /**
   * A workflow definition carrying exactly one step, named `stepName`, that is immediately
   * eligible on a freshly-created run (no unmet `depends_on`) — used by CLAIM_SINGLE_OWNER to
   * race two concurrent `claimStep` calls against a fresh run of this definition.
   */
  definition: WorkflowDefinition;
  stepName: string;
}

/**
 * Caching 3-M (piece A-1) — the copied predecessor `USAGE_RECORD_ROUNDTRIP` writes on its request:
 * every field of `CacheReference` (`satisfies Required<…>`, so a field left off fails the compile),
 * each a value no store default could produce, `prefix_parts` with its four parts and `cache_auto` in
 * its shape with the most keys (as on the request), so a store that drops a key inside it fails the
 * law.
 */
const TCK_REFERENCE = {
  from: 'run',
  request_start: '2025-12-31T23:59:58.000Z',
  request_id: '3a1a0000-0000-4000-8000-0000000003a1',
  provider: 'tck-reference-provider',
  model: 'tck-reference-model-2025-12-31',
  endpoint: 'custom',
  cache_requested: 'provider_rules',
  cache_read_input_tokens: 1234,
  cache_creation_input_tokens: 567,
  cache_write_tokens: 89,
  cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 67 },
  cache_lifetime_s: 300,
  cache_ttl_sent: true,
  cache_auto: {
    basis: 'listen_trigger_gaps',
    gaps_s: [62, 3598],
    prices: { from: 'economics', excluded: ['long'], missing: ['cache_write_1h'] },
  },
  prefix_chars: 1234,
  prefix_parts: {
    tools: '5555555555555555555555555555555555555555555555555555555555555555',
    system: '6666666666666666666666666666666666666666666666666666666666666666',
    prompt: '7777777777777777777777777777777777777777777777777777777777777777',
    format: '8888888888888888888888888888888888888888888888888888888888888888',
  },
  cache_marked: ['system', 'prompt', 'key'],
  request_strict_sent: true,
  agent_profile_changed: true,
} satisfies Required<CacheReference>;

/**
 * Issue #600 PR 2 — the request facts `USAGE_RECORD_ROUNDTRIP` writes, every one with a value no store
 * default could produce (`true` for the booleans, words other than `off` and `default`). The law
 * checks each field on this list; a field left off it is a field no store is held to. Issue #715 (R)
 * adds the request's identity, `request_id`: a fixed UUID no store default could produce. Caching
 * 3-B adds the split's seven facts: digests, a count, closed words and booleans, the objects in the
 * shape with the most keys. Caching 3-M (piece A-1) adds `reference`, the copy of a request's
 * predecessor: `TCK_REFERENCE`, every one of its fields. Piece A-1b adds `request_in_call`, the
 * request's place in its provider call: a place other than 0, which no store default could produce.
 * Piece B1 adds `response_id`, the id of the provider's answer: Anthropic's documented example id.
 * Piece B3a adds `cache_diagnostics`, in its state with a reason object.
 */
const TCK_REQUEST_FACTS: Required<
  Pick<
    UsageRecord,
    | 'model'
    | 'cache_requested'
    | 'cache_lifetime_s'
    | 'cache_ttl_sent'
    | 'cache_requested_source'
    | 'cache_requested_by'
    | 'cache_auto'
    | 'provider'
    | 'endpoint'
    | 'cache_split_offered'
    | 'request_id'
    | 'prefix_sha256'
    | 'prefix_chars'
    | 'prefix_parts'
    | 'cache_marked'
    | 'request_strict_sent'
    | 'cache_controls_rejected'
    | 'cache_key_sent'
    | 'reference'
    | 'request_in_call'
    | 'response_id'
    | 'cache_diagnostics'
  >
> = {
  model: 'tck-model-2026-01-01',
  cache_requested: 'lifetime',
  cache_lifetime_s: 3600,
  cache_ttl_sent: true,
  cache_requested_source: 'stated',
  cache_requested_by: 'tck-runner',
  // issue #600 (the lifetime unit): an object no store default produces; issue #898: its `prices`
  // in the shape with the most keys, so a store that drops a nested key fails (the law compares by
  // deep equality, so a store that keeps the keys in another order passes)
  cache_auto: {
    basis: 'listen_trigger_gaps',
    gaps_s: [61, 3599],
    prices: { from: 'economics', excluded: ['long'], missing: ['cache_write_1h'] },
  },
  provider: 'tck-provider',
  endpoint: 'custom',
  cache_split_offered: true,
  request_id: '715a0000-0000-4000-8000-00000000715a',
  // caching 3-B (A6): the split's facts
  prefix_sha256: '3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b',
  prefix_chars: 4321,
  prefix_parts: {
    tools: '1111111111111111111111111111111111111111111111111111111111111111',
    system: '2222222222222222222222222222222222222222222222222222222222222222',
    prompt: '3333333333333333333333333333333333333333333333333333333333333333',
    format: '4444444444444444444444444444444444444444444444444444444444444444',
  },
  cache_marked: ['system', 'prompt'],
  request_strict_sent: true,
  cache_controls_rejected: {
    status: 400,
    dropped: ['cache_fields'],
    proven: 'none',
    fields: ['cache_control', 'prompt_cache_key'],
  },
  cache_key_sent: true,
  reference: TCK_REFERENCE,
  // caching 3-M (piece A-1b): the request's place in its call
  request_in_call: 7,
  // caching 3-M (piece B1): the answer's id, Anthropic's documented example (anth-pc@2026-10-09.md:1107)
  response_id: 'msg_01XFDUDYJgAACzvnptvVoYEL',
  // caching 3-M (piece B3a): the shape with the most keys, a reason with its count
  cache_diagnostics: {
    asked: true,
    reference_id: 'msg_01XFDUDYJgAACzvnptvVoYEL',
    result: { type: 'messages_changed', cache_missed_input_tokens: 1200 },
  },
};

/**
 * Caching 3-M (piece B3a): the other two states of `cache_diagnostics`, written as the second and third
 * request beside `TCK_REQUEST_FACTS`'s reason object. The commonest state, a call's first request,
 * holds a `null`, and the refusal's holds a `cause`: a store that drops a null key or a key inside the
 * value fails on them, which the first request's state, with every key set, cannot show.
 */
const TCK_DIAGNOSTICS_STATES: readonly CacheDiagnostics[] = [
  { asked: true, reference_id: null },
  { asked: false, cause: 'rejected' },
];

/** The program the holder laws name — a synthetic label, never a real host or user. */
const TCK_CLAIMANT: Attributed = { by: 'tck-program', by_source: 'stated', channel: 'tck' };

/**
 * `CLAIM_NAMES_HOLDER`'s one assertion: the step's claim carries a `since` inside the bracket
 * [before, after] taken around the claiming call (`since` is the STORE's own act, at the write that
 * creates the claim), and carries the claimant as `holder` — or, when none was passed, no `holder`
 * key at all.
 */
function assertClaimNames(
  record: RunRecord,
  stepName: string,
  claimant: Attributed | undefined,
  before: number,
  after: number,
  where: string,
): void {
  const claim = record.claims?.[stepName];
  if (claim === undefined) {
    throw new Error(
      `CLAIM_NAMES_HOLDER (${where}): the store wrote no claim for step '${stepName}'`,
    );
  }
  if (typeof claim.since !== 'string') {
    throw new Error(
      `CLAIM_NAMES_HOLDER (${where}): the claim carries no 'since' — a store stamps it on EVERY ` +
        `claim, in the write that creates it (got ${JSON.stringify(claim.since)})`,
    );
  }
  const at = Date.parse(claim.since);
  if (!(at >= before && at <= after)) {
    throw new Error(
      `CLAIM_NAMES_HOLDER (${where}): 'since' ${claim.since} is outside the bracket around the ` +
        `claiming call (${new Date(before).toISOString()} .. ${new Date(after).toISOString()}) — ` +
        "it is the store's own act, stamped at the claim write",
    );
  }
  if (claimant === undefined) {
    if ('holder' in claim) {
      throw new Error(
        `CLAIM_NAMES_HOLDER (${where}): a claim made with no claimant must carry no 'holder' ` +
          `(got ${JSON.stringify(claim.holder)})`,
      );
    }
    return;
  }
  if (JSON.stringify(claim.holder) !== JSON.stringify(claimant)) {
    throw new Error(
      `CLAIM_NAMES_HOLDER (${where}): expected holder ${JSON.stringify(claimant)}, got ` +
        `${JSON.stringify(claim.holder)} — claimStep's fourth argument must be written as ` +
        '`claims[step].holder`',
    );
  }
}

/**
 * `CREATE_REPORTS_CREATED`'s words for what a create reported: its `created` (`left out` when the
 * result carries none, as a store that never sets it reports).
 */
function reportedCreated(result: { created?: unknown }): string {
  return result.created === undefined
    ? '`created` left out'
    : `created: ${JSON.stringify(result.created)}`;
}

/** `CREATE_REPORTS_CREATED`'s words for a run's `rerun_of`, returned by `create` or read by `get`. */
function reportedLink(rerunOf: string | undefined): string {
  return rerunOf === undefined ? 'no rerun_of' : `rerun_of ${rerunOf}`;
}

/** A workflow id and idempotency key no other case, and no earlier run of this case, uses. */
function mintCreatedTag(): string {
  return `tck-created-${Math.random().toString(36).slice(2)}`;
}

/** A workflow id (and key) for one case of the scan, key and purge laws: no other case uses it. */
function mintTag(what: string): string {
  return `tck-${what}-${Math.random().toString(36).slice(2)}`;
}

/** The one shape a store's stamps take, `toISOString()`'s. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Whether `call` is refused: it throws, or the promise it returns rejects. */
async function refuses(call: () => Promise<unknown>): Promise<boolean> {
  try {
    await call();
    return false;
  } catch {
    return true;
  }
}

/** A whole scan, page by page: each page's run ids, tombstones and `next_after`, and all of them. */
async function scanAll(
  store: RunStore,
  filter: ScanFilter,
  options: ScanOptions,
  law: RunStoreFidelityLaw,
) {
  const pages: Array<{ runs: string[]; purged: PurgedItem[]; next_after?: string }> = [];
  for await (const page of store.scan(filter, options)) {
    if (pages.length === 1000) throw new Error(`${law}: the scan did not end after 1,000 pages`);
    const runs: string[] = [];
    const purged: PurgedItem[] = [];
    for (const item of page.items) {
      if (item.kind === 'purged') purged.push(item);
      else runs.push('record' in item.run ? item.run.record.id : item.run.id);
    }
    pages.push({
      runs,
      purged,
      ...(page.next_after !== undefined ? { next_after: page.next_after } : {}),
    });
  }
  return { pages, runs: pages.flatMap((p) => p.runs), purged: pages.flatMap((p) => p.purged) };
}

/** Ends `run` with the contract's own terminal write (`SEALED_BY_ROUNDTRIP`'s). */
async function endRun(store: RunStore, run: RunRecord): Promise<void> {
  await store.update({
    ...run,
    completed_steps: ['tck-step'],
    terminal_state: true,
    sealed_by: { arm: 'complete', step: 'tck-step' },
    terminal_reason: 'Workflow completed.',
  });
}

/**
 * The purge laws' wiring check (#616 PR-2c c4-i), which `PURGE_CAPABILITY_WIRED` and every purge case
 * run first: the store's `purgesRuns` is a boolean, the adapter's `purge` is a function or left out,
 * and the two agree. A disagreement throws, its message beginning `ADAPTER_WIRING:`.
 */
function checkPurgeWiring(adapter: RunStoreFidelityContractAdapter): void {
  const flag: unknown = adapter.store.purgesRuns;
  const purge: unknown = adapter.purge;
  const wiring = (why: string) => new Error(`ADAPTER_WIRING: ${why}`);
  if (typeof flag !== 'boolean') {
    throw wiring(
      `a store says whether it deletes runs with \`purgesRuns: true\` or \`false\`; this store's is ${String(flag)}`,
    );
  }
  if (purge !== undefined && typeof purge !== 'function') {
    throw wiring(
      `the adapter's \`purge\` must be a function that deletes one ended run; it is a ${typeof purge}`,
    );
  }
  if (flag && purge === undefined) {
    throw wiring(
      'the store says it deletes runs (`purgesRuns: true`), but the adapter supplies no `purge`: supply one, or set `purgesRuns: false`',
    );
  }
  if (!flag && purge !== undefined) {
    throw wiring(
      'the adapter supplies `purge`, but the store says it never deletes a run (`purgesRuns: false`): set `purgesRuns: true`, or leave `purge` out',
    );
  }
}

/**
 * A purge law's case: skipped, by name, for a store with `purgesRuns: false` and no `purge` (it
 * deletes no run, so it has no tombstone to show); otherwise `run`, after the wiring check.
 */
function purgeCase(
  adapter: RunStoreFidelityContractAdapter,
  law: RunStoreFidelityLaw,
  name: string,
  run: () => Promise<void>,
): RunStoreFidelityContractCase {
  if (adapter.store.purgesRuns === false && adapter.purge === undefined) {
    return {
      law,
      name: `SKIPPED — store does not delete runs (purgesRuns: false): ${name}`,
      skipped: true,
      run: async () => {
        // Intentional no-op — see the case name for why.
      },
    };
  }
  return {
    law,
    name,
    run: async () => {
      checkPurgeWiring(adapter);
      await run();
    },
  };
}

/**
 * The purge laws' fixture: a keyed run of a workflow of its own, ended by {@link endRun}, then deleted
 * by the adapter's `purge` (the wiring check has passed, so it is a function).
 */
async function purgedRun(adapter: RunStoreFidelityContractAdapter, what: string) {
  const tag = mintTag(what);
  const { record: run } = await adapter.store.create({
    workflowId: tag,
    workflowVersion: 1,
    params: {},
    idempotencyKey: tag,
  });
  await endRun(adapter.store, run);
  await adapter.purge!(run.id);
  return { tag, runId: run.id };
}

/** The four branches of `CREATE_REPORTS_CREATED`, as each failure message names its own. */
const CREATED_UNKEYED = 'an unkeyed create';
const CREATED_FRESH = 'a keyed create on a fresh key';
const CREATED_REUSE = 'a keyed create that reuses the live run under its key';
const CREATED_RERUN = "a keyed create with onTerminalMatch 'rerun' over a finished run";

/**
 * `CREATE_REPORTS_CREATED`'s read of a create's result (#616 PR-1a unit 16a correction). A create
 * resolves `{ record, at, created }`; a store that resolves nothing, or a value that is not an
 * object, fails the case in the law's words, naming the branch and which of its creates (`site`)
 * resolved what, never with a bare `TypeError` from reading a field of it.
 */
function createResultOf(branch: string, site: string, result: CreateResult): CreateResult {
  const value: unknown = result;
  if (typeof value !== 'object' || value === null) {
    throw new Error(
      `CREATE_REPORTS_CREATED (${branch}): a create resolves { record, at, created }; the ` +
        `${site} resolved ${value === undefined || value === null ? 'nothing' : `a ${typeof value}`}`,
    );
  }
  return result;
}

/**
 * {@link createResultOf} for a case that reads the run a create made or reused: the result must
 * also carry a `record` that is an object (a missing, `null` or non-object one is reported with
 * the result's own keys, as the shape before #715, `{ run, created }`, is) whose `id` is a string.
 */
function createdRunOf(branch: string, site: string, result: CreateResult): CreateResult {
  const value: { record?: unknown } = createResultOf(branch, site, result);
  if (typeof value.record !== 'object' || value.record === null) {
    const keys = Object.keys(value);
    throw new Error(
      `CREATE_REPORTS_CREATED (${branch}): a create resolves { record, at, created }; the ` +
        `${site} resolved an object with no record ` +
        `(${keys.length === 0 ? 'it has no keys' : `its keys: ${keys.join(', ')}`})`,
    );
  }
  const id: unknown = (value.record as { id?: unknown }).id;
  if (typeof id !== 'string') {
    throw new Error(
      `CREATE_REPORTS_CREATED (${branch}): the run the ${site} returned has no string id; its ` +
        `id's type is ${typeof id}`,
    );
  }
  return result;
}

/**
 * One realistic, minimal-but-valid sample value per {@link LoadBearingRunRecordField} — used by
 * FIDELITY_HONESTY to actually exercise a round-trip. Deliberately real shapes (not `{}` or
 * `null`), since a store that only round-trips empty/degenerate values would not actually prove
 * fidelity for the shapes the engine truly writes.
 *
 * The type annotation is CLOSED over every key of `LoadBearingRunRecordField` — issue #279
 * (increment 1) relies on this: widening that union to add `settled`/`finalizer_ledger` forced a
 * compile error here until both got a sample value, which is deliberate (a store declaring
 * `settleStep` gets these two FIDELITY_HONESTY cases automatically, everywhere
 * `runStoreFidelityContract` already runs — including the byte-untouched CLI contract test file;
 * see that file's own header for why it needs no edit).
 */
const SAMPLE_VALUES: {
  [K in LoadBearingRunRecordField]: NonNullable<RunRecord[K]>;
} = {
  // issue #367: present so the closed-map compile check stays satisfied. The GENERIC loop below
  // deliberately skips this field — see SEALED_BY_ROUNDTRIP for why writing it the generic way
  // would violate the boundary it shares a package with.
  sealed_by: { arm: 'complete' },
  capability_blocks: {
    'tck-step': {
      requirement: { kind: 'handler', name: 'tck-handler' },
      code: 'ENGINE_HANDLER_NOT_REGISTERED',
      at: '2026-01-01T00:00:00.000Z',
    },
  },
  workflow_context_snapshots: {
    'tck-key': {
      source_path: '/tck/sample.md',
      content: 'hello',
      content_hash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      loaded_at: '2026-01-01T00:00:00.000Z',
    },
  },
  extension_identity: [
    {
      captured_at: '2026-01-01T00:00:00.000Z',
      modules: [],
      tree: {
        roots: [],
        rules: 'tck-rules',
        file_count: 0,
        total_bytes: 0,
        tree_hash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        truncated: false,
      },
      coverage: 'dir_tree_v1',
      // #729 PR-3 (D-12; §0 rule 5): what decides the run's declared values — the manifest's
      // `secrets` block hash beside its whole-file hash, and the secret names — round-trips whole.
      manifest: {
        path: '/tck/realm.yaml',
        content_hash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        secrets_block_hash: 'cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe',
      },
      secret_names: ['TCK_SECRET'],
    },
  ],
  validation_rejections: { 'tck-step': 3 },
  defaulted_steps: ['tck-step'],
  // issue #279 (increment 1): sample values for the two settlement fields — dormant data shapes
  // (nothing writes these until PR-B), but real/valid ones per their own RunRecord doc.
  settled: { 'tck-step': { token: 'tck-fidelity-token', outcome: 'complete' } },
  finalizer_ledger: { 'tck-finalizer': { status: 'pending', rank: 0 } },
};

/**
 * Builds the contract cases for `adapter`.
 *
 * **FIDELITY_HONESTY** — one case PER FIELD in `adapter.store.persistedRunRecordFields` (a store
 * that declares nothing gets one case, J-5 below: the identity entry a run is created with must
 * not come back, since the store does not list that field; such a store gets the conservative
 * runtime gates instead, and that combination is correct-by-design, not a TCK gap). Each case:
 * `create` a fresh run, `update` it to carry a realistic sample value for that field, `get` it
 * back, and byte-compare (via JSON, since every `LoadBearingRunRecordField` is
 * plain-JSON-serializable data) what was written against what was read. A mismatch means the
 * store's declaration is DISHONEST.
 *
 * **CLAIM_SINGLE_OWNER** — races two concurrent `claimStep(runId, sameStep)` calls against a
 * fresh run; asserts exactly one resolves and the other rejects with
 * `STATE_STEP_ALREADY_CLAIMED`. **Cross-host caveat: this only exercises and asserts the
 * SAME-PROCESS (same-host) guarantee** — for an in-memory store this is same-process by
 * construction; for a lock-based store like `JsonFileStore` it exercises same-host
 * multi-process safety via the real OS-level lock the two concurrent calls contend on, but this
 * TCK run happens within ONE test process, so it does not and cannot exercise true cross-host
 * concurrency. The CROSS-HOST single-owner obligation (stated on `RunStore.claimStep`'s own
 * JSDoc) can only be verified by a store's OWN conformance suite against its real concurrent
 * backend (e.g. a Postgres store's suite exercising genuine multi-connection contention) — do
 * NOT read a green result here as proof of cross-host safety.
 */
export function runStoreFidelityContract(
  adapter: RunStoreFidelityContractAdapter,
): RunStoreFidelityContractCase[] {
  const cases: RunStoreFidelityContractCase[] = [];

  const declaredFields =
    adapter.store.persistedRunRecordFields ?? new Set<LoadBearingRunRecordField>();
  for (const field of declaredFields) {
    // issue #367: `sealed_by` cannot ride the generic loop. That loop writes its sample onto a
    // LIVE record, and a live record carrying a seal is an orphan — the store boundary refuses it
    // (STATE_SEAL_ORPHANED), so the case would red for a reason that has nothing to do with
    // fidelity. It gets the dedicated SEALED_BY_ROUNDTRIP case below, which seals the run properly
    // first and then asserts the arm survives byte-for-byte.
    if (field === 'sealed_by') continue;
    cases.push({
      law: 'FIDELITY_HONESTY',
      name: `a store declaring '${field}' actually round-trips it (create → update → get)`,
      run: async () => {
        const { record: run } = await adapter.store.create({
          workflowId: `tck-fidelity-${field}`,
          workflowVersion: 1,
          params: {},
        });
        const sampleValue = SAMPLE_VALUES[field];
        await adapter.store.update({ ...run, [field]: sampleValue });
        const { record: reread } = await adapter.store.get(run.id);
        const actual = (reread as unknown as Record<string, unknown>)[field];
        const wroteJson = JSON.stringify(sampleValue);
        const readJson = JSON.stringify(actual);
        if (readJson !== wroteJson) {
          throw new Error(
            `store declares persistedRunRecordFields includes '${field}' but a round-trip did ` +
              `NOT preserve it — the declared fidelity is DISHONEST (issue #188). wrote: ` +
              `${wroteJson}, read back: ${readJson}`,
          );
        }
      },
    });
  }

  // #729 PR-3 correction 5 (J-5): the identity entry a creator writes WITH the run (its manifest
  // reference at the run's start) is kept by a store that declares `extension_identity`, in the
  // creation write; a store that declares it not kept leaves it absent — never a field it says it
  // does not keep.
  cases.push({
    law: 'FIDELITY_HONESTY',
    name: "create's start entry: kept when the store declares 'extension_identity', absent when it does not",
    run: async () => {
      const entry = { ...SAMPLE_VALUES.extension_identity![0]!, origin: 'start' as const };
      const { record: run } = await adapter.store.create({
        workflowId: 'tck-fidelity-start-identity',
        workflowVersion: 1,
        params: {},
        extensionIdentity: [entry],
      });
      const { record: reread } = await adapter.store.get(run.id);
      const declared = declaredFields.has('extension_identity');
      const want = declared ? JSON.stringify([entry]) : undefined;
      const read = JSON.stringify(reread.extension_identity);
      if (read !== want) {
        throw new Error(
          `store ${declared ? 'declares' : 'does not declare'} persistedRunRecordFields includes ` +
            `'extension_identity', but create's start entry read back as ${read ?? 'absent'} ` +
            `(#729 PR-3 correction 5, J-5). want: ${want ?? 'absent'}`,
        );
      }
    },
  });

  if (declaredFields.has('sealed_by')) {
    cases.push({
      law: 'SEALED_BY_ROUNDTRIP',
      name: 'a store declaring sealed_by round-trips the seal arm through a PROPER terminal write',
      run: async () => {
        const { record: run } = await adapter.store.create({
          workflowId: 'tck-fidelity-sealed-by',
          workflowVersion: 1,
          params: {},
        });
        // A real seal: terminal_state and sealed_by in the same write, exactly as every engine
        // seal site does it.
        await adapter.store.update({
          ...run,
          completed_steps: ['tck-step'],
          terminal_state: true,
          sealed_by: { arm: 'complete', step: 'tck-step' },
          terminal_reason: 'Workflow completed.',
        });
        const { record: reread } = await adapter.store.get(run.id);
        const wrote = JSON.stringify({ arm: 'complete', step: 'tck-step' });
        const read = JSON.stringify(reread.sealed_by);
        if (read !== wrote) {
          throw new Error(
            `store declares persistedRunRecordFields includes 'sealed_by' but a terminal ` +
              `round-trip did NOT preserve it — the run's recorded outcome silently changed ` +
              `(issue #367). wrote: ${wrote}, read back: ${read}`,
          );
        }
      },
    });
  }

  // issue #625 (the holder slice) — CLAIM_NAMES_HOLDER. Active only for a store that keeps claims
  // (`persistsClaims === true`): a store that keeps none has nothing to name a holder ON, and says
  // so by name rather than passing silently. The case follows the fenced trace-buffer contract's
  // skip idiom — `skipped: true`, which a wiring reads, and the name `SKIPPED — <reason>: <name>`,
  // which a person reads — so a wiring run lists it (issue #616 PR-1b B5).
  if (adapter.store.persistsClaims === true) {
    cases.push(
      {
        law: 'CLAIM_NAMES_HOLDER',
        name: 'a claim made with a claimant reads back with that holder and a since — returned and re-read',
        run: async () => {
          const { record: run } = await adapter.store.create({
            workflowId: `tck-holder-${Math.random().toString(36).slice(2)}`,
            workflowVersion: 1,
            params: {},
          });
          const before = Date.now();
          const { record: claimed } = await adapter.store.claimStep(
            run.id,
            adapter.stepName,
            adapter.definition,
            TCK_CLAIMANT,
          );
          const after = Date.now();
          assertClaimNames(
            claimed,
            adapter.stepName,
            TCK_CLAIMANT,
            before,
            after,
            'the returned record',
          );
          assertClaimNames(
            (await adapter.store.get(run.id)).record,
            adapter.stepName,
            TCK_CLAIMANT,
            before,
            after,
            'a re-read of the stored record',
          );
        },
      },
      {
        law: 'CLAIM_NAMES_HOLDER',
        name: 'a claim made WITHOUT a claimant reads back with a since and NO holder',
        run: async () => {
          const { record: run } = await adapter.store.create({
            workflowId: `tck-holder-${Math.random().toString(36).slice(2)}`,
            workflowVersion: 1,
            params: {},
          });
          const before = Date.now();
          await adapter.store.claimStep(run.id, adapter.stepName, adapter.definition);
          const after = Date.now();
          assertClaimNames(
            (await adapter.store.get(run.id)).record,
            adapter.stepName,
            undefined,
            before,
            after,
            'a re-read of the stored record',
          );
        },
      },
    );
  } else {
    cases.push({
      law: 'CLAIM_NAMES_HOLDER',
      name: "SKIPPED — store does not declare 'persistsClaims': claim holder round-trip",
      skipped: true,
      run: async () => {
        // Intentional no-op — see the case name for why.
      },
    });
  }

  // issue #625 — EVIDENCE_KEEPS_DRIVER_AND_PROOF. Always active: every store round-trips evidence.
  // F4 (framework §5 E1): and a bare step's entry written with output_source reads back with it.
  cases.push({
    law: 'EVIDENCE_KEEPS_DRIVER_AND_PROOF',
    name: 'an entry written with driven_by, a gate_response entry written with claim_proof and an entry written with output_source read back with all three',
    run: async () => {
      const { record: run } = await adapter.store.create({
        workflowId: `tck-evidence-${Math.random().toString(36).slice(2)}`,
        workflowVersion: 1,
        params: {},
      });
      const base: EvidenceSnapshot = {
        step_id: adapter.stepName,
        started_at: '2026-01-01T00:00:00.000Z',
        completed_at: '2026-01-01T00:00:01.000Z',
        duration_ms: 1,
        input_summary: {},
        output_summary: {},
        status: 'success',
        evidence_hash: 'tck-evidence',
      };
      const proof = { proof: 'unverifiable', cause: 'claim_has_no_token' } as const;
      await adapter.store.update({
        ...run,
        evidence: [
          { ...base, driven_by: TCK_CLAIMANT },
          { ...base, kind: 'gate_response', claim_proof: proof },
          { ...base, output_source: 'dependency' },
        ],
      });
      const { record: reread } = await adapter.store.get(run.id);
      const wroteDriver = JSON.stringify(TCK_CLAIMANT);
      const readDriver = JSON.stringify(reread.evidence[0]?.driven_by);
      if (readDriver !== wroteDriver) {
        throw new Error(
          `a store must round-trip an evidence entry's driven_by (issue #625): wrote ${wroteDriver}, ` +
            `read back ${readDriver}`,
        );
      }
      const wroteProof = JSON.stringify(proof);
      const readProof = JSON.stringify(reread.evidence[1]?.claim_proof);
      if (readProof !== wroteProof) {
        throw new Error(
          `a store must round-trip a gate_response entry's claim_proof (issue #625): wrote ` +
            `${wroteProof}, read back ${readProof}`,
        );
      }
      const readSource = reread.evidence[2]?.output_source;
      if (readSource !== 'dependency') {
        throw new Error(
          `a store must round-trip a bare step's entry's output_source (issue #625): wrote ` +
            `"dependency", read back ${JSON.stringify(readSource)}`,
        );
      }
    },
  });

  // issue #729 PR-0 (T-17 (iv), §5 E1 (iv)) — SUPPLIER_ROUND_TRIPS. Always active: every store
  // round-trips evidence. The role is a closed word (`SUPPLIER_ROLES`); an entry with none keeps none —
  // a store never fills the absence (its readers name why: `readSupplier`).
  cases.push({
    law: 'SUPPLIER_ROUND_TRIPS',
    name: 'an entry written with supplied_by reads back with it, and one written without reads back without',
    run: async () => {
      const { record: run } = await adapter.store.create({
        workflowId: `tck-supplier-${Math.random().toString(36).slice(2)}`,
        workflowVersion: 1,
        params: {},
      });
      const base: EvidenceSnapshot = {
        step_id: adapter.stepName,
        started_at: '2026-01-01T00:00:00.000Z',
        completed_at: '2026-01-01T00:00:01.000Z',
        duration_ms: 1,
        input_summary: {},
        output_summary: {},
        status: 'success',
        evidence_hash: 'tck-supplier',
      };
      await adapter.store.update({
        ...run,
        evidence: [{ ...base, supplied_by: 'agent' }, { ...base }],
      });
      const { record: reread } = await adapter.store.get(run.id);
      const read = reread.evidence[0]?.supplied_by;
      if (read !== 'agent') {
        throw new Error(
          `a store must round-trip an evidence entry's supplied_by (issue #729 PR-0): wrote "agent", ` +
            `read back ${JSON.stringify(read)}`,
        );
      }
      const second = reread.evidence[1];
      if (second === undefined || 'supplied_by' in second) {
        throw new Error(
          `an evidence entry written without supplied_by must read back without it (issue #729 ` +
            `PR-0): read back ${JSON.stringify(second?.supplied_by)}`,
        );
      }
    },
  });

  // issue #627 W (§5.8) — EVIDENCE_KEEPS_ANSWER_FACTS. Always active: every store round-trips
  // evidence. Two `gate_response` entries: one with every fact a server door declares (a form's
  // route with what showed it, the program, the client-prompt request, an API-key principal), one
  // with the record's typed absences (a library caller that declared no route; dev mode's principal)
  // — a store keeps an absence as written and never fills one in.
  cases.push({
    law: 'EVIDENCE_KEEPS_ANSWER_FACTS',
    name: 'a gate_response entry written with answer, driven_by, client_prompt_requested and principal reads back with each one, and one written with the typed absences reads back with them',
    run: async () => {
      const { record: run } = await adapter.store.create({
        workflowId: `tck-answer-${Math.random().toString(36).slice(2)}`,
        workflowVersion: 1,
        params: {},
      });
      const base: EvidenceSnapshot = {
        step_id: adapter.stepName,
        started_at: '2026-01-01T00:00:00.000Z',
        completed_at: '2026-01-01T00:00:01.000Z',
        duration_ms: 1,
        input_summary: {},
        output_summary: {},
        status: 'success',
        evidence_hash: 'tck-answer',
        kind: 'gate_response',
      };
      const declared = {
        answer: { route: 'mcp_form', shown: { renderer: 'tck-renderer/1' } },
        driven_by: TCK_CLAIMANT,
        client_prompt_requested: true,
        principal: { kind: 'api_key', id: 'tck-key-id' },
      } as const satisfies Partial<EvidenceSnapshot>;
      const absent = {
        answer: { absent: 'route_not_declared' },
        principal: { absent: 'door_authentication_disabled' },
      } as const satisfies Partial<EvidenceSnapshot>;
      await adapter.store.update({
        ...run,
        evidence: [
          { ...base, ...declared },
          { ...base, ...absent },
        ],
      });
      const { record: reread } = await adapter.store.get(run.id);
      const pairs: [string, unknown, unknown][] = [
        ['answer', declared.answer, reread.evidence[0]?.answer],
        ['driven_by', declared.driven_by, reread.evidence[0]?.driven_by],
        [
          'client_prompt_requested',
          declared.client_prompt_requested,
          reread.evidence[0]?.client_prompt_requested,
        ],
        ['principal', declared.principal, reread.evidence[0]?.principal],
        ['answer (a typed absence)', absent.answer, reread.evidence[1]?.answer],
        ['principal (a typed absence)', absent.principal, reread.evidence[1]?.principal],
      ];
      for (const [field, wrote, read] of pairs) {
        if (JSON.stringify(read) !== JSON.stringify(wrote)) {
          throw new Error(
            `a store must round-trip a gate_response entry's ${field} (issue #627): wrote ` +
              `${JSON.stringify(wrote)}, read back ${JSON.stringify(read)}`,
          );
        }
      }
      const second = reread.evidence[1];
      if (second === undefined || 'client_prompt_requested' in second || 'driven_by' in second) {
        throw new Error(
          'a gate_response entry written without client_prompt_requested and driven_by must read ' +
            'back without them (issue #627): a store never fills in an answer fact',
        );
      }
    },
  });

  // #872 (b1) — EVIDENCE_WRITE_ORDER. Always active: every store round-trips evidence. A run's
  // evidence reads back in WRITE order — `get_run_state` pages a run's steps in first-attempt order,
  // its cursor a step's place in that order, so a store that reorders evidence moves the pages.
  cases.push({
    law: 'EVIDENCE_WRITE_ORDER',
    name: "three steps' evidence written in three separate writes (a, b, c) reads back as a, b, c",
    run: async () => {
      const { record: run } = await adapter.store.create({
        workflowId: `tck-order-${Math.random().toString(36).slice(2)}`,
        workflowVersion: 1,
        params: {},
      });
      const entry = (step_id: string): EvidenceSnapshot => ({
        step_id,
        started_at: '2026-01-01T00:00:00.000Z',
        completed_at: '2026-01-01T00:00:01.000Z',
        duration_ms: 1,
        input_summary: {},
        output_summary: {},
        status: 'success',
        evidence_hash: `tck-order-${step_id}`,
      });
      let current = run;
      for (const step of ['a', 'b', 'c']) {
        ({ record: current } = await adapter.store.update({
          ...current,
          evidence: [...current.evidence, entry(step)],
        }));
      }
      const read = (await adapter.store.get(run.id)).record.evidence.map((e) => e.step_id);
      if (JSON.stringify(read) !== JSON.stringify(['a', 'b', 'c'])) {
        throw new Error(
          `a store must read a run's evidence back in the order it was written (#872): wrote a, b, c ` +
            `in three writes, read back ${JSON.stringify(read)}`,
        );
      }
    },
  });

  cases.push({
    law: 'CLAIM_SINGLE_OWNER',
    name: 'two concurrent claimStep calls for the same (runId, step) — exactly one succeeds',
    run: async () => {
      const { record: run } = await adapter.store.create({
        workflowId: `tck-claim-${Math.random().toString(36).slice(2)}`,
        workflowVersion: 1,
        params: {},
      });
      const results = await Promise.allSettled([
        adapter.store.claimStep(run.id, adapter.stepName, adapter.definition),
        adapter.store.claimStep(run.id, adapter.stepName, adapter.definition),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (fulfilled.length !== 1) {
        throw new Error(
          `expected exactly ONE of two concurrent claimStep calls for the same (runId, step) to ` +
            `succeed, got ${fulfilled.length} — the single-owner guarantee is violated (breaks ` +
            'the resurrect-race protection, issue #184, and the trace-buffer epoch minting, issue #185).',
        );
      }
      for (const r of rejected) {
        const err: unknown = r.reason;
        if (!(err instanceof WorkflowError) || err.code !== 'STATE_STEP_ALREADY_CLAIMED') {
          const described = err instanceof WorkflowError ? err.code : String(err);
          throw new Error(
            `expected the losing claimStep call to reject with a WorkflowError carrying code ` +
              `STATE_STEP_ALREADY_CLAIMED, got: ${described}${crossCopyNote(err, WorkflowError)}`,
          );
        }
      }
    },
  });

  // issue #600 PR 2 — USAGE_RECORD_ROUNDTRIP. Always active: every store round-trips evidence and
  // drive failures.
  cases.push({
    law: 'USAGE_RECORD_ROUNDTRIP',
    name: "a request record written with every request fact, in a step's evidence and in a failed drive's usage, reads back with each one",
    run: async () => {
      const { record: run } = await adapter.store.create({
        workflowId: `tck-usage-${Math.random().toString(36).slice(2)}`,
        workflowVersion: 1,
        params: {},
      });
      const request: UsageRecord = {
        request_index: 0,
        request_start: '2026-01-01T00:00:00.000Z',
        prompt_tokens: 10,
        ...TCK_REQUEST_FACTS,
      };
      // the request above, then one request per other state of `cache_diagnostics` (index 1, 2, ...)
      const requests: UsageRecord[] = [
        { ...request },
        ...TCK_DIAGNOSTICS_STATES.map((cache_diagnostics, i) => ({
          request_index: i + 1,
          request_start: '2026-01-01T00:00:00.000Z',
          prompt_tokens: 10,
          cache_diagnostics,
        })),
      ];
      const entry: EvidenceSnapshot = {
        step_id: adapter.stepName,
        started_at: '2026-01-01T00:00:00.000Z',
        completed_at: '2026-01-01T00:00:01.000Z',
        duration_ms: 1,
        input_summary: {},
        output_summary: {},
        status: 'success',
        evidence_hash: 'tck-usage',
        diagnostics: {
          input_token_estimate: 10,
          precondition_trace: [],
          cache: {
            state: 'engaged',
            basis: 'provider_reported',
            requests: requests.map((r) => ({ ...r })),
          },
        },
      };
      await adapter.store.update({
        ...run,
        evidence: [entry],
        drive_failures: {
          first_failed_at: '2026-01-01T00:00:02.000Z',
          total: 1,
          entries: [
            {
              at: '2026-01-01T00:00:02.000Z',
              step: adapter.stepName,
              provider: 'tck-provider',
              error_class: 'other',
              message: 'tck',
              elapsed_ms: 1,
              usage: requests.map((r) => ({ ...r })),
            },
          ],
        },
      });
      const { record: reread } = await adapter.store.get(run.id);
      const lists: Array<[string, readonly unknown[] | undefined]> = [
        [
          'evidence[0].diagnostics.cache.requests',
          reread.evidence[0]?.diagnostics?.cache?.requests,
        ],
        ['drive_failures.entries[0].usage', reread.drive_failures?.entries[0]?.usage],
      ];
      const places: Array<[string, unknown]> = lists.map(([where, list]) => [
        `${where}[0]`,
        list?.[0],
      ]);
      for (const [where, list] of lists) {
        for (const [i, state] of TCK_DIAGNOSTICS_STATES.entries()) {
          const read = list?.[i + 1];
          const got =
            typeof read === 'object' && read !== null
              ? (read as Record<string, unknown>)['cache_diagnostics']
              : undefined;
          if (!isDeepStrictEqual(got, state)) {
            throw new Error(
              `a store must round-trip a request record's cache_diagnostics in each of its states ` +
                `(caching 3-M B3a): at ${where}[${i + 1}], wrote ${JSON.stringify(state)}, ` +
                `read back ${JSON.stringify(got)}`,
            );
          }
        }
      }
      for (const [where, read] of places) {
        for (const [field, wrote] of Object.entries(TCK_REQUEST_FACTS)) {
          const got =
            typeof read === 'object' && read !== null
              ? (read as Record<string, unknown>)[field]
              : undefined;
          // deep equality: the same answer as before for the scalars, and an object's key order no
          // longer matters (`cache_auto`)
          if (!isDeepStrictEqual(got, wrote)) {
            throw new Error(
              `a store must round-trip a request record's ${field} (issue #600 PR 2): at ${where}, ` +
                `wrote ${JSON.stringify(wrote)}, read back ${JSON.stringify(got)}`,
            );
          }
        }
      }
    },
  });

  // #715 (b) (02 §D.2) — DRIVE_FAILURE_KEEPS_ITS_FENCE. Always active: every store round-trips
  // drive failures.
  cases.push({
    law: 'DRIVE_FAILURE_KEEPS_ITS_FENCE',
    name: "a failed drive's entry reads back with the evidence count and question id it was appended at; one written without them reads back without them",
    run: async () => {
      const { record: run } = await adapter.store.create({
        workflowId: `tck-fence-${Math.random().toString(36).slice(2)}`,
        workflowVersion: 1,
        params: {},
      });
      const base = {
        at: '2026-01-01T00:00:02.000Z',
        step: adapter.stepName,
        provider: 'tck-provider',
        error_class: 'other' as const,
        message: 'tck',
        elapsed_ms: 1,
      };
      await adapter.store.update({
        ...run,
        drive_failures: {
          first_failed_at: base.at,
          total: 2,
          entries: [base, { ...base, evidence_count: 3, gate_id: 'tck-fence-gate' }],
        },
      });
      const { record: reread } = await adapter.store.get(run.id);
      const [legacy, fenced] = reread.drive_failures?.entries ?? [];
      const got = {
        legacy: [
          legacy !== undefined && 'evidence_count' in legacy,
          legacy !== undefined && 'gate_id' in legacy,
        ],
        fenced: [fenced?.evidence_count, fenced?.gate_id],
      };
      if (
        got.legacy[0] !== false ||
        got.legacy[1] !== false ||
        got.fenced[0] !== 3 ||
        got.fenced[1] !== 'tck-fence-gate'
      ) {
        throw new Error(
          `a store must round-trip a failed drive's fence (#715 (b)): read back ${JSON.stringify(got)} — want the legacy entry without evidence_count and gate_id, the other with 3 and 'tck-fence-gate'`,
        );
      }
    },
  });

  // #616 PR-1a unit 16a — CREATE_REPORTS_CREATED. Always active: every store creates runs, keyed
  // ones included. The adapter hands one store to every case, so each case mints its own workflow
  // id and key and asserts only its own fact: (c) and (d) read their first create's run and leave
  // its `created` to (b). Every create's result is read through `createResultOf` / `createdRunOf`,
  // so a store that resolves another shape fails in the law's words (the correction).
  cases.push(
    {
      law: 'CREATE_REPORTS_CREATED',
      name: 'an unkeyed create reports created: true',
      run: async () => {
        const result = createResultOf(
          CREATED_UNKEYED,
          'create',
          await adapter.store.create({
            workflowId: mintCreatedTag(),
            workflowVersion: 1,
            params: {},
          }),
        );
        if (result.created !== true) {
          throw new Error(
            `CREATE_REPORTS_CREATED (${CREATED_UNKEYED}): a create that makes a new run must report ` +
              `created: true; the store reported ${reportedCreated(result)}`,
          );
        }
      },
    },
    {
      law: 'CREATE_REPORTS_CREATED',
      name: 'a keyed create on a fresh key reports created: true',
      run: async () => {
        const tag = mintCreatedTag();
        const result = createResultOf(
          CREATED_FRESH,
          'create',
          await adapter.store.create({
            workflowId: tag,
            workflowVersion: 1,
            params: {},
            idempotencyKey: tag,
          }),
        );
        if (result.created !== true) {
          throw new Error(
            `CREATE_REPORTS_CREATED (${CREATED_FRESH}): a create that makes a new run must report ` +
              `created: true; the store reported ${reportedCreated(result)}`,
          );
        }
      },
    },
    {
      law: 'CREATE_REPORTS_CREATED',
      name: 'a second keyed create while the first run is live reuses it: created: false and the same id',
      run: async () => {
        const tag = mintCreatedTag();
        const options = { workflowId: tag, workflowVersion: 1, params: {}, idempotencyKey: tag };
        const { record: live } = createdRunOf(
          CREATED_REUSE,
          'first create',
          await adapter.store.create(options),
        );
        const result = createdRunOf(
          CREATED_REUSE,
          'second create',
          await adapter.store.create(options),
        );
        if (result.created !== false) {
          throw new Error(
            `CREATE_REPORTS_CREATED (${CREATED_REUSE}): it must report created: false; the store ` +
              `reported ${reportedCreated(result)}`,
          );
        }
        if (result.record.id !== live.id) {
          throw new Error(
            `CREATE_REPORTS_CREATED (${CREATED_REUSE}): it must return that run (${live.id}); the ` +
              `store returned ${result.record.id} and reported created: false`,
          );
        }
      },
    },
    {
      law: 'CREATE_REPORTS_CREATED',
      name: "a keyed create with onTerminalMatch 'rerun' over a finished run reports created: true and a rerun_of naming that run",
      run: async () => {
        const tag = mintCreatedTag();
        const options = { workflowId: tag, workflowVersion: 1, params: {}, idempotencyKey: tag };
        const { record: first } = createdRunOf(
          CREATED_RERUN,
          'first create',
          await adapter.store.create(options),
        );
        // The holder ends the way the supersede journey of #558 PR-C ends it, through the store's
        // own `get` and `update`.
        const { record: fresh } = await adapter.store.get(first.id);
        await adapter.store.update({
          ...fresh,
          run_phase: 'abandoned',
          terminal_state: true,
          abandoned_at: fresh.updated_at,
          sealed_by: { arm: 'abandon_requested' },
          terminal_reason: 'Abandoned via realm run abandon',
        });
        const result = createdRunOf(
          CREATED_RERUN,
          'rerun create',
          await adapter.store.create({ ...options, onTerminalMatch: 'rerun' }),
        );
        if (result.created !== true) {
          throw new Error(
            `CREATE_REPORTS_CREATED (${CREATED_RERUN}): a create that makes a new run must report ` +
              `created: true; the store reported ${reportedCreated(result)}`,
          );
        }
        if (result.record.id === first.id) {
          throw new Error(
            `CREATE_REPORTS_CREATED (${CREATED_RERUN}): a create that replaces a run must make a ` +
              `new run; the store returned the id of the run it replaces (${first.id})`,
          );
        }
        if (result.record.rerun_of !== first.id) {
          throw new Error(
            `CREATE_REPORTS_CREATED (${CREATED_RERUN}): the new run's rerun_of must name the run ` +
              `it replaces (${first.id}); the store returned ${reportedLink(result.record.rerun_of)}`,
          );
        }
        // The link a rerun writes must be the link `get` returns: the key holder and `inspect`
        // read it from the stored record, not from the create's result.
        const { record: stored } = await adapter.store.get(result.record.id);
        if (stored.rerun_of !== first.id) {
          throw new Error(
            `CREATE_REPORTS_CREATED (${CREATED_RERUN}): the new run's rerun_of, read back by get, ` +
              `must name the run it replaces (${first.id}); get returned ` +
              reportedLink(stored.rerun_of),
          );
        }
      },
    },
  );

  // #616 PR-2c c4-i — the scan, key and purge laws. Each case keeps to a workflow of its own: a
  // wiring may share one store across laws.
  const { store } = adapter;
  const create = async (workflowId: string, idempotencyKey?: string) =>
    (
      await store.create({
        workflowId,
        workflowVersion: 1,
        params: {},
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      })
    ).record;
  cases.push(
    {
      law: 'SCAN_PAGES_EVERY_RECORD_ONCE',
      name: 'a scan of 20 runs in pages of 7 returns each run once, in id order, in pages of 7, 7 and 6; only a full page carries next_after',
      run: async () => {
        const tag = mintTag('scan-pages');
        const ids: string[] = [];
        for (let i = 0; i < 20; i++) ids.push((await create(tag)).id);
        const got = await scanAll(
          store,
          { workflow: tag },
          { pageSize: 7 },
          'SCAN_PAGES_EVERY_RECORD_ONCE',
        );
        const sizes = got.pages.map((p) => p.runs.length).join(', ');
        // Realm mints ASCII UUIDs, so `sort()` is their byte order; no order is pinned for other ids.
        if (got.runs.join() !== [...ids].sort().join() || sizes !== '7, 7, 6') {
          const missing = ids.filter((id) => !got.runs.includes(id)).length;
          throw new Error(
            `SCAN_PAGES_EVERY_RECORD_ONCE: a scan of 20 runs in pages of 7 must return each once, in id order, in pages of 7, 7 and 6; it returned pages of ${sizes}: ${got.runs.length} runs, ${new Set(got.runs).size} of them distinct, ${missing} missing`,
          );
        }
        const short = got.pages.find((p) => p.runs.length < 7 && p.next_after !== undefined);
        if (short !== undefined) {
          throw new Error(
            `SCAN_PAGES_EVERY_RECORD_ONCE: only a full page carries next_after; a page of ${short.runs.length} carried ${short.next_after}`,
          );
        }
      },
    },
    {
      law: 'SCAN_PAGES_EVERY_RECORD_ONCE',
      name: `a scan with a page size of 0, ${SCAN_MAX_PAGE_SIZE + 1} or 2.5 is refused`,
      run: async () => {
        // A store that throws on a bad argument passes this case however it throws; the law pins
        // that the bad input is never served, not how it is refused.
        for (const pageSize of [0, SCAN_MAX_PAGE_SIZE + 1, 2.5]) {
          if (
            !(await refuses(() =>
              store.scan({ workflow: mintTag('scan-refused') }, { pageSize }).next(),
            ))
          ) {
            throw new Error(
              `SCAN_PAGES_EVERY_RECORD_ONCE: a page size must be a whole number from 1 to ${SCAN_MAX_PAGE_SIZE}; the store accepted ${pageSize}`,
            );
          }
        }
      },
    },
    {
      law: 'SCAN_FILTERS_HOLD',
      name: 'each scan filter selects exactly the runs it matches, and a key filter without a workflow is refused',
      run: async () => {
        const a = mintTag('scan-filters');
        const live = await create(a);
        const ended = await create(a, 'k1');
        await endRun(store, ended);
        const keyed = await create(a, 'k2');
        const other = await create(`${a}-other`, 'k1');
        const stored = await Promise.all(
          [live, ended, keyed].map(async (r) => (await store.get(r.id)).record),
        );
        const since = (field: 'created_at' | 'updated_at', at: string) =>
          stored.filter((r) => r[field] >= at).map((r) => r.id);
        const late = '9999-12-31T23:59:59.999Z';
        const table: Array<[ScanFilter, string[]]> = [
          [{ workflow: a }, [live.id, ended.id, keyed.id]],
          [{ workflow: `${a}-other` }, [other.id]],
          [{ workflow: a, terminal: true }, [ended.id]],
          [{ workflow: a, terminal: false }, [live.id, keyed.id]],
          [{ workflow: a, phase: 'completed' }, [ended.id]],
          [{ workflow: a, phase: 'running' }, [live.id, keyed.id]],
          [{ workflow: a, key: 'k1' }, [ended.id]],
          [{ workflow: a, created_since: keyed.created_at }, since('created_at', keyed.created_at)],
          [{ workflow: a, created_since: late }, []],
          [
            { workflow: a, updated_since: stored[1]!.updated_at },
            since('updated_at', stored[1]!.updated_at),
          ],
          [{ workflow: a, updated_since: late }, []],
        ];
        for (const [filter, want] of table) {
          const got = (
            await scanAll(store, filter, { pageSize: 100, projection: 'row' }, 'SCAN_FILTERS_HOLD')
          ).runs;
          if ([...got].sort().join() !== [...want].sort().join()) {
            throw new Error(
              `SCAN_FILTERS_HOLD: the filter ${JSON.stringify(filter)} must select ${want.length} run(s) (${want.join(', ') || 'none'}); the store returned ${got.length} (${got.join(', ') || 'none'})`,
            );
          }
        }
        if (!(await refuses(() => store.scan({ key: 'k1' }, { pageSize: 100 }).next()))) {
          throw new Error(
            'SCAN_FILTERS_HOLD: a key filter without a workflow must be refused (a key belongs to one workflow); the store accepted it',
          );
        }
      },
    },
    {
      law: 'KEY_RESOLVES_THREE_WAYS',
      name: 'a key no run has carried is unseen, with an ISO since; a keyed run holds its key',
      run: async () => {
        const tag = mintTag('key');
        const unseen = await store.resolveKey(tag, tag);
        if (unseen.state !== 'unseen' || !ISO_INSTANT.test(unseen.since)) {
          throw new Error(
            `KEY_RESOLVES_THREE_WAYS: a key no run has carried resolves { state: 'unseen', since: <an ISO instant> }; the store answered ${JSON.stringify(unseen)}`,
          );
        }
        const run = await create(tag, tag);
        const held = await store.resolveKey(tag, tag);
        if (held.state !== 'held' || held.run_id !== run.id) {
          throw new Error(
            `KEY_RESOLVES_THREE_WAYS: a keyed run holds its key, { state: 'held', run_id: '${run.id}' }; the store answered ${JSON.stringify(held)}`,
          );
        }
      },
    },
    purgeCase(
      adapter,
      'KEY_RESOLVES_THREE_WAYS',
      'after the only run carrying a key ended and was purged, the key resolves purged, listing that run and when it was deleted, with since at or before it',
      async () => {
        const { tag, runId } = await purgedRun(adapter, 'key-purged');
        const answer = await store.resolveKey(tag, tag);
        const listed = answer.state === 'purged' ? answer.runs : [];
        const at = listed[0]?.purged_at ?? '';
        if (
          answer.state !== 'purged' ||
          listed.length !== 1 ||
          listed[0]!.run_id !== runId ||
          !ISO_INSTANT.test(at) ||
          !(Date.parse(answer.since) <= Date.parse(at))
        ) {
          throw new Error(
            `KEY_RESOLVES_THREE_WAYS: after its only run (${runId}) ended and was purged, a key resolves { state: 'purged', runs: [{ run_id, purged_at }], since } with since at or before purged_at; the store answered ${JSON.stringify(answer)}`,
          );
        }
      },
    ),
    purgeCase(
      adapter,
      'PURGED_RUNS_SCAN_AS_TOMBSTONES',
      "a purged run scans as { kind: 'purged' } with include_purged, never as { kind: 'run' }, and not at all without it",
      async () => {
        const { tag, runId } = await purgedRun(adapter, 'scan-purged');
        const law = 'PURGED_RUNS_SCAN_AS_TOMBSTONES';
        const kept = await scanAll(
          store,
          { workflow: tag, include_purged: true },
          { pageSize: 100 },
          law,
        );
        const tomb = kept.purged.filter((p) => p.run_id === runId);
        if (
          tomb.length !== 1 ||
          !ISO_INSTANT.test(tomb[0]!.purged_at) ||
          kept.runs.includes(runId)
        ) {
          throw new Error(
            `${law}: a scan with include_purged yields the purged run ${runId} once as { kind: 'purged', run_id, purged_at }, never as a run; it yielded ${tomb.length} tombstone(s) ${JSON.stringify(tomb)} and ${kept.runs.includes(runId) ? 'the run' : 'no run'}`,
          );
        }
        const plain = await scanAll(store, { workflow: tag }, { pageSize: 100 }, law);
        if (plain.runs.includes(runId) || plain.purged.some((p) => p.run_id === runId)) {
          throw new Error(
            `${law}: a scan without include_purged does not yield the purged run ${runId}; it did`,
          );
        }
      },
    ),
    purgeCase(
      adapter,
      'HORIZON_BELOW_TOMBSTONES',
      'tombstonesSince is an ISO instant at or before every purged_at a scan or resolveKey lists',
      async () => {
        const { tag } = await purgedRun(adapter, 'horizon');
        const horizon = await store.tombstonesSince();
        const law = 'HORIZON_BELOW_TOMBSTONES';
        const key = await store.resolveKey(tag, tag);
        const listed = [
          ...(await scanAll(store, { workflow: tag, include_purged: true }, { pageSize: 100 }, law))
            .purged,
          ...(key.state === 'purged' ? key.runs : []),
        ].map((p) => p.purged_at);
        const later = listed.filter((at) => !(Date.parse(horizon) <= Date.parse(at)));
        if (!ISO_INSTANT.test(horizon) || listed.length === 0 || later.length > 0) {
          throw new Error(
            `${law}: tombstonesSince() is an ISO instant at or before every purged_at listed; it returned ${horizon}, and the scan and resolveKey listed ${listed.length === 0 ? 'no tombstone' : listed.join(', ')}`,
          );
        }
      },
    ),
    {
      law: 'PURGE_CAPABILITY_WIRED',
      name: "the store's purgesRuns is true or false and agrees with the adapter: true with a purge, false without one",
      run: async () => checkPurgeWiring(adapter),
    },
  );

  cases.push({
    law: 'STORE_RELEASE_LINE_TRUE',
    name: "the store's declared release line is the line of its own refusal (get of a missing run)",
    run: () =>
      storeReleaseLineLaw(adapter.store, () =>
        adapter.store.get('store-release-line-true-missing-run'),
      ),
  });

  return cases;
}
