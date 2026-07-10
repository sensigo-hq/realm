// NotionAdapter — wraps the Notion REST API for page, block, and search operations.
import { WorkflowError } from '../types/workflow-error.js';
import type { ServiceAdapter, ServiceResponse } from '../extensions/service-adapter.js';
import { parseRetryAfterHeader } from './adapter-utils.js';

const NOTION_API_VERSION = '2026-03-11';
const NOTION_BASE_URL = 'https://api.notion.com';

/**
 * Configuration for NotionAdapter.
 */
export interface NotionAdapterConfig {
  /**
   * Notion integration token. Must be a non-empty string.
   * Obtain from https://www.notion.so/my-integrations
   */
  api_key: string;

  /**
   * Override base URL for tests (replaces https://api.notion.com).
   * Trailing slash is stripped.
   */
  base_url?: string;
}

/**
 * NotionAdapter wraps the Notion REST API.
 *
 * Supported operations:
 *   fetch('get_page', { page_id, filter_properties? })                      — GET  /v1/pages/{page_id}
 *   fetch('list_block_children', { block_id, start_cursor?, page_size? })   — GET  /v1/blocks/{block_id}/children
 *   fetch('query_data_source', { data_source_id, ...opts })                 — POST /v1/data_sources/{data_source_id}/query
 *   fetch('search', { query?, filter?, sort?, start_cursor?, page_size? })  — POST /v1/search
 *   create('create_page', { parent, properties?, children?, icon?, cover? }) — POST /v1/pages
 *   create('append_block_children', { block_id, children, position? })      — PATCH /v1/blocks/{block_id}/children
 *   update('update_page', { page_id, properties?, icon?, cover?, ... })     — PATCH /v1/pages/{page_id}
 *   delete('delete_block', { block_id })                                    — DELETE /v1/blocks/{block_id}
 */
export class NotionAdapter implements ServiceAdapter {
  readonly id: string;
  // Notion normally returns a Retry-After header on 429; this is the tier-3 fallback
  // (used only when no header and no YAML fallback_retry_seconds is configured).
  readonly defaultRetryAfterSeconds = 30;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(id: string, config: NotionAdapterConfig) {
    if (!config.api_key) {
      throw new Error('NotionAdapter: api_key must not be empty');
    }
    this.id = id;
    this.apiKey = config.api_key;
    this.baseUrl = config.base_url?.replace(/\/$/, '') ?? NOTION_BASE_URL;
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
      Authorization: `Bearer ${this.apiKey}`,
      'Notion-Version': NOTION_API_VERSION,
      Accept: 'application/json',
    };
  }

  private buildUrl(path: string): URL {
    return new URL(path, this.baseUrl);
  }

  /**
   * @param networkRetryable — set to false for non-idempotent write operations
   *   (create_page, append_block_children) where retrying a failed request may
   *   create duplicate resources.
   */
  private async executeRequest(
    url: URL,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    body?: unknown,
    signal?: AbortSignal,
    networkRetryable = true,
  ): Promise<Response> {
    this.checkAborted(signal);
    const hasBody = (method === 'POST' || method === 'PATCH') && body !== undefined;
    const headers: Record<string, string> = {
      ...this.buildHeaders(),
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    };

    let response: Response;
    try {
      response = await fetch(url.href, {
        method,
        headers,
        ...(hasBody ? { body: JSON.stringify(body) } : {}),
        signal: signal ?? null,
      });
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
        retryable: networkRetryable,
      });
    }
    return response;
  }

  private async throwHttpError(response: Response, operation: string): Promise<never> {
    // Read body as text first — avoids "body already consumed" if JSON.parse fails.
    const rawText = await response.text();
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawText);
    } catch {
      parsedBody = rawText;
    }

    const status = response.status;
    const notionRequestIdHeader = response.headers.get('x-notion-request-id');
    const baseDetails: Record<string, unknown> = { status, operation };
    if (notionRequestIdHeader !== null) {
      baseDetails['notionRequestId'] = notionRequestIdHeader;
    }

    if (status === 400) {
      const parsed = parsedBody as Record<string, unknown> | null;
      const apiMessage =
        typeof parsed?.['message'] === 'string' ? parsed['message'] : 'validation error';
      throw new WorkflowError(`Notion API error (HTTP 400): ${apiMessage}`, {
        code: 'SERVICE_HTTP_4XX',
        category: 'SERVICE',
        agentAction: 'stop',
        retryable: false,
        details: { ...baseDetails, body: parsedBody },
      });
    }

    if (status === 401) {
      throw new WorkflowError('Notion authentication failed — check API key', {
        code: 'SERVICE_AUTH_FAILED',
        category: 'SERVICE',
        agentAction: 'stop',
        retryable: false,
        details: baseDetails,
      });
    }

    if (status === 403) {
      throw new WorkflowError('Notion: forbidden (HTTP 403)', {
        code: 'SERVICE_HTTP_4XX',
        category: 'SERVICE',
        agentAction: 'stop',
        retryable: false,
        details: baseDetails,
      });
    }

    if (status === 404) {
      throw new WorkflowError('Notion: resource not found', {
        code: 'SERVICE_NOT_FOUND',
        category: 'SERVICE',
        agentAction: 'provide_input',
        retryable: false,
        details: baseDetails,
      });
    }

    if (status === 409) {
      const parsed = parsedBody as Record<string, unknown> | null;
      const apiMessage = typeof parsed?.['message'] === 'string' ? parsed['message'] : 'conflict';
      throw new WorkflowError(`Notion API error (HTTP 409): ${apiMessage}`, {
        code: 'SERVICE_HTTP_4XX',
        category: 'SERVICE',
        agentAction: 'stop',
        retryable: false,
        details: { ...baseDetails, body: parsedBody },
      });
    }

    if (status === 429) {
      const retryAfterFromHeader = parseRetryAfterHeader(response.headers.get('Retry-After'));
      throw new WorkflowError('Rate limited by Notion API', {
        code: 'SERVICE_RATE_LIMITED',
        category: 'SERVICE',
        agentAction: 'wait_and_proceed',
        retryable: true,
        ...(retryAfterFromHeader !== undefined ? { retry_after: retryAfterFromHeader } : {}),
        details: baseDetails,
      });
    }

    if (status === 503) {
      const parsed = parsedBody as Record<string, unknown> | null;
      const additionalData = parsed?.['additional_data'];
      throw new WorkflowError('Notion service temporarily unavailable (HTTP 503)', {
        code: 'SERVICE_HTTP_5XX',
        category: 'SERVICE',
        agentAction: 'wait_for_human',
        retryable: true,
        details: {
          ...baseDetails,
          ...(additionalData !== undefined ? { additionalData } : {}),
        },
      });
    }

    if (status >= 500) {
      throw new WorkflowError(`Notion server error (HTTP ${status})`, {
        code: 'SERVICE_HTTP_5XX',
        category: 'SERVICE',
        agentAction: 'report_to_user',
        retryable: true,
        details: baseDetails,
      });
    }

    // other 4xx
    throw new WorkflowError(`Notion: HTTP ${status}`, {
      code: 'SERVICE_HTTP_4XX',
      category: 'SERVICE',
      agentAction: 'stop',
      retryable: false,
      details: baseDetails,
    });
  }

  async fetch(
    operation: string,
    params: Record<string, unknown>,
    _config: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ServiceResponse> {
    if (operation === 'get_page') {
      const pageId = params['page_id'];
      if (typeof pageId !== 'string' || pageId === '') {
        throw new WorkflowError('NotionAdapter: page_id param must be a non-empty string', {
          code: 'ADAPTER_VALIDATION_FAILED',
          category: 'ENGINE',
          agentAction: 'provide_input',
          retryable: false,
        });
      }

      const url = this.buildUrl(`/v1/pages/${encodeURIComponent(pageId)}`);
      const filterProperties = params['filter_properties'];
      if (Array.isArray(filterProperties) && filterProperties.length > 0) {
        for (const val of filterProperties as unknown[]) {
          url.searchParams.append('filter_properties', String(val));
        }
      }

      const response = await this.executeRequest(url, 'GET', undefined, signal);
      if (!response.ok) {
        await this.throwHttpError(response, operation);
      }

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        throw new WorkflowError('NotionAdapter: failed to parse response body', {
          code: 'SERVICE_RESPONSE_INVALID',
          category: 'SERVICE',
          agentAction: 'report_to_user',
          retryable: false,
        });
      }

      const data = parsed as { id?: unknown };
      if (typeof data.id !== 'string' || data.id === '') {
        throw new WorkflowError('NotionAdapter: get_page response missing id field', {
          code: 'SERVICE_RESPONSE_INVALID',
          category: 'SERVICE',
          agentAction: 'report_to_user',
          retryable: false,
        });
      }

      return { status: response.status, data: parsed };
    }

    if (operation === 'list_block_children') {
      // data shape for paginated responses:
      // { object: 'list', results: unknown[], has_more: boolean, next_cursor: string | null }
      // Pass next_cursor back as start_cursor on the next call to retrieve subsequent pages.
      const blockId = params['block_id'];
      if (typeof blockId !== 'string' || blockId === '') {
        throw new WorkflowError('NotionAdapter: block_id param must be a non-empty string', {
          code: 'ADAPTER_VALIDATION_FAILED',
          category: 'ENGINE',
          agentAction: 'provide_input',
          retryable: false,
        });
      }

      const url = this.buildUrl(`/v1/blocks/${encodeURIComponent(blockId)}/children`);
      if (typeof params['start_cursor'] === 'string') {
        url.searchParams.set('start_cursor', params['start_cursor']);
      }
      if (typeof params['page_size'] === 'number') {
        url.searchParams.set('page_size', String(params['page_size']));
      }

      const response = await this.executeRequest(url, 'GET', undefined, signal);
      if (!response.ok) {
        await this.throwHttpError(response, operation);
      }

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        throw new WorkflowError('NotionAdapter: failed to parse response body', {
          code: 'SERVICE_RESPONSE_INVALID',
          category: 'SERVICE',
          agentAction: 'report_to_user',
          retryable: false,
        });
      }

      const data = parsed as { results?: unknown };
      if (!Array.isArray(data.results)) {
        throw new WorkflowError(
          'NotionAdapter: list_block_children response missing results array',
          {
            code: 'SERVICE_RESPONSE_INVALID',
            category: 'SERVICE',
            agentAction: 'report_to_user',
            retryable: false,
          },
        );
      }

      return { status: response.status, data: parsed };
    }

    if (operation === 'query_data_source') {
      // data shape for paginated responses:
      // { object: 'list', results: unknown[], has_more: boolean, next_cursor: string | null }
      // Pass next_cursor back as start_cursor on the next call to retrieve subsequent pages.
      const dataSourceId = params['data_source_id'];
      if (typeof dataSourceId !== 'string' || dataSourceId === '') {
        throw new WorkflowError('NotionAdapter: data_source_id param must be a non-empty string', {
          code: 'ADAPTER_VALIDATION_FAILED',
          category: 'ENGINE',
          agentAction: 'provide_input',
          retryable: false,
        });
      }

      const url = this.buildUrl(`/v1/data_sources/${encodeURIComponent(dataSourceId)}/query`);
      const filterProperties = params['filter_properties'];
      if (Array.isArray(filterProperties) && filterProperties.length > 0) {
        for (const val of filterProperties as unknown[]) {
          url.searchParams.append('filter_properties', String(val));
        }
      }

      const body: Record<string, unknown> = {};
      if (params['filter'] !== undefined) body['filter'] = params['filter'];
      if (params['sorts'] !== undefined) body['sorts'] = params['sorts'];
      if (params['start_cursor'] !== undefined) body['start_cursor'] = params['start_cursor'];
      if (params['page_size'] !== undefined) body['page_size'] = params['page_size'];
      if (params['in_trash'] !== undefined) body['in_trash'] = params['in_trash'];

      const response = await this.executeRequest(url, 'POST', body, signal);
      if (!response.ok) {
        await this.throwHttpError(response, operation);
      }

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        throw new WorkflowError('NotionAdapter: failed to parse response body', {
          code: 'SERVICE_RESPONSE_INVALID',
          category: 'SERVICE',
          agentAction: 'report_to_user',
          retryable: false,
        });
      }

      const data = parsed as { results?: unknown };
      if (!Array.isArray(data.results)) {
        throw new WorkflowError('NotionAdapter: query_data_source response missing results array', {
          code: 'SERVICE_RESPONSE_INVALID',
          category: 'SERVICE',
          agentAction: 'report_to_user',
          retryable: false,
        });
      }

      return { status: response.status, data: parsed };
    }

    if (operation === 'search') {
      // data shape for paginated responses:
      // { object: 'list', results: unknown[], has_more: boolean, next_cursor: string | null }
      // Pass next_cursor back as start_cursor on the next call to retrieve subsequent pages.

      // Validate filter structure before sending.
      const filter = params['filter'];
      if (filter !== undefined) {
        if (filter === null || typeof filter !== 'object' || Array.isArray(filter)) {
          throw new WorkflowError(
            "NotionAdapter: search — 'filter' must be a plain object with property: 'object' and value: 'page'|'database'|'data_source'",
            {
              code: 'ADAPTER_VALIDATION_FAILED',
              category: 'ENGINE',
              agentAction: 'provide_input',
              retryable: false,
            },
          );
        }
        const f = filter as Record<string, unknown>;
        if (
          f['property'] !== 'object' ||
          !['page', 'database', 'data_source'].includes(f['value'] as string)
        ) {
          throw new WorkflowError(
            "NotionAdapter: search — 'filter' must have property: 'object' and value: 'page'|'database'|'data_source'",
            {
              code: 'ADAPTER_VALIDATION_FAILED',
              category: 'ENGINE',
              agentAction: 'provide_input',
              retryable: false,
            },
          );
        }
      }

      const url = this.buildUrl('/v1/search');
      const body: Record<string, unknown> = {};
      if (params['query'] !== undefined) body['query'] = params['query'];
      if (params['filter'] !== undefined) body['filter'] = params['filter'];
      if (params['sort'] !== undefined) body['sort'] = params['sort'];
      if (params['start_cursor'] !== undefined) body['start_cursor'] = params['start_cursor'];
      if (params['page_size'] !== undefined) body['page_size'] = params['page_size'];

      const response = await this.executeRequest(url, 'POST', body, signal);
      if (!response.ok) {
        await this.throwHttpError(response, operation);
      }

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        throw new WorkflowError('NotionAdapter: failed to parse response body', {
          code: 'SERVICE_RESPONSE_INVALID',
          category: 'SERVICE',
          agentAction: 'report_to_user',
          retryable: false,
        });
      }

      const data = parsed as { results?: unknown };
      if (!Array.isArray(data.results)) {
        throw new WorkflowError('NotionAdapter: search response missing results array', {
          code: 'SERVICE_RESPONSE_INVALID',
          category: 'SERVICE',
          agentAction: 'report_to_user',
          retryable: false,
        });
      }

      return { status: response.status, data: parsed };
    }

    throw new WorkflowError(`NotionAdapter: unsupported fetch operation "${operation}"`, {
      code: 'ADAPTER_OP_UNSUPPORTED',
      category: 'ENGINE',
      agentAction: 'report_to_user',
      retryable: false,
    });
  }

  /**
   * NOTE: retryable is false for network errors — retrying a failed create or append
   * risks creating duplicate content if the server processed the request before the network dropped.
   */
  async create(
    operation: string,
    params: Record<string, unknown>,
    _config: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ServiceResponse> {
    if (operation === 'create_page') {
      const parent = params['parent'];
      if (
        parent === null ||
        parent === undefined ||
        typeof parent !== 'object' ||
        Array.isArray(parent)
      ) {
        throw new WorkflowError('NotionAdapter: create_page — parent must be a plain object', {
          code: 'ADAPTER_VALIDATION_FAILED',
          category: 'ENGINE',
          agentAction: 'provide_input',
          retryable: false,
        });
      }

      const p = parent as Record<string, unknown>;
      let wireParent: Record<string, unknown>;
      if (typeof p['page_id'] === 'string' && p['page_id'] !== '') {
        wireParent = { type: 'page_id', page_id: p['page_id'] };
      } else if (typeof p['data_source_id'] === 'string' && p['data_source_id'] !== '') {
        wireParent = { type: 'data_source_id', data_source_id: p['data_source_id'] };
      } else if (p['workspace'] === true) {
        wireParent = { type: 'workspace', workspace: true };
      } else {
        throw new WorkflowError(
          "NotionAdapter: create_page — 'parent' must be one of: { page_id }, { data_source_id }, or { workspace: true }",
          {
            code: 'ADAPTER_VALIDATION_FAILED',
            category: 'ENGINE',
            agentAction: 'provide_input',
            retryable: false,
          },
        );
      }

      const children = params['children'];
      const markdown = params['markdown'];
      if (children !== undefined && markdown !== undefined) {
        throw new WorkflowError(
          "NotionAdapter: create_page — 'children' and 'markdown' are mutually exclusive",
          {
            code: 'ADAPTER_VALIDATION_FAILED',
            category: 'ENGINE',
            agentAction: 'provide_input',
            retryable: false,
          },
        );
      }

      if (Array.isArray(children) && children.length > 100) {
        throw new WorkflowError(
          `NotionAdapter: create_page — 'children' array exceeds 100 items (got ${children.length})`,
          {
            code: 'ADAPTER_VALIDATION_FAILED',
            category: 'ENGINE',
            agentAction: 'provide_input',
            retryable: false,
          },
        );
      }

      const body: Record<string, unknown> = { parent: wireParent };
      if (params['properties'] !== undefined) body['properties'] = params['properties'];
      if (params['children'] !== undefined) body['children'] = params['children'];
      if (params['markdown'] !== undefined) body['markdown'] = params['markdown'];
      if (params['icon'] !== undefined) body['icon'] = params['icon'];
      if (params['cover'] !== undefined) body['cover'] = params['cover'];

      const url = this.buildUrl('/v1/pages');
      // networkRetryable: false — retrying risks creating a duplicate page.
      const response = await this.executeRequest(url, 'POST', body, signal, false);
      if (!response.ok) {
        await this.throwHttpError(response, operation);
      }

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        throw new WorkflowError('NotionAdapter: failed to parse response body', {
          code: 'SERVICE_RESPONSE_INVALID',
          category: 'SERVICE',
          agentAction: 'report_to_user',
          retryable: false,
        });
      }

      const data = parsed as { id?: unknown };
      if (typeof data.id !== 'string' || data.id === '') {
        throw new WorkflowError('NotionAdapter: create_page response missing id field', {
          code: 'SERVICE_RESPONSE_INVALID',
          category: 'SERVICE',
          agentAction: 'report_to_user',
          retryable: false,
        });
      }

      return { status: response.status, data: parsed };
    }

    if (operation === 'append_block_children') {
      // data shape for paginated responses:
      // { object: 'list', results: unknown[], has_more: boolean, next_cursor: string | null }
      // Pass next_cursor back as start_cursor on the next call to retrieve subsequent pages.
      //
      // Note: append_block_children lives in create() because it creates new block resources.
      // The underlying HTTP verb is PATCH — this is expected.
      const blockId = params['block_id'];
      if (typeof blockId !== 'string' || blockId === '') {
        throw new WorkflowError('NotionAdapter: block_id param must be a non-empty string', {
          code: 'ADAPTER_VALIDATION_FAILED',
          category: 'ENGINE',
          agentAction: 'provide_input',
          retryable: false,
        });
      }

      const children = params['children'];
      if (!Array.isArray(children) || children.length === 0) {
        throw new WorkflowError(
          'NotionAdapter: append_block_children — children must be a non-empty array',
          {
            code: 'ADAPTER_VALIDATION_FAILED',
            category: 'ENGINE',
            agentAction: 'provide_input',
            retryable: false,
          },
        );
      }

      if (children.length > 100) {
        throw new WorkflowError(
          `NotionAdapter: append_block_children — 'children' array exceeds 100 items (got ${children.length})`,
          {
            code: 'ADAPTER_VALIDATION_FAILED',
            category: 'ENGINE',
            agentAction: 'provide_input',
            retryable: false,
          },
        );
      }

      for (const item of children as unknown[]) {
        if (
          item === null ||
          typeof item !== 'object' ||
          Array.isArray(item) ||
          typeof (item as Record<string, unknown>)['type'] !== 'string' ||
          (item as Record<string, unknown>)['type'] === ''
        ) {
          throw new WorkflowError(
            'NotionAdapter: append_block_children — each child must be a plain object with a non-empty type field',
            {
              code: 'ADAPTER_VALIDATION_FAILED',
              category: 'ENGINE',
              agentAction: 'provide_input',
              retryable: false,
            },
          );
        }
      }

      const position = params['position'];
      if (position !== undefined) {
        if (position === null || typeof position !== 'object' || Array.isArray(position)) {
          throw new WorkflowError(
            "NotionAdapter: append_block_children — 'position' must be a plain object",
            {
              code: 'ADAPTER_VALIDATION_FAILED',
              category: 'ENGINE',
              agentAction: 'provide_input',
              retryable: false,
            },
          );
        }
        const pos = position as Record<string, unknown>;
        if (!['end', 'start', 'after_block'].includes(pos['type'] as string)) {
          throw new WorkflowError(
            "NotionAdapter: append_block_children — 'position.type' must be one of 'end', 'start', 'after_block'",
            {
              code: 'ADAPTER_VALIDATION_FAILED',
              category: 'ENGINE',
              agentAction: 'provide_input',
              retryable: false,
            },
          );
        }
        if (pos['type'] === 'after_block') {
          const afterBlock = pos['after_block'];
          if (
            afterBlock === null ||
            typeof afterBlock !== 'object' ||
            Array.isArray(afterBlock) ||
            typeof (afterBlock as Record<string, unknown>)['id'] !== 'string' ||
            (afterBlock as Record<string, unknown>)['id'] === ''
          ) {
            throw new WorkflowError(
              "NotionAdapter: append_block_children — 'position.after_block.id' must be a non-empty string when type is 'after_block'",
              {
                code: 'ADAPTER_VALIDATION_FAILED',
                category: 'ENGINE',
                agentAction: 'provide_input',
                retryable: false,
              },
            );
          }
        }
      }

      const body: Record<string, unknown> = { children };
      if (position !== undefined) body['position'] = position;

      const url = this.buildUrl(`/v1/blocks/${encodeURIComponent(blockId)}/children`);
      // networkRetryable: false — retrying risks appending duplicate blocks.
      const response = await this.executeRequest(url, 'PATCH', body, signal, false);
      if (!response.ok) {
        await this.throwHttpError(response, operation);
      }

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        throw new WorkflowError('NotionAdapter: failed to parse response body', {
          code: 'SERVICE_RESPONSE_INVALID',
          category: 'SERVICE',
          agentAction: 'report_to_user',
          retryable: false,
        });
      }

      const data = parsed as { results?: unknown };
      if (!Array.isArray(data.results)) {
        throw new WorkflowError(
          'NotionAdapter: append_block_children response missing results array',
          {
            code: 'SERVICE_RESPONSE_INVALID',
            category: 'SERVICE',
            agentAction: 'report_to_user',
            retryable: false,
          },
        );
      }

      return { status: response.status, data: parsed };
    }

    throw new WorkflowError(`NotionAdapter: unsupported create operation "${operation}"`, {
      code: 'ADAPTER_OP_UNSUPPORTED',
      category: 'ENGINE',
      agentAction: 'report_to_user',
      retryable: false,
    });
  }

  async update(
    operation: string,
    params: Record<string, unknown>,
    _config: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ServiceResponse> {
    if (operation === 'update_page') {
      const pageId = params['page_id'];
      if (typeof pageId !== 'string' || pageId === '') {
        throw new WorkflowError('NotionAdapter: page_id param must be a non-empty string', {
          code: 'ADAPTER_VALIDATION_FAILED',
          category: 'ENGINE',
          agentAction: 'provide_input',
          retryable: false,
        });
      }

      if ('archived' in params) {
        throw new WorkflowError(
          "NotionAdapter: update_page — 'archived' is deprecated; use 'in_trash' instead",
          {
            code: 'ADAPTER_VALIDATION_FAILED',
            category: 'ENGINE',
            agentAction: 'provide_input',
            retryable: false,
          },
        );
      }

      const body: Record<string, unknown> = {};
      if (params['properties'] !== undefined) body['properties'] = params['properties'];
      if (params['icon'] !== undefined) body['icon'] = params['icon'];
      if (params['cover'] !== undefined) body['cover'] = params['cover'];
      if (params['in_trash'] !== undefined) body['in_trash'] = params['in_trash'];
      if (params['is_locked'] !== undefined) body['is_locked'] = params['is_locked'];

      const url = this.buildUrl(`/v1/pages/${encodeURIComponent(pageId)}`);
      const response = await this.executeRequest(url, 'PATCH', body, signal);
      if (!response.ok) {
        await this.throwHttpError(response, operation);
      }

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        throw new WorkflowError('NotionAdapter: failed to parse response body', {
          code: 'SERVICE_RESPONSE_INVALID',
          category: 'SERVICE',
          agentAction: 'report_to_user',
          retryable: false,
        });
      }

      const data = parsed as { id?: unknown };
      if (typeof data.id !== 'string' || data.id === '') {
        throw new WorkflowError('NotionAdapter: update_page response missing id field', {
          code: 'SERVICE_RESPONSE_INVALID',
          category: 'SERVICE',
          agentAction: 'report_to_user',
          retryable: false,
        });
      }

      return { status: response.status, data: parsed };
    }

    throw new WorkflowError(`NotionAdapter: unsupported update operation "${operation}"`, {
      code: 'ADAPTER_OP_UNSUPPORTED',
      category: 'ENGINE',
      agentAction: 'report_to_user',
      retryable: false,
    });
  }

  async delete(
    operation: string,
    params: Record<string, unknown>,
    _config: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ServiceResponse> {
    if (operation === 'delete_block') {
      const blockId = params['block_id'];
      if (typeof blockId !== 'string' || blockId === '') {
        throw new WorkflowError('NotionAdapter: block_id param must be a non-empty string', {
          code: 'ADAPTER_VALIDATION_FAILED',
          category: 'ENGINE',
          agentAction: 'provide_input',
          retryable: false,
        });
      }

      const url = this.buildUrl(`/v1/blocks/${encodeURIComponent(blockId)}`);
      const response = await this.executeRequest(url, 'DELETE', undefined, signal);
      if (!response.ok) {
        await this.throwHttpError(response, operation);
      }

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        throw new WorkflowError('NotionAdapter: failed to parse response body', {
          code: 'SERVICE_RESPONSE_INVALID',
          category: 'SERVICE',
          agentAction: 'report_to_user',
          retryable: false,
        });
      }

      const data = parsed as { id?: unknown };
      if (typeof data.id !== 'string' || data.id === '') {
        throw new WorkflowError('NotionAdapter: delete_block response missing id field', {
          code: 'SERVICE_RESPONSE_INVALID',
          category: 'SERVICE',
          agentAction: 'report_to_user',
          retryable: false,
        });
      }

      return { status: response.status, data: parsed };
    }

    throw new WorkflowError(`NotionAdapter: unsupported delete operation "${operation}"`, {
      code: 'ADAPTER_OP_UNSUPPORTED',
      category: 'ENGINE',
      agentAction: 'report_to_user',
      retryable: false,
    });
  }
}
