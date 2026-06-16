// ShopifyAdapter — communicates with the Shopify Admin GraphQL API.
import { WorkflowError } from '../types/workflow-error.js';
import type { ServiceAdapter, ServiceResponse } from '../extensions/service-adapter.js';
import { parseRetryAfterHeader } from './adapter-utils.js';

const SHOPIFY_DEFAULT_API_VERSION = '2024-04';

/**
 * Configuration for ShopifyAdapter.
 */
export interface ShopifyAdapterConfig {
  /**
   * Per-store routing map. Keys are store identifiers (e.g. 'ellegems', 'fleur').
   * At least one entry required.
   */
  stores: Record<
    string,
    {
      /** Shopify store subdomain — e.g. "my-store" resolves to my-store.myshopify.com */
      shop_domain: string;
      /** Private app access token for this store */
      access_token: string;
    }
  >;
  /**
   * Shopify Admin API version, e.g. '2024-04'. Default: SHOPIFY_DEFAULT_API_VERSION constant.
   * Validated against /^\d{4}-\d{2}$/ at construction time.
   */
  api_version?: string;
  /**
   * Override the base URL for tests (replaces https://{shop_domain} only).
   * Trailing slash is stripped.
   */
  base_url?: string;
}

/**
 * ShopifyAdapter communicates with the Shopify Admin GraphQL API.
 *
 * Supported operations:
 *   fetch('query', { store, query, variables? })   — POST /admin/api/{version}/graphql.json
 *
 * The caller provides the complete GraphQL query string and optional variables.
 * The adapter handles authentication, store routing, and error classification.
 * The raw GraphQL response body is returned — no field selection or renaming.
 *
 * Throws SERVICE_RATE_LIMITED on HTTP 429 or GraphQL THROTTLED.
 * All other GraphQL errors (partial success, field errors) pass through to the caller.
 */
export class ShopifyAdapter implements ServiceAdapter {
  readonly id: string;
  readonly defaultRetryAfterSeconds = 30;
  private readonly apiVersion: string;
  private readonly baseUrlOverride: string | undefined;
  private readonly stores: ShopifyAdapterConfig['stores'];

  constructor(id: string, config: ShopifyAdapterConfig) {
    const storeEntries = Object.entries(config.stores);

    if (storeEntries.length === 0) {
      throw new Error('ShopifyAdapter: stores must not be empty');
    }

    for (const [key, store] of storeEntries) {
      if (key === '') {
        throw new Error('ShopifyAdapter: store key must not be an empty string');
      }
      if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(store.shop_domain)) {
        throw new Error(`ShopifyAdapter: invalid shop_domain for store "${key}"`);
      }
      if (store.access_token === '') {
        throw new Error(`ShopifyAdapter: access_token must not be empty for store "${key}"`);
      }
    }

    if (config.api_version !== undefined && !/^\d{4}-\d{2}$/.test(config.api_version)) {
      throw new Error('ShopifyAdapter: invalid api_version');
    }

    this.id = id;
    this.stores = config.stores;
    this.apiVersion = config.api_version ?? SHOPIFY_DEFAULT_API_VERSION;
    this.baseUrlOverride = config.base_url?.replace(/\/$/, '');
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

  private async executeRequest(
    url: string,
    options: RequestInit,
    signal?: AbortSignal,
  ): Promise<Response> {
    this.checkAborted(signal);
    let response: Response;
    try {
      response = await fetch(url, { ...options, signal: signal ?? null });
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
    return response;
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
      throw new WorkflowError('Rate limited by Shopify API', {
        code: 'SERVICE_RATE_LIMITED',
        category: 'SERVICE',
        agentAction: 'wait_and_proceed',
        retryable: true,
        ...(retryAfterFromHeader !== undefined ? { retry_after: retryAfterFromHeader } : {}),
        details,
      });
    }

    if (status === 401) {
      throw new WorkflowError('Shopify authentication failed — check access token', {
        code: 'SERVICE_AUTH_FAILED',
        category: 'SERVICE',
        agentAction: 'stop',
        retryable: false,
        details,
      });
    }

    if (status === 403) {
      throw new WorkflowError(`Account lacks permission for Shopify operation '${operation}'`, {
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
    throw new WorkflowError(`Shopify server error (HTTP ${status})`, {
      code: 'SERVICE_HTTP_5XX',
      category: 'SERVICE',
      agentAction: 'report_to_user',
      retryable: true,
      details,
    });
  }

  async fetch(
    operation: string,
    params: Record<string, unknown>,
    _config: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ServiceResponse> {
    if (operation === 'query') {
      // Validate store
      const store = params['store'];
      if (typeof store !== 'string' || store === '') {
        throw new WorkflowError('ShopifyAdapter: store param must be a non-empty string', {
          code: 'ADAPTER_VALIDATION_FAILED',
          category: 'ENGINE',
          agentAction: 'provide_input',
          retryable: false,
        });
      }
      const storeConfig = this.stores[store];
      if (storeConfig === undefined) {
        throw new WorkflowError(`ShopifyAdapter: unknown store "${store}"`, {
          code: 'ADAPTER_VALIDATION_FAILED',
          category: 'ENGINE',
          agentAction: 'provide_input',
          retryable: false,
          details: { store },
        });
      }

      // Validate query
      const query = params['query'];
      if (typeof query !== 'string' || query === '') {
        throw new WorkflowError('ShopifyAdapter: query param must be a non-empty string', {
          code: 'ADAPTER_VALIDATION_FAILED',
          category: 'ENGINE',
          agentAction: 'provide_input',
          retryable: false,
        });
      }

      // Variables are optional — no validation, passed through as-is
      const variables = params['variables'];

      const base = this.baseUrlOverride ?? `https://${storeConfig.shop_domain}`;
      const url = `${base}/admin/api/${this.apiVersion}/graphql.json`;

      const requestBody: Record<string, unknown> = { query };
      if (variables !== undefined && variables !== null) {
        requestBody['variables'] = variables;
      }

      const requestOptions: RequestInit = {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': storeConfig.access_token,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(requestBody),
      };

      const response = await this.executeRequest(url, requestOptions, signal);

      if (!response.ok) {
        await this.throwHttpError(response, 'query');
      }

      let json: unknown;
      try {
        json = await response.json();
      } catch {
        throw new WorkflowError('ShopifyAdapter: failed to parse GraphQL response', {
          code: 'SERVICE_RESPONSE_INVALID',
          category: 'SERVICE',
          agentAction: 'report_to_user',
          retryable: false,
        });
      }

      // Throw only on THROTTLED — all other GraphQL errors pass through to the caller
      const body = json as Record<string, unknown>;
      if (Array.isArray(body['errors']) && (body['errors'] as unknown[]).length > 0) {
        const errors = body['errors'] as Array<Record<string, unknown>>;
        const firstError = errors[0] as Record<string, unknown> | undefined;
        const extensions = firstError?.['extensions'] as Record<string, unknown> | undefined;
        if (extensions?.['code'] === 'THROTTLED') {
          throw new WorkflowError('Shopify GraphQL rate limited', {
            code: 'SERVICE_RATE_LIMITED',
            category: 'SERVICE',
            agentAction: 'wait_and_proceed',
            retryable: true,
            retry_after: 2,
          });
        }
      }

      return { status: response.status, data: json };
    }

    throw new WorkflowError(`ShopifyAdapter: unsupported fetch operation '${operation}'`, {
      code: 'ADAPTER_OP_UNSUPPORTED',
      category: 'ENGINE',
      agentAction: 'report_to_user',
      retryable: false,
      details: { operation },
    });
  }

  async create(
    operation: string,
    _params: Record<string, unknown>,
    _config: Record<string, unknown>,
    _signal?: AbortSignal,
  ): Promise<ServiceResponse> {
    throw new WorkflowError(`ShopifyAdapter: unsupported create operation: ${operation}`, {
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
    throw new WorkflowError(`ShopifyAdapter: unsupported update operation: ${operation}`, {
      code: 'ADAPTER_OP_UNSUPPORTED',
      category: 'ENGINE',
      agentAction: 'report_to_user',
      retryable: false,
      details: { operation },
    });
  }
}
