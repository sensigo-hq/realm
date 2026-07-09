// GorgiasAdapter — communicates with the Gorgias REST API.
import { WorkflowError } from '../types/workflow-error.js';
import type { ServiceAdapter, ServiceResponse } from '../extensions/service-adapter.js';
import { parseRetryAfterHeader, redactErrorBody } from './adapter-utils.js';

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
  uri?: string | null;
  message_id?: string | null;
  ticket_id?: number | null;
  external_id?: string | null;
  public: boolean;
  channel: string;
  via?: string | null;
  source?: unknown;
  sender?: {
    id?: number | null;
    email?: string | null;
    name?: string | null;
    firstname?: string | null;
    lastname?: string | null;
    meta?: Record<string, unknown> | null;
  } | null;
  receiver?: {
    id?: number | null;
    email?: string | null;
    name?: string | null;
  } | null;
  from_agent: boolean;
  subject?: string | null;
  body_text?: string | null;
  body_html?: string | null;
  stripped_text?: string | null;
  stripped_html?: string | null;
  stripped_signature?: string | null;
  headers?: unknown;
  attachments?: unknown[];
  actions?: unknown[];
  macros?: unknown[];
  meta?: unknown;
  created_datetime: string;
  processed_datetime?: string | null;
  sent_datetime?: string | null;
  failed_datetime?: string | null;
  deleted_datetime?: string | null;
  opened_datetime?: string | null;
  last_sending_error?: unknown;
  is_retriable?: boolean | null;
  imported?: boolean | null;
  auth_customer_identity?: unknown;
  integration_id?: number | null;
  intents?: unknown[];
  rule_id?: number | null;
  replied_by?: unknown | null;
  replied_to?: unknown | null;
  [key: string]: unknown;
}

/**
 * GorgiasAdapter communicates with the Gorgias REST API.
 *
 * Supported operations:
 *   fetch('get_ticket',       { ticket_id })                         — GET  /tickets/{id}
 *   fetch('list_tickets',     { order_by?, cursor?, limit?, ... })   — GET  /tickets
 *   fetch('get_messages',     { ticket_id?, limit?, order_by? })     — GET /tickets/{id}/messages (per-ticket) | GET /messages (global scan when ticket_id omitted)
 *   fetch('get_customer',     { customer_id })                       — GET  /customers/{id}
 *   fetch('list_customers',   { order_by?, cursor?, limit?, ... })   — GET  /customers
 *   create('create_message',  { ticket_id, ...messageFields })       — POST /tickets/{id}/messages
 *   create('create_ticket',   { messages, ...ticketFields })         — POST /tickets
 *   create('create_customer', { channels, ...customerFields })       — POST /customers
 *   update('update_ticket',   { ticket_id, ...ticketFields })        — PUT  /tickets/{id}
 *   update('update_customer', { customer_id, ...customerFields })    — PUT  /customers/{id}
 *
 * list_tickets and list_customers return a single page; pass cursor from response meta
 * to retrieve subsequent pages. Scalar params (string | number | boolean) are forwarded
 * as query params. Non-scalar values (arrays, objects) are silently skipped.
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
    method: 'GET' | 'POST' | 'PUT',
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
    const details = { status, operation, body: redactErrorBody(body) };

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
      throw new WorkflowError(`Account lacks permission for Gorgias operation '${operation}'`, {
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

  private validateCustomerId(params: Record<string, unknown>): number {
    const customerId = params['customer_id'];
    if (typeof customerId !== 'number' || !Number.isInteger(customerId) || customerId <= 0) {
      throw new WorkflowError('GorgiasAdapter: customer_id must be a positive integer', {
        code: 'ADAPTER_VALIDATION_FAILED',
        category: 'ENGINE',
        agentAction: 'provide_input',
        retryable: false,
        details: { received: customerId },
      });
    }
    return customerId;
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
      const ticketId = params['ticket_id'] !== undefined ? this.validateTicketId(params) : null;
      const PAGE_SIZE = 100;
      // A no-limit per-ticket fetch defaults to the WHOLE thread, guarded by PER_TICKET_DEFAULT against
      // a pathological thread. An explicit caller `limit` is AUTHORITATIVE and honored as-is (the caller
      // owns the size/cost tradeoff) — the guard applies ONLY when no limit is given.
      const PER_TICKET_DEFAULT = 500; // no-limit default for a per-ticket fetch (safety guard, not a cap)
      const GLOBAL_SCAN_DEFAULT = 30; // ticket_id omitted → unbounded corpus; keep a modest default
      const explicitLimit =
        typeof params['limit'] === 'number' && params['limit'] > 0 ? params['limit'] : undefined;
      const effectiveLimit =
        explicitLimit ?? (ticketId !== null ? PER_TICKET_DEFAULT : GLOBAL_SCAN_DEFAULT);

      const orderBy = typeof params['order_by'] === 'string' ? params['order_by'] : undefined;
      const stableParts: string[] = [`limit=${PAGE_SIZE}`];
      if (orderBy !== undefined) stableParts.push(`order_by=${encodeURIComponent(orderBy)}`);

      const accumulated: GorgiasMessage[] = [];
      let cursor: string | undefined = undefined;
      // INVARIANT: truncated === true iff at least one message the API would have returned for
      // this request was NOT included in `messages` — i.e. we stopped because of effectiveLimit,
      // never merely because the API ran out. (A1 fix: the prior version checked next_cursor===null
      // FIRST and unconditionally set truncated: false there, so a single over-limit page with no
      // next page silently dropped the surplus while reporting success.)
      let truncated = false;

      for (;;) {
        this.checkAborted(signal);

        const urlParts = cursor !== undefined ? [...stableParts, `cursor=${cursor}`] : stableParts;
        // Per-ticket endpoint when a ticket_id is supplied — the flat /messages?ticket_id= filter
        // is inconsistent (returns 0, 1, or all messages for the same request; live evidence:
        // ticket 71355453 → 0 via the flat filter vs 4 via the per-ticket path, same moment).
        // Retained for the global-scan case (ticketId === null), where there is no id to path on.
        const messagesPath = ticketId !== null ? `/tickets/${ticketId}/messages` : `/messages`;
        const url = `${this.baseUrl}${messagesPath}?${urlParts.join('&')}`;

        const response = await this.executeRequest('GET', url, 'get_messages', undefined, signal);
        const json = response.data as {
          data: GorgiasMessage[];
          meta: { next_cursor?: string | null };
        };

        for (const message of json.data) {
          if (accumulated.length < effectiveLimit) {
            accumulated.push(message);
          } else {
            truncated = true; // a message we had no room for → the result is incomplete
          }
        }

        const nextCursor = json.meta.next_cursor ?? null;
        if (accumulated.length >= effectiveLimit) {
          if (nextCursor !== null) truncated = true; // more pages remain past the limit
          break;
        }
        if (nextCursor === null) break; // API exhausted with room to spare — nothing dropped
        cursor = nextCursor;
      }

      return { status: 200, data: { messages: accumulated, truncated } };
    }

    if (operation === 'list_tickets') {
      this.checkAborted(signal);
      const queryParts: string[] = [];
      for (const [key, value] of Object.entries(params)) {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          queryParts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
        }
      }
      const queryString = queryParts.length > 0 ? `?${queryParts.join('&')}` : '';
      return this.executeRequest(
        'GET',
        `${this.baseUrl}/tickets${queryString}`,
        'list_tickets',
        undefined,
        signal,
      );
    }

    if (operation === 'get_customer') {
      const customerId = this.validateCustomerId(params);
      this.checkAborted(signal);
      return this.executeRequest(
        'GET',
        `${this.baseUrl}/customers/${customerId}`,
        'get_customer',
        undefined,
        signal,
      );
    }

    if (operation === 'list_customers') {
      this.checkAborted(signal);
      const queryParts: string[] = [];
      for (const [key, value] of Object.entries(params)) {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          queryParts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
        }
      }
      const queryString = queryParts.length > 0 ? `?${queryParts.join('&')}` : '';
      return this.executeRequest(
        'GET',
        `${this.baseUrl}/customers${queryString}`,
        'list_customers',
        undefined,
        signal,
      );
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

    if (operation === 'create_message') {
      const ticketId = this.validateTicketId(params);

      const { ticket_id: _tid, ...messageBody } = params;

      this.checkAborted(signal);

      return this.executeRequest(
        'POST',
        `${this.baseUrl}/tickets/${ticketId}/messages`,
        'create_message',
        messageBody,
        signal,
      );
    }

    if (operation === 'create_ticket') {
      this.checkAborted(signal);
      return this.executeRequest(
        'POST',
        `${this.baseUrl}/tickets`,
        'create_ticket',
        params,
        signal,
      );
    }

    if (operation === 'create_customer') {
      this.checkAborted(signal);
      return this.executeRequest(
        'POST',
        `${this.baseUrl}/customers`,
        'create_customer',
        params,
        signal,
      );
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
    params: Record<string, unknown>,
    _config: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ServiceResponse> {
    // config.auth is ignored — auth is set at construction time

    if (operation === 'update_ticket') {
      const ticketId = this.validateTicketId(params);
      const { ticket_id: _tid, ...ticketBody } = params;
      this.checkAborted(signal);
      return this.executeRequest(
        'PUT',
        `${this.baseUrl}/tickets/${ticketId}`,
        'update_ticket',
        ticketBody,
        signal,
      );
    }

    if (operation === 'update_customer') {
      const customerId = this.validateCustomerId(params);
      const { customer_id: _cid, ...customerBody } = params;
      this.checkAborted(signal);
      return this.executeRequest(
        'PUT',
        `${this.baseUrl}/customers/${customerId}`,
        'update_customer',
        customerBody,
        signal,
      );
    }

    throw new WorkflowError(`GorgiasAdapter: unsupported update operation '${operation}'`, {
      code: 'ADAPTER_OP_UNSUPPORTED',
      category: 'ENGINE',
      agentAction: 'report_to_user',
      retryable: false,
      details: { operation },
    });
  }
}
