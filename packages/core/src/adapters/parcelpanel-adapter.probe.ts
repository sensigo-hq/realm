// Contract probe for ParcelPanelAdapter — hits the real ParcelPanel API.
// Requires PARCELPANEL_TEST_API_KEY and PARCELPANEL_TEST_STORE (optionally
// PARCELPANEL_TEST_ORDER_NUMBER). Run via `npm run test:contract --workspace=packages/core`.
import { it, expect } from 'vitest';
import { ParcelPanelAdapter } from './parcelpanel-adapter.js';
import type { NormalizedTracking } from './parcelpanel-adapter.js';

it.skipIf(!process.env['PARCELPANEL_TEST_API_KEY'] || !process.env['PARCELPANEL_TEST_STORE'])(
  'contract probe — real API (requires PARCELPANEL_TEST_API_KEY and PARCELPANEL_TEST_STORE)',
  async () => {
    const apiKey = process.env['PARCELPANEL_TEST_API_KEY'] ?? '';
    const store = process.env['PARCELPANEL_TEST_STORE'] ?? '';
    const orderNumber = process.env['PARCELPANEL_TEST_ORDER_NUMBER'] ?? '';

    const adapter = new ParcelPanelAdapter('parcelpanel', {
      stores: { [store]: apiKey },
    });

    const result = await adapter.fetch('get_tracking', { store, order_number: orderNumber }, {});
    expect(result.status).toBe(200);
    const data = result.data as NormalizedTracking;
    expect(typeof data.tracking_url).toBe('string');
    expect(data.tracking_url.length).toBeGreaterThan(0);
  },
);
