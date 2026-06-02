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
  /**
   * Default retry-after delay in seconds when the service returns HTTP 429
   * with no Retry-After header (or with an unparseable value).
   * Read by callAdapter() as the last-resort fallback after
   * rate_limit.fallback_retry_seconds. If undefined, no adapter-level
   * fallback is applied and retry_after remains undefined.
   */
  readonly defaultRetryAfterSeconds?: number;
  /**
   * Optional JSON Schema describing per-step config accepted by this adapter.
   * When declared, steps targeting this adapter may include a `config` field in YAML.
   * The engine validates step config against this schema at registration time.
   * If omitted, steps targeting this adapter must not declare `config`.
   */
  readonly config_schema?: Record<string, unknown>;
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
