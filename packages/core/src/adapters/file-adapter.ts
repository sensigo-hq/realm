// FileSystemAdapter — reads files from the local filesystem for use in workflows.
import { readFile } from 'node:fs/promises';
import { WorkflowError } from '../types/workflow-error.js';
import type { ServiceAdapter, ServiceResponse } from '../extensions/service-adapter.js';

/**
 * FileSystemAdapter reads files from disk and returns their content as structured data.
 * Only the `fetch` method is meaningful; `create` and `update` are not supported.
 * Supported operations: 'read' — reads a file at `params.path` and returns content metadata.
 */
export class FileSystemAdapter implements ServiceAdapter {
  constructor(public readonly id: string) {}

  async fetch(
    operation: string,
    params: Record<string, unknown>,
    _config: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ServiceResponse> {
    if (operation !== 'read') {
      throw new WorkflowError(`unknown operation: ${operation}`, {
        code: 'ENGINE_ADAPTER_FAILED',
        category: 'ENGINE',
        agentAction: 'stop',
        retryable: false,
      });
    }

    const path = params['path'];
    if (typeof path !== 'string' || path.trim() === '') {
      throw new WorkflowError('path is required', {
        code: 'VALIDATION_EMPTY_VALUE',
        category: 'VALIDATION',
        agentAction: 'provide_input',
        retryable: false,
      });
    }

    if (!path.startsWith('/')) {
      throw new WorkflowError('path must be absolute', {
        code: 'VALIDATION_INPUT_SCHEMA',
        category: 'VALIDATION',
        agentAction: 'provide_input',
        retryable: false,
      });
    }

    let content: string;
    try {
      content = await readFile(path, { encoding: 'utf8', signal });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new WorkflowError('Adapter request aborted', {
          code: 'STEP_ABORTED',
          category: 'ENGINE',
          agentAction: 'report_to_user',
          retryable: false,
        });
      }
      const isEnoent = (err as NodeJS.ErrnoException).code === 'ENOENT';
      if (isEnoent) {
        throw new WorkflowError(`file not found: ${path}`, {
          code: 'RESOURCE_FETCH_FAILED',
          category: 'RESOURCE',
          agentAction: 'provide_input',
          retryable: false,
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new WorkflowError(message, {
        code: 'ENGINE_ADAPTER_FAILED',
        category: 'ENGINE',
        agentAction: 'stop',
        retryable: false,
      });
    }

    return {
      status: 200,
      data: {
        content,
        path,
        line_count: content.split('\n').length,
        size_bytes: Buffer.byteLength(content, 'utf8'),
      },
    };
  }

  async create(
    _operation: string,
    _params: Record<string, unknown>,
    _config: Record<string, unknown>,
    _signal?: AbortSignal,
  ): Promise<ServiceResponse> {
    throw new WorkflowError('not supported', {
      code: 'ENGINE_ADAPTER_FAILED',
      category: 'ENGINE',
      agentAction: 'stop',
      retryable: false,
    });
  }

  async update(
    _operation: string,
    _params: Record<string, unknown>,
    _config: Record<string, unknown>,
    _signal?: AbortSignal,
  ): Promise<ServiceResponse> {
    throw new WorkflowError('not supported', {
      code: 'ENGINE_ADAPTER_FAILED',
      category: 'ENGINE',
      agentAction: 'stop',
      retryable: false,
    });
  }
}
