import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { THEME_INIT } from './src/lib/theme-init.mjs';
import { ICON_LINKS, THEME_COLOR } from './src/lib/favicon.mjs';
import { SITE_URL } from './src/lib/site-meta.mjs';
import { DOCS_SIDEBAR } from './src/data/docs-sidebar.mjs';

export default defineConfig({
  site: SITE_URL,
  integrations: [
    starlight({
      title: 'Realm',
      description:
        'A workflow state machine that agents call. Wrong behaviour becomes impossible, not prohibited.',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/sensigo-hq/realm' }],
      customCss: ['./src/styles/tokens.css'],
      // the Realm logo in place of the title text
      components: { SiteTitle: './src/components/SiteTitle.astro' },
      // each docs page's preview image, Markdown copy link and breadcrumb (src/route-data.mjs)
      routeMiddleware: './src/route-data.mjs',
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
      sidebar: DOCS_SIDEBAR,
    }),
  ],
});
