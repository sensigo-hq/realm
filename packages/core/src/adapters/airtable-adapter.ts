// AirtableAdapter — wraps the Airtable REST API for record-level operations.
import { WorkflowError } from '../types/workflow-error.js';
import type { ServiceAdapter, ServiceResponse } from '../extensions/service-adapter.js';

const AIRTABLE_DEFAULT_BASE_URL = 'https://api.airtable.com';

/**
 * Configuration for AirtableAdapter.
 *
 * One adapter instance is scoped to a single Airtable base. For multi-base workflows,
 * create one adapter instance per base.
 */
export interface AirtableAdapterConfig {
  /**
   * Personal Access Token (PAT). Required.
   * Rate limit: 5 req/sec per base. On HTTP 429, wait 30 seconds before retrying.
   * No Retry-After header is provided by Airtable.
   */
  api_key: string;

  /**
   * Airtable base ID. Format: /^app[a-zA-Z0-9]{14}$/.
   * One adapter instance per base. Multi-base = two instances.
   */
  base_id: string;

  /**
   * Override the base URL for tests (replaces https://api.airtable.com).
   * Trailing slash is stripped.
   */
  base_url?: string;
}

/** Raw Airtable record shape. */
interface AirtableRecord {
  id?: unknown;
  createdTime?: unknown;
  fields?: Record<string, unknown>;
}

/**
 * AirtableAdapter wraps the Airtable REST API.
 *
 * Supported operations:
 *   fetch('get_record', { table, record_id })        — GET  /v0/{base}/{table}/{id}
 *   fetch('list_records', { table, ...query })       — GET  /v0/{base}/{table}
 *   create('create_record', { table, fields, ... })  — POST /v0/{base}/{table}
 *   update('upsert_record', { table, fields, ... })  — POST /v0/{base}/{table} (upsert)
 */
export class AirtableAdapter implements ServiceAdapter {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly baseId: string;

  constructor(id: string, config: AirtableAdapterConfig) {
    if (!config.api_key) {
      throw new Error('AirtableAdapter: api_key must not be empty');
    }
    if (!/^app[a-zA-Z0-9]{14}$/.test(config.base_id)) {
      throw new Error(
        'AirtableAdapter: base_id must be a valid Airtable base ID (format: appXXXXXXXXXXXXXX)',
      );
    }
    this.id = id;
    this.apiKey = config.api_key;
    this.baseId = config.base_id;
    this.baseUrl = config.base_url?.replace(/\/$/, '') ?? AIRTABLE_DEFAULT_BASE_URL;
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
      Accept: 'application/json',
    };
  }

  private buildUrl(table: string, recordId?: string): URL {
    let path = `/v0/${this.baseId}/${encodeURIComponent(table)}`;
    if (recordId !== undefined) {
      path += `/${encodeURIComponent(recordId)}`;
    }
    return new URL(path, this.baseUrl);
  }

  private async executeRequest(
    url: URL,
    method: 'GET' | 'POST' | 'PATCH',
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    this.checkAborted(signal);
    const hasBody = method !== 'GET' && body !== undefined;
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
    const baseDetails = { status, operation };

    if (status === 401) {
      throw new WorkflowError('Airtable authentication failed — check API key', {
        code: 'SERVICE_AUTH_FAILED',
        category: 'SERVICE',
        agentAction: 'stop',
        retryable: false,
        details: baseDetails,
      });
    }

    if (status === 403) {
      throw new WorkflowError('Airtable: forbidden (HTTP 403)', {
        code: 'SERVICE_HTTP_4XX',
        category: 'SERVICE',
        agentAction: 'stop',
        retryable: false,
        details: baseDetails,
      });
    }

    if (status === 404) {
      throw new WorkflowError('Airtable: record not found', {
        code: 'SERVICE_NOT_FOUND',
        category: 'SERVICE',
        agentAction: 'provide_input',
        retryable: false,
        details: baseDetails,
      });
    }

    if (status === 422) {
      throw new WorkflowError('Airtable: unprocessable entity (HTTP 422)', {
        code: 'SERVICE_HTTP_4XX',
        category: 'SERVICE',
        agentAction: 'stop',
        retryable: false,
        details: { ...baseDetails, body },
      });
    }

    if (status === 429) {
      throw new WorkflowError('Rate limited by Airtable API — wait 30 seconds before retrying', {
        code: 'SERVICE_RATE_LIMITED',
        category: 'SERVICE',
        agentAction: 'wait_and_proceed',
        retryable: true,
        retry_after: 30,
        details: baseDetails,
      });
    }

    if (status >= 500) {
      throw new WorkflowError(`Airtable server error (HTTP ${status})`, {
        code: 'SERVICE_HTTP_5XX',
        category: 'SERVICE',
        agentAction: 'report_to_user',
        retryable: true,
        details: baseDetails,
      });
    }

    // 400 and other 4xx
    throw new WorkflowError(`HTTP ${status}: ${response.statusText}`, {
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
    if (operation === 'get_record') {
      const table = params['table'];
      const recordId = params['record_id'];

      if (typeof table !== 'string' || table === '') {
        throw new WorkflowError('AirtableAdapter: table param must be a non-empty string', {
          code: 'ADAPTER_VALIDATION_FAILED',
          category: 'ENGINE',
          agentAction: 'provide_input',
          retryable: false,
        });
      }
      if (typeof recordId !== 'string' || recordId === '') {
        throw new WorkflowError('AirtableAdapter: record_id param must be a non-empty string', {
          code: 'ADAPTER_VALIDATION_FAILED',
          category: 'ENGINE',
          agentAction: 'provide_input',
          retryable: false,
        });
      }

      const url = this.buildUrl(table, recordId);
      const response = await this.executeRequest(url, 'GET', undefined, signal);

      if (!response.ok) {
        await this.throwHttpError(response, 'get_record');
      }

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        throw new WorkflowError('AirtableAdapter: failed to parse response body', {
          code: 'SERVICE_RESPONSE_INVALID',
          category: 'SERVICE',
          agentAction: 'report_to_user',
          retryable: false,
        });
      }

      const data = parsed as AirtableRecord;
      if (typeof data.id !== 'string' || data.id === '') {
        throw new WorkflowError('AirtableAdapter: get_record response missing id field', {
          code: 'SERVICE_RESPONSE_INVALID',
          category: 'SERVICE',
          agentAction: 'report_to_user',
          retryable: false,
        });
      }

      return { status: response.status, data: parsed };
    }

    if (operation === 'list_records') {
      const table = params['table'];
      if (typeof table !== 'string' || table === '') {
        throw new WorkflowError('AirtableAdapter: table param must be a non-empty string', {
          code: 'ADAPTER_VALIDATION_FAILED',
          category: 'ENGINE',
          agentAction: 'provide_input',
          retryable: false,
        });
      }

      const url = this.buildUrl(table);

      if (typeof params['filter_by_formula'] === 'string') {
        url.searchParams.set('filterByFormula', params['filter_by_formula']);
      }
      if (typeof params['view'] === 'string') {
        url.searchParams.set('view', params['view']);
      }
      if (typeof params['max_records'] === 'number') {
        url.searchParams.set('maxRecords', String(params['max_records']));
      }
      if (Array.isArray(params['fields'])) {
        for (const f of params['fields'] as unknown[]) {
          url.searchParams.append('fields[]', String(f));
        }
      }
      if (typeof params['offset'] === 'string') {
        url.searchParams.set('offset', params['offset']);
      }

      const response = await this.executeRequest(url, 'GET', undefined, signal);

      if (!response.ok) {
        await this.throwHttpError(response, 'list_records');
      }

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        throw new WorkflowError('AirtableAdapter: failed to parse response body', {
          code: 'SERVICE_RESPONSE_INVALID',
          category: 'SERVICE',
          agentAction: 'report_to_user',
          retryable: false,
        });
      }

      const data = parsed as { records?: unknown };
      if (!Array.isArray(data.records)) {
        throw new WorkflowError('AirtableAdapter: list_records response missing records array', {
          code: 'SERVICE_RESPONSE_INVALID',
          category: 'SERVICE',
          agentAction: 'report_to_user',
          retryable: false,
        });
      }

      return { status: response.status, data: parsed };
    }

    throw new WorkflowError(`AirtableAdapter: unsupported fetch operation "${operation}"`, {
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
    if (operation === 'create_record') {
      const table = params['table'];
      const fields = params['fields'];

      if (typeof table !== 'string' || table === '') {
        throw new WorkflowError('AirtableAdapter: table param must be a non-empty string', {
          code: 'ADAPTER_VALIDATION_FAILED',
          category: 'ENGINE',
          agentAction: 'provide_input',
          retryable: false,
        });
      }
      if (
        fields === undefined ||
        fields === null ||
        typeof fields !== 'object' ||
        Array.isArray(fields)
      ) {
        throw new WorkflowError('AirtableAdapter: fields param must be a plain object', {
          code: 'ADAPTER_VALIDATION_FAILED',
          category: 'ENGINE',
          agentAction: 'provide_input',
          retryable: false,
        });
      }

      const body: Record<string, unknown> = { fields };
      if (params['typecast'] === true) {
        body['typecast'] = true;
      }

      const url = this.buildUrl(table);
      const response = await this.executeRequest(url, 'POST', body, signal);

      if (!response.ok) {
        await this.throwHttpError(response, 'create_record');
      }

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        throw new WorkflowError('AirtableAdapter: failed to parse response body', {
          code: 'SERVICE_RESPONSE_INVALID',
          category: 'SERVICE',
          agentAction: 'report_to_user',
          retryable: false,
        });
      }

      const data = parsed as AirtableRecord;
      if (typeof data.id !== 'string' || data.id === '') {
        throw new WorkflowError('AirtableAdapter: create_record response missing id field', {
          code: 'SERVICE_RESPONSE_INVALID',
          category: 'SERVICE',
          agentAction: 'report_to_user',
          retryable: false,
        });
      }

      return { status: response.status, data: parsed };
    }

    throw new WorkflowError(`AirtableAdapter: unsupported create operation "${operation}"`, {
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
    if (operation === 'upsert_record') {
      const table = params['table'];
      const fields = params['fields'];
      const fieldsToMergeOn = params['fields_to_merge_on'];

      if (typeof table !== 'string' || table === '') {
        throw new WorkflowError('AirtableAdapter: table param must be a non-empty string', {
          code: 'ADAPTER_VALIDATION_FAILED',
          category: 'ENGINE',
          agentAction: 'provide_input',
          retryable: false,
        });
      }
      if (
        fields === undefined ||
        fields === null ||
        typeof fields !== 'object' ||
        Array.isArray(fields)
      ) {
        throw new WorkflowError('AirtableAdapter: fields param must be a plain object', {
          code: 'ADAPTER_VALIDATION_FAILED',
          category: 'ENGINE',
          agentAction: 'provide_input',
          retryable: false,
        });
      }

      // Validate fields_to_merge_on: must be a non-empty array of non-empty strings
      if (!Array.isArray(fieldsToMergeOn) || fieldsToMergeOn.length === 0) {
        throw new WorkflowError(
          'AirtableAdapter: fields_to_merge_on must be a non-empty array of non-empty strings',
          {
            code: 'ADAPTER_VALIDATION_FAILED',
            category: 'ENGINE',
            agentAction: 'provide_input',
            retryable: false,
          },
        );
      }
      for (const element of fieldsToMergeOn) {
        if (typeof element !== 'string' || element === '') {
          throw new WorkflowError(
            'AirtableAdapter: fields_to_merge_on must be a non-empty array of non-empty strings',
            {
              code: 'ADAPTER_VALIDATION_FAILED',
              category: 'ENGINE',
              agentAction: 'provide_input',
              retryable: false,
            },
          );
        }
      }

      const body: Record<string, unknown> = {
        records: [{ fields }],
        performUpsert: { fieldsToMergeOn },
      };
      if (params['typecast'] === true) {
        body['typecast'] = true;
      }

      const url = this.buildUrl(table);
      const response = await this.executeRequest(url, 'POST', body, signal);

      if (!response.ok) {
        await this.throwHttpError(response, 'upsert_record');
      }

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        throw new WorkflowError('AirtableAdapter: failed to parse response body', {
          code: 'SERVICE_RESPONSE_INVALID',
          category: 'SERVICE',
          agentAction: 'report_to_user',
          retryable: false,
        });
      }

      const data = parsed as { records?: unknown };
      if (!Array.isArray(data.records)) {
        throw new WorkflowError('AirtableAdapter: upsert_record response missing records array', {
          code: 'SERVICE_RESPONSE_INVALID',
          category: 'SERVICE',
          agentAction: 'report_to_user',
          retryable: false,
        });
      }

      return { status: response.status, data: parsed };
    }

    throw new WorkflowError(`AirtableAdapter: unsupported update operation "${operation}"`, {
      code: 'ADAPTER_OP_UNSUPPORTED',
      category: 'ENGINE',
      agentAction: 'report_to_user',
      retryable: false,
    });
  }
}
