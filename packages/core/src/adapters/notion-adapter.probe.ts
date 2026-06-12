// Contract probe for NotionAdapter — hits the real Notion API.
// Requires NOTION_TEST_API_KEY. Run via `npm run test:contract --workspace=packages/core`.
import { it, expect } from 'vitest';
import { NotionAdapter } from './notion-adapter.js';

it.skipIf(!process.env['NOTION_TEST_API_KEY'])(
  'contract probe — real API (requires NOTION_TEST_API_KEY)',
  async () => {
    const apiKey = process.env['NOTION_TEST_API_KEY'] ?? '';
    const adapter = new NotionAdapter('notion', { api_key: apiKey });
    const result = await adapter.fetch('search', {}, {});
    expect(result.status).toBe(200);
    const data = result.data as { results: unknown[] };
    expect(Array.isArray(data.results)).toBe(true);
  },
);
