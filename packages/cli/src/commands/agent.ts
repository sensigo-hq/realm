// realm agent — autonomous CLI command that drives a workflow using an LLM provider.
// Core loop logic lives in packages/cli/src/agent/run-agent.ts for testability.
//
// v0.14: the legacy env-gated adapter tier (GITHUB_TOKEN/SLACK_WEBHOOK_URL) is GONE —
// adapters are constructed from the deployment manifest (realm.yaml); the loader registry
// (with its drift identity attached) flows directly into the run. Gate-notifier config is
// sourced from `manifest.notifiers.slack_gate` (the nine SLACK_* env reads are deleted).
import { Command, InvalidArgumentError, Option } from 'commander';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  validateRunParams,
  loadWorkflowFromFile,
  JsonFileStore,
  JsonWorkflowStore,
  WorkflowError,
  describeUnrecognised,
  describeForeignProvider,
  unbrandedClause,
  shellWord,
  getWorkflowForRun,
  deriveRunPhase,
} from '@sensigo/realm';
import { renderLoadFailure } from '../lib/loader-warnings.js';
import { resolveProgramIdentity } from '../lib/program-identity.js';
import type {
  RunStore,
  WorkflowDefinition,
  ExtensionRegistry,
  Attributed,
  PromptCacheSetting,
} from '@sensigo/realm';
import {
  LlmProvider,
  checkProviderFlags,
  readProviderKeys,
  resolveProvider,
} from '../agent/providers/llm-provider.js';
import type { ProviderName } from '../agent/providers/llm-provider.js';
import { runAgent } from '../agent/run-agent.js';
import {
  cacheableStepCounts,
  parsePromptCache,
  providerName,
  resolvePromptCache,
} from '../agent/prompt-cache.js';
import { reattachable, resolveRunAttach } from '../agent/run-attach.js';
import {
  loadProjectExtensions,
  collectReleaseLineWarnings,
  type LoadedProjectExtensions,
} from '../extensions/load-project-extensions.js';
import { createSlackGateHandler } from '../agent/gate/slack-gate-notifier.js';
import type { SlackGateHandlerConfig } from '../agent/gate/slack-gate-notifier.js';
import {
  errorWithCommand,
  noteRunManifest,
  valuesWithheldFor,
  valuesWithheldLine,
  withholdUnlessAccepted,
  writerCtx,
  writerMode,
  writerReceiptLine,
} from '../output/writer.js';

/**
 * Builds the Slack gate handler from the deployment manifest's `notifiers.slack_gate`
 * config (secret-resolved by the loader). Manifest presence IS the gate switch — no
 * environment reads. Returns undefined when no notifier is configured (terminal fallback).
 * Exported for the manifest-sourced-gate-config tests.
 */
export function buildManifestGateHandler(
  notifiers: LoadedProjectExtensions['notifiers'],
  deps: {
    store: RunStore;
    definition: WorkflowDefinition;
    provider: LlmProvider;
    registry?: ExtensionRegistry;
    /** Issue #625: the program this command runs in — forwarded to the Slack attendant. */
    driver?: Attributed;
  },
): ((runId: string, gate: import('@sensigo/realm').PendingGate) => Promise<void>) | undefined {
  const slack = notifiers?.slack_gate;
  if (slack === undefined) return undefined;
  const config: SlackGateHandlerConfig = {
    store: deps.store,
    definition: deps.definition,
    provider: deps.provider,
    ...(deps.registry !== undefined ? { registry: deps.registry } : {}),
    ...(deps.driver !== undefined ? { driver: deps.driver } : {}),
    ...(slack.webhook_url !== undefined && { webhookUrl: slack.webhook_url }),
    ...(slack.bot_token !== undefined && { botToken: slack.bot_token }),
    ...(slack.channel_id !== undefined && { channelId: slack.channel_id }),
    ...(slack.signing_secret !== undefined && { signingSecret: slack.signing_secret }),
    ...(slack.events_port !== undefined && { eventsPort: slack.events_port }),
    ...(slack.app_token !== undefined && { appToken: slack.app_token }),
    ...(slack.reminder_interval_ms !== undefined && {
      reminderIntervalMs: slack.reminder_interval_ms,
    }),
    ...(slack.escalation_threshold_ms !== undefined && {
      escalationThresholdMs: slack.escalation_threshold_ms,
    }),
  };
  return createSlackGateHandler(config);
}

/**
 * Commander argParser for `--schema-retries` (issue #217). Commander does NOT run the argParser
 * on the option's own default value — only on a user-supplied string — so an out-of-range default
 * can never reach here; this only guards user input. Rejects loudly (InvalidArgumentError, commander
 * ^14 idiom) on anything that isn't a non-negative integer — do NOT copy listen.ts's silent
 * `parseInt` (which truncates '3abc' to 3 instead of rejecting it).
 */
function parseSchemaRetries(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new InvalidArgumentError('--schema-retries must be a non-negative integer.');
  }
  return n;
}

/**
 * Commander argParser for `--llm-timeout` (issue #401). Same idiom and the same reasons as
 * `parseSchemaRetries` above; the value is a PER-ATTEMPT ceiling in seconds, so zero is rejected
 * along with the negatives — a zero-second budget would abort every request before it started.
 */
export function parseLlmTimeout(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new InvalidArgumentError('--llm-timeout must be a positive integer number of seconds.');
  }
  return n;
}

/**
 * Commander argParser for `--provider` (issue #676), used by `realm agent` and `realm listen`.
 * Same idiom as `parseLlmTimeout`. Version 0.45.0 took any other word as Anthropic, silently.
 */
export function parseProvider(value: string): ProviderName {
  if (value === 'openai' || value === 'anthropic') return value;
  throw new InvalidArgumentError('--provider must be openai or anthropic.');
}

// A value as a shell word: core's one quoter, `shellWord` (issue #625 PR-2a, F6), imported above.

/** `--schema-retries`' default; the re-attach command repeats the flag only when it differs. */
const SCHEMA_RETRIES_DEFAULT = 2;

/**
 * Issue #676 — the flags a drive was started with, as shell words, for the re-attach command the
 * drive prints when a step is blocked (`AgentDeps.reattachFlags`). Following that command must
 * continue the SAME drive: realm has no default model, and a step blocked on a missing handler is
 * usually fixed through `--extensions-module`, so a command that dropped either would be refused or
 * blocked again. Repeated, each when given: `--provider-module <path>`, or `--provider`, `--model`,
 * `--base-url`, `--strict-base-url`; then `--extensions-module`, `--project`, `--schema-retries`
 * (only when it differs from its default, so the command never shows a value nobody typed),
 * `--llm-timeout`, `--mint-writer-nonce` and `--prompt-cache` (issue #600 PR 2: only when it was
 * stated and the provider can apply it — there is no Commander default, so a default is never
 * repeated). Left out: `--workflow`, `--params` and `--register` (they apply only when a run is
 * created) and the hidden `--no-release-line-advisory` and `--spawned-by-listen` (listen's own).
 * A value outside `[A-Za-z0-9._/:@%+=,-]` is single-quoted, `'` written `'\''`.
 *
 * #729 PR-0 (RE-CUT; caching PR 2's R6-1): this is the ONE builder of `CliHost.driveFlags`, and the
 * prompt-cache rule lives here, never at a caller — the caller says where the setting came from
 * (`promptCacheSource`: `stated` by the operator, or a `default`) and whether the provider can apply
 * it (`providerAppliesPromptCache`); the flag is repeated only for a stated setting the provider
 * applies. Absent, both read as a stated setting a provider applies (the value was typed).
 *
 * @internal Exported for testing only.
 */
export function buildReattachFlags(opts: {
  provider?: string;
  model?: string;
  baseUrl?: string;
  strictBaseUrl?: boolean;
  providerModule?: string;
  extensionsModule?: string;
  project?: string;
  schemaRetries?: number;
  llmTimeout?: number;
  mintWriterNonce?: boolean;
  promptCache?: string;
  promptCacheSource?: 'stated' | 'default';
  providerAppliesPromptCache?: boolean;
}): string {
  const words: string[] = [];
  if (opts.providerModule !== undefined) {
    words.push('--provider-module', shellWord(opts.providerModule));
  } else {
    if (opts.provider !== undefined) words.push('--provider', shellWord(opts.provider));
    if (opts.model !== undefined) words.push('--model', shellWord(opts.model));
    if (opts.baseUrl !== undefined) words.push('--base-url', shellWord(opts.baseUrl));
    if (opts.strictBaseUrl === true) words.push('--strict-base-url');
  }
  if (opts.extensionsModule !== undefined) {
    words.push('--extensions-module', shellWord(opts.extensionsModule));
  }
  if (opts.project !== undefined) words.push('--project', shellWord(opts.project));
  if (opts.schemaRetries !== undefined && opts.schemaRetries !== SCHEMA_RETRIES_DEFAULT) {
    words.push('--schema-retries', String(opts.schemaRetries));
  }
  if (opts.llmTimeout !== undefined) words.push('--llm-timeout', String(opts.llmTimeout));
  if (opts.mintWriterNonce === true) words.push('--mint-writer-nonce');
  if (
    opts.promptCache !== undefined &&
    opts.promptCacheSource !== 'default' &&
    opts.providerAppliesPromptCache !== false
  ) {
    words.push('--prompt-cache', shellWord(opts.promptCache));
  }
  return words.join(' ');
}

/**
 * #729 PR-3 (RECORD 05 "shaped sites"; F10): in log mode, one line per run says what was hidden and
 * shaped — the walks' counts included — and it is printed however the drive ends (correction 2, C4:
 * an early exit prints it too).
 */
function printDriveReceipt(): void {
  if (writerMode() === 'broadcast') {
    const receipt = writerReceiptLine();
    if (receipt !== undefined) console.error(receipt);
  }
}

export const agentCommand = new Command('agent')
  .description('Run a workflow autonomously using an LLM provider')
  .option('--workflow <path>', 'Path to workflow directory or workflow.yaml file')
  .option('--run-id <id>', 'Attach to an existing run instead of creating a new one')
  .option('--params <json>', 'Initial run parameters as JSON string', '{}')
  .option(
    '--provider <provider>',
    'LLM provider: openai or anthropic (default: chosen from the API key that is set; OpenAI when both are)',
    parseProvider,
  )
  // issue #676: realm has no default model. Not Commander's `requiredOption`: a
  // `--provider-module` run must not be given one.
  .option(
    '--model <model>',
    'The model, as the provider names it. Required unless --provider-module is given.',
  )
  .option(
    '--base-url <url>',
    'Base URL for OpenAI-compatible endpoints (e.g. DeepSeek, Qwen, Groq)',
  )
  .option(
    '--strict-base-url',
    'Attest that the --base-url endpoint genuinely enforces structured-output strict mode. ' +
      'Without this, strict is never sent to a compat endpoint (it may accept and ignore it) ' +
      'and every strict-declared step records compat_endpoint.',
  )
  .option(
    '--provider-module <path>',
    'Path to a custom LlmProvider module (default export must be an instance extending LlmProvider)',
  )
  .option(
    '--register',
    'Persist the workflow definition to ~/.realm/workflows/ (same as realm workflow register)',
  )
  .option(
    '--extensions-module <path>',
    "CODE override: module that REPLACES the workflow's declared 'extensions' modules (repair tool)",
  )
  .option(
    '--project <dir>',
    'CONFIG anchor: deployment root whose realm.yaml applies to definitions without a stored trust_root (default: current directory)',
  )
  .option(
    '--mint-writer-nonce',
    'Mint a fresh writer_nonce (UUIDv4) per step-attempt for faithful trace attribution (issue ' +
      "#197) — opt-in; default OFF (today's behavior). No caller-supplied value is accepted.",
    false,
  )
  .option(
    '--schema-retries <n>',
    "Number of in-drive repair attempts when an agent step's output is rejected by " +
      'output_schema/input_schema validation (issue #217) — the drive re-prompts the same step ' +
      "with the validator's errors appended. 0 disables (today's behavior).",
    parseSchemaRetries,
    SCHEMA_RETRIES_DEFAULT,
  )
  .option(
    '--llm-timeout <seconds>',
    'Per-attempt ceiling for each model request, in seconds (issue #401). A step that authors ' +
      "its own `llm_timeout_seconds` WINS; this fills in for every step that doesn't. Default " +
      '600. When the ceiling fires the drive stops and records why, naming this lever.',
    parseLlmTimeout,
    // NO default argument, deliberately (issue #401 DQ5). The help text above stays true —
    // run-agent's own `?? 600` supplies the fallback — but a Commander default would hand the
    // drive 600 whether or not an operator typed it, and the drive would then record
    // `declared_per_attempt_ms: 600000` for a value nobody chose. Unset means unset, which is
    // what lets the recorded provenance tell a declaration from a fallback.
  )
  // issue #600 PR 2: no Commander default — an unstated flag must stay unstated, so the drive can
  // record `runner_default` and the re-attach command never repeats a value nobody typed.
  .option(
    '--prompt-cache <setting>',
    "What Anthropic is asked to cache: auto, short, long or off. auto (the default) chooses per drive — the short lifetime for a drive realm agent starts on its own; for a drive realm listen starts, off, short or long by the gaps between that workflow's recent triggers. short: Anthropic's 5 minutes. long: Anthropic's 1 hour. off: Anthropic is asked to cache nothing. Other providers are asked for no caching.",
    parsePromptCache,
  )
  // issue #620 PR-C: the repo's first hidden option. `realm listen` appends it to every child it
  // spawns (buildAgentArgv): listen tells the operator once at startup, so a child per webhook
  // must not repeat the release-line advisory. Hidden because it is listen's, not an operator's.
  .addOption(new Option('--no-release-line-advisory').hideHelp())
  // issue #600 PR 2: listen's own, never an operator's. `realm listen` appends it to every child it
  // spawns (buildAgentArgv), so the child's `auto` reads listen's measurement (its prior is the long
  // lifetime), its runner is recorded as `realm listen`, and a setting it cannot apply is disclosed,
  // not refused.
  .addOption(new Option('--spawned-by-listen').hideHelp())
  // #729 PR-3 (L-1): this drive's output is a shared log — the broadcast audience, as under
  // listen: a run's values print as their shapes, secrets are hidden as on a log (a gate's
  // question at the declared tier), and one disclosure line is printed per run. Not repeated by the
  // re-attach command (an output choice, not the drive's).
  .option(
    '--log-mode',
    "Print as a shared log, as realm listen's drives do: a run's values print as their type and size, and one line per run counts what was hidden",
  )
  // issue #600 (the lifetime unit): listen's own too — the gaps between the recent triggers of the
  // child's workflow, in whole seconds. No argParser: a refusal there would exit a listen child after
  // listen already answered `202`, leaving the run undriven; `resolvePromptCache` reads it and never
  // throws.
  .addOption(new Option('--cache-gaps <seconds>').hideHelp())
  .action(
    async (opts: {
      workflow?: string;
      runId?: string;
      params: string;
      provider?: ProviderName;
      model?: string;
      baseUrl?: string;
      strictBaseUrl?: boolean;
      providerModule?: string;
      register?: boolean;
      extensionsModule?: string;
      project?: string;
      mintWriterNonce?: boolean;
      schemaRetries: number;
      llmTimeout: number;
      promptCache?: PromptCacheSetting;
      spawnedByListen?: boolean;
      logMode?: boolean;
      cacheGaps?: string;
      releaseLineAdvisory: boolean;
    }) => {
      // issue #625 (holder slice): this program's name, made once, before any other output. A name
      // that cannot be used prints one line and exits 1 here; nothing has been started.
      const driver = resolveProgramIdentity('agent');
      if (!opts.workflow && !opts.runId) {
        console.error('Error: one of --workflow or --run-id is required');
        process.exit(1);
      }
      if (opts.workflow && opts.runId) {
        console.error('Error: --workflow and --run-id are mutually exclusive');
        process.exit(1);
      }
      if (opts.params !== '{}' && opts.runId) {
        console.error(
          'Error: --params cannot be used with --run-id; the run already has params from creation time',
        );
        process.exit(1);
      }
      // The closing sentence of every refusal below: what happened to the run, which only this
      // command knows.
      const tail =
        opts.runId !== undefined
          ? `If run ${opts.runId} exists, it was not changed.`
          : 'Nothing was started.';
      // issue #600 (the lifetime unit): `--cache-gaps` is listen's measurement, passed only to the
      // agents it starts; refused here, before anything is loaded, when an operator types it.
      if (opts.cacheGaps !== undefined && opts.spawnedByListen !== true) {
        console.error(
          `Error: --cache-gaps is realm listen's own option, passed to the agents it starts; remove it. ${tail}`,
        );
        process.exit(1);
      }
      // issue #600 PR 2 (C1): the caching setting, resolved once — the provider is built with it
      // and the drive's start line names it.
      const promptCache = resolvePromptCache({
        flag: opts.promptCache,
        spawnedByListen: opts.spawnedByListen === true,
        cacheGaps: opts.cacheGaps,
      });
      // issue #600 PR 2 (C3e): a stated setting the workflow has no step to apply to is refused
      // (an operator's `realm agent` only: listen's flag is fleet-wide and cannot be judged per
      // workflow, so its child discloses instead).
      const refuseInertPromptCache = (definition: WorkflowDefinition): void => {
        if (opts.promptCache === undefined || opts.spawnedByListen === true) return;
        if (cacheableStepCounts(definition).singleShot > 0) return;
        console.error(
          `Error: --prompt-cache has nothing to apply to: workflow '${definition.id}' has no agent step that sends its instructions in one request (steps that call tools are not cached yet), so the flag would change nothing. Remove --prompt-cache; it applies once the workflow has an agent step without tools. ${tail}`,
        );
        process.exit(1);
      };
      let exitCode: number;
      try {
        const workflowStore = new JsonWorkflowStore();
        const store = new JsonFileStore();
        // issue #207 PR-2 (D3 §5, mixed-wiring gap): construct the trace-buffer store beside the
        // concrete JsonFileStore (same runsDir), mirroring reclaim.ts's own wiring shape — without
        // this, `realm agent`'s driver never adopted/fenced a step's streamed WAL trace at all.
        const { JsonTraceBufferStore } = await import('@sensigo/realm-mcp');
        // issue #616 PR-0: the run reader is the run store the driver writes — every fence
        // predicate is evaluated against it inside the trace buffer's own critical section.
        const traceBufferStore = new JsonTraceBufferStore(store.runsDirPath, store);
        let provider: LlmProvider;
        // issue #313: a third-party provider cannot declare a `providerId` capability (realm
        // does not know its dialect), so its identity travels separately and evidence can still
        // name it. In-repo providers declare their own and this stays undefined.
        let moduleProviderId: `module:${string}` | undefined;
        if (opts.providerModule !== undefined) {
          if (
            opts.provider !== undefined ||
            opts.model !== undefined ||
            opts.baseUrl !== undefined ||
            opts.strictBaseUrl === true ||
            opts.promptCache !== undefined
          ) {
            console.error(
              'Error: --provider-module cannot be combined with --provider, --model, --base-url, --strict-base-url, or --prompt-cache',
            );
            process.exit(1);
          }
          const modulePath = resolve(opts.providerModule);
          const moduleUrl = pathToFileURL(modulePath).href;
          let mod: { default?: unknown };
          try {
            mod = (await import(moduleUrl)) as { default?: unknown };
          } catch (err) {
            console.error(
              `Error: failed to import provider module '${opts.providerModule}': ${err instanceof Error ? err.message : String(err)}`,
            );
            process.exit(1);
          }
          if (!(mod.default instanceof LlmProvider)) {
            // issue #620 PR-C: say which copy the provider's LlmProvider came from. Core composes
            // the text; this command prints it.
            const unrecognised = describeUnrecognised(mod.default, LlmProvider);
            if (unrecognised.kind === 'foreign_line') {
              for (const line of describeForeignProvider(unrecognised)) console.error(line);
              process.exit(1);
            }
            // The hedged clause ends the first line in place of its period.
            const ending =
              unrecognised.kind === 'unbranded_copy'
                ? unbrandedClause(unrecognised.className)
                : '.';
            console.error(
              `Error: provider module default export must be an instance extending LlmProvider${ending}\n` +
                `Import LlmProvider from '@sensigo/realm-cli/agent' and export 'export default new MyProvider()'.`,
            );
            process.exit(1);
          }
          provider = mod.default;
          moduleProviderId = `module:${basename(modulePath)}`;
        } else {
          // issue #676: the model flags are checked before either branch below, so a refusal
          // happens before any run is created or attached. The message is the check's; the
          // closing sentence says what happened to the run, which only this command knows.
          const flags = checkProviderFlags({
            provider: opts.provider,
            model: opts.model,
            baseUrl: opts.baseUrl,
            env: readProviderKeys(),
          });
          if (!flags.ok) {
            console.error(`Error: ${flags.message} ${tail}`);
            process.exit(1);
          }
          // issue #313 (dead-config cell 1): the attestation only means anything for a compat
          // endpoint. Silently accepting it alone would let an author believe they had changed
          // something when nothing changed at all.
          if (opts.strictBaseUrl === true && opts.baseUrl === undefined) {
            console.error(
              '  ⚠ --strict-base-url has no effect without --base-url — it attests that a ' +
                'COMPAT endpoint enforces strict, and native OpenAI endpoints already do.',
            );
          }
          provider = await resolveProvider({
            provider: opts.provider,
            model: opts.model,
            baseUrl: opts.baseUrl,
            strictBaseUrl: opts.strictBaseUrl === true,
            promptCache,
          });
          // issue #600 PR 2 (C3b): a stated setting for a provider that cannot apply it is refused,
          // keyed on the capability, never on a provider's name. A child `realm listen` started is
          // never refused: listen's flag is fleet-wide, so the child's start line discloses it.
          const caps = provider.capabilities();
          if (
            opts.promptCache !== undefined &&
            opts.spawnedByListen !== true &&
            caps.promptCache === undefined
          ) {
            console.error(
              `Error: --prompt-cache sets caching only for Anthropic; Realm asks ${providerName(caps, 'this provider')} for no caching, so the flag would change nothing. Remove --prompt-cache, or use --provider anthropic with an Anthropic model. ${tail}`,
            );
            process.exit(1);
          }
        }
        // issue #600 PR 2 (C6): the re-attach command repeats a stated setting only when this
        // provider applies it — a listen child that picked OpenAI was given the flag, and repeating
        // it would print a command C3b refuses. #729 PR-0: the rule is the builder's; this caller
        // says only where the setting came from and whether the provider applies it.
        const reattachFlags = buildReattachFlags({
          ...opts,
          promptCacheSource: 'stated',
          providerAppliesPromptCache: provider.capabilities().promptCache !== undefined,
        });
        // issue #600 PR 2: the setting the provider was built with, for the start line. A
        // `--provider-module` run has none: the module asks for what it asks.
        const promptCacheForDrive = moduleProviderId === undefined ? { promptCache } : {};
        // `realm agent` is operator-launched: cwd is a legitimate deployment-root default.
        const projectDir = resolve(opts.project ?? process.cwd());
        const extensionOpts = {
          ...(opts.extensionsModule !== undefined ? { overrideModule: opts.extensionsModule } : {}),
          projectDir,
          ...(opts.releaseLineAdvisory === false
            ? { onReleaseLineWarning: collectReleaseLineWarnings }
            : {}),
        };

        let result: import('../agent/run-agent.js').AgentRunResult;

        if (opts.runId !== undefined) {
          // issue #600 PR 2 (C3e), BEFORE resolveRunAttach, which can write (it re-opens a run that
          // ended with extensions_load_failed). Reads only, and only when the flag was stated. A read
          // that fails leaves the judgement to resolveRunAttach, which raises its own error, so an
          // unreadable run or definition fails exactly as it does without the flag.
          if (opts.promptCache !== undefined && opts.spawnedByListen !== true) {
            const stated = await store
              .get(opts.runId)
              .then((run) =>
                getWorkflowForRun(workflowStore, run, {
                  retryVerb: 're-attach',
                  verb: 're-attach',
                }),
              )
              .catch(() => undefined);
            if (stated !== undefined) refuseInertPromptCache(stated);
          }
          // #729 PR-3 correction 4 (I-11): an ended run is refused below with its stored reason, so
          // its manifest is read first, as `attempts` reads it — the reason is masked with the run's
          // declared values, and shown as its type and size while they cannot all be read (no flag
          // here: the line names the command that takes it). A run re-attached, or one that cannot
          // be read, is left to resolveRunAttach.
          const ended = await store.get(opts.runId).catch(() => undefined);
          if (ended !== undefined && ended.terminal_state && !reattachable(ended)) {
            const endedDefinition = await getWorkflowForRun(workflowStore, ended, {
              retryVerb: 're-attach',
              verb: 're-attach',
              terminalOk: true,
            }).catch(() => undefined);
            await noteRunManifest(endedDefinition, ended);
            withholdUnlessAccepted(false);
            const withheld = valuesWithheldFor();
            if (
              withheld !== undefined &&
              ended.terminal_reason !== undefined &&
              deriveRunPhase(ended) !== 'completed'
            )
              console.error(
                valuesWithheldLine(
                  withheld,
                  writerCtx().cmd(`realm run inspect ${opts.runId} --accept-partial-disclosure`),
                ),
              );
          }
          // --run-id path: attach to existing run, load definition from store.
          // resolveRunAttach loads project extensions + manifest BEFORE the run is claimed
          // and carries the extensions_load_failed write / re-attach semantics.
          const { definition, ...loaded } = await resolveRunAttach(
            opts.runId,
            // eslint-disable-next-line no-restricted-syntax -- #729 PR-3 correction 3 (H-8''): the ended-run refusal this context marks is thrown before the run is claimed and printed only by this command's own catch below; nothing keeps it.
            { store, workflowStore, ctx: writerCtx() },
            extensionOpts,
          );

          const gateHandler = buildManifestGateHandler(loaded.notifiers, {
            store,
            definition,
            provider,
            registry: loaded.registry,
            ...(driver !== undefined ? { driver } : {}),
          });

          result = await runAgent(
            {
              store,
              workflowStore,
              provider,
              ...(moduleProviderId !== undefined ? { providerId: moduleProviderId } : {}),
              registry: loaded.registry,
              traceBufferStore,
              ...(driver !== undefined ? { driver } : {}),
              // issue #197 PR-2: default OFF; the strict-flip (REALM_REQUIRE_WRITER_NONCE) force-
              // enables minting even without the flag — resolved once in run-agent.ts's loop.
              mintWriterNonce: opts.mintWriterNonce === true,
              // issue #217: default 2, threaded exactly like mintWriterNonce above. Commander
              // always supplies a value (the option's own default), so this is never undefined.
              schemaRetries: opts.schemaRetries,
              llmTimeoutSeconds: opts.llmTimeout,
              reattachFlags,
              ...promptCacheForDrive,
              ...(gateHandler ? { gateHandler } : {}),
              ...(loaded.secretValues !== undefined
                ? { redactionValues: loaded.secretValues }
                : {}),
            },
            {
              existingRunId: opts.runId,
              definition,
              params: {},
            },
          );
        } else {
          const params = JSON.parse(opts.params) as Record<string, unknown>;

          // Resolve and load workflow definition before starting a run.
          const inputPath = opts.workflow!;
          const filePath =
            inputPath.endsWith('.yaml') || inputPath.endsWith('.yml')
              ? inputPath
              : join(inputPath, 'workflow.yaml');
          const definition = loadWorkflowFromFile(filePath);
          // issue #600 PR 2 (C3e): before params, extensions and the run.
          refuseInertPromptCache(definition);

          // issue #586: apply a declared `params_schema` BEFORE the run is created (the run is
          // minted inside `runAgent` below). No local catch: the outer catch already renders a
          // non-`Invalid workflow:` WorkflowError as `Error: <message>` and exits 1, which is
          // exactly the voice `realm run` prints one file over — a second render here would be a
          // duplicated composer.
          if (definition.params_schema !== undefined) {
            validateRunParams(params, definition.params_schema, definition.id);
          }

          // Load project extensions + deployment manifest BEFORE the run is created
          // (fail-before-create); the loader registry flows directly into the run.
          // issue #465 — a failure here gets the sentence run/validate/register/watch print
          // (run.ts's arm, verbatim) instead of riding the outer catch to a bare `Error:`. The
          // workflow's own warnings already printed, above, on the core's lenient load.
          let loaded: LoadedProjectExtensions;
          try {
            loaded = await loadProjectExtensions(definition, extensionOpts);
          } catch (err) {
            console.error(
              `Error loading extensions: ${err instanceof Error ? err.message : String(err)}`,
            );
            // #729 PR-3 correction 2 (C4): this exit skips the `finally` below, so the drive's
            // `Disclosure:` line is printed here.
            printDriveReceipt();
            process.exit(1);
          }

          const gateHandler = buildManifestGateHandler(loaded.notifiers, {
            store,
            definition,
            provider,
            registry: loaded.registry,
            ...(driver !== undefined ? { driver } : {}),
          });

          result = await runAgent(
            {
              store,
              workflowStore,
              provider,
              ...(moduleProviderId !== undefined ? { providerId: moduleProviderId } : {}),
              registry: loaded.registry,
              traceBufferStore,
              ...(driver !== undefined ? { driver } : {}),
              // issue #197 PR-2: default OFF; the strict-flip (REALM_REQUIRE_WRITER_NONCE) force-
              // enables minting even without the flag — resolved once in run-agent.ts's loop.
              mintWriterNonce: opts.mintWriterNonce === true,
              // issue #217: default 2, threaded exactly like mintWriterNonce above. Commander
              // always supplies a value (the option's own default), so this is never undefined.
              schemaRetries: opts.schemaRetries,
              llmTimeoutSeconds: opts.llmTimeout,
              reattachFlags,
              ...promptCacheForDrive,
              ...(gateHandler ? { gateHandler } : {}),
              ...(loaded.secretValues !== undefined
                ? { redactionValues: loaded.secretValues }
                : {}),
            },
            {
              definition,
              params,
              register: opts.register === true,
            },
          );
        }

        exitCode = result === 'completed' ? 0 : 1;
      } catch (err) {
        // issue #425 — THE FAMILY SPLIT. An `Invalid workflow:` message announces itself, so it
        // renders verbatim through the shared helper (which also lists a multi-error throw one per
        // line). Everything else this catch can see — a store failure, a provider failure —
        // announces nothing on its own, so it keeps the prefix that earns its place (#417). The
        // predicate carries the colon, byte-matching the helper's own check.
        // This catch wraps the ENTIRE drive, so the else-arm carries provider failures, store
        // errors and everything else a run can hit — dropping the prefix here wholesale would
        // strip it from all of them.
        if (err instanceof WorkflowError && err.message.startsWith('Invalid workflow:')) {
          console.error(renderLoadFailure(err));
        } else {
          console.error(`Error: ${errorWithCommand(err, writerCtx())}`);
        }
        exitCode = 1;
      } finally {
        printDriveReceipt();
      }
      process.exit(exitCode);
    },
  );
