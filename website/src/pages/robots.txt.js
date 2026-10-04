// /robots.txt: lets every crawler read the whole site and names the sitemap, so search engines get
// the full page list without being told it some other way (SITEMAP_PATH, written by
// src/integrations/sitemap-at-root.mjs).
// Cloudflare's managed robots.txt, when it is switched on, puts its own block above this file and
// keeps the lines below (developers.cloudflare.com/bots/additional-configurations/managed-robots-txt/).
import { SITEMAP_PATH, absolute } from '../lib/site-meta.mjs';

export function GET() {
  const text = `User-agent: *
Allow: /

Sitemap: ${absolute(SITEMAP_PATH)}
`;
  return new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
