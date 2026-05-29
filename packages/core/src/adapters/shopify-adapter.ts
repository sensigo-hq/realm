// ShopifyAdapter — communicates with the Shopify Admin GraphQL API.
import { WorkflowError } from '../types/workflow-error.js';
import type { ServiceAdapter, ServiceResponse } from '../extensions/service-adapter.js';

const SHOPIFY_DEFAULT_API_VERSION = '2024-04';

const ORDERS_BY_NAME_QUERY = `
query OrderByName($query: String!) {
  orders(first: 1, query: $query) {
    edges {
      node {
        id
        legacyResourceId
        number
        name
        displayFinancialStatus
        displayFulfillmentStatus
        cancelledAt
        cancelReason
        createdAt
        customer {
          firstName
          lastName
          email
        }
        currentTotalPriceSet {
          shopMoney { amount currencyCode }
        }
        currentSubtotalPriceSet {
          shopMoney { amount }
        }
        currentShippingPriceSet {
          shopMoney { amount }
        }
        discountCodes
        lineItems(first: 50) {
          edges {
            node {
              name
              quantity
              originalUnitPriceSet {
                shopMoney { amount }
              }
            }
          }
        }
      }
    }
  }
}
`.trim();

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

/** Normalized order returned by fetch('get_order'). */
export interface NormalizedOrder {
  /** Shopify global ID, e.g. "gid://shopify/Order/450789469" */
  id: string;
  /** Legacy numeric REST resource ID, e.g. "450789469" */
  legacy_id: string;
  /** Sequential order number, e.g. 1234 */
  order_number: number;
  /** Order name with store prefix, e.g. "#1234" or "#B1001" */
  name: string;
  /** Financial status for display, e.g. "PAID". Null if not available. */
  financial_status: string | null;
  /** Fulfillment status for display, e.g. "FULFILLED". Always present. */
  fulfillment_status: string;
  /** ISO 8601 datetime when the order was cancelled, or null. */
  cancelled_at: string | null;
  /** Cancellation reason, or null. */
  cancel_reason: string | null;
  /** ISO 8601 datetime when the order was created. */
  created_at: string;
  /** Customer details. Null for guest checkouts. */
  customer: {
    first_name: string;
    last_name: string;
    /** Customer email. Null for phone-only customers. */
    email: string | null;
  } | null;
  /** Total order price including taxes and discounts, as a decimal string e.g. "99.99". */
  total_price: string;
  /** Subtotal price, as a decimal string. */
  subtotal_price: string;
  /** Current shipping price after refunds and discounts, as a decimal string. "0.00" if no shipping. */
  shipping_total: string;
  /** Currency code for shop money, e.g. "EUR". */
  currency: string;
  /** Discount codes applied to the order. */
  discount_codes: string[];
  /** Order line items. */
  line_items: Array<{
    name: string;
    quantity: number;
    price: string;
  }>;
}

/** Raw GraphQL node shape from the Shopify API. */
interface ShopifyOrderNode {
  id: unknown;
  legacyResourceId: unknown;
  number: unknown;
  name: unknown;
  displayFinancialStatus: unknown;
  displayFulfillmentStatus: unknown;
  cancelledAt: unknown;
  cancelReason: unknown;
  createdAt: unknown;
  customer:
    | {
        firstName: string;
        lastName: string;
        email: string;
      }
    | null
    | undefined;
  currentTotalPriceSet:
    | { shopMoney: { amount: unknown; currencyCode: unknown } }
    | null
    | undefined;
  currentSubtotalPriceSet: { shopMoney: { amount: unknown } } | null | undefined;
  currentShippingPriceSet: { shopMoney: { amount: unknown } } | null | undefined;
  discountCodes: unknown;
  lineItems:
    | {
        edges: Array<{
          node: {
            name: string;
            quantity: number;
            originalUnitPriceSet: { shopMoney: { amount: unknown } } | null | undefined;
          };
        }>;
      }
    | null
    | undefined;
}

/**
 * ShopifyAdapter communicates with the Shopify Admin GraphQL API.
 *
 * Supported operations:
 *   fetch('get_order', { store, order_name })   — POST /admin/api/{version}/graphql.json
 */
export class ShopifyAdapter implements ServiceAdapter {
  readonly id: string;
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
      throw new WorkflowError('Rate limited by Shopify API', {
        code: 'SERVICE_RATE_LIMITED',
        category: 'SERVICE',
        agentAction: 'wait_for_human',
        retryable: true,
        details: { ...details, retry_after: response.headers.get('Retry-After') ?? undefined },
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

  private normalizeOrder(
    node: ShopifyOrderNode,
    store: string,
    normalizedOrderName: string,
  ): NormalizedOrder {
    if (typeof node.id !== 'string' || node.id === '') {
      throw new WorkflowError('ShopifyAdapter: missing order id in response', {
        code: 'SERVICE_RESPONSE_INVALID',
        category: 'SERVICE',
        agentAction: 'report_to_user',
        retryable: false,
      });
    }
    if (typeof node.number !== 'number') {
      throw new WorkflowError('ShopifyAdapter: missing order number in response', {
        code: 'SERVICE_RESPONSE_INVALID',
        category: 'SERVICE',
        agentAction: 'report_to_user',
        retryable: false,
      });
    }
    if (typeof node.displayFulfillmentStatus !== 'string' || node.displayFulfillmentStatus === '') {
      throw new WorkflowError('ShopifyAdapter: missing fulfillment_status in response', {
        code: 'SERVICE_RESPONSE_INVALID',
        category: 'SERVICE',
        agentAction: 'report_to_user',
        retryable: false,
      });
    }
    if (typeof node.createdAt !== 'string') {
      throw new WorkflowError('ShopifyAdapter: missing created_at in response', {
        code: 'SERVICE_RESPONSE_INVALID',
        category: 'SERVICE',
        agentAction: 'report_to_user',
        retryable: false,
      });
    }

    const totalPrice = node.currentTotalPriceSet?.shopMoney?.amount;
    if (typeof totalPrice !== 'string') {
      throw new WorkflowError('ShopifyAdapter: missing total_price in response', {
        code: 'SERVICE_RESPONSE_INVALID',
        category: 'SERVICE',
        agentAction: 'report_to_user',
        retryable: false,
      });
    }

    const subtotalPrice = node.currentSubtotalPriceSet?.shopMoney?.amount;
    if (typeof subtotalPrice !== 'string') {
      throw new WorkflowError('ShopifyAdapter: missing subtotal_price in response', {
        code: 'SERVICE_RESPONSE_INVALID',
        category: 'SERVICE',
        agentAction: 'report_to_user',
        retryable: false,
      });
    }

    const customer =
      node.customer != null
        ? {
            first_name: node.customer.firstName,
            last_name: node.customer.lastName,
            email: node.customer.email || null,
          }
        : null;

    const lineItems = (node.lineItems?.edges ?? []).map((edge) => ({
      name: edge.node.name,
      quantity: edge.node.quantity,
      price: (edge.node.originalUnitPriceSet?.shopMoney?.amount as string | undefined) ?? '0.00',
    }));

    void store;
    void normalizedOrderName;

    return {
      id: node.id,
      legacy_id: String(node.legacyResourceId ?? ''),
      order_number: node.number,
      name: String(node.name ?? ''),
      financial_status:
        typeof node.displayFinancialStatus === 'string' ? node.displayFinancialStatus : null,
      fulfillment_status: node.displayFulfillmentStatus,
      cancelled_at: typeof node.cancelledAt === 'string' ? node.cancelledAt : null,
      cancel_reason: typeof node.cancelReason === 'string' ? node.cancelReason : null,
      created_at: node.createdAt,
      customer,
      total_price: totalPrice,
      subtotal_price: subtotalPrice,
      shipping_total:
        (node.currentShippingPriceSet?.shopMoney?.amount as string | undefined) ?? '0.00',
      currency: (node.currentTotalPriceSet?.shopMoney?.currencyCode as string | undefined) ?? '',
      discount_codes: Array.isArray(node.discountCodes) ? (node.discountCodes as string[]) : [],
      line_items: lineItems,
    };
  }

  async fetch(
    operation: string,
    params: Record<string, unknown>,
    _config: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ServiceResponse> {
    // config.auth is ignored — auth is set at construction time via stores map

    if (operation === 'get_order') {
      // Validate store param
      const store = params['store'];
      if (typeof store !== 'string') {
        throw new WorkflowError('ShopifyAdapter: store param must be a string', {
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

      // Validate order_name
      const rawOrderName = params['order_name'];
      if (typeof rawOrderName !== 'string' || rawOrderName === '') {
        throw new WorkflowError('ShopifyAdapter: order_name param must be a non-empty string', {
          code: 'ADAPTER_VALIDATION_FAILED',
          category: 'ENGINE',
          agentAction: 'provide_input',
          retryable: false,
        });
      }

      // Normalize order_name
      let normalizedOrderName = rawOrderName.trim();
      if (!normalizedOrderName.startsWith('#')) {
        normalizedOrderName = '#' + normalizedOrderName;
      }
      if (!/^#.+$/.test(normalizedOrderName)) {
        throw new WorkflowError('ShopifyAdapter: order_name is invalid after normalization', {
          code: 'ADAPTER_VALIDATION_FAILED',
          category: 'ENGINE',
          agentAction: 'provide_input',
          retryable: false,
        });
      }

      const base = this.baseUrlOverride ?? `https://${storeConfig.shop_domain}`;
      const url = `${base}/admin/api/${this.apiVersion}/graphql.json`;

      const requestOptions: RequestInit = {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': storeConfig.access_token,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          query: ORDERS_BY_NAME_QUERY,
          variables: { query: `name:${normalizedOrderName}` },
        }),
      };

      const response = await this.executeRequest(url, requestOptions, signal);

      if (!response.ok) {
        await this.throwHttpError(response, 'get_order');
      }

      // Parse JSON response
      let gqlBody: unknown;
      try {
        gqlBody = await response.json();
      } catch {
        throw new WorkflowError('ShopifyAdapter: failed to parse GraphQL response', {
          code: 'SERVICE_RESPONSE_INVALID',
          category: 'SERVICE',
          agentAction: 'report_to_user',
          retryable: false,
        });
      }

      const body = gqlBody as Record<string, unknown>;

      // Check for GraphQL errors
      if (Array.isArray(body['errors']) && (body['errors'] as unknown[]).length > 0) {
        const errors = body['errors'] as Array<Record<string, unknown>>;
        const firstError = errors[0] as Record<string, unknown> | undefined;
        const extensions = firstError?.['extensions'] as Record<string, unknown> | undefined;
        if (extensions?.['code'] === 'THROTTLED') {
          throw new WorkflowError('Shopify GraphQL rate limited', {
            code: 'SERVICE_RATE_LIMITED',
            category: 'SERVICE',
            agentAction: 'wait_for_human',
            retryable: true,
          });
        }
        throw new WorkflowError('ShopifyAdapter: GraphQL errors in response', {
          code: 'SERVICE_RESPONSE_INVALID',
          category: 'SERVICE',
          agentAction: 'report_to_user',
          retryable: false,
          details: { errors: body['errors'] },
        });
      }

      // Validate edges shape
      const data = body['data'] as Record<string, unknown> | undefined;
      const orders = data?.['orders'] as Record<string, unknown> | undefined;
      const edges = orders?.['edges'];
      if (!Array.isArray(edges)) {
        throw new WorkflowError('ShopifyAdapter: unexpected response shape — edges not an array', {
          code: 'SERVICE_RESPONSE_INVALID',
          category: 'SERVICE',
          agentAction: 'report_to_user',
          retryable: false,
        });
      }

      if (edges.length === 0) {
        throw new WorkflowError('ShopifyAdapter: order not found', {
          code: 'SERVICE_NOT_FOUND',
          category: 'SERVICE',
          agentAction: 'provide_input',
          retryable: false,
          details: { store, order_name: normalizedOrderName },
        });
      }

      if (edges.length > 1) {
        throw new WorkflowError('ShopifyAdapter: unexpected multiple edges for first:1 query', {
          code: 'SERVICE_RESPONSE_INVALID',
          category: 'SERVICE',
          agentAction: 'report_to_user',
          retryable: false,
        });
      }

      const edge = edges[0] as { node: ShopifyOrderNode };
      const normalizedOrder = this.normalizeOrder(edge.node, store, normalizedOrderName);
      return { status: 200, data: normalizedOrder };
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
