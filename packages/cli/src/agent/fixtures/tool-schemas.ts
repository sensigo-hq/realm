// Tool-argument schema fixtures for issue #311 (strict MCP tool-call arguments).
//
// Three populations, each earning its place:
//   1. REAL, third-party, ineligible — proves the verdict function's behaviour against a schema
//      realm did not author and cannot change.
//   2. SYNTHETIC eligible — no public MCP server in the census ships a clean strict-attachable
//      schema (0/238 clean; 21/238 attachable, 20 of those from one server via a converter
//      accident), so the eligible cells MUST be synthetic. They are honest clones in shape, not
//      inventions of a schema style nobody uses.
//   3. CONVERTER-DERIVED with caveats — the shape a zod-v3-style converter emits: explicit
//      `additionalProperties: false` plus a `$schema` dialect stamp and optional properties.
//
// ATTRIBUTION — the fixture in population 1 is copied VERBATIM from:
//   github/github-mcp-server, pkg/github/__toolsnaps__/list_pull_requests.snap
//   Licence: MIT (Copyright (c) 2024 GitHub, Inc.)
//   Snapshot: commit 0ea1f775a7c73eff1bd2e25904d01136756bbfe2, fetched 2026-08-16.
// It is a SNAPSHOT, deliberately frozen: it pins how realm assesses a real published tool schema
// as of that date. If upstream changes its schema, this fixture must NOT be silently refreshed —
// re-snapshot it deliberately, with the commit and date updated here, and re-read the pins.

/**
 * REAL, unmodified: GitHub's `list_pull_requests` tool.
 *
 * Ineligible for strict, and it fails for BOTH of the census's dominant reasons at once:
 *   - no `additionalProperties: false` anywhere (G1 — near-universal in the wild: 192/193
 *     measured schemas), and
 *   - `minimum`/`maximum` on the pagination parameters (G2-hard — the dominant github class,
 *     54 of 116 tools).
 * Neither is realm's to fix: this schema belongs to the MCP server that publishes it.
 */
export const GITHUB_LIST_PULL_REQUESTS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['owner', 'repo'],
  properties: {
    base: { description: 'Filter by base branch', type: 'string' },
    direction: { description: 'Sort direction', enum: ['asc', 'desc'], type: 'string' },
    fields: {
      description:
        "Subset of fields to return for each pull request. If omitted, all fields are returned. Use this to reduce response size when you only need specific fields; omitting 'body' in particular drops the largest per-result data.",
      items: {
        enum: [
          'number',
          'title',
          'body',
          'state',
          'draft',
          'merged',
          'mergeable_state',
          'html_url',
          'user',
          'labels',
          'assignees',
          'requested_reviewers',
          'merged_by',
          'head',
          'base',
          'additions',
          'deletions',
          'changed_files',
          'commits',
          'comments',
          'created_at',
          'updated_at',
          'closed_at',
          'merged_at',
          'milestone',
        ],
        type: 'string',
      },
      type: 'array',
    },
    head: { description: 'Filter by head user/org and branch', type: 'string' },
    owner: { description: 'Repository owner', type: 'string' },
    page: { description: 'Page number for pagination (min 1)', minimum: 1, type: 'number' },
    perPage: {
      description: 'Results per page for pagination (min 1, max 100)',
      maximum: 100,
      minimum: 1,
      type: 'number',
    },
    repo: { description: 'Repository name', type: 'string' },
    sort: {
      description: 'Sort by',
      enum: ['created', 'updated', 'popularity', 'long-running'],
      type: 'string',
    },
    state: { description: 'Filter by state', type: 'string' },
  },
};

/**
 * SYNTHETIC, strict-eligible with ZERO optional properties — the only shape that draws no
 * caveats at all. Every property is `required`, so it also consumes zero of the 24-optional
 * budget, which makes it the neutral element in the budget-composition pins.
 */
export const ELIGIBLE_NO_OPTIONALS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['owner', 'repo'],
  properties: {
    owner: { type: 'string', description: 'Repository owner' },
    repo: { type: 'string', description: 'Repository name' },
  },
};

/**
 * SYNTHETIC, ineligible (no `additionalProperties: false`) and carrying ZERO optional properties.
 *
 * The zero-optional part is load-bearing for test isolation: it lets a pin use an ineligible tool
 * WITHOUT that tool's optional count being able to disturb the budget arithmetic, so a mutation
 * to the eligible-only budget rule reds only the pin that targets that rule.
 */
export const INELIGIBLE_NO_OPTIONALS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['x'],
  properties: { x: { type: 'string' } },
};

/**
 * Builds a synthetic strict-eligible schema with exactly `optionalCount` optional properties —
 * the budget pins need precise, arbitrary optional counts (up to and across the API's 24 limit)
 * that no real corpus schema happens to provide.
 */
export function eligibleWithOptionals(optionalCount: number): Record<string, unknown> {
  const properties: Record<string, unknown> = { id: { type: 'string' } };
  for (let i = 0; i < optionalCount; i += 1) {
    properties[`opt_${i}`] = { type: 'string' };
  }
  return {
    type: 'object',
    additionalProperties: false,
    required: ['id'], // `id` is required, so exactly `optionalCount` properties are optional
    properties,
  };
}

/**
 * CONVERTER-DERIVED: the shape a zod-v3-style `toJSONSchema` emits — an explicit
 * `additionalProperties: false` (which is why this class is strict-attachable at all) alongside a
 * `$schema` dialect stamp and optional properties.
 *
 * Eligible WITH caveats, and it is the realistic caveat cell: the census found the `$schema`
 * stamp to be the universal caveat driver, and any optional property additionally draws
 * `optional_emission`. Both are informational — neither blocks strict.
 */
export const CONVERTER_DERIVED_WITH_CAVEATS_SCHEMA: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['url'],
  properties: {
    url: { type: 'string', description: 'Target URL' },
    timeout: { type: 'number', description: 'Optional timeout in milliseconds' },
  },
};
