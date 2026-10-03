import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { THEME_INIT } from './src/lib/theme-init.mjs';
import { ICON_LINKS, THEME_COLOR } from './src/lib/favicon.mjs';

export default defineConfig({
  site: 'https://realmengine.dev',
  integrations: [
    starlight({
      title: 'Realm',
      description:
        'A workflow state machine that agents call. Wrong behaviour becomes impossible, not prohibited.',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/sensigo-hq/realm' }],
      customCss: ['./src/styles/tokens.css'],
      // the Realm logo in place of the title text
      components: { SiteTitle: './src/components/SiteTitle.astro' },
      // Starlight writes the link for this one itself; the rest of the icon set is added in head below
      favicon: '/favicon.svg',
      head: [
        // dark for a first-time visitor, and one saved choice shared with the home page's switch
        { tag: 'script', content: THEME_INIT },
        ...ICON_LINKS.filter((l) => l.href !== '/favicon.svg').map((attrs) => ({
          tag: 'link',
          attrs,
        })),
        { tag: 'meta', attrs: { name: 'theme-color', content: THEME_COLOR } },
      ],
      disable404Route: false,
      sidebar: [
        {
          label: 'Start here',
          items: [
            'docs/start/what-realm-is',
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
      ],
    }),
  ],
});
