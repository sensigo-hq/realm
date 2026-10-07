// A Markdown copy of each docs page, for AI agents and other programs that read text rather than HTML:
// /docs/guides/human-gates.md beside /docs/guides/human-gates/, and /docs.md for the docs index.
// Each page names its copy in a <link rel="alternate" type="text/markdown"> (src/route-data.mjs), and
// llms.txt links to every copy.
//
// The copy is the page as written in docs/, with three differences: the title is plain text (as on the
// site, see scripts/sync-docs.mjs), the description comment is gone, and links to other docs pages point
// at their copies. Links are full addresses, so they still work when the text is read away from the site.
import { getCollection } from 'astro:content';
import { SITE_URL, absolute, markdownPath } from '../lib/site-meta.mjs';
import { isDocsPageId } from '../data/docs-sidebar.mjs';

export async function getStaticPaths() {
  const pages = await getCollection('docs', (page) => isDocsPageId(page.id));
  return pages.map((page) => ({
    params: { slug: page.id },
    props: { title: page.data.title, body: page.body ?? '' },
  }));
}

// scripts/sync-docs.mjs wrote links between docs pages as site addresses: /docs/<path>/ or /docs/.
// Point them at the Markdown copies. Other site-relative links become full addresses. Fenced code is
// left alone, as sync-docs leaves it.
function linksToCopies(body) {
  let inFence = false;
  return body
    .split('\n')
    .map((line) => {
      if (line.startsWith('```')) inFence = !inFence;
      if (inFence) return line;
      return line.replace(/\]\((\/[^)\s]*)\)/g, (whole, target) => {
        const [path, anchor] = target.split('#');
        // /docs/ and /docs/<path>/ are docs pages; their id is the address without its slashes.
        const isPage = path === '/docs/' || (path.startsWith('/docs/') && path.endsWith('/'));
        const url = isPage
          ? absolute(markdownPath(path.slice(1, -1)))
          : new URL(path, SITE_URL).href;
        return `](${url}${anchor ? `#${anchor}` : ''})`;
      });
    })
    .join('\n');
}

export function GET({ props }) {
  const text = `# ${props.title}\n\n${linksToCopies(props.body).trim()}\n`;
  return new Response(text, { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
}
