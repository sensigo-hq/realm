// The link-preview images: /og/site.png for the home and how-it-works pages, /og/compare.png for the
// comparison, and one per docs page at /og/<page id>.png (for example
// /og/docs/guides/human-gates.png). Drawn at build time.
import { getCollection } from 'astro:content';
import { HOME_DESCRIPTION } from '../../lib/site-meta.mjs';
import { docsPreviewPng, sitePreviewPng } from '../../lib/preview-image.mjs';
import { groupOf, isDocsPageId } from '../../data/docs-sidebar.mjs';
import { pageTitle as compareTitle } from '../../lib/compare-text.mjs';

export async function getStaticPaths() {
  const pages = await getCollection('docs', (page) => isDocsPageId(page.id));
  return [
    { params: { slug: 'site' }, props: { kind: 'site' } },
    { params: { slug: 'compare' }, props: { kind: 'compare' } },
    ...pages.map((page) => ({
      params: { slug: page.id },
      props: { kind: 'docs', id: page.id, title: page.data.title },
    })),
  ];
}

export async function GET({ props }) {
  let png;
  if (props.kind === 'site') {
    // The home page's description, its two sentences on two lines.
    const [headline, ...rest] = HOME_DESCRIPTION.split(/(?<=\.)\s+/);
    png = await sitePreviewPng({ headline, subline: rest.join(' ') });
  } else if (props.kind === 'compare') {
    png = await docsPreviewPng({ eyebrow: 'Comparison', title: compareTitle });
  } else {
    const group = groupOf(props.id);
    png = await docsPreviewPng({
      eyebrow: group ? `Documentation · ${group}` : 'Documentation',
      title: props.title,
    });
  }
  return new Response(png, { headers: { 'Content-Type': 'image/png' } });
}
