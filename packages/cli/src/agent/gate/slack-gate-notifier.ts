// slack-gate-notifier.ts — Slack gate notification logic.
// Owns all Slack-specific gate notification: formatting, posting, reminder timers,
// and bidirectional resolution via Events API or Socket Mode.
// Internal to the CLI package — not exported from the package's public index.
import {
  submitHumanResponse,
  type RunStore,
  type WorkflowDefinition,
  type PendingGate,
} from '@sensigo/realm';
import type { LlmProvider } from '../providers/llm-provider.js';
import { startSlackGateServer } from './slack-gate-server.js';
import { connectSocketMode } from './slack-socket-client.js';

/**
 * Formats a gate preview object as human-readable Slack mrkdwn text.
 * Uses `headline` and `message` fields when present; falls back to indented JSON.
 * Exported for testing.
 */
export function formatGatePreviewForSlack(preview: Record<string, unknown>): string {
  const headline = typeof preview['headline'] === 'string' ? preview['headline'] : undefined;
  const message = typeof preview['message'] === 'string' ? preview['message'] : undefined;

  if (headline !== undefined || message !== undefined) {
    const parts: string[] = [];
    if (headline !== undefined) parts.push(`*${headline}*`);
    if (message !== undefined) parts.push(message);
    return parts.join('\n\n');
  }

  if (Object.keys(preview).length === 0) {
    return '_(no preview)_';
  }

  return '```\n' + JSON.stringify(preview, null, 2) + '\n```';
}

/**
 * POSTs a gate-waiting notification to a Slack Incoming Webhook.
 * Failure is warned but does not abort the workflow run.
 * Exported for testing.
 */
export async function postGateNotificationToSlack(
  webhookUrl: string,
  gate: PendingGate,
  runId: string,
): Promise<void> {
  const ownerLine = gate.owner !== undefined ? `\n*Owner:* ${gate.owner}` : '';
  const previewText = gate.resolved_message ?? formatGatePreviewForSlack(gate.preview);
  const gateId = gate.gate_id;
  const cmdLines = gate.choices
    .map((c) => `realm run respond ${runId} --gate ${gateId} --choice ${c}`)
    .join('\n');
  const blockText =
    `*Gate:* \`${gate.step_name}\`${ownerLine}\n\n${previewText}\n\n---\n` +
    `*Gate requires a terminal response — open a terminal and run:*\n\`\`\`${cmdLines}\`\`\``;
  const body = {
    text: '⏸ Workflow gate waiting for approval',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: blockText,
        },
      },
    ],
  };
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.warn(
      `  ⚠  Slack notification failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Posts a gate notification to Slack via chat.postMessage (bot token path).
 * Returns the message ts for use as a thread anchor, or undefined on failure.
 * Exported for testing.
 */
export async function postGateViaApi(
  botToken: string,
  channelId: string,
  gate: PendingGate,
  runId: string,
): Promise<string | undefined> {
  const ownerLine = gate.owner !== undefined ? `\n*Owner:* ${gate.owner}` : '';
  const previewText = gate.resolved_message ?? formatGatePreviewForSlack(gate.preview);
  const choiceList = gate.choices.map((c) => `\`${c}\``).join(' or ');
  const gateId = gate.gate_id;
  const cmdLines = gate.choices
    .map((c) => `realm run respond ${runId} --gate ${gateId} --choice ${c}`)
    .join('\n');
  const blockText =
    `*Gate:* \`${gate.step_name}\`${ownerLine}\n\n${previewText}\n\n---\n` +
    `*Reply in this thread with ${choiceList} to resolve, or run:*\n\`\`\`${cmdLines}\`\`\``;
  try {
    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify({
        channel: channelId,
        text: '⏸ Workflow gate waiting for approval',
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: blockText } }],
      }),
    });
    const data = (await response.json()) as { ok: boolean; ts?: string };
    return data.ok ? data.ts : undefined;
  } catch (err) {
    console.warn(
      `Gate API notification failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

/**
 * Posts a reply to an existing Slack thread via chat.postMessage.
 * Failures are warned but not thrown — best-effort.
 * Exported for testing.
 */
export async function postSlackReply(
  botToken: string,
  channelId: string,
  threadTs: string,
  text: string,
): Promise<void> {
  try {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify({ channel: channelId, thread_ts: threadTs, text }),
    });
  } catch (err) {
    console.warn(`Slack reply failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Starts reminder and escalation timers for an open gate.
 * Returns a cleanup function that clears both timers — must be called when the gate resolves.
 * Exported for testing.
 */
export function startGateReminderTimers(
  botToken: string,
  channelId: string,
  threadTs: string,
  gate: PendingGate,
  reminderIntervalMs: number,
  escalationThresholdMs: number,
): () => void {
  const reminderTimer = setTimeout(() => {
    postSlackReply(
      botToken,
      channelId,
      threadTs,
      `⏰ Reminder: gate \`${gate.step_name}\` is still waiting for a response.`,
    ).catch((err) => {
      console.warn(`Reminder post failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, reminderIntervalMs);

  const escalationTimer = setTimeout(() => {
    const elapsedMin = Math.round((Date.now() - new Date(gate.opened_at).getTime()) / 60_000);
    const mention = gate.owner !== undefined ? `${gate.owner} — ` : '';
    const text = `${mention}gate \`${gate.step_name}\` has been open for ${elapsedMin} minutes. Please respond.`;
    postSlackReply(botToken, channelId, threadTs, text).catch((err) => {
      console.warn(`Escalation post failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, escalationThresholdMs);

  return () => {
    clearTimeout(reminderTimer);
    clearTimeout(escalationTimer);
  };
}

/** Parameters for the bidirectional gate handler. Exported for testing. */
export interface BidirectionalGateParams {
  gate: PendingGate;
  runId: string;
  definition: WorkflowDefinition;
  store: RunStore;
  provider: LlmProvider;
  slackBotToken: string;
  slackChannelId: string;
  gateThreadTs: string | undefined;
  slackSigningSecret?: string;
  slackEventsPort: number;
  /** App-level token (xapp-…) — enables Socket Mode when set (manifest: notifiers.slack_gate.app_token). */
  slackAppToken?: string;
  gateReminderIntervalMs: number;
  gateEscalationThresholdMs: number;
  pollIntervalMs: number;
}

/**
 * Handles a gate using Slack bidirectional resolution:
 * - Events API (when signing secret is present) or Socket Mode (when app token is present)
 * - LLM intent interpretation of Slack replies
 * - Reminder and escalation timers
 * - Falls back to store polling for terminal-command gate resolution
 * Exported for testing.
 */
export async function handleBidirectionalGate(params: BidirectionalGateParams): Promise<void> {
  const {
    gate,
    runId,
    definition,
    store,
    provider: _provider,
    slackBotToken,
    slackChannelId,
    gateThreadTs,
    slackSigningSecret,
    slackEventsPort,
    slackAppToken,
    gateReminderIntervalMs,
    gateEscalationThresholdMs,
    pollIntervalMs,
  } = params;

  let clarificationCount = 0;
  const abortController = new AbortController();

  const processCandidate = async (text: string): Promise<void> => {
    if (abortController.signal.aborted) return;

    // Gate choices must be exact (case-insensitive). No LLM interpretation — gate responses
    // are irreversible writes and must reflect unambiguous intent.
    const normalised = text.trim().toLowerCase();
    const exactMatch = gate.choices.find((c) => c.toLowerCase() === normalised);

    if (exactMatch !== undefined) {
      try {
        await submitHumanResponse(store, definition, {
          runId,
          gateId: gate.gate_id,
          choice: exactMatch,
        });
        if (gateThreadTs !== undefined) {
          const confirmationText =
            gate.resolution_messages?.[exactMatch] ??
            `✅ Gate resolved: \`${exactMatch}\` — run continuing.`;
          await postSlackReply(slackBotToken, slackChannelId, gateThreadTs, confirmationText);
        }
        abortController.abort();
      } catch (err) {
        console.warn(
          `Gate response submission failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else if (clarificationCount < 2 && gateThreadTs !== undefined) {
      clarificationCount++;
      await postSlackReply(
        slackBotToken,
        slackChannelId,
        gateThreadTs,
        `Please reply with one of: ${gate.choices.join(', ')}`,
      );
    }
  };

  // Set up candidate intake — Socket Mode (preferred), Events API, or none.
  // Dedup set prevents duplicate onEvent calls. Socket Mode (preferred) and Events API both
  // have at-least-once delivery — the same event can arrive more than once.
  const seenEventIds = new Set<string>();
  let serverHandle: { close(): void } | undefined;
  if (slackAppToken !== undefined && gateThreadTs !== undefined) {
    // Mode 2 — Socket Mode (WebSocket push, no public URL required)
    serverHandle = connectSocketMode({
      appToken: slackAppToken,
      threadTs: gateThreadTs,
      onEvent: (event) => {
        if (seenEventIds.has(event.event_id)) return;
        seenEventIds.add(event.event_id);
        processCandidate(event.text).catch((err) => {
          console.warn(
            `Candidate processing failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      },
      signal: abortController.signal,
    });
  } else if (slackSigningSecret !== undefined && gateThreadTs !== undefined) {
    // Mode 3 — Events API (HTTP push, requires public URL)
    serverHandle = startSlackGateServer({
      port: slackEventsPort,
      signingSecret: slackSigningSecret,
      onEvent: (event) => {
        if (seenEventIds.has(event.event_id)) return;
        seenEventIds.add(event.event_id);
        if (event.thread_ts !== gateThreadTs) return;
        processCandidate(event.text).catch((err) => {
          console.warn(
            `Candidate processing failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      },
    });
  } else if (gateThreadTs !== undefined) {
    // Gate notification posted but no listener configured.
    console.log(
      '  ℹ  Gate notification posted. Configure app_token (Socket Mode) or signing_secret + events_port (Events API) under notifiers.slack_gate in realm.yaml to resolve via Slack. Using terminal command fallback.',
    );
  }

  // Notify when neither Events nor polling can be used — no thread anchor available.
  if (gateThreadTs === undefined) {
    console.log(
      '  ℹ  Bidirectional Slack resolution unavailable (no thread anchor). Use terminal command shown above.',
    );
  }

  // Start reminder/escalation timers if we have a thread anchor.
  const clearTimers =
    gateThreadTs !== undefined
      ? startGateReminderTimers(
          slackBotToken,
          slackChannelId,
          gateThreadTs,
          gate,
          gateReminderIntervalMs,
          gateEscalationThresholdMs,
        )
      : (): void => {};

  try {
    // Poll the store as the unified done-detector — resolves when candidate processor
    // calls submitHumanResponse OR when the terminal command is used.
    await pollUntilGateResolved(store, runId, gate.gate_id, pollIntervalMs, abortController.signal);
  } finally {
    abortController.abort();
    clearTimers();
    serverHandle?.close();
  }
}

/** Polls the store until the gate is resolved or the run reaches a terminal state. */
async function pollUntilGateResolved(
  store: RunStore,
  runId: string,
  gateId: string,
  intervalMs: number,
  signal?: AbortSignal,
): Promise<void> {
  console.log('   Waiting for approval...');
  for (;;) {
    if (signal?.aborted) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      if (signal !== undefined) {
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      }
    });
    if (signal?.aborted) break;
    const run = await store.get(runId);
    if (run.terminal_state) break;
    if (run.pending_gate === undefined || run.pending_gate.gate_id !== gateId) break;
  }
}

export interface SlackGateHandlerConfig {
  store: RunStore;
  definition: WorkflowDefinition;
  /** Required by handleBidirectionalGate for LLM intent parsing. */
  provider: LlmProvider;
  webhookUrl?: string;
  botToken?: string;
  channelId?: string;
  signingSecret?: string;
  eventsPort?: number;
  appToken?: string;
  reminderIntervalMs?: number;
  escalationThresholdMs?: number;
  pollIntervalMs?: number;
}

/**
 * Creates a gate handler that notifies via Slack and waits for resolution.
 * Returns a function typed (runId, gate) => Promise<void>.
 */
export function createSlackGateHandler(
  config: SlackGateHandlerConfig,
): (runId: string, gate: PendingGate) => Promise<void> {
  return async (runId, gate) => {
    // Bidirectional path (bot token + channel).
    if (config.botToken !== undefined && config.channelId !== undefined) {
      const gateThreadTs = await postGateViaApi(config.botToken, config.channelId, gate, runId);
      await handleBidirectionalGate({
        gate,
        runId,
        definition: config.definition,
        store: config.store,
        provider: config.provider,
        slackBotToken: config.botToken,
        slackChannelId: config.channelId,
        gateThreadTs,
        ...(config.signingSecret !== undefined ? { slackSigningSecret: config.signingSecret } : {}),
        slackEventsPort: config.eventsPort ?? 3100,
        ...(config.appToken !== undefined ? { slackAppToken: config.appToken } : {}),
        gateReminderIntervalMs: config.reminderIntervalMs ?? 600_000,
        gateEscalationThresholdMs: config.escalationThresholdMs ?? 1_800_000,
        pollIntervalMs: config.pollIntervalMs ?? 3000,
      });
    } else if (config.webhookUrl !== undefined) {
      // One-way webhook + inline poll loop (avoids circular dependency with run-agent.ts).
      await postGateNotificationToSlack(config.webhookUrl, gate, runId);
      console.log('   Waiting for approval...');
      const intervalMs = config.pollIntervalMs ?? 3000;
      for (;;) {
        await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
        const run = await config.store.get(runId);
        if (run.terminal_state) break;
        if (run.pending_gate === undefined || run.pending_gate.gate_id !== gate.gate_id) break;
      }
    }
  };
}
