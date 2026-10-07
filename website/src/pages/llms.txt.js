// /llms.txt: a plain-text map of the site for AI agents, in the format proposed at https://llmstxt.org/
// (a title, a one-line summary, then sections of links with a description each).
// Every docs page appears once, in the sidebar's groups and order, linked to its Markdown copy.
import { getCollection } from 'astro:content';
import {
  HOME_DESCRIPTION,
  HOW_IT_WORKS_DESCRIPTION,
  COMPARE_DESCRIPTION,
  SITE_NAME,
  SOURCE_URL,
  absolute,
  markdownPath,
} from '../lib/site-meta.mjs';
import {
  DOCS_INDEX_ID,
  DOCS_SIDEBAR,
  assertDocsListed,
  isDocsPageId,
} from '../data/docs-sidebar.mjs';

export async function GET() {
  const pages = await getCollection('docs', (page) => isDocsPageId(page.id));
  assertDocsListed(pages.map((p) => p.id));
  const byId = new Map(pages.map((p) => [p.id, p.data]));
  const link = (id) =>
    `- [${byId.get(id).title}](${absolute(markdownPath(id))}): ${byId.get(id).description}`;

  const text = [
    `# ${SITE_NAME}`,
    '',
    `> ${HOME_DESCRIPTION}`,
    '',
    `Realm is an open-source workflow engine (Apache-2.0) for AI agents, published by Sensigo Software. An agent calls it through its MCP server, \`@sensigo/realm-mcp\`, or \`realm agent\` drives a model from the command line. Realm decides which steps may run next, refuses an answer that breaks the JSON Schema its step declares, pauses the run at a human gate until someone answers it or its time limit runs out, and records each finished step's output with a SHA-256 hash in a run record you can inspect, export and compare. It is not MongoDB's Realm mobile database or any other product named Realm. Install the command line with \`npm install -g @sensigo/realm-cli\`.`,
    '',
    `Each docs page below links to its Markdown copy. The page itself is at the same address with a closing slash in place of \`.md\`. The docs index is ${absolute(markdownPath(DOCS_INDEX_ID))}.`,
    '',
    ...DOCS_SIDEBAR.flatMap((group) => [`## ${group.label}`, '', ...group.items.map(link), '']),
    '## Optional',
    '',
    `- [How it works](${absolute('/how-it-works/')}): ${HOW_IT_WORKS_DESCRIPTION}`,
    `- [How Realm compares](${absolute('/compare.md')}): ${COMPARE_DESCRIPTION} The page itself is ${absolute('/compare/')}.`,
    `- [Source code](${SOURCE_URL}): The Realm repository on GitHub, with the changelog and the docs as written.`,
    '',
  ].join('\n');
  return new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
