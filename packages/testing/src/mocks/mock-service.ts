// MockServiceRecorder — records all calls and returns pre-configured responses.
import {
  WorkflowError,
  brandClass,
  type ServiceAdapter,
  type ServiceResponse,
} from '@sensigo/realm';
import { REALM_TESTING_BRAND } from '../brand.js';

/** A single recorded call to the mock adapter. */
export interface RecordedCall {
  method: 'fetch' | 'create' | 'update';
  operation: string;
  params: Record<string, unknown>;
}

/**
 * MockServiceRecorder implements ServiceAdapter. Returns pre-configured responses
 * and records all calls for post-test assertions.
 */
export class MockServiceRecorder implements ServiceAdapter {
  /** Ordered list of all calls made to this adapter. */
  readonly calls: RecordedCall[] = [];

  constructor(
    public readonly id: string,
    private readonly responses: Record<string, ServiceResponse>,
  ) {}

  async fetch(
    operation: string,
    params: Record<string, unknown>,
    _config: Record<string, unknown>,
    _signal?: AbortSignal,
  ): Promise<ServiceResponse> {
    this.calls.push({ method: 'fetch', operation, params });
    return this.lookupResponse(operation);
  }

  async create(
    operation: string,
    params: Record<string, unknown>,
    _config: Record<string, unknown>,
    _signal?: AbortSignal,
  ): Promise<ServiceResponse> {
    this.calls.push({ method: 'create', operation, params });
    return this.lookupResponse(operation);
  }

  async update(
    operation: string,
    params: Record<string, unknown>,
    _config: Record<string, unknown>,
    _signal?: AbortSignal,
  ): Promise<ServiceResponse> {
    this.calls.push({ method: 'update', operation, params });
    return this.lookupResponse(operation);
  }

  private lookupResponse(operation: string): ServiceResponse {
    const response = this.responses[operation];
    if (response === undefined) {
      throw new WorkflowError(
        `MockServiceRecorder: no response configured for operation '${operation}'`,
        {
          code: 'ENGINE_ADAPTER_FAILED',
          category: 'ENGINE',
          agentAction: 'report_to_user',
          retryable: false,
        },
      );
    }
    return response;
  }
}

brandClass(
  MockServiceRecorder,
  Symbol.for('@sensigo/realm-testing/MockServiceRecorder'),
  REALM_TESTING_BRAND,
);
