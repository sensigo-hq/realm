// Starlight route middleware: adds each docs page's own tags to the head Starlight builds.
// Starlight already writes the title, the description, canonical, og:title/description/url and
// twitter:card; this adds what it does not: the preview image, the link to the page's Markdown copy, and
// the page's place in the site as structured data (a breadcrumb trail) for search engines.
import { defineRouteMiddleware } from '@astrojs/starlight/route-data';
import {
  SITE_NAME,
  absolute,
  docsPagePath,
  imageTags,
  jsonLdText,
  markdownPath,
} from './lib/site-meta.mjs';
import { DOCS_INDEX_ID, isDocsPageId } from './data/docs-sidebar.mjs';

export const onRequest = defineRouteMiddleware((context) => {
  const route = context.locals.starlightRoute;
  const id = route.id;
  // Only the docs pages; the 404 page has no source in ../docs and no copy.
  if (!isDocsPageId(id)) return;
  const title = route.entry.data.title;

  const trail = [
    { name: SITE_NAME, item: absolute('/') },
    { name: 'Documentation', item: absolute(docsPagePath(DOCS_INDEX_ID)) },
  ];
  // The last item is the page itself. It carries no address: Google's breadcrumb guide says the last
  // item needs none and is taken to be the page that holds the trail.
  if (id === DOCS_INDEX_ID) delete trail[1].item;
  else trail.push({ name: title });

  route.head.push(
    ...imageTags(
      id,
      id === DOCS_INDEX_ID ? 'Realm documentation' : `Realm documentation: ${title}`,
    ),
    {
      tag: 'link',
      attrs: { rel: 'alternate', type: 'text/markdown', href: markdownPath(id) },
    },
    {
      tag: 'script',
      attrs: { type: 'application/ld+json' },
      content: jsonLdText({
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: trail.map((step, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          ...step,
        })),
      }),
    },
  );
});
