// realm agent — autonomous CLI command that drives a workflow using an LLM provider.
// Core loop logic lives in packages/cli/src/agent/run-agent.ts for testability.
//
// v0.14: the legacy env-gated adapter tier (GITHUB_TOKEN/SLACK_WEBHOOK_URL) is GONE —
// adapters are constructed from the deployment manifest (realm.yaml); the loader registry
// (with its drift identity attached) flows directly into the run. Gate-notifier config is
// sourced from `manifest.notifiers.slack_gate` (the nine SLACK_* env reads are deleted).
import { Command, InvalidArgumentError } from 'commander';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadWorkflowFromFile, JsonFileStore, JsonWorkflowStore } from '@sensigo/realm';
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
  .action(
    async (opts: {
      workflow?: string;
      runId?: string;
      params: string;
      provider?: string;
      model?: string;
      baseUrl?: string;
      providerModule?: string;
      register?: boolean;
      extensionsModule?: string;
      project?: string;
      mintWriterNonce?: boolean;
      schemaRetries: number;
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
        if (opts.providerModule !== undefined) {
          if (
            opts.provider !== undefined ||
            opts.model !== undefined ||
            opts.baseUrl !== undefined
          ) {
            console.error(
              'Error: --provider-module cannot be combined with --provider, --model, or --base-url',
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
        } else {
          provider = await resolveProvider(
            opts.provider as ProviderName | undefined,
            opts.model,
            opts.baseUrl,
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
              registry: loaded.registry,
              traceBufferStore,
              // issue #197 PR-2: default OFF; the strict-flip (REALM_REQUIRE_WRITER_NONCE) force-
              // enables minting even without the flag — resolved once in run-agent.ts's loop.
              mintWriterNonce: opts.mintWriterNonce === true,
              // issue #217: default 2, threaded exactly like mintWriterNonce above. Commander
              // always supplies a value (the option's own default), so this is never undefined.
              schemaRetries: opts.schemaRetries,
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
          const loaded = await loadProjectExtensions(definition, extensionOpts);

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
              registry: loaded.registry,
              traceBufferStore,
              // issue #197 PR-2: default OFF; the strict-flip (REALM_REQUIRE_WRITER_NONCE) force-
              // enables minting even without the flag — resolved once in run-agent.ts's loop.
              mintWriterNonce: opts.mintWriterNonce === true,
              // issue #217: default 2, threaded exactly like mintWriterNonce above. Commander
              // always supplies a value (the option's own default), so this is never undefined.
              schemaRetries: opts.schemaRetries,
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
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    },
  );
