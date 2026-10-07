// Generates Starlight content from ../docs — the single source of truth.
// The engine's docs stay free of frontmatter so they read cleanly on GitHub;
// this derives the title from the first H1, strips it (Starlight renders its own),
// and writes into src/content/docs/docs/** which is gitignored. It also writes the 404 page
// (src/content/docs/404.md), from the site menu's links.
//
// Each page carries its own description for search results and link previews, as a comment on the
// line after the H1, which GitHub does not show:
//
//   # Add a human gate
//
//   <!-- description: Add a point where a person must decide before anything takes effect: ... -->
//
// The build stops, naming every page at fault, when a page has no H1, has no such line, has an empty
// description or one containing "--" (which would end the comment), or shares its description with
// another page.
import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, dirname, relative, posix, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nav } from '../src/data/nav.js';

const here = dirname(fileURLToPath(import.meta.url));
// REALM_DOCS_SRC points the site at another checkout's docs (the docs-rebuild preview).
const SRC = process.env.REALM_DOCS_SRC ?? join(here, '..', '..', 'docs');
const OUT = join(here, '..', 'src', 'content', 'docs', 'docs');

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

// Links between docs pages are written as relative `.md` paths so they work on GitHub.
// On the site each page lives at /docs/<path>/, so rewrite them here. Fenced code is left alone.
function rewriteLinks(body, relFile) {
  const dir = posix.dirname(relFile.split(sep).join('/'));
  let inFence = false;
  return body
    .split('\n')
    .map((line) => {
      if (line.startsWith('```')) inFence = !inFence;
      if (inFence) return line;
      return line.replace(/\]\(([^)\s]+)\)/g, (whole, target) => {
        if (/^(https?:|mailto:|#|\/)/.test(target)) return whole;
        const [path, anchor] = target.split('#');
        if (!path.endsWith('.md')) return whole;
        const resolved = posix.normalize(posix.join(dir, path));
        if (resolved.startsWith('..')) return whole;
        let slug = resolved.replace(/\.md$/, '').toLowerCase();
        if (slug === 'readme') slug = '';
        else if (slug.endsWith('/readme')) slug = slug.slice(0, -'/readme'.length);
        const url = `/docs/${slug ? slug + '/' : ''}${anchor ? '#' + anchor : ''}`;
        return `](${url})`;
      });
    })
    .join('\n');
}

const DESCRIPTION = /^<!-- description: (.+) -->$/;

// Reads one page: its title, its description and the rest of its text. Returns problems instead of
// throwing, so one build run can name every page at fault.
function readPage(raw) {
  const lines = raw.split('\n');
  const i = lines.findIndex((l) => /^#\s+/.test(l));
  if (i === -1) return { problem: 'no H1 heading' };
  // A title is plain text on the site: in the browser tab, search results, link previews, the page heading
  // and the sidebar. The backticks that mark code in the H1 on GitHub would show there as backticks.
  const title = lines[i].replace(/^#\s+/, '').replaceAll('`', '').trim();
  let j = i + 1;
  while (j < lines.length && lines[j].trim() === '') j++;
  const match = DESCRIPTION.exec(lines[j] ?? '');
  if (!match) {
    return { problem: 'no "<!-- description: ... -->" line after the H1 heading' };
  }
  const description = match[1].trim();
  if (description === '' || description.includes('--')) {
    return { problem: 'the description is empty or contains "--", which ends an HTML comment' };
  }
  const body = [...lines.slice(0, i), ...lines.slice(j + 1)].join('\n').replace(/^\n+/, '');
  return { title, description, body };
}

const files = await walk(SRC);

const pages = [];
const problems = [];
for (const file of files) {
  const rel = relative(SRC, file);
  const page = readPage(await readFile(file, 'utf8'));
  if (page.problem) problems.push(`docs/${rel}: ${page.problem}`);
  else pages.push({ rel, ...page });
}
// Search engines treat one description on many pages as no description (Google: identical
// descriptions "aren't helpful").
const byDescription = new Map();
for (const { rel, description } of pages) {
  byDescription.set(description, [...(byDescription.get(description) ?? []), `docs/${rel}`]);
}
for (const [description, rels] of byDescription) {
  if (rels.length > 1) problems.push(`${rels.join(', ')}: the same description "${description}"`);
}
if (problems.length > 0) {
  console.error(`sync-docs: ${problems.length} problem(s) in ../docs:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

// Only after every page passed, so a mistake leaves the last good output in place.
await rm(OUT, { recursive: true, force: true });
for (const { rel, title, description, body } of pages) {
  // docs/README.md is the index on GitHub; on the site it is /docs/.
  const dest = join(
    OUT,
    basename(rel).toLowerCase() === 'readme.md' ? join(dirname(rel), 'index.md') : rel,
  );
  await mkdir(dirname(dest), { recursive: true });
  // JSON.stringify gives a valid YAML double-quoted string: it escapes backslashes, quotes and control
  // characters (a hand-written quote-only replace broke on a title with a backslash).
  await writeFile(
    dest,
    `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\n---\n\n${rewriteLinks(body, rel)}`,
  );
}

// The 404 page. Starlight's own has no menu on a narrow screen (it has no sidebar), so a visitor on a
// phone would have only the logo and the search box. This one offers the home page and the site
// menu's links (src/data/nav.js) as buttons.
const notFound = {
  title: 'Page not found',
  template: 'splash',
  editUrl: false,
  pagefind: false,
  hero: {
    tagline: 'Nothing is at this address. Search the docs, or go to one of these pages.',
    actions: [
      { text: 'Home', link: '/', variant: 'primary' },
      ...nav.map((l) => ({ text: l.label, link: l.href, variant: 'minimal' })),
    ],
  },
};
// JSON is valid YAML, so the front matter is written as JSON.
await writeFile(
  join(here, '..', 'src', 'content', 'docs', '404.md'),
  `---\n${JSON.stringify(notFound, null, 2)}\n---\n`,
);

console.log(`sync-docs: ${files.length} files -> src/content/docs/docs/, and the 404 page`);
