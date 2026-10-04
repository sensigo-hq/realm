// Puts the sitemap at one address, SITEMAP_PATH (/sitemap.xml), the conventional place for it.
// Crawlers asked for /sitemap.xml even while it did not exist (server log, September 2026).
//
// @astrojs/sitemap always writes an index, sitemap-index.xml, that points to the page lists
// sitemap-0.xml, sitemap-1.xml, ... (45,000 pages each), and to any customSitemaps. This site has
// one list and nothing else, so this step, which must be listed after sitemap() in
// astro.config.mjs, moves sitemap-0.xml to SITEMAP_PATH and deletes the index. The old addresses
// redirect to the new one (website/deploy/nginx-site.conf).
// The build stops instead when the index points anywhere but that one list: a second page list
// or an extra sitemap would otherwise be dropped without a word.
import { readdir, readFile, rename, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { SITEMAP_PATH, absolute } from '../lib/site-meta.mjs';

const INDEX = 'sitemap-index.xml';
const LIST = 'sitemap-0.xml';
const TARGET = SITEMAP_PATH.replace(/^\//, '');

const locs = (xml) => [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);

export default function sitemapAtRoot() {
  return {
    name: 'realm-sitemap-at-root',
    hooks: {
      'astro:build:done': async ({ dir, logger }) => {
        const out = fileURLToPath(dir);
        const written = (await readdir(out)).filter((f) => /^sitemap-(index|\d+)\.xml$/.test(f));
        if (written.length === 0) {
          throw new Error(
            `sitemap-at-root: @astrojs/sitemap wrote no sitemap. If it printed a warning above, ` +
              `that says why (for example no \`site\` in astro.config.mjs, or no pages). ` +
              `Otherwise check that sitemap() is listed before sitemapAtRoot() in astro.config.mjs ` +
              `and that its filenameBase is unchanged.`,
          );
        }
        if (!written.includes(INDEX) || written.length !== 2 || !written.includes(LIST)) {
          throw new Error(
            `sitemap-at-root: expected ${INDEX} and one page list ${LIST}, found: ${written.join(', ')}. ` +
              `A site with more than one page list needs its index served instead.`,
          );
        }
        const pointsTo = locs(await readFile(join(out, INDEX), 'utf8'));
        const expected = absolute(`/${LIST}`);
        if (pointsTo.length !== 1 || pointsTo[0] !== expected) {
          throw new Error(
            `sitemap-at-root: ${INDEX} points to ${pointsTo.join(', ') || 'nothing'}, not only ${expected}. ` +
              `Moving the page list alone would drop the rest (customSitemaps?).`,
          );
        }
        const pages = locs(await readFile(join(out, LIST), 'utf8'));
        if (pages.length === 0) {
          throw new Error(`sitemap-at-root: ${LIST} lists no pages.`);
        }
        await rename(join(out, LIST), join(out, TARGET));
        await rm(join(out, INDEX));
        logger.info(
          `${TARGET} written with ${pages.length} pages (from ${LIST}; ${INDEX} removed)`,
        );
      },
    },
  };
}
