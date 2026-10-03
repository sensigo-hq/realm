// Generates Starlight content from ../docs — the single source of truth.
// The engine's docs stay free of frontmatter so they read cleanly on GitHub;
// this derives the title from the first H1, strips it (Starlight renders its own),
// and writes into src/content/docs/docs/** which is gitignored.
import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, dirname, relative, posix, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const esc = (s) => s.replace(/"/g, '\\"');

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

await rm(OUT, { recursive: true, force: true });
const files = await walk(SRC);

for (const file of files) {
  const raw = await readFile(file, 'utf8');
  const lines = raw.split('\n');
  const i = lines.findIndex((l) => /^#\s+/.test(l));
  if (i === -1) {
    console.warn(`  skip (no H1): ${relative(SRC, file)}`);
    continue;
  }
  const title = lines[i].replace(/^#\s+/, '').trim();
  const body = [...lines.slice(0, i), ...lines.slice(i + 1)].join('\n').replace(/^\n+/, '');
  const rel = relative(SRC, file);
  // docs/README.md is the index on GitHub; on the site it is /docs/.
  const dest = join(
    OUT,
    basename(rel).toLowerCase() === 'readme.md' ? join(dirname(rel), 'index.md') : rel,
  );
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, `---\ntitle: "${esc(title)}"\n---\n\n${rewriteLinks(body, rel)}`);
}

console.log(`sync-docs: ${files.length} files -> src/content/docs/docs/`);
