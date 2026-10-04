// What the site says about itself in page metadata: link previews, search results, llms.txt.
// One place, used by the two custom pages, the docs pages (src/route-data.mjs), the preview
// images (src/pages/og/), the Markdown copies and llms.txt.

export const SITE_URL = 'https://realmengine.dev';
export const SITE_NAME = 'Realm';

// The home page's description; llms.txt quotes it as the site's one-line summary.
export const HOME_DESCRIPTION =
  'A workflow state machine that agents call. The state cannot change until valid output is submitted.';

export const HOW_IT_WORKS_DESCRIPTION =
  'How a Realm run passes between the engine, an MCP client, realm agent and realm listen — four diagrams.';

export const SOURCE_URL = 'https://github.com/sensigo-hq/realm';

// The sitemap's one address. Written there by src/integrations/sitemap-at-root.mjs, named by
// robots.txt and by every docs page's <link rel="sitemap">. The old addresses redirect to it in
// website/deploy/nginx-site.conf, which cannot import this, so change both together.
export const SITEMAP_PATH = '/sitemap.xml';

// The publisher named in the home page's structured data. Sensigo Software owns the Realm name and
// logo (README, "Trademarks"); its website and its GitHub organisation identify it. No logo is
// given: the R is Realm's mark, not Sensigo Software's.
export const PUBLISHER = {
  name: 'Sensigo Software',
  url: 'https://sensigo.ro/',
  sameAs: ['https://github.com/sensigo-hq'],
};

// Link-preview images are 1200x630, the size Open Graph consumers (Slack, LinkedIn, X) show large.
export const PREVIEW_SIZE = { width: 1200, height: 630 };

/** A path on this site as a full URL, for tags that must be absolute (og:url, og:image). */
export function absolute(path) {
  return new URL(path, SITE_URL).href;
}

// Docs pages are content entries with ids like `docs/start/install-and-first-run`; the index is `docs`.

/** The page's address on the site: `/docs/start/install-and-first-run/`. */
export function docsPagePath(id) {
  return `/${id}/`;
}

/** The address of the page's Markdown copy: the page's address with `.md` in place of the last slash. */
export function markdownPath(id) {
  return `/${id}.md`;
}

/** The address of a page's preview image. `site` is the image of the home and how-it-works pages. */
export function previewImagePath(key) {
  return `/og/${key}.png`;
}

/**
 * The text of a `<script type="application/ld+json">` element. `<` is written as `<`, so no value
 * in the data can end the script element early.
 */
export function jsonLdText(data) {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

/** The tags a link preview reads, for a page that is not a docs page. */
export function previewTags({ title, description, path, imageKey, imageAlt }) {
  const url = absolute(path);
  return [
    { tag: 'link', attrs: { rel: 'canonical', href: url } },
    { tag: 'meta', attrs: { property: 'og:type', content: 'website' } },
    { tag: 'meta', attrs: { property: 'og:site_name', content: SITE_NAME } },
    { tag: 'meta', attrs: { property: 'og:locale', content: 'en' } },
    { tag: 'meta', attrs: { property: 'og:title', content: title } },
    { tag: 'meta', attrs: { property: 'og:description', content: description } },
    { tag: 'meta', attrs: { property: 'og:url', content: url } },
    ...imageTags(imageKey, imageAlt),
    { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
  ];
}

/** og:image with its type, size and description, and the same image for X's card. */
export function imageTags(imageKey, imageAlt) {
  const image = absolute(previewImagePath(imageKey));
  return [
    { tag: 'meta', attrs: { property: 'og:image', content: image } },
    { tag: 'meta', attrs: { property: 'og:image:type', content: 'image/png' } },
    { tag: 'meta', attrs: { property: 'og:image:width', content: String(PREVIEW_SIZE.width) } },
    { tag: 'meta', attrs: { property: 'og:image:height', content: String(PREVIEW_SIZE.height) } },
    { tag: 'meta', attrs: { property: 'og:image:alt', content: imageAlt } },
    { tag: 'meta', attrs: { name: 'twitter:image', content: image } },
    { tag: 'meta', attrs: { name: 'twitter:image:alt', content: imageAlt } },
  ];
}
