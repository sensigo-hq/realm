// realm agent — autonomous CLI command that drives a workflow using an LLM provider.
// Core loop logic lives in packages/cli/src/agent/run-agent.ts for testability.
import { Command } from 'commander';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  loadWorkflowFromFile,
  JsonFileStore,
  JsonWorkflowStore,
  GitHubAdapter,
  SlackAdapter,
} from '@sensigo/realm';
import type { ExtensionRegistry, ExtensionManifest } from '@sensigo/realm';
import { LlmProvider, resolveProvider } from '../agent/providers/llm-provider.js';
import type { ProviderName } from '../agent/providers/llm-provider.js';
import { runAgent } from '../agent/run-agent.js';
import { resolveRunAttach } from '../agent/run-attach.js';
import { loadProjectExtensions } from '../extensions/load-project-extensions.js';
import { createSlackGateHandler } from '../agent/gate/slack-gate-notifier.js';
import type { SlackGateHandlerConfig } from '../agent/gate/slack-gate-notifier.js';
import {
  checkAdapterPrerequisites,
  formatPreflightError,
  checkSlackBidirectionalConfig,
} from '../agent/preflight.js';

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
    "Extensions module that REPLACES the workflow's declared 'extensions' modules (repair/override)",
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
        const extensionOpts =
          opts.extensionsModule !== undefined ? { overrideModule: opts.extensionsModule } : {};

        // Legacy env-gated built-ins — the legacy tier of the precedence chain
        // (defaults < legacy env-gated < declared extensions < --extensions-module):
        // applied only when the name was not claimed by an extensions module.
        const applyLegacyEnvAdapters = (
          registry: ExtensionRegistry,
          manifest: ExtensionManifest,
        ): void => {
          if (process.env['GITHUB_TOKEN'] !== undefined && !manifest.adapters.includes('github'))
            registry.register(
              'adapter',
              'github',
              new GitHubAdapter('github', { auth: { token: process.env['GITHUB_TOKEN'] } }),
            );
          if (
            process.env['SLACK_WEBHOOK_URL'] !== undefined &&
            !manifest.adapters.includes('slack')
          )
            registry.register(
              'adapter',
              'slack',
              new SlackAdapter('slack', { webhook_url: process.env['SLACK_WEBHOOK_URL'] }),
            );
        };

        let result: import('../agent/run-agent.js').AgentRunResult;

        if (opts.runId !== undefined) {
          // --run-id path: attach to existing run, load definition from store.
          // resolveRunAttach loads project extensions BEFORE the run is claimed and carries
          // the extensions_load_failed write / re-attach semantics.
          const { definition, registry, manifest } = await resolveRunAttach(
            opts.runId,
            { store, workflowStore },
            extensionOpts,
          );
          applyLegacyEnvAdapters(registry, manifest);

          const hasSlack =
            process.env['SLACK_BOT_TOKEN'] !== undefined ||
            process.env['SLACK_WEBHOOK_URL'] !== undefined;
          const slackConfig: SlackGateHandlerConfig = {
            store,
            definition,
            provider,
            ...(process.env['SLACK_WEBHOOK_URL'] !== undefined && {
              webhookUrl: process.env['SLACK_WEBHOOK_URL'],
            }),
            ...(process.env['SLACK_BOT_TOKEN'] !== undefined && {
              botToken: process.env['SLACK_BOT_TOKEN'],
            }),
            ...(process.env['SLACK_CHANNEL_ID'] !== undefined && {
              channelId: process.env['SLACK_CHANNEL_ID'],
            }),
            ...(process.env['SLACK_SIGNING_SECRET'] !== undefined && {
              signingSecret: process.env['SLACK_SIGNING_SECRET'],
            }),
            ...(process.env['SLACK_EVENTS_PORT'] !== undefined && {
              eventsPort: parseInt(process.env['SLACK_EVENTS_PORT'], 10),
            }),
            ...(process.env['SLACK_APP_TOKEN'] !== undefined && {
              appToken: process.env['SLACK_APP_TOKEN'],
            }),
            ...(process.env['SLACK_GATE_REMINDER_INTERVAL_MS'] !== undefined && {
              reminderIntervalMs: parseInt(process.env['SLACK_GATE_REMINDER_INTERVAL_MS'], 10),
            }),
            ...(process.env['SLACK_GATE_ESCALATION_THRESHOLD_MS'] !== undefined && {
              escalationThresholdMs: parseInt(
                process.env['SLACK_GATE_ESCALATION_THRESHOLD_MS'],
                10,
              ),
            }),
          };
          const gateHandler = hasSlack ? createSlackGateHandler(slackConfig) : undefined;

          result = await runAgent(
            { store, workflowStore, provider, registry, ...(gateHandler ? { gateHandler } : {}) },
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

          // Load project extensions BEFORE the run is created (fail-before-create).
          const { registry, manifest } = await loadProjectExtensions(definition, extensionOpts);
          applyLegacyEnvAdapters(registry, manifest);

          // Fail fast if required adapter env vars are missing.
          const preflightFindings = checkAdapterPrerequisites(definition);
          if (preflightFindings.length > 0) {
            console.error(formatPreflightError(preflightFindings));
            process.exit(1);
          }

          // Print advisory warnings for incomplete Slack bidirectional config.
          const slackWarnings = checkSlackBidirectionalConfig();
          for (const warning of slackWarnings) {
            console.warn(`  ⚠  ${warning.message}`);
          }

          const hasSlack2 =
            process.env['SLACK_BOT_TOKEN'] !== undefined ||
            process.env['SLACK_WEBHOOK_URL'] !== undefined;
          const slackConfig2: SlackGateHandlerConfig = {
            store,
            definition,
            provider,
            ...(process.env['SLACK_WEBHOOK_URL'] !== undefined && {
              webhookUrl: process.env['SLACK_WEBHOOK_URL'],
            }),
            ...(process.env['SLACK_BOT_TOKEN'] !== undefined && {
              botToken: process.env['SLACK_BOT_TOKEN'],
            }),
            ...(process.env['SLACK_CHANNEL_ID'] !== undefined && {
              channelId: process.env['SLACK_CHANNEL_ID'],
            }),
            ...(process.env['SLACK_SIGNING_SECRET'] !== undefined && {
              signingSecret: process.env['SLACK_SIGNING_SECRET'],
            }),
            ...(process.env['SLACK_EVENTS_PORT'] !== undefined && {
              eventsPort: parseInt(process.env['SLACK_EVENTS_PORT'], 10),
            }),
            ...(process.env['SLACK_APP_TOKEN'] !== undefined && {
              appToken: process.env['SLACK_APP_TOKEN'],
            }),
            ...(process.env['SLACK_GATE_REMINDER_INTERVAL_MS'] !== undefined && {
              reminderIntervalMs: parseInt(process.env['SLACK_GATE_REMINDER_INTERVAL_MS'], 10),
            }),
            ...(process.env['SLACK_GATE_ESCALATION_THRESHOLD_MS'] !== undefined && {
              escalationThresholdMs: parseInt(
                process.env['SLACK_GATE_ESCALATION_THRESHOLD_MS'],
                10,
              ),
            }),
          };
          const gateHandler2 = hasSlack2 ? createSlackGateHandler(slackConfig2) : undefined;

          result = await runAgent(
            {
              store,
              workflowStore,
              provider,
              registry,
              ...(gateHandler2 ? { gateHandler: gateHandler2 } : {}),
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
