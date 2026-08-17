// SlackAdapter — posts messages to a Slack channel via Incoming Webhooks.
import { WorkflowError } from '../types/workflow-error.js';
import { takeParam } from './adapter-utils.js';
import type { ServiceAdapter, ServiceResponse } from '../extensions/service-adapter.js';

export interface SlackAdapterConfig {
  webhook_url: string;
}

/**
 * SlackAdapter posts messages to a Slack channel via Incoming Webhooks.
 * Only the `create` method is supported; `fetch` and `update` throw WorkflowError.
 * Supported operations: 'post_message' — POSTs { text, blocks? } to the webhook URL.
 */
export class SlackAdapter implements ServiceAdapter {
  constructor(
    public readonly id: string,
    private readonly config: SlackAdapterConfig,
  ) {}

  async fetch(
    _operation: string,
    _params: Record<string, unknown>,
    _config: Record<string, unknown>,
    _signal?: AbortSignal,
  ): Promise<ServiceResponse> {
    throw new WorkflowError('SlackAdapter does not support fetch', {
      code: 'ADAPTER_OP_UNSUPPORTED',
      category: 'ENGINE',
      agentAction: 'report_to_user',
      retryable: false,
    });
  }

  async create(
    operation: string,
    params: Record<string, unknown>,
    _config: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ServiceResponse> {
    if (operation !== 'post_message') {
      throw new WorkflowError(`SlackAdapter: unsupported operation: ${operation}`, {
        code: 'ADAPTER_OP_UNSUPPORTED',
        category: 'ENGINE',
        agentAction: 'report_to_user',
        retryable: false,
      });
    }

    // issue #287: `text` is REQUIRED here — this was never a silent-drop site, and its
    // absent ⇒ throw contract is preserved exactly (same code, same `provide_input`, same
    // message). What changes is only the MISTYPED case, which now reports expected/found
    // through the shared helper instead of collapsing into "is required".
    const text = takeParam(params, 'text', 'string', { adapter: 'slack', operation });
    if (text === undefined) {
      throw new WorkflowError('SlackAdapter: text is required for post_message', {
        code: 'ADAPTER_VALIDATION_FAILED',
        category: 'ENGINE',
        agentAction: 'provide_input',
        retryable: false,
      });
    }

    const body: Record<string, unknown> = { text };
    if (params['blocks'] !== undefined) {
      body['blocks'] = params['blocks'];
    }

    let response: Response;
    try {
      response = await fetch(this.config.webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ?? null,
      });
    } catch (err) {
      // AbortError means the engine cancelled this request (e.g. step timeout) — standardized
      // to STEP_ABORTED to match every other network adapter (airtable/github/gorgias/http/
      // notion/parcelpanel/shopify). Any other fetch failure keeps the existing mapping.
      if (err instanceof Error && err.name === 'AbortError') {
        throw new WorkflowError('Adapter request aborted', {
          code: 'STEP_ABORTED',
          category: 'ENGINE',
          agentAction: 'report_to_user',
          retryable: false,
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new WorkflowError(`Slack webhook request failed: ${message}`, {
        code: 'ADAPTER_REQUEST_FAILED',
        category: 'ENGINE',
        agentAction: 'report_to_user',
        retryable: false,
      });
    }

    if (response.status !== 200) {
      throw new WorkflowError(`Slack webhook returned HTTP ${response.status}`, {
        code: 'ADAPTER_REQUEST_FAILED',
        category: 'ENGINE',
        agentAction: 'report_to_user',
        retryable: false,
      });
    }

    return { status: response.status, data: { ok: true } };
  }

  async update(
    _operation: string,
    _params: Record<string, unknown>,
    _config: Record<string, unknown>,
    _signal?: AbortSignal,
  ): Promise<ServiceResponse> {
    throw new WorkflowError('SlackAdapter does not support update', {
      code: 'ADAPTER_OP_UNSUPPORTED',
      category: 'ENGINE',
      agentAction: 'report_to_user',
      retryable: false,
    });
  }
}
