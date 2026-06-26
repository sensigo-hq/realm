// AirtableAdapter — wraps the Airtable REST API for record-level operations.
import { WorkflowError } from '../types/workflow-error.js';
import type { ServiceAdapter, ServiceResponse } from '../extensions/service-adapter.js';
import { parseRetryAfterHeader } from './adapter-utils.js';

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
 *   fetch('search_records', { table, search_term, fields, ... }) — GET via filterByFormula
 *   create('create_record', { table, fields, ... })  — POST /v0/{base}/{table}
 *   update('upsert_record', { table, fields, ... })  — PATCH /v0/{base}/{table} (upsert via performUpsert)
 *   update('update_record', { table, record_id, fields, ... }) — PATCH /v0/{base}/{table}/{id}
 *   delete('delete_records', { table, record_ids })  — DELETE /v0/{base}/{table}?records[]=…
 */
export class AirtableAdapter implements ServiceAdapter {
  readonly id: string;
  readonly defaultRetryAfterSeconds = 30;
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
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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
    const airtableError =
      typeof body === 'object' && body !== null && 'error' in body
        ? (body as { error?: { type?: unknown; message?: unknown } }).error
        : undefined;
    const airtableMessage =
      typeof airtableError?.message === 'string' ? airtableError.message : undefined;
    const airtableType = typeof airtableError?.type === 'string' ? airtableError.type : undefined;
    const detailSuffix = airtableMessage !== undefined ? ` — ${airtableMessage}` : '';
    const baseDetails = {
      status,
      operation,
      ...(airtableType !== undefined ? { airtable_error_type: airtableType } : {}),
    };

    if (status === 401) {
      // PAT format hint (never include any part of the key itself).
      const dotCount = (this.apiKey.match(/\./g) ?? []).length;
      const formatHint =
        dotCount !== 1
          ? ' (API key format looks wrong: expected one "." in a PAT — check you copied the full token)'
          : '';
      throw new WorkflowError(`Airtable authentication failed — check API key${formatHint}`, {
        code: 'SERVICE_AUTH_FAILED',
        category: 'SERVICE',
        agentAction: 'stop',
        retryable: false,
        details: baseDetails,
      });
    }

    if (status === 403) {
      throw new WorkflowError(`Airtable: forbidden (HTTP 403)${detailSuffix}`, {
        code: 'SERVICE_HTTP_4XX',
        category: 'SERVICE',
        agentAction: 'stop',
        retryable: false,
        details: baseDetails,
      });
    }

    if (status === 404) {
      throw new WorkflowError(`Airtable: record not found${detailSuffix}`, {
        code: 'SERVICE_NOT_FOUND',
        category: 'SERVICE',
        agentAction: 'provide_input',
        retryable: false,
        details: baseDetails,
      });
    }

    if (status === 422) {
      throw new WorkflowError(`Airtable: unprocessable entity (HTTP 422)${detailSuffix}`, {
        code: 'SERVICE_HTTP_4XX',
        category: 'SERVICE',
        agentAction: 'stop',
        retryable: false,
        details: { ...baseDetails, body },
      });
    }

    if (status === 429) {
      const retryAfterFromHeader = parseRetryAfterHeader(response.headers.get('Retry-After'));
      throw new WorkflowError('Rate limited by Airtable API', {
        code: 'SERVICE_RATE_LIMITED',
        category: 'SERVICE',
        agentAction: 'wait_and_proceed',
        retryable: true,
        ...(retryAfterFromHeader !== undefined ? { retry_after: retryAfterFromHeader } : {}),
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
    throw new WorkflowError(`HTTP ${status}: ${response.statusText}${detailSuffix}`, {
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
      // Malformed sort entries are skipped silently, consistent with the permissive
      // param handling in this branch (e.g. non-string view is ignored, not an error).
      if (Array.isArray(params['sort'])) {
        (params['sort'] as unknown[]).forEach((entry, i) => {
          if (typeof entry === 'object' && entry !== null) {
            const e = entry as { field?: unknown; direction?: unknown };
            if (typeof e.field === 'string' && e.field !== '') {
              url.searchParams.set(`sort[${i}][field]`, e.field);
              if (e.direction === 'asc' || e.direction === 'desc') {
                url.searchParams.set(`sort[${i}][direction]`, e.direction);
              }
            }
          }
        });
      }

      // Bounded auto-pagination — opt-in via fetch_all: true. Two caps, whichever
      // hits first (mirrors the trace normalizer's count/byte-limit design). Caps
      // are stop conditions, not truncation: the page that crossed a limit is kept.
      if (params['fetch_all'] === true) {
        const rawMaxPages = params['max_pages'];
        const maxPages =
          typeof rawMaxPages === 'number' && Number.isFinite(rawMaxPages) && rawMaxPages >= 1
            ? Math.min(Math.floor(rawMaxPages), 10)
            : 3;
        const rawMaxBytes = params['max_bytes'];
        const maxBytes =
          typeof rawMaxBytes === 'number' && Number.isFinite(rawMaxBytes) && rawMaxBytes >= 1
            ? Math.min(Math.floor(rawMaxBytes), 1000000)
            : 100000;

        const allRecords: unknown[] = [];
        let pagesFetched = 0;
        let nextOffset: string | undefined;
        let truncationReason: 'page_limit' | 'byte_limit' | undefined;
        let lastStatus = 200;

        for (;;) {
          this.checkAborted(signal);
          const pageUrl = new URL(url.href);
          if (nextOffset !== undefined) {
            pageUrl.searchParams.set('offset', nextOffset);
          }
          const pageResponse = await this.executeRequest(pageUrl, 'GET', undefined, signal);

          if (!pageResponse.ok) {
            await this.throwHttpError(pageResponse, 'list_records');
          }

          let pageParsed: unknown;
          try {
            pageParsed = await pageResponse.json();
          } catch {
            throw new WorkflowError('AirtableAdapter: failed to parse response body', {
              code: 'SERVICE_RESPONSE_INVALID',
              category: 'SERVICE',
              agentAction: 'report_to_user',
              retryable: false,
            });
          }

          const page = pageParsed as { records?: unknown; offset?: unknown };
          if (!Array.isArray(page.records)) {
            throw new WorkflowError(
              'AirtableAdapter: list_records response missing records array',
              {
                code: 'SERVICE_RESPONSE_INVALID',
                category: 'SERVICE',
                agentAction: 'report_to_user',
                retryable: false,
              },
            );
          }

          lastStatus = pageResponse.status;
          allRecords.push(...(page.records as unknown[]));
          pagesFetched += 1;
          nextOffset = typeof page.offset === 'string' ? page.offset : undefined;

          // No further pages — the run is complete, not truncated.
          if (nextOffset === undefined) {
            break;
          }
          if (pagesFetched >= maxPages) {
            truncationReason = 'page_limit';
            break;
          }
          if (JSON.stringify(allRecords).length > maxBytes) {
            truncationReason = 'byte_limit';
            break;
          }
        }

        const truncated = truncationReason !== undefined;
        return {
          status: lastStatus,
          data: {
            records: allRecords,
            truncated,
            ...(truncated ? { truncation_reason: truncationReason } : {}),
            ...(truncated && nextOffset !== undefined ? { offset: nextOffset } : {}),
          },
        };
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

    if (operation === 'search_records') {
      const table = params['table'];
      const searchTerm = params['search_term'];
      const fields = params['fields'];

      if (typeof table !== 'string' || table === '') {
        throw new WorkflowError('AirtableAdapter: table param must be a non-empty string', {
          code: 'ADAPTER_VALIDATION_FAILED',
          category: 'ENGINE',
          agentAction: 'provide_input',
          retryable: false,
        });
      }
      if (typeof searchTerm !== 'string' || searchTerm === '') {
        throw new WorkflowError('AirtableAdapter: search_term param must be a non-empty string', {
          code: 'ADAPTER_VALIDATION_FAILED',
          category: 'ENGINE',
          agentAction: 'provide_input',
          retryable: false,
        });
      }
      // fields is required: the adapter has no schema discovery (by design), so the
      // workflow author must name the searchable fields.
      if (
        !Array.isArray(fields) ||
        fields.length === 0 ||
        fields.some((f) => typeof f !== 'string' || f === '')
      ) {
        throw new WorkflowError(
          'AirtableAdapter: fields param must be a non-empty array of non-empty strings — name the fields to search',
          {
            code: 'ADAPTER_VALIDATION_FAILED',
            category: 'ENGINE',
            agentAction: 'provide_input',
            retryable: false,
          },
        );
      }

      // Injection guard — escape " and \ in the term; never interpolate it raw.
      const escapedTerm = searchTerm.replace(/["\\]/g, '\\$&');
      const finds = (fields as string[]).map((f) => `FIND("${escapedTerm}", {${f}})`);
      const formula = finds.length === 1 ? finds.join('') : `OR(${finds.join(',')})`;

      const url = this.buildUrl(table);
      url.searchParams.set('filterByFormula', formula);
      if (typeof params['view'] === 'string') {
        url.searchParams.set('view', params['view']);
      }
      if (typeof params['max_records'] === 'number') {
        url.searchParams.set('maxRecords', String(params['max_records']));
      }

      const response = await this.executeRequest(url, 'GET', undefined, signal);

      if (!response.ok) {
        await this.throwHttpError(response, 'search_records');
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
        throw new WorkflowError('AirtableAdapter: search_records response missing records array', {
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
      // Airtable accepts `performUpsert` ONLY on PATCH /v0/{base}/{table}; POST returns HTTP 422.
      const response = await this.executeRequest(url, 'PATCH', body, signal);

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

    if (operation === 'update_record') {
      const table = params['table'];
      const recordId = params['record_id'];
      const fields = params['fields'];

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

      const url = this.buildUrl(table, recordId);
      const response = await this.executeRequest(url, 'PATCH', body, signal);

      if (!response.ok) {
        await this.throwHttpError(response, 'update_record');
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
        throw new WorkflowError('AirtableAdapter: update_record response missing id field', {
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

  async delete(
    operation: string,
    params: Record<string, unknown>,
    _config: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ServiceResponse> {
    if (operation === 'delete_records') {
      const table = params['table'];
      const recordIds = params['record_ids'];

      if (typeof table !== 'string' || table === '') {
        throw new WorkflowError('AirtableAdapter: table param must be a non-empty string', {
          code: 'ADAPTER_VALIDATION_FAILED',
          category: 'ENGINE',
          agentAction: 'provide_input',
          retryable: false,
        });
      }
      if (!Array.isArray(recordIds) || recordIds.length === 0) {
        throw new WorkflowError(
          'AirtableAdapter: record_ids must be a non-empty array of non-empty strings',
          {
            code: 'ADAPTER_VALIDATION_FAILED',
            category: 'ENGINE',
            agentAction: 'provide_input',
            retryable: false,
          },
        );
      }
      if (recordIds.length > 10) {
        throw new WorkflowError(
          'AirtableAdapter: record_ids accepts at most 10 ids per call (Airtable API limit) — split into multiple steps',
          {
            code: 'ADAPTER_VALIDATION_FAILED',
            category: 'ENGINE',
            agentAction: 'provide_input',
            retryable: false,
          },
        );
      }
      for (const element of recordIds) {
        if (typeof element !== 'string' || element === '') {
          throw new WorkflowError(
            'AirtableAdapter: record_ids must be a non-empty array of non-empty strings',
            {
              code: 'ADAPTER_VALIDATION_FAILED',
              category: 'ENGINE',
              agentAction: 'provide_input',
              retryable: false,
            },
          );
        }
      }

      // One API call only — never chunk internally: partial deletion across
      // chunks would corrupt evidence semantics.
      const url = this.buildUrl(table);
      for (const id of recordIds as string[]) {
        url.searchParams.append('records[]', id);
      }
      const response = await this.executeRequest(url, 'DELETE', undefined, signal);

      if (!response.ok) {
        await this.throwHttpError(response, 'delete_records');
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
        throw new WorkflowError('AirtableAdapter: delete_records response missing records array', {
          code: 'SERVICE_RESPONSE_INVALID',
          category: 'SERVICE',
          agentAction: 'report_to_user',
          retryable: false,
        });
      }
      for (const element of data.records) {
        const record = element as { id?: unknown; deleted?: unknown };
        if (typeof record.id !== 'string' || record.id === '' || record.deleted !== true) {
          throw new WorkflowError(
            'AirtableAdapter: delete_records response element missing id or deleted: true',
            {
              code: 'SERVICE_RESPONSE_INVALID',
              category: 'SERVICE',
              agentAction: 'report_to_user',
              retryable: false,
            },
          );
        }
      }

      return { status: response.status, data: parsed };
    }

    throw new WorkflowError(`AirtableAdapter: unsupported delete operation "${operation}"`, {
      code: 'ADAPTER_OP_UNSUPPORTED',
      category: 'ENGINE',
      agentAction: 'report_to_user',
      retryable: false,
    });
  }
}
