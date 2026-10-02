// MockAdapter — returns pre-configured responses for named operations.
import { WorkflowError } from '../types/workflow-error.js';
import type { ServiceAdapter, ServiceResponse } from '../extensions/service-adapter.js';
import { brandClass, REALM_BRAND } from '../brand.js';

/**
 * MockAdapter returns pre-configured responses for named operations.
 * All three methods (fetch, create, update) look up the same responses map.
 * If an operation is not found, throws WorkflowError(ENGINE_ADAPTER_FAILED).
 */
export class MockAdapter implements ServiceAdapter {
  constructor(
    public readonly id: string,
    private readonly responses: Record<string, ServiceResponse>,
  ) {}

  private resolve(operation: string): ServiceResponse {
    const response = this.responses[operation];
    if (response === undefined) {
      throw new WorkflowError(`MockAdapter: unknown operation: ${operation}`, {
        code: 'ENGINE_ADAPTER_FAILED',
        category: 'ENGINE',
        agentAction: 'stop',
        retryable: false,
      });
    }
    return response;
  }

  async fetch(
    operation: string,
    _params: Record<string, unknown>,
    _config: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ServiceResponse> {
    if (signal?.aborted === true) {
      throw new WorkflowError('MockAdapter: request aborted', {
        code: 'STEP_ABORTED',
        category: 'ENGINE',
        agentAction: 'report_to_user',
        retryable: false,
      });
    }
    return this.resolve(operation);
  }

  async create(
    operation: string,
    _params: Record<string, unknown>,
    _config: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ServiceResponse> {
    if (signal?.aborted === true) {
      throw new WorkflowError('MockAdapter: request aborted', {
        code: 'STEP_ABORTED',
        category: 'ENGINE',
        agentAction: 'report_to_user',
        retryable: false,
      });
    }
    return this.resolve(operation);
  }

  async update(
    operation: string,
    _params: Record<string, unknown>,
    _config: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ServiceResponse> {
    if (signal?.aborted === true) {
      throw new WorkflowError('MockAdapter: request aborted', {
        code: 'STEP_ABORTED',
        category: 'ENGINE',
        agentAction: 'report_to_user',
        retryable: false,
      });
    }
    return this.resolve(operation);
  }
}

brandClass(MockAdapter, Symbol.for('@sensigo/realm/MockAdapter'), REALM_BRAND);
