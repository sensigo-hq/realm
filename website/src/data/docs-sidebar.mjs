// The docs sidebar, in reading order. astro.config.mjs gives it to Starlight; llms.txt lists the pages
// in the same groups; the preview images name a page's group.

export const DOCS_SIDEBAR = [
  {
    label: 'Start here',
    items: [
      'docs/start/what-is-realm',
      'docs/start/install-and-first-run',
      'docs/start/how-a-run-moves',
    ],
  },
  {
    label: 'Concepts',
    items: [
      'docs/concepts/workflows-steps-and-runs',
      'docs/concepts/step-kinds',
      'docs/concepts/order-and-routing',
      'docs/concepts/gates-and-trust',
      'docs/concepts/evidence',
      'docs/concepts/who-drives-a-run',
    ],
  },
  {
    label: 'Guides',
    collapsed: true,
    items: [
      'docs/guides/first-workflow',
      'docs/guides/call-a-service',
      'docs/guides/agent-steps',
      'docs/guides/agent-tools',
      'docs/guides/human-gates',
      'docs/guides/step-handlers',
      'docs/guides/realm-agent',
      'docs/guides/connect-an-mcp-client',
      'docs/guides/webhooks',
      'docs/guides/slack-gates',
      'docs/guides/handle-failure',
      'docs/guides/idempotency-and-batches',
      'docs/guides/test-a-workflow',
      'docs/guides/operate-runs',
      'docs/guides/deploy',
      'docs/guides/agent-created-workflows',
      'docs/guides/upgrade',
    ],
  },
  {
    label: 'Reference: workflow file',
    collapsed: true,
    items: [
      'docs/reference/workflow/top-level-fields',
      'docs/reference/workflow/step-fields',
      'docs/reference/workflow/input-map-and-templates',
      'docs/reference/workflow/conditions',
      'docs/reference/workflow/gates',
      'docs/reference/workflow/retry-and-timeouts',
      'docs/reference/workflow/agent-step-controls',
      'docs/reference/workflow/services-profiles-and-context',
      'docs/reference/workflow/webhook-trigger',
      'docs/reference/workflow/json-schema-blocks',
      'docs/reference/workflow/loader-diagnostics',
    ],
  },
  {
    label: 'Reference: command line',
    collapsed: true,
    items: [
      'docs/reference/cli/realm-workflow',
      'docs/reference/cli/realm-run-reading',
      'docs/reference/cli/realm-run-acting',
      'docs/reference/cli/realm-agent',
      'docs/reference/cli/realm-listen',
      'docs/reference/cli/realm-mcp-and-serve',
    ],
  },
  {
    label: 'Reference: MCP',
    collapsed: true,
    items: ['docs/reference/mcp/tools', 'docs/reference/mcp/run-state-and-health'],
  },
  {
    label: 'Reference: code and settings',
    collapsed: true,
    items: [
      'docs/reference/adapters',
      'docs/reference/handlers',
      'docs/reference/deployment-manifest',
      'docs/reference/project-extensions',
      'docs/reference/testing-package',
      'docs/reference/core-library',
    ],
  },
  {
    label: 'Reference: lookups',
    collapsed: true,
    items: [
      'docs/reference/error-codes',
      'docs/reference/run-record-and-export',
      'docs/reference/environment-and-files',
      'docs/reference/glossary',
    ],
  },
];

// The docs index (docs/README.md) is reached from the header, not the sidebar.
export const DOCS_INDEX_ID = 'docs';

/** Whether a content entry is a docs page. The other entry is the 404 page (scripts/sync-docs.mjs). */
export function isDocsPageId(id) {
  return id === DOCS_INDEX_ID || id.startsWith(`${DOCS_INDEX_ID}/`);
}

// Pages kept at their old addresses so that old links still work. Each one only links to the pages
// that replaced it, so the sidebar and llms.txt leave them out.
export const REPLACED_PAGE_IDS = [
  'docs/getting-started',
  'docs/reference/cli-commands',
  'docs/reference/mcp-protocol',
  'docs/reference/operating-runs',
  'docs/reference/realm-agent-slack',
  'docs/reference/testing',
  'docs/reference/yaml-schema',
];

/** The sidebar group a docs page is in, or undefined for the index and the replaced pages. */
export function groupOf(id) {
  return DOCS_SIDEBAR.find((group) => group.items.includes(id))?.label;
}

/**
 * Throws unless every docs page is in exactly one of: the sidebar, the index, the replaced pages; and
 * every id listed there is a page. A new page that nobody put in the sidebar fails the build here, instead
 * of being reachable only by its address and missing from llms.txt.
 */
export function assertDocsListed(pageIds) {
  const listed = [...DOCS_SIDEBAR.flatMap((g) => g.items), DOCS_INDEX_ID, ...REPLACED_PAGE_IDS];
  const problems = [];
  for (const id of pageIds) {
    const n = listed.filter((l) => l === id).length;
    if (n === 0) problems.push(`${id}: in no sidebar group (src/data/docs-sidebar.mjs)`);
    if (n > 1) problems.push(`${id}: listed ${n} times in src/data/docs-sidebar.mjs`);
  }
  for (const id of new Set(listed)) {
    if (!pageIds.includes(id))
      problems.push(`${id}: listed in src/data/docs-sidebar.mjs but no such page`);
  }
  if (problems.length > 0)
    throw new Error(`Docs pages and the sidebar disagree:\n  ${problems.join('\n  ')}`);
}
