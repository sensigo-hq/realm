// /llms.txt: a plain-text map of the site for AI agents, in the format proposed at https://llmstxt.org/
// (a title, a one-line summary, then sections of links with a description each).
// Every docs page appears once, in the sidebar's groups and order, linked to its Markdown copy.
import { getCollection } from 'astro:content';
import {
  HOME_DESCRIPTION,
  HOW_IT_WORKS_DESCRIPTION,
  SITE_NAME,
  SOURCE_URL,
  absolute,
  markdownPath,
} from '../lib/site-meta.mjs';
import { DOCS_INDEX_ID, DOCS_SIDEBAR, assertDocsListed } from '../data/docs-sidebar.mjs';

export async function GET() {
  const pages = await getCollection('docs');
  assertDocsListed(pages.map((p) => p.id));
  const byId = new Map(pages.map((p) => [p.id, p.data]));
  const link = (id) =>
    `- [${byId.get(id).title}](${absolute(markdownPath(id))}): ${byId.get(id).description}`;

  const text = [
    `# ${SITE_NAME}`,
    '',
    `> ${HOME_DESCRIPTION}`,
    '',
    `Realm is an open-source workflow engine (Apache-2.0) that an AI agent calls. Install the command line with \`npm install -g @sensigo/realm-cli\`.`,
    '',
    `Each docs page below links to its Markdown copy. The page itself is at the same address with a closing slash in place of \`.md\`. The docs index is ${absolute(markdownPath(DOCS_INDEX_ID))}.`,
    '',
    ...DOCS_SIDEBAR.flatMap((group) => [`## ${group.label}`, '', ...group.items.map(link), '']),
    '## Optional',
    '',
    `- [How it works](${absolute('/how-it-works/')}): ${HOW_IT_WORKS_DESCRIPTION}`,
    `- [Source code](${SOURCE_URL}): The Realm repository on GitHub, with the changelog and the docs as written.`,
    '',
  ].join('\n');
  return new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
