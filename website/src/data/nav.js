// The site menu's links, for every page: the home, how-it-works and comparison pages show them through
// src/components/SiteNav.astro, the docs pages through src/components/DocsHeaderLinks.astro, and the
// menu on a narrow screen through src/components/MenuLinks.astro on both. One source, so a link added
// for one page is never missing from another. `icon` names a Starlight icon: the header of every page
// shows that link as the icon alone on a wide screen, as most sites show GitHub (of the 26 surveyed
// pages that put it in the header, 24 use an icon, 16 of them the icon alone); the menu on a narrow
// screen lists it by name. The site pages draw these icons from src/components/SiteIcon.astro, so a
// new one must be added there too (the build says so if it is missing).
export const nav = [
  { href: '/how-it-works/', label: 'How it works' },
  { href: '/compare/', label: 'Compare' },
  { href: '/docs/', label: 'Docs' },
  { href: 'https://github.com/sensigo-hq/realm', label: 'GitHub', icon: 'github' },
  { href: 'https://www.npmjs.com/package/@sensigo/realm', label: 'npm', icon: 'npm' },
];

/**
 * The `aria-current` value of a menu link on the page at `pathname`: 'page' on the page it links to,
 * 'true' for the Docs link on any other docs page (the reader is in that part of the site), and
 * nothing elsewhere.
 */
export function ariaCurrent(href, pathname) {
  if (href === pathname) return 'page';
  if (href === '/docs/' && pathname.startsWith('/docs/')) return 'true';
  return undefined;
}
