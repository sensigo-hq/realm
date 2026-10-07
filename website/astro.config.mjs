import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import sitemap from '@astrojs/sitemap';
import sitemapAtRoot from './src/integrations/sitemap-at-root.mjs';
import { THEME_INIT } from './src/lib/theme-init.mjs';
import { ICON_LINKS, THEME_COLOR } from './src/lib/favicon.mjs';
import { HOME_DESCRIPTION, SITEMAP_PATH, SITE_URL } from './src/lib/site-meta.mjs';
import { DOCS_SIDEBAR } from './src/data/docs-sidebar.mjs';

export default defineConfig({
  site: SITE_URL,
  integrations: [
    starlight({
      title: 'Realm',
      // the description of a page without its own: only the 404 page (every docs page has one)
      description: HOME_DESCRIPTION,
      customCss: ['./src/styles/tokens.css'],
      // the Realm logo in place of the title text, and the site menu's links (src/data/nav.js) where
      // Starlight puts its social icons: the header's right side, and its menu on a narrow screen
      components: {
        SiteTitle: './src/components/SiteTitle.astro',
        SocialIcons: './src/components/DocsHeaderLinks.astro',
      },
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
        // replaces Starlight's own link to /sitemap-index.xml (see sitemapAtRoot below)
        { tag: 'link', attrs: { rel: 'sitemap', href: SITEMAP_PATH } },
      ],
      // Shiki, which colours code examples, stops colouring a line after 500 ms by default and
      // leaves the rest plain. That made the colours depend on how busy the build machine was,
      // and Astro keeps a rendered page in its cache, so a slow build's plain words stayed.
      // 0 removes the limit: the same docs always give the same colours, and a line that
      // could never finish would stop the build where everyone sees it.
      // Expressive Code passes no time-limit option to Shiki; a transformer's preprocess step
      // receives the very options object Shiki then tokenizes with.
      expressiveCode: {
        shiki: {
          transformers: [
            {
              name: 'realm-no-tokenize-time-limit',
              preprocess(code, options) {
                options.tokenizeTimeLimit = 0;
              },
            },
          ],
        },
      },
      disable404Route: false,
      sidebar: DOCS_SIDEBAR,
    }),
    // Listed here, sitemap() is used as is and Starlight adds no second copy of it. It must come
    // before sitemapAtRoot(), which moves its output to /sitemap.xml once it is written.
    sitemap(),
    sitemapAtRoot(),
  ],
});
