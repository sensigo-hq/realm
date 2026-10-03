// GenericHttpAdapter — makes HTTP requests to any REST API using Node 24 native fetch.
import { WorkflowError } from '../types/workflow-error.js';
import type { ServiceAdapter, ServiceResponse } from '../extensions/service-adapter.js';
import { brandClass, REALM_BRAND } from '../brand.js';

export interface HttpAdapterConfig {
  base_url: string;
  headers?: Record<string, string>;
  auth?: {
    type: 'bearer' | 'basic' | 'header';
    token?: string;
    header_name?: string;
  };
}

/**
 * GenericHttpAdapter makes HTTP requests to any REST API.
 * Method mapping:
 *   fetch()  → GET  {base_url}/{operation}?{params as query string}
 *   create() → POST {base_url}/{operation} with JSON body
 *   update() → PATCH {base_url}/{operation} with JSON body
 */
export class GenericHttpAdapter implements ServiceAdapter {
  constructor(
    public readonly id: string,
    private readonly config: HttpAdapterConfig,
  ) {}

  private buildAuthHeaders(auth: HttpAdapterConfig['auth']): Record<string, string> {
    if (auth === undefined) return {};
    const token = auth.token ?? '';
    if (auth.type === 'bearer') {
      return { Authorization: `Bearer ${token}` };
    }
    if (auth.type === 'basic') {
      return { Authorization: `Basic ${Buffer.from(token).toString('base64')}` };
    }
    // header type
    const headerName = auth.header_name ?? 'X-Auth-Token';
    return { [headerName]: token };
  }

  private async request(
    method: 'GET' | 'POST' | 'PATCH',
    operation: string,
    params: Record<string, unknown>,
    callConfig: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ServiceResponse> {
    // Only per-call headers can be merged — base_url and auth are constructor-time
    // security boundaries that callers must not override.
    const callHeaders = (callConfig['headers'] as Record<string, string> | undefined) ?? {};
    const authHeaders = this.buildAuthHeaders(this.config.auth);
    const baseHeaders: Record<string, string> = {
      ...(this.config.headers ?? {}),
      ...callHeaders,
      ...authHeaders,
    };

    const url =
      method === 'GET'
        ? `${this.config.base_url}/${operation}?${new URLSearchParams(params as Record<string, string>).toString()}`
        : `${this.config.base_url}/${operation}`;

    const fetchOptions: RequestInit =
      method === 'GET'
        ? { method, headers: baseHeaders, signal: signal ?? null }
        : {
            method,
            headers: { ...baseHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify(params),
            signal: signal ?? null,
          };

    let response: Response;
    try {
      response = await fetch(url, fetchOptions);
    } catch (err) {
      // AbortError means the engine cancelled this request (e.g. step timeout).
      // Do not categorize as a network failure — the engine already recorded the reason.
      if (err instanceof Error && err.name === 'AbortError') {
        throw new WorkflowError(`Adapter request aborted`, {
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
      const status = response.status;
      throw new WorkflowError(`HTTP ${status}: ${response.statusText}`, {
        code: status >= 500 ? 'SERVICE_HTTP_5XX' : 'SERVICE_HTTP_4XX',
        category: 'SERVICE',
        agentAction: status >= 500 ? 'wait_for_human' : 'report_to_user',
        retryable: status >= 500,
      });
    }

    const data: unknown = await response.json();
    return { status: response.status, data };
  }

  fetch(
    operation: string,
    params: Record<string, unknown>,
    config: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ServiceResponse> {
    return this.request('GET', operation, params, config, signal);
  }

  create(
    operation: string,
    params: Record<string, unknown>,
    config: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ServiceResponse> {
    return this.request('POST', operation, params, config, signal);
  }

  update(
    operation: string,
    params: Record<string, unknown>,
    config: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ServiceResponse> {
    return this.request('PATCH', operation, params, config, signal);
  }
}

brandClass(GenericHttpAdapter, Symbol.for('@sensigo/realm/GenericHttpAdapter'), REALM_BRAND);
