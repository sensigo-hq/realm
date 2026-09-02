// realm agent — autonomous CLI command that drives a workflow using an LLM provider.
// Core loop logic lives in packages/cli/src/agent/run-agent.ts for testability.
//
// v0.14: the legacy env-gated adapter tier (GITHUB_TOKEN/SLACK_WEBHOOK_URL) is GONE —
// adapters are constructed from the deployment manifest (realm.yaml); the loader registry
// (with its drift identity attached) flows directly into the run. Gate-notifier config is
// sourced from `manifest.notifiers.slack_gate` (the nine SLACK_* env reads are deleted).
import { Command, InvalidArgumentError } from 'commander';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  loadWorkflowFromFile,
  JsonFileStore,
  JsonWorkflowStore,
  WorkflowError,
} from '@sensigo/realm';
import { renderLoadFailure } from '../lib/loader-warnings.js';
import type { RunStore, WorkflowDefinition, ExtensionRegistry } from '@sensigo/realm';
import { LlmProvider, resolveProvider } from '../agent/providers/llm-provider.js';
import type { ProviderName } from '../agent/providers/llm-provider.js';
import { runAgent } from '../agent/run-agent.js';
import { resolveRunAttach } from '../agent/run-attach.js';
import {
  loadProjectExtensions,
  type LoadedProjectExtensions,
} from '../extensions/load-project-extensions.js';
import { createSlackGateHandler } from '../agent/gate/slack-gate-notifier.js';
import type { SlackGateHandlerConfig } from '../agent/gate/slack-gate-notifier.js';

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
  },
): ((runId: string, gate: import('@sensigo/realm').PendingGate) => Promise<void>) | undefined {
  const slack = notifiers?.slack_gate;
  if (slack === undefined) return undefined;
  const config: SlackGateHandlerConfig = {
    store: deps.store,
    definition: deps.definition,
    provider: deps.provider,
    ...(deps.registry !== undefined ? { registry: deps.registry } : {}),
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

export const agentCommand = new Command('agent')
  .description('Run a workflow autonomously using an LLM provider')
  .option('--workflow <path>', 'Path to workflow directory or workflow.yaml file')
  .option('--run-id <id>', 'Attach to an existing run instead of creating a new one')
  .option('--params <json>', 'Initial run parameters as JSON string', '{}')
  .option('--provider <provider>', 'LLM provider: openai or anthropic (auto-detected from env)')
  .option('--model <model>', 'Model name override (default: gpt-4o / claude-sonnet-4-5)')
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
    2,
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
  .action(
    async (opts: {
      workflow?: string;
      runId?: string;
      params: string;
      provider?: string;
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
    }) => {
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
      try {
        const workflowStore = new JsonWorkflowStore();
        const store = new JsonFileStore();
        // issue #207 PR-2 (D3 §5, mixed-wiring gap): construct the trace-buffer store beside the
        // concrete JsonFileStore (same runsDir), mirroring reclaim.ts's own wiring shape — without
        // this, `realm agent`'s driver never adopted/fenced a step's streamed WAL trace at all.
        const { JsonTraceBufferStore } = await import('@sensigo/realm-mcp');
        const traceBufferStore = new JsonTraceBufferStore(store.runsDirPath);
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
            opts.strictBaseUrl === true
          ) {
            console.error(
              'Error: --provider-module cannot be combined with --provider, --model, --base-url, or --strict-base-url',
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
            console.error(
              `Error: provider module default export must be an instance extending LlmProvider.\n` +
                `Import LlmProvider from '@sensigo/realm-cli/agent' and export 'export default new MyProvider()'.`,
            );
            process.exit(1);
          }
          provider = mod.default;
          moduleProviderId = `module:${basename(modulePath)}`;
        } else {
          // issue #313 (dead-config cell 1): the attestation only means anything for a compat
          // endpoint. Silently accepting it alone would let an author believe they had changed
          // something when nothing changed at all.
          if (opts.strictBaseUrl === true && opts.baseUrl === undefined) {
            console.error(
              '  ⚠ --strict-base-url has no effect without --base-url — it attests that a ' +
                'COMPAT endpoint enforces strict, and native OpenAI endpoints already do.',
            );
          }
          provider = await resolveProvider(
            opts.provider as ProviderName | undefined,
            opts.model,
            opts.baseUrl,
            opts.strictBaseUrl === true,
          );
        }
        // `realm agent` is operator-launched: cwd is a legitimate deployment-root default.
        const projectDir = resolve(opts.project ?? process.cwd());
        const extensionOpts = {
          ...(opts.extensionsModule !== undefined ? { overrideModule: opts.extensionsModule } : {}),
          projectDir,
        };

        let result: import('../agent/run-agent.js').AgentRunResult;

        if (opts.runId !== undefined) {
          // --run-id path: attach to existing run, load definition from store.
          // resolveRunAttach loads project extensions + manifest BEFORE the run is claimed
          // and carries the extensions_load_failed write / re-attach semantics.
          const { definition, ...loaded } = await resolveRunAttach(
            opts.runId,
            { store, workflowStore },
            extensionOpts,
          );

          const gateHandler = buildManifestGateHandler(loaded.notifiers, {
            store,
            definition,
            provider,
            registry: loaded.registry,
          });

          result = await runAgent(
            {
              store,
              workflowStore,
              provider,
              ...(moduleProviderId !== undefined ? { providerId: moduleProviderId } : {}),
              registry: loaded.registry,
              traceBufferStore,
              // issue #197 PR-2: default OFF; the strict-flip (REALM_REQUIRE_WRITER_NONCE) force-
              // enables minting even without the flag — resolved once in run-agent.ts's loop.
              mintWriterNonce: opts.mintWriterNonce === true,
              // issue #217: default 2, threaded exactly like mintWriterNonce above. Commander
              // always supplies a value (the option's own default), so this is never undefined.
              schemaRetries: opts.schemaRetries,
              llmTimeoutSeconds: opts.llmTimeout,
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
            process.exit(1);
          }

          const gateHandler = buildManifestGateHandler(loaded.notifiers, {
            store,
            definition,
            provider,
            registry: loaded.registry,
          });

          result = await runAgent(
            {
              store,
              workflowStore,
              provider,
              ...(moduleProviderId !== undefined ? { providerId: moduleProviderId } : {}),
              registry: loaded.registry,
              traceBufferStore,
              // issue #197 PR-2: default OFF; the strict-flip (REALM_REQUIRE_WRITER_NONCE) force-
              // enables minting even without the flag — resolved once in run-agent.ts's loop.
              mintWriterNonce: opts.mintWriterNonce === true,
              // issue #217: default 2, threaded exactly like mintWriterNonce above. Commander
              // always supplies a value (the option's own default), so this is never undefined.
              schemaRetries: opts.schemaRetries,
              llmTimeoutSeconds: opts.llmTimeout,
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

        process.exit(result === 'completed' ? 0 : 1);
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
          console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
        process.exit(1);
      }
    },
  );
