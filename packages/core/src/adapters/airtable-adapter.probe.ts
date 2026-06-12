// Contract probe for AirtableAdapter — hits the real Airtable API.
// Requires AIRTABLE_TEST_API_KEY, AIRTABLE_TEST_BASE_ID, and AIRTABLE_TEST_TABLE.
// Run via `npm run test:contract --workspace=packages/core`.
import { it, expect } from 'vitest';
import { AirtableAdapter } from './airtable-adapter.js';

it.skipIf(
  !process.env['AIRTABLE_TEST_API_KEY'] ||
    !process.env['AIRTABLE_TEST_BASE_ID'] ||
    !process.env['AIRTABLE_TEST_TABLE'],
)(
  'contract probe — real API (requires AIRTABLE_TEST_API_KEY + AIRTABLE_TEST_BASE_ID + AIRTABLE_TEST_TABLE)',
  async () => {
    const apiKey = process.env['AIRTABLE_TEST_API_KEY'] ?? '';
    const baseId = process.env['AIRTABLE_TEST_BASE_ID'] ?? '';
    const table = process.env['AIRTABLE_TEST_TABLE'] ?? '';

    const adapter = new AirtableAdapter('airtable', { api_key: apiKey, base_id: baseId });
    const result = await adapter.fetch('list_records', { table }, {});
    expect(result.status).toBe(200);
    const data = result.data as { records: unknown[] };
    expect(Array.isArray(data.records)).toBe(true);
  },
);
