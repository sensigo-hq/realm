// Service adapter — handles communication with a specific external API.

export interface ServiceResponse {
  status: number;
  data: unknown;
}

/**
 * Service adapter — handles communication with a specific external API.
 *
 * Implementors that perform multi-step operations (paginated fetch, multi-part upload,
 * sequential writes) must check `signal?.aborted` between steps and throw if true.
 * Passing the signal to native `fetch()` handles single-request cancellation automatically.
 *
 * Method semantics:
 * - `fetch`  — read or query; must be safe and idempotent.
 * - `create` — write a new resource; may be non-idempotent.
 * - `update` — mutate an existing resource; typically idempotent when addressed by ID.
 * - `delete` — remove an existing resource. Optional: only implement when the adapter
 *              supports deletion. The engine throws `ADAPTER_OP_UNSUPPORTED` if a workflow
 *              step requests `service_method: delete` but the adapter omits this method.
 */
export interface ServiceAdapter {
  readonly id: string;
  fetch(
    operation: string,
    params: Record<string, unknown>,
    config: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ServiceResponse>;
  create(
    operation: string,
    params: Record<string, unknown>,
    config: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ServiceResponse>;
  update(
    operation: string,
    params: Record<string, unknown>,
    config: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ServiceResponse>;
  delete?(
    operation: string,
    params: Record<string, unknown>,
    config: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ServiceResponse>;
}
