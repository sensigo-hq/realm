// Puts the sitemap at /sitemap.xml, the address crawlers try first.
//
// @astrojs/sitemap always writes an index, sitemap-index.xml, that points to the page lists
// sitemap-0.xml, sitemap-1.xml, ... (45,000 pages each). This site has one list, so this step,
// which must be listed after sitemap() in astro.config.mjs, moves sitemap-0.xml to sitemap.xml and
// deletes the index. The old addresses redirect to /sitemap.xml (website/deploy/nginx-site.conf).
// If the build ever writes a second list, the build stops: one file can no longer hold every page.
import { readdir, readFile, rename, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const INDEX = 'sitemap-index.xml';
const LIST = 'sitemap-0.xml';
const TARGET = 'sitemap.xml';

export default function sitemapAtRoot() {
  return {
    name: 'realm-sitemap-at-root',
    hooks: {
      'astro:build:done': async ({ dir, logger }) => {
        const out = fileURLToPath(dir);
        const written = (await readdir(out)).filter((f) => /^sitemap-(index|\d+)\.xml$/.test(f));
        const lists = written.filter((f) => f !== INDEX);
        if (!written.includes(INDEX) || lists.length !== 1 || lists[0] !== LIST) {
          throw new Error(
            `sitemap-at-root: expected ${INDEX} and one page list ${LIST}, found: ${written.join(', ') || 'none'}. ` +
              `Check that sitemap() is listed before sitemapAtRoot() in astro.config.mjs, ` +
              `or, if the site now has more than one page list, serve the index instead.`,
          );
        }
        const xml = await readFile(join(out, LIST), 'utf8');
        const urls = (xml.match(/<loc>/g) ?? []).length;
        if (!xml.includes('<urlset') || urls === 0) {
          throw new Error(`sitemap-at-root: ${LIST} is not a page list with at least one address.`);
        }
        await rename(join(out, LIST), join(out, TARGET));
        await rm(join(out, INDEX));
        logger.info(`${TARGET} written with ${urls} pages (from ${LIST}; ${INDEX} removed)`);
      },
    },
  };
}
