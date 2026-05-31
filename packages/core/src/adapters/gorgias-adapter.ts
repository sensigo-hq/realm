// GorgiasAdapter — communicates with the Gorgias REST API.
import { WorkflowError } from '../types/workflow-error.js';
import type { ServiceAdapter, ServiceResponse } from '../extensions/service-adapter.js';
import { parseRetryAfterHeader } from './adapter-utils.js';

/**
 * Configuration for GorgiasAdapter.
 */
export interface GorgiasAdapterConfig {
  /** Gorgias account subdomain — e.g. "acme" resolves to https://acme.gorgias.com/api */
  domain: string;
  auth: {
    type: 'basic';
    /** Combined credential string: "{email}:{api_key}" */
    token: string;
  };
  /** Override base URL — used in tests to point at a local mock server */
  base_url?: string;
}

/** Raw Gorgias message shape from the API. */
interface GorgiasMessage {
  id: number;
  from_agent: boolean;
  public: boolean;
  channel: string;
  body_text?: string | null;
  body_html?: string | null;
  created_datetime: string;
}

/** Normalized message shape returned by get_messages. */
interface NormalizedMessage {
  id: number;
  from_agent: boolean;
  public: boolean;
  channel: string;
  body: string;
  created_datetime: string;
}

/**
 * Intentionally minimal — strips tags and decodes five common HTML entities.
 * Sufficient for Gorgias plain-text note bodies.
 */
function stripHtmlTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .trim();
}

/**
 * GorgiasAdapter communicates with the Gorgias REST API.
 *
 * Supported operations:
 *   fetch('get_ticket', { ticket_id })                          — GET  /tickets/{ticket_id}
 *   fetch('get_messages', { ticket_id, limit? })               — GET  /messages?ticket_id={ticket_id}&...
 *   create('post_internal_note', { ticket_id, body_html })     — POST /tickets/{ticket_id}/messages
 */
export class GorgiasAdapter implements ServiceAdapter {
  readonly id: string;
  readonly defaultRetryAfterSeconds = 60;
  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(id: string, config: GorgiasAdapterConfig) {
    // Validate domain — parse and verify the hostname matches to reject values with
    // path segments or query strings (e.g. 'evil.com/api?q=').
    let domainValid = false;
    try {
      const testUrl = new URL(`https://${config.domain}.gorgias.com`);
      domainValid = testUrl.hostname === `${config.domain}.gorgias.com`;
    } catch {
      // URL constructor threw — invalid
    }
    if (!domainValid) {
      throw new Error('GorgiasAdapter: invalid domain');
    }

    this.id = id;
    this.baseUrl = config.base_url ?? `https://${config.domain}.gorgias.com/api`;
    this.authHeader = 'Basic ' + Buffer.from(config.auth.token).toString('base64');
  }

  private checkAborted(signal?: AbortSignal): void {
    if (signal?.aborted === true) {
      throw new WorkflowError('Adapter request aborted', {
        code: 'STEP_ABORTED',
        category: 'ENGINE',
        agentAction: 'report_to_user',
        retryable: false,
      });
    }
  }

  private buildHeaders(): Record<string, string> {
    return {
      Authorization: this.authHeader,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  private async executeRequest(
    method: 'GET' | 'POST',
    url: string,
    operation: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<ServiceResponse> {
    const fetchOptions: RequestInit =
      method === 'GET'
        ? { method, headers: this.buildHeaders(), signal: signal ?? null }
        : {
            method,
            headers: this.buildHeaders(),
            body: JSON.stringify(body),
            signal: signal ?? null,
          };

    let response: Response;
    try {
      response = await fetch(url, fetchOptions);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new WorkflowError('Adapter request aborted', {
          code: 'STEP_ABORTED',
          category: 'ENGINE',
          agentAction: 'report_to_user',
          retryable: false,
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new WorkflowError(message, {
        code: 'NETWORK_UNREACHABLE',
        category: 'NETWORK',
        agentAction: 'wait_for_human',
        retryable: true,
      });
    }

    if (!response.ok) {
      await this.throwHttpError(response, operation);
    }

    const json: unknown = await response.json();
    return { status: response.status, data: json };
  }

  private async throwHttpError(response: Response, operation: string): Promise<never> {
    // Read body as text first — avoids "body already consumed" if JSON.parse fails.
    const rawText = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(rawText);
    } catch {
      body = rawText;
    }

    const status = response.status;
    const details = { status, operation, body };

    if (status === 429) {
      const retryAfterFromHeader = parseRetryAfterHeader(response.headers.get('Retry-After'));
      throw new WorkflowError('Rate limited by Gorgias API', {
        code: 'SERVICE_RATE_LIMITED',
        category: 'SERVICE',
        agentAction: 'wait_and_proceed',
        retryable: true,
        ...(retryAfterFromHeader !== undefined ? { retry_after: retryAfterFromHeader } : {}),
        details,
      });
    }

    if (status === 401) {
      throw new WorkflowError('Gorgias authentication failed — check email and API key', {
        code: 'SERVICE_AUTH_FAILED',
        category: 'SERVICE',
        agentAction: 'stop',
        retryable: false,
        details,
      });
    }

    if (status === 403) {
      const message403 =
        operation === 'get_ticket'
          ? 'Account lacks permission to read Gorgias tickets'
          : operation === 'get_messages'
            ? 'Account lacks permission to read Gorgias ticket messages'
            : operation === 'post_internal_note'
              ? 'Account lacks permission to create Gorgias messages'
              : 'Account lacks permission for this Gorgias operation';
      throw new WorkflowError(message403, {
        code: 'SERVICE_HTTP_4XX',
        category: 'SERVICE',
        agentAction: 'stop',
        retryable: false,
        details,
      });
    }

    if (status === 404) {
      throw new WorkflowError('Gorgias resource not found', {
        code: 'SERVICE_HTTP_4XX',
        category: 'SERVICE',
        agentAction: 'stop',
        retryable: false,
        details,
      });
    }

    if (status >= 400 && status < 500) {
      throw new WorkflowError(`HTTP ${status}: ${response.statusText}`, {
        code: 'SERVICE_HTTP_4XX',
        category: 'SERVICE',
        agentAction: 'stop',
        retryable: false,
        details,
      });
    }

    // 5xx
    throw new WorkflowError(`Gorgias server error (HTTP ${status})`, {
      code: 'SERVICE_HTTP_5XX',
      category: 'SERVICE',
      agentAction: 'report_to_user',
      retryable: true,
      details,
    });
  }

  private validateTicketId(params: Record<string, unknown>): number {
    const ticketId = params['ticket_id'];
    if (typeof ticketId !== 'number' || !Number.isInteger(ticketId) || ticketId <= 0) {
      throw new WorkflowError('GorgiasAdapter: ticket_id must be a positive integer', {
        code: 'ADAPTER_VALIDATION_FAILED',
        category: 'ENGINE',
        agentAction: 'provide_input',
        retryable: false,
        details: { received: ticketId },
      });
    }
    return ticketId;
  }

  private normalize(msg: GorgiasMessage): NormalizedMessage {
    const body = msg.body_text ?? stripHtmlTags(msg.body_html ?? '') ?? '';
    return {
      id: msg.id,
      from_agent: msg.from_agent,
      public: msg.public,
      channel: msg.channel,
      body,
      created_datetime: msg.created_datetime,
    };
  }

  async fetch(
    operation: string,
    params: Record<string, unknown>,
    _config: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ServiceResponse> {
    // config.auth is ignored — auth is set at construction time

    if (operation === 'get_ticket') {
      const ticketId = this.validateTicketId(params);
      this.checkAborted(signal);
      return this.executeRequest(
        'GET',
        `${this.baseUrl}/tickets/${ticketId}`,
        'get_ticket',
        undefined,
        signal,
      );
    }

    if (operation === 'get_messages') {
      const ticketId = this.validateTicketId(params);
      const userLimit =
        typeof params['limit'] === 'number' && params['limit'] > 0 ? params['limit'] : 30;
      const effectiveLimit = Math.min(userLimit, 200);
      const PAGE_SIZE = 100;

      const accumulated: NormalizedMessage[] = [];
      let cursor: string | undefined = undefined;
      let truncated = false;

      for (;;) {
        this.checkAborted(signal);

        const url =
          `${this.baseUrl}/messages?ticket_id=${ticketId}&limit=${PAGE_SIZE}&order_by=created_datetime:asc` +
          (cursor !== undefined ? `&cursor=${cursor}` : '');

        const response = await this.executeRequest('GET', url, 'get_messages', undefined, signal);
        const json = response.data as {
          data: GorgiasMessage[];
          meta: { next_cursor?: string | null };
        };

        for (const message of json.data) {
          if (accumulated.length < effectiveLimit) {
            accumulated.push(this.normalize(message));
          }
        }

        const nextCursor = json.meta.next_cursor ?? null;
        if (nextCursor === null) {
          truncated = false;
          break;
        }
        if (accumulated.length >= effectiveLimit) {
          truncated = true;
          break;
        }
        cursor = nextCursor;
      }

      return { status: 200, data: { messages: accumulated, truncated } };
    }

    throw new WorkflowError(`GorgiasAdapter: unsupported fetch operation '${operation}'`, {
      code: 'ADAPTER_OP_UNSUPPORTED',
      category: 'ENGINE',
      agentAction: 'report_to_user',
      retryable: false,
      details: { operation },
    });
  }

  async create(
    operation: string,
    params: Record<string, unknown>,
    _config: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ServiceResponse> {
    // config.auth is ignored — auth is set at construction time

    if (operation === 'post_internal_note') {
      const ticketId = this.validateTicketId(params);

      if (typeof params['body_html'] !== 'string') {
        throw new WorkflowError('GorgiasAdapter: body_html must be a string', {
          code: 'ADAPTER_VALIDATION_FAILED',
          category: 'ENGINE',
          agentAction: 'provide_input',
          retryable: false,
          details: { received: params['body_html'] },
        });
      }

      this.checkAborted(signal);

      const requestBody = {
        channel: 'note',
        public: false,
        from_agent: true,
        body_html: params['body_html'],
      };

      const response = await this.executeRequest(
        'POST',
        `${this.baseUrl}/tickets/${ticketId}/messages`,
        'post_internal_note',
        requestBody,
        signal,
      );

      const json = response.data as { id?: unknown };
      const noteId = json.id;
      if (typeof noteId !== 'number') {
        throw new WorkflowError(
          'GorgiasAdapter: unexpected response shape from post_internal_note',
          {
            code: 'SERVICE_RESPONSE_INVALID',
            category: 'SERVICE',
            agentAction: 'stop',
            retryable: false,
            details: { received: json },
          },
        );
      }

      return { status: 201, data: { ok: true, note_id: noteId } };
    }

    throw new WorkflowError(`GorgiasAdapter: unsupported create operation '${operation}'`, {
      code: 'ADAPTER_OP_UNSUPPORTED',
      category: 'ENGINE',
      agentAction: 'report_to_user',
      retryable: false,
      details: { operation },
    });
  }

  async update(
    operation: string,
    _params: Record<string, unknown>,
    _config: Record<string, unknown>,
    _signal?: AbortSignal,
  ): Promise<ServiceResponse> {
    throw new WorkflowError(`GorgiasAdapter: update is not supported (operation: '${operation}')`, {
      code: 'ADAPTER_OP_UNSUPPORTED',
      category: 'ENGINE',
      agentAction: 'report_to_user',
      retryable: false,
      details: { operation },
    });
  }
}
