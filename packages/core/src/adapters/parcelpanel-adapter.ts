// ParcelPanelAdapter — communicates with the ParcelPanel / ParcelWILL Shopify tracking API v2.
import { WorkflowError } from '../types/workflow-error.js';
import type { ServiceAdapter, ServiceResponse } from '../extensions/service-adapter.js';
import { parseRetryAfterHeader } from './adapter-utils.js';

const PARCELPANEL_DEFAULT_BASE_URL = 'https://open.parcelwill.com';
// Previous domain https://open.parcelpanel.com deprecated as of 2026-02-11.
// Override base_url in ParcelPanelAdapterConfig for tests.

/**
 * Configuration for ParcelPanelAdapter.
 *
 * Uses a flat Record<string, string> for the stores map (unlike ShopifyAdapter's nested
 * object) because ParcelPanel has exactly one credential per store — an API key. The shape
 * intentionally diverges from ShopifyAdapter's nested form; do not "fix" this to match.
 */
export interface ParcelPanelAdapterConfig {
  /**
   * Per-store routing map. Keys are store identifiers (e.g. 'ellegems', 'fleur').
   * Values are the ParcelPanel API keys for those stores. At least one entry required.
   */
  stores: Record<string, string>;
  /**
   * Override the base URL for tests (replaces https://open.parcelwill.com).
   * Trailing slash is stripped.
   */
  base_url?: string;
}

/** Raw shipment shape from the ParcelPanel API. */
export interface ParcelPanelShipment {
  status?: string | null;
  status_label?: string | null;
  tracking_number?: string | null;
  carrier?: { name?: string | null; code?: string | null } | null;
  [key: string]: unknown;
}

/** Raw order body shape from the ParcelPanel API. */
export interface ParcelPanelOrderBody {
  order?: {
    order_id?: number | null;
    order_number?: string | null;
    tracking_link?: string | null;
    shipments?: ParcelPanelShipment[];
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

/**
 * ParcelPanelAdapter communicates with the ParcelPanel / ParcelWILL tracking API v2.
 *
 * Supported operations:
 *   fetch('get_tracking', { store, order_number })   — GET /api/v2/tracking/order?order_number={n}
 *
 * order_number normalisation: leading whitespace is trimmed and a leading '#' is stripped before
 * the request is sent. Shopify formats order numbers as '#1030'; ParcelPanel expects '1030'.
 * Pass either format — the adapter handles both correctly.
 */
export class ParcelPanelAdapter implements ServiceAdapter {
  readonly id: string;
  readonly defaultRetryAfterSeconds = 60;
  private readonly baseUrl: string;
  private readonly storesMap: Map<string, string>;

  constructor(id: string, config: ParcelPanelAdapterConfig) {
    const entries = Object.entries(config.stores);

    if (entries.length === 0) {
      throw new Error('ParcelPanelAdapter: stores must not be empty');
    }

    for (const [key, apiKey] of entries) {
      if (key === '') {
        throw new Error('ParcelPanelAdapter: store key must not be an empty string');
      }
      if (apiKey === '') {
        throw new Error(`ParcelPanelAdapter: api_key must not be empty for store "${key}"`);
      }
    }

    this.id = id;
    this.baseUrl = config.base_url?.replace(/\/$/, '') ?? PARCELPANEL_DEFAULT_BASE_URL;
    this.storesMap = new Map(entries);
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

  private buildHeaders(apiKey: string): Record<string, string> {
    return {
      'x-parcelpanel-api-key': apiKey,
      Accept: 'application/json',
    };
  }

  private async executeRequest(
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    operation: string,
    apiKey: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<ServiceResponse> {
    this.checkAborted(signal);
    const fetchOptions: RequestInit =
      method === 'GET'
        ? { method, headers: this.buildHeaders(apiKey), signal: signal ?? null }
        : {
            method,
            headers: { ...this.buildHeaders(apiKey), 'Content-Type': 'application/json' },
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

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new WorkflowError('ParcelPanelAdapter: failed to parse response body', {
        code: 'SERVICE_RESPONSE_INVALID',
        category: 'SERVICE',
        agentAction: 'report_to_user',
        retryable: false,
      });
    }
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
      throw new WorkflowError('Rate limited by ParcelPanel API', {
        code: 'SERVICE_RATE_LIMITED',
        category: 'SERVICE',
        agentAction: 'wait_and_proceed',
        retryable: true,
        ...(retryAfterFromHeader !== undefined ? { retry_after: retryAfterFromHeader } : {}),
        details,
      });
    }

    if (status === 401) {
      throw new WorkflowError('ParcelPanel authentication failed — check API key', {
        code: 'SERVICE_AUTH_FAILED',
        category: 'SERVICE',
        agentAction: 'stop',
        retryable: false,
        details,
      });
    }

    if (status === 403) {
      throw new WorkflowError(`Account lacks permission for ParcelPanel operation '${operation}'`, {
        code: 'SERVICE_HTTP_4XX',
        category: 'SERVICE',
        agentAction: 'stop',
        retryable: false,
        details,
      });
    }

    if (status === 404) {
      throw new WorkflowError('ParcelPanel: order not found', {
        code: 'SERVICE_NOT_FOUND',
        category: 'SERVICE',
        agentAction: 'provide_input',
        retryable: false,
        details,
      });
    }

    if (status >= 500) {
      throw new WorkflowError(`ParcelPanel server error (HTTP ${status})`, {
        code: 'SERVICE_HTTP_5XX',
        category: 'SERVICE',
        agentAction: 'report_to_user',
        retryable: true,
        details,
      });
    }

    // Any other 4xx (400, 403, 422, etc.)
    throw new WorkflowError(`HTTP ${status}: ${response.statusText}`, {
      code: 'SERVICE_HTTP_4XX',
      category: 'SERVICE',
      agentAction: 'stop',
      retryable: false,
      details,
    });
  }

  async fetch(
    operation: string,
    params: Record<string, unknown>,
    _config: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ServiceResponse> {
    if (operation === 'get_tracking') {
      // Validate store param
      const store = params['store'];
      if (typeof store !== 'string' || store === '') {
        throw new WorkflowError('ParcelPanelAdapter: store param must be a non-empty string', {
          code: 'ADAPTER_VALIDATION_FAILED',
          category: 'ENGINE',
          agentAction: 'provide_input',
          retryable: false,
        });
      }
      const apiKey = this.storesMap.get(store);
      if (apiKey === undefined) {
        throw new WorkflowError(`ParcelPanelAdapter: unknown store "${store}"`, {
          code: 'ADAPTER_VALIDATION_FAILED',
          category: 'ENGINE',
          agentAction: 'provide_input',
          retryable: false,
          details: { store },
        });
      }

      // Validate order_number param
      const rawOrderNumber = params['order_number'];
      if (typeof rawOrderNumber !== 'string' || rawOrderNumber === '') {
        throw new WorkflowError(
          'ParcelPanelAdapter: order_number param must be a non-empty string',
          {
            code: 'ADAPTER_VALIDATION_FAILED',
            category: 'ENGINE',
            agentAction: 'provide_input',
            retryable: false,
          },
        );
      }

      // Normalise order_number: trim whitespace then strip leading '#'.
      // Shopify formats order numbers as '#1030'; ParcelPanel expects '1030'.
      let normalizedOrderNumber = rawOrderNumber.trim();
      if (normalizedOrderNumber.startsWith('#')) {
        normalizedOrderNumber = normalizedOrderNumber.slice(1);
      }

      const url = `${this.baseUrl}/api/v2/tracking/order?order_number=${encodeURIComponent(normalizedOrderNumber)}`;

      return this.executeRequest('GET', url, 'get_tracking', apiKey, undefined, signal);
    }

    throw new WorkflowError(`ParcelPanelAdapter: operation "${operation}" is not supported`, {
      code: 'ADAPTER_OP_UNSUPPORTED',
      category: 'ENGINE',
      agentAction: 'report_to_user',
      retryable: false,
    });
  }

  async create(
    operation: string,
    _params: Record<string, unknown>,
    _config: Record<string, unknown>,
    _signal?: AbortSignal,
  ): Promise<ServiceResponse> {
    throw new WorkflowError(`ParcelPanelAdapter: operation "${operation}" is not supported`, {
      code: 'ADAPTER_OP_UNSUPPORTED',
      category: 'ENGINE',
      agentAction: 'report_to_user',
      retryable: false,
    });
  }

  async update(
    operation: string,
    _params: Record<string, unknown>,
    _config: Record<string, unknown>,
    _signal?: AbortSignal,
  ): Promise<ServiceResponse> {
    throw new WorkflowError(`ParcelPanelAdapter: operation "${operation}" is not supported`, {
      code: 'ADAPTER_OP_UNSUPPORTED',
      category: 'ENGINE',
      agentAction: 'report_to_user',
      retryable: false,
    });
  }
}
